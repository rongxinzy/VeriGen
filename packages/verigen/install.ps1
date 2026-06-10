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

function Show-NodeInstallHint {
	Write-Host ""
	Write-Host "Install Node.js on Windows:"
	Write-InstallHint "Open PowerShell as Administrator."
	Write-InstallHint 'powershell -c "irm https://community.chocolatey.org/install.ps1 | iex"'
	Write-InstallHint "choco install nodejs --version=`"$RecommendedNodeVersion`""
	Write-InstallHint "node -v    # should print v$RecommendedNodeVersion"
	Write-InstallHint "npm -v     # should print $RecommendedNpmVersion"
	Write-Host ""
}

function Show-GitBashInstallHint {
	Write-Host ""
	Write-Host "Install Git Bash on Windows:"
	Write-InstallHint "choco install git"
	Write-InstallHint "or download Git for Windows from https://git-scm.com/download/win"
	Write-Host ""
}

function Show-PowerShellExecutionPolicyHint {
	Write-Host ""
	Write-Host "If PowerShell blocks install.ps1 execution, run:"
	Write-InstallHint "powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1"
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

function Require-NodeAndNpm {
	if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
		Write-InstallWarning "Node.js is required and was not found."
		Show-NodeInstallHint
		throw "Node.js is required"
	}

	$nodeOutput = (& node -v 2>$null).Trim()
	if ($LASTEXITCODE -ne 0) {
		Write-InstallWarning "node -v failed."
		Show-NodeInstallHint
		throw "Node.js is required"
	}
	$nodeVersion = Convert-ToVersion $nodeOutput
	if ($null -eq $nodeVersion -or $nodeVersion -lt $MinimumNodeVersion) {
		Write-InstallWarning "Node.js $nodeOutput is unsupported; VeriGen requires Node.js >= $MinimumNodeVersion."
		Show-NodeInstallHint
		throw "Node.js version is unsupported"
	}

	if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
		Write-InstallWarning "npm is required and was not found."
		Show-NodeInstallHint
		throw "npm is required"
	}
	$npmOutput = (& npm -v 2>$null).Trim()
	if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($npmOutput)) {
		Write-InstallWarning "npm -v failed."
		Show-NodeInstallHint
		throw "npm is required"
	}
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

	$npmPrefix = (& npm prefix -g).Trim()
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
Require-NodeAndNpm
Warn-IfGitBashMissing

$spec = "$PackageName@$Version"
Write-InstallLog "installing $spec from $NpmRegistry"
$npmArgs = @("install", "-g")
if (-not [string]::IsNullOrWhiteSpace($Prefix)) {
	$npmArgs += @("--prefix", $Prefix)
}
$npmArgs += @("--ignore-scripts", "--registry", $NpmRegistry, $spec)
& npm @npmArgs
if ($LASTEXITCODE -ne 0) {
	throw "npm install failed"
}

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
