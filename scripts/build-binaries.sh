#!/usr/bin/env bash
#
# Build VeriGen binaries for all platforms locally.
# Mirrors .github/workflows/build-binaries.yml
#
# Usage:
#   ./scripts/build-binaries.sh [--skip-install] [--skip-deps] [--skip-build] [--platform <platform>] [--out <dir>]
#
# Options:
#   --skip-install      Skip npm ci
#   --skip-deps         Skip installing cross-platform dependencies
#   --skip-build        Skip npm run build
#   --platform <name>   Build only for specified platform (darwin-arm64, darwin-x64, linux-x64, linux-arm64, windows-x64, windows-arm64)
#   --out <dir>         Output directory (default: packages/verigen/binaries)
#
# Output:
#   packages/verigen/binaries/
#     verigen-darwin-arm64.tar.gz
#     verigen-darwin-x64.tar.gz
#     verigen-linux-x64.tar.gz
#     verigen-linux-arm64.tar.gz
#     verigen-windows-x64.zip
#     verigen-windows-arm64.zip

set -euo pipefail

cd "$(dirname "$0")/.."

SKIP_INSTALL=false
SKIP_DEPS=false
SKIP_BUILD=false
PLATFORM=""
OUTPUT_DIR=""

while [[ $# -gt 0 ]]; do
    case $1 in
        --skip-install)
            SKIP_INSTALL=true
            shift
            ;;
        --skip-deps)
            SKIP_DEPS=true
            shift
            ;;
        --skip-build)
            SKIP_BUILD=true
            shift
            ;;
        --platform)
            PLATFORM="$2"
            shift 2
            ;;
        --out)
            OUTPUT_DIR="$2"
            shift 2
            ;;
        *)
            echo "Unknown option: $1"
            exit 1
            ;;
    esac
done

# Validate platform if specified
if [[ -n "$PLATFORM" ]]; then
    case "$PLATFORM" in
        darwin-arm64|darwin-x64|linux-x64|linux-arm64|windows-x64|windows-arm64)
            ;;
        *)
            echo "Invalid platform: $PLATFORM"
            echo "Valid platforms: darwin-arm64, darwin-x64, linux-x64, linux-arm64, windows-x64, windows-arm64"
            exit 1
            ;;
    esac
fi

if [[ -z "$OUTPUT_DIR" ]]; then
    OUTPUT_DIR="packages/verigen/binaries"
