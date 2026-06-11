param(
	[string]$PackageName = $env:VERIGEN_NPM_PACKAGE,
	[string]$Version = $env:VERIGEN_VERSION,
	[string]$Prefix = $env:VERIGEN_INSTALL_PREFIX,
	[string]$NpmRegistry = $env:VERIGEN_NPM_REGISTRY,
	[switch]$SkipPythonBootstrap
)

$ErrorActionPreference = "Stop"
if (Get-Variable PSNativeCommandUseErrorActionPreference -ErrorAction SilentlyContinue) {
	$PSNativeCommandUseErrorActionPreference = $false
}

$MinimumNodeVersion = [Version]"22.19.0"
$RecommendedNodeVersion = "24.16.0"
$RecommendedNpmVersion = "11.13.0"
$UvVersion = "0.8.4"

if ([string]::IsNullOrWhiteSpace($PackageName)) {
	$PackageName = "verigen"
}
if ([string]::IsNullOrWhiteSpace($Version)) {
	$Version = "latest"
}
if ([string]::IsNullOrWhiteSpace($NpmRegistry)) {
	$NpmRegistry = "https://registry.npmmirror.com"
}

function Write-InstallLog {
	param([string]$Message)
	Write-Host "verigen install: $Message"
}

function Write-InstallWarning {
	param([string]$Message)
	Write-Warning "verigen install: $Message"
}

function Write-InstallHint {
	param([string]$Message)
	Write-Host "  $Message"
}

function Show-PowerShellExecutionPolicyHint {
	Write-Host ""
	Write-Host "Allow PowerShell scripts for the current user:"
	Write-InstallHint "Set-ExecutionPolicy -Scope CurrentUser RemoteSigned -Force"
	Write-Host ""
}

