#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

uv export \
  --frozen \
  --no-dev \
  --no-emit-project \
  --no-emit-package pyverilog \
  --no-hashes \
  --output-file requirements.lock.txt
mkdir -p wheelhouse
uv run --with pip==26.1.2 python -m pip download --requirement requirements.lock.txt --dest wheelhouse