fi
if [[ "$OUTPUT_DIR" != /* ]]; then
    OUTPUT_DIR="$(pwd)/$OUTPUT_DIR"
fi

if [[ "$SKIP_INSTALL" == "false" ]]; then
    echo "==> Installing dependencies..."
    npm ci --ignore-scripts
else
    echo "==> Skipping npm ci (--skip-install)"
fi

if [[ "$SKIP_DEPS" == "false" ]]; then
    echo "==> Installing cross-platform native bindings..."
    CLIPBOARD_VERSION=$(node -p "require('./packages/coding-agent/package.json').optionalDependencies['@mariozechner/clipboard']")
    # npm ci only installs optional deps for the current platform
    # We need the base clipboard package and all platform bindings for bun cross-compilation
    # Do not use npm install here: it reifies the whole node_modules tree and
    # can prune peer dependencies needed by the subsequent bun compile step.
    install_npm_tarball() {
        local package_spec="$1"
        local package_name="${package_spec%@*}"
        local package_dir="node_modules/$package_name"
        local tmp_dir
        local tarball

        tmp_dir="$(mktemp -d)"
        tarball="$(npm pack --ignore-scripts --min-release-age=0 --pack-destination "$tmp_dir" "$package_spec" | tail -n 1)"
        mkdir -p "$(dirname "$package_dir")"
        rm -rf "$package_dir"
        mkdir -p "$package_dir"
        tar -xzf "$tmp_dir/$tarball" -C "$package_dir" --strip-components=1
        rm -rf "$tmp_dir"
    }

    install_npm_tarball @mariozechner/clipboard@"$CLIPBOARD_VERSION"
    install_npm_tarball @mariozechner/clipboard-darwin-arm64@"$CLIPBOARD_VERSION"
    install_npm_tarball @mariozechner/clipboard-darwin-x64@"$CLIPBOARD_VERSION"
    install_npm_tarball @mariozechner/clipboard-linux-x64-gnu@"$CLIPBOARD_VERSION"
    install_npm_tarball @mariozechner/clipboard-linux-arm64-gnu@"$CLIPBOARD_VERSION"
    install_npm_tarball @mariozechner/clipboard-win32-x64-msvc@"$CLIPBOARD_VERSION"
    install_npm_tarball @mariozechner/clipboard-win32-arm64-msvc@"$CLIPBOARD_VERSION"
else
    echo "==> Skipping cross-platform native bindings (--skip-deps)"
fi

if [[ "$SKIP_BUILD" == "false" ]]; then
    echo "==> Building all packages..."
    npm run build
else
    echo "==> Skipping package build (--skip-build)"
fi

echo "==> Building binaries..."
cd packages/verigen

# Clean previous builds
rm -rf "$OUTPUT_DIR"
mkdir -p "$OUTPUT_DIR"/{darwin-arm64,darwin-x64,linux-x64,linux-arm64,windows-x64,windows-arm64}

# Determine which platforms to build
if [[ -n "$PLATFORM" ]]; then
    PLATFORMS=("$PLATFORM")
else
    PLATFORMS=(darwin-arm64 darwin-x64 linux-x64 linux-arm64 windows-x64 windows-arm64)
fi

for platform in "${PLATFORMS[@]}"; do
    echo "Building for $platform..."
    # Compile the VeriGen CLI entrypoint. Runtime assets are copied beside the
    # executable before the archive is created.
    if [[ "$platform" == windows-* ]]; then
        bun build --compile --external @huggingface/transformers --target=bun-$platform ./dist/cli.js --outfile "$OUTPUT_DIR/$platform/verigen.exe"
    else
        bun build --compile --external @huggingface/transformers --target=bun-$platform ./dist/cli.js --outfile "$OUTPUT_DIR/$platform/verigen"
    fi
done

echo "==> Creating release archives..."

# Copy shared files to each platform directory
for platform in "${PLATFORMS[@]}"; do
    cp package.json "$OUTPUT_DIR/$platform/"
    cp README.md "$OUTPUT_DIR/$platform/"
    cp CHANGELOG.md "$OUTPUT_DIR/$platform/"
    cp -r dist/python "$OUTPUT_DIR/$platform/"
    cp -r dist/pi-assets "$OUTPUT_DIR/$platform/"
    cp dist/verigen-coding-agent-extension.js "$OUTPUT_DIR/$platform/"
    cp dist/verigen-coding-agent-extension.d.ts "$OUTPUT_DIR/$platform/"
done

# Create archives
cd "$OUTPUT_DIR"

for platform in "${PLATFORMS[@]}"; do
    if [[ "$platform" == windows-* ]]; then
        # Windows (zip)
        echo "Creating verigen-$platform.zip..."
        (cd "$platform" && zip -r ../verigen-$platform.zip .)
    else
        # Unix platforms (tar.gz) - use wrapper directory for mise compatibility
        echo "Creating verigen-$platform.tar.gz..."
        mv "$platform" verigen && tar -czf verigen-$platform.tar.gz verigen && mv verigen "$platform"
    fi
done

# Extract archives for easy local testing
echo "==> Extracting archives for testing..."
for platform in "${PLATFORMS[@]}"; do
    rm -rf "$platform"
    if [[ "$platform" == windows-* ]]; then
        mkdir -p "$platform" && (cd "$platform" && unzip -q ../verigen-$platform.zip)
    else
        tar -xzf verigen-$platform.tar.gz && mv verigen "$platform"
    fi
done

echo ""
echo "==> Build complete!"
echo "Archives available in $OUTPUT_DIR/"
ls -lh *.tar.gz *.zip 2>/dev/null || true
echo ""
echo "Extracted directories for testing:"
for platform in "${PLATFORMS[@]}"; do
    if [[ "$platform" == windows-* ]]; then
        echo "  $OUTPUT_DIR/$platform/verigen.exe"
    else
        echo "  $OUTPUT_DIR/$platform/verigen"
    fi
done