function Show-NodeInstallHint {
	Write-Host ""
	Write-Host "Install Node.js on Windows:"
	Write-InstallHint 'powershell -c "irm https://community.chocolatey.org/install.ps1 | iex"'
	Write-InstallHint "choco install nodejs --version=`"$RecommendedNodeVersion`" -y"
	Write-InstallHint "node -v    # should print v$RecommendedNodeVersion"
	Write-InstallHint "npm -v     # should print $RecommendedNpmVersion"
	Write-Host ""
}

function Show-GitBashInstallHint {
	Write-Host ""
	Write-Host "Install Git Bash on Windows:"
	Write-InstallHint "choco install git -y"
	Write-InstallHint "or download Git for Windows from https://git-scm.com/download/win"
	Write-Host ""
}

function Test-Truthy {
	param([string]$Value)
	if ([string]::IsNullOrWhiteSpace($Value)) {
		return $false
	}
	$normalized = $Value.Trim().ToLowerInvariant()
	return $normalized -ne "0" -and $normalized -ne "false" -and $normalized -ne "off"
}

function Convert-ToVersion {
	param([string]$Value)
	if ([string]::IsNullOrWhiteSpace($Value)) {
		return $null
	}
	$normalized = $Value.Trim()
	if ($normalized.StartsWith("v")) {
		$normalized = $normalized.Substring(1)
	}
	try {
		return [Version]$normalized
	} catch {
		return $null
	}
}

function Test-IsAdministrator {
	$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
	$principal = [Security.Principal.WindowsPrincipal]::new($identity)
	return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Update-ProcessPath {
	$machinePath = [Environment]::GetEnvironmentVariable("Path", "Machine")
	$userPath = [Environment]::GetEnvironmentVariable("Path", "User")
	$paths = @()
	if (-not [string]::IsNullOrWhiteSpace($machinePath)) {
		$paths += $machinePath
	}
	if (-not [string]::IsNullOrWhiteSpace($userPath)) {
		$paths += $userPath
	}
	if ($paths.Count -gt 0) {
		$env:Path = ($paths -join ";")
	}
}

function Ensure-Chocolatey {
	$choco = Get-Command choco -ErrorAction SilentlyContinue
	if ($choco) {
		return $choco.Source
	}
	if (-not (Test-IsAdministrator)) {
		Write-InstallWarning "Chocolatey is not installed and automatic install requires Administrator PowerShell."
		Show-NodeInstallHint
		throw "Chocolatey install requires Administrator PowerShell"
	}
	Write-InstallLog "installing Chocolatey"
	powershell -NoProfile -ExecutionPolicy Bypass -Command "Set-ExecutionPolicy Bypass -Scope Process -Force; irm https://community.chocolatey.org/install.ps1 | iex"
	if ($LASTEXITCODE -ne 0) {
		throw "Chocolatey install failed"
	}
	Update-ProcessPath
	$choco = Get-Command choco -ErrorAction SilentlyContinue
	if (-not $choco) {
		throw "Chocolatey was installed but choco is not available in PATH"
	}
	return $choco.Source
}

function Get-NodeVersion {
	if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
		return $null
	}
	$nodeOutput = (& node -v 2>$null).Trim()
	if ($LASTEXITCODE -ne 0) {
		return $null
	}
	return Convert-ToVersion $nodeOutput
}

function Ensure-NodeAndNpm {
	$nodeVersion = Get-NodeVersion
	if ($null -eq $nodeVersion -or $nodeVersion -lt $MinimumNodeVersion) {
		if ($null -eq $nodeVersion) {
			Write-InstallWarning "Node.js was not found; installing Node.js $RecommendedNodeVersion with Chocolatey."
		} else {
			Write-InstallWarning "Node.js $nodeVersion is unsupported; installing Node.js $RecommendedNodeVersion with Chocolatey."
		}
		Ensure-Chocolatey | Out-Null
		if (-not (Test-IsAdministrator)) {
			Write-InstallWarning "Node.js automatic install requires Administrator PowerShell."
			Show-NodeInstallHint
			throw "Node.js install requires Administrator PowerShell"
		}
		choco install nodejs --version="$RecommendedNodeVersion" -y
		if ($LASTEXITCODE -ne 0) {
			throw "Node.js install failed"
		}
		Update-ProcessPath
	}

	$nodeVersion = Get-NodeVersion
	if ($null -eq $nodeVersion -or $nodeVersion -lt $MinimumNodeVersion) {
		Show-NodeInstallHint
		throw "Node.js >= $MinimumNodeVersion is required"
	}
	if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
		Show-NodeInstallHint
		throw "npm is required"
	}
	$npmOutput = (& npm -v 2>$null).Trim()
	if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($npmOutput)) {
		Show-NodeInstallHint
		throw "npm is required"
	}
	Write-InstallLog "using Node.js $nodeVersion and npm $npmOutput"
}

function Find-GitBash {
	$candidates = @()
	if (-not [string]::IsNullOrWhiteSpace($env:ProgramFiles)) {
		$candidates += Join-Path $env:ProgramFiles "Git\bin\bash.exe"
		$candidates += Join-Path $env:ProgramFiles "Git\usr\bin\bash.exe"
	}
	$programFilesX86 = [Environment]::GetEnvironmentVariable("ProgramFiles(x86)")
	if (-not [string]::IsNullOrWhiteSpace($programFilesX86)) {
		$candidates += Join-Path $programFilesX86 "Git\bin\bash.exe"
		$candidates += Join-Path $programFilesX86 "Git\usr\bin\bash.exe"
	}
	if (-not [string]::IsNullOrWhiteSpace($env:LocalAppData)) {
		$candidates += Join-Path $env:LocalAppData "Programs\Git\bin\bash.exe"
		$candidates += Join-Path $env:LocalAppData "Programs\Git\usr\bin\bash.exe"
	}
	foreach ($candidate in $candidates) {
		if (Test-Path -LiteralPath $candidate -PathType Leaf) {
			return $candidate
		}
	}

	$bashCommand = Get-Command bash.exe -ErrorAction SilentlyContinue
	if ($bashCommand -and $bashCommand.Source -match "\\Git\\(bin|usr\\bin)\\bash\.exe$") {
		return $bashCommand.Source
	}
	return $null
}

function Warn-IfGitBashMissing {
	if ($null -eq (Find-GitBash)) {
		Write-InstallWarning "Git Bash was not found. Some VeriGen workflows expect Git Bash on Windows."
		Show-GitBashInstallHint
	}
}

function Warn-IfExecutionPolicyMayBlockDirectRun {
	$policy = Get-ExecutionPolicy
	if ($policy -eq "Restricted" -or $policy -eq "AllSigned") {
		Write-InstallWarning "PowerShell execution policy is $policy and may block direct install.ps1 execution."
		Show-PowerShellExecutionPolicyHint
	}
}

function Get-WindowsUvAsset {
	$arch = $env:PROCESSOR_ARCHITECTURE
	if ($arch -eq "ARM64") {
		return @{
			Target = "win32-arm64"
			Archive = "uv-aarch64-pc-windows-msvc.zip"
			Url = "https://github.com/astral-sh/uv/releases/download/$UvVersion/uv-aarch64-pc-windows-msvc.zip"
			Sha256 = "34cdff9ed7e1ffece93a895e65377a0ea4f186eb6785ead045280be59edabf19"
		}
	}
	return @{
		Target = "win32-x64"
		Archive = "uv-x86_64-pc-windows-msvc.zip"
		Url = "https://github.com/astral-sh/uv/releases/download/$UvVersion/uv-x86_64-pc-windows-msvc.zip"
		Sha256 = "817c50c80229f88de9699626ee3774c0cceed86099663e8fb00c5ffae7ea911c"
	}
}

function Install-StagedUv {
	$asset = Get-WindowsUvAsset
	$stageRoot = Join-Path ([IO.Path]::GetTempPath()) "verigen-native-tools"
	$archivePath = Join-Path $stageRoot $asset.Archive
	$extractDir = Join-Path $stageRoot "extract"
	$toolDir = Join-Path $stageRoot $asset.Target

	Remove-Item -LiteralPath $extractDir -Recurse -Force -ErrorAction SilentlyContinue
	Remove-Item -LiteralPath $toolDir -Recurse -Force -ErrorAction SilentlyContinue
	New-Item -ItemType Directory -Force -Path $stageRoot, $extractDir, $toolDir | Out-Null

	Write-InstallLog "downloading uv/uvx $UvVersion from Astral"
	Invoke-WebRequest -Uri $asset.Url -OutFile $archivePath
	$actualSha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $archivePath).Hash.ToLowerInvariant()
	if ($actualSha256 -ne $asset.Sha256) {
		throw "uv checksum mismatch: expected $($asset.Sha256), got $actualSha256"
	}
	Expand-Archive -LiteralPath $archivePath -DestinationPath $extractDir -Force
	$uv = Get-ChildItem -LiteralPath $extractDir -Recurse -File -Filter "uv.exe" | Select-Object -First 1
	$uvx = Get-ChildItem -LiteralPath $extractDir -Recurse -File -Filter "uvx.exe" | Select-Object -First 1
	if (-not $uv -or -not $uvx) {
		throw "uv archive did not contain uv.exe and uvx.exe"
	}
	Copy-Item -LiteralPath $uv.FullName -Destination (Join-Path $toolDir "uv.exe") -Force
	Copy-Item -LiteralPath $uvx.FullName -Destination (Join-Path $toolDir "uvx.exe") -Force
	return @{
		Target = $asset.Target
		ToolDir = $toolDir
		Sha256 = $asset.Sha256
		Url = $asset.Url
	}
}

function Get-PackageNodeModulesPath {
	if (-not [string]::IsNullOrWhiteSpace($Prefix)) {
		return Join-Path $Prefix "node_modules"
	}
	$npmRoot = (& npm root -g).Trim()
	if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($npmRoot)) {
		throw "failed to resolve npm global root"
	}
	return $npmRoot
}

function Get-PackageRoot {
	$nodeModules = Get-PackageNodeModulesPath
	if ($PackageName.StartsWith("@")) {
		$parts = $PackageName.Split("/")
		if ($parts.Length -ne 2) {
			throw "unsupported scoped package name: $PackageName"
		}
		return Join-Path (Join-Path $nodeModules $parts[0]) $parts[1]
	}
	return Join-Path $nodeModules $PackageName
}

function Install-StagedUvIntoPackage {
	param([hashtable]$StagedUv)
	$packageRoot = Get-PackageRoot
	$targetDir = Join-Path (Join-Path (Join-Path $packageRoot "dist") "native-tools") $StagedUv.Target
	New-Item -ItemType Directory -Force -Path $targetDir | Out-Null
	Copy-Item -LiteralPath (Join-Path $StagedUv.ToolDir "uv.exe") -Destination (Join-Path $targetDir "uv.exe") -Force
	Copy-Item -LiteralPath (Join-Path $StagedUv.ToolDir "uvx.exe") -Destination (Join-Path $targetDir "uvx.exe") -Force
	Set-Content -LiteralPath (Join-Path $targetDir "THIRD_PARTY_NOTICES.txt") -Value "uv $UvVersion (astral-sh/uv) asset=$($StagedUv.Url) sha256=$($StagedUv.Sha256) license=MIT OR Apache-2.0" -Encoding UTF8
}

function Find-VerigenCommand {
	$candidates = @()
	if (-not [string]::IsNullOrWhiteSpace($Prefix)) {
		$candidates += Join-Path $Prefix "verigen.cmd"
		$candidates += Join-Path $Prefix "verigen.ps1"
		$candidates += Join-Path (Join-Path $Prefix "bin") "verigen.cmd"
		$candidates += Join-Path (Join-Path $Prefix "bin") "verigen.ps1"
	}
	foreach ($candidate in $candidates) {
		if (Test-Path -LiteralPath $candidate -PathType Leaf) {
			return $candidate
		}
	}

	$pathCommand = Get-Command verigen.cmd -ErrorAction SilentlyContinue
	if ($pathCommand) {
		return $pathCommand.Source
	}
	$pathCommand = Get-Command verigen -ErrorAction SilentlyContinue
	if ($pathCommand) {
		return $pathCommand.Source
	}

	$npmPrefixArgs = @("prefix", "-g")
	if (-not [string]::IsNullOrWhiteSpace($Prefix)) {
		$npmPrefixArgs += @("--prefix", $Prefix)
	}
	$npmPrefix = (& npm @npmPrefixArgs).Trim()
	if ($LASTEXITCODE -eq 0 -and -not [string]::IsNullOrWhiteSpace($npmPrefix)) {
		$candidates = @(
			(Join-Path $npmPrefix "verigen.cmd"),
			(Join-Path $npmPrefix "verigen.ps1"),
			(Join-Path (Join-Path $npmPrefix "bin") "verigen.cmd"),
			(Join-Path (Join-Path $npmPrefix "bin") "verigen.ps1")
		)
		foreach ($candidate in $candidates) {
			if (Test-Path -LiteralPath $candidate -PathType Leaf) {
				return $candidate
			}
		}
	}

	return "verigen"
}

Warn-IfExecutionPolicyMayBlockDirectRun
Ensure-NodeAndNpm
Warn-IfGitBashMissing
$stagedUv = Install-StagedUv

$spec = "$PackageName@$Version"
Write-InstallLog "running npm install -g $spec"
$npmArgs = @("install", "-g")
if (-not [string]::IsNullOrWhiteSpace($Prefix)) {
	$npmArgs += @("--prefix", $Prefix)
}
$npmArgs += @("--ignore-scripts", "--registry", $NpmRegistry, $spec)
& npm @npmArgs
if ($LASTEXITCODE -ne 0) {
	throw "npm install failed"
}

Install-StagedUvIntoPackage $stagedUv

$verigenBin = Find-VerigenCommand
$skipBootstrap = $SkipPythonBootstrap.IsPresent -or (Test-Truthy $env:VERIGEN_SKIP_PYTHON_BOOTSTRAP)
if ($skipBootstrap) {
	Write-InstallLog "skipping Python worker bootstrap"
} else {
	Write-InstallLog "preparing Python worker cache and dependencies"
	& $verigenBin python-bootstrap --json | Out-Null
	if ($LASTEXITCODE -eq 0) {
		Write-InstallLog "Python worker cache and dependencies ready"
	} else {
		Write-InstallWarning "Python worker bootstrap failed; VeriGen will retry dependency installation on first Python worker use"
	}
}

Write-InstallLog "done"
Write-InstallLog "run: $verigenBin doctor"
