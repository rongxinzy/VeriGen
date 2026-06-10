#!/usr/bin/env bash
set -euo pipefail

package_name="${VERIGEN_NPM_PACKAGE:-verigen}"
package_version="${VERIGEN_VERSION:-latest}"
install_prefix="${VERIGEN_INSTALL_PREFIX:-}"
npm_registry="${VERIGEN_NPM_REGISTRY:-https://registry.npmmirror.com}"
skip_python_bootstrap="${VERIGEN_SKIP_PYTHON_BOOTSTRAP:-}"

usage() {
	cat <<'EOF'
Usage: install.sh [options]

Options:
  --version VERSION          Install verigen@VERSION instead of latest
  --prefix PATH             Install into an npm global prefix
  --registry URL            npm registry URL, defaults to https://registry.npmmirror.com
  --skip-python-bootstrap   Do not pre-create the VeriGen Python worker venv and dependencies
  -h, --help                Show this help

Environment:
  VERIGEN_NPM_PACKAGE       npm package name to install, defaults to verigen
  VERIGEN_VERSION           npm package version or dist-tag, defaults to latest
  VERIGEN_INSTALL_PREFIX    npm global prefix
  VERIGEN_NPM_REGISTRY      npm registry URL, defaults to https://registry.npmmirror.com
  VERIGEN_SKIP_PYTHON_BOOTSTRAP=1
                            Skip the prewarm step
EOF
}

log() {
	printf 'verigen install: %s\n' "$*"
}

warn() {
	printf 'verigen install warning: %s\n' "$*" >&2
}

die() {
	printf 'verigen install error: %s\n' "$*" >&2
	exit 1
}

require_command() {
	command -v "$1" >/dev/null 2>&1 || die "$1 is required"
}

package_spec() {
	printf '%s@%s' "$package_name" "$package_version"
}

verigen_command() {
	if [ -n "$install_prefix" ] && [ -x "$install_prefix/bin/verigen" ]; then
		printf '%s\n' "$install_prefix/bin/verigen"
		return
	fi
	if command -v verigen >/dev/null 2>&1; then
		command -v verigen
		return
	fi
	local npm_prefix
	npm_prefix="$(npm prefix -g)"
	if [ -x "$npm_prefix/bin/verigen" ]; then
		printf '%s\n' "$npm_prefix/bin/verigen"
		return
	fi
	printf 'verigen\n'
}

while [ "$#" -gt 0 ]; do
	case "$1" in
		--version)
			[ "$#" -ge 2 ] || die "--version requires a value"
			package_version="$2"
			shift 2
			;;
		--prefix)
			[ "$#" -ge 2 ] || die "--prefix requires a path"
			install_prefix="$2"
			shift 2
			;;
		--registry)
			[ "$#" -ge 2 ] || die "--registry requires a URL"
			npm_registry="$2"
			shift 2
			;;
		--skip-python-bootstrap)
			skip_python_bootstrap=1
			shift
			;;
		-h | --help)
			usage
			exit 0
			;;
		*)
			die "unknown option: $1"
			;;
	esac
done

case "$(uname -s)" in
	Darwin | Linux) ;;
	*) warn "this shell installer is intended for macOS and Linux; npm install may still work on this platform" ;;
esac

require_command node
require_command npm

spec="$(package_spec)"
log "installing $spec from $npm_registry"
if [ -n "$install_prefix" ]; then
	npm install -g --prefix "$install_prefix" --ignore-scripts --registry "$npm_registry" "$spec"
else
	npm install -g --ignore-scripts --registry "$npm_registry" "$spec"
fi

verigen_bin="$(verigen_command)"
if [ -n "$skip_python_bootstrap" ]; then
	log "skipping Python worker bootstrap"
else
	log "preparing Python worker cache and dependencies"
	if "$verigen_bin" python-bootstrap --json >/dev/null; then
		log "Python worker cache and dependencies ready"
	else
		warn "Python worker bootstrap failed; VeriGen will retry dependency installation on first Python worker use"
	fi
fi

log "done"
log "run: $verigen_bin doctor"
