# Changelog

## [Unreleased]

## [0.79.5] - 2026-06-10

### Added

- Added a compact `VERIGEN` ASCII startup banner for the chat-first TUI header.

### Changed

- Changed bare `verigen` to launch the chat-first coding-agent TUI instead of the product workbench dashboard.
- Passed leading agent options such as `--approve` and `-p` through to the coding-agent default path.
- Stopped auto-mounting the S15 product workbench dashboard in coding-agent sessions; use `/verigen-workbench show` when needed.

### Fixed

- Resolved the bundled pi coding-agent launcher from installed npm dependencies instead of falling back to PATH.
- Added VeriGen playbook skill metadata so the chat-first TUI starts without a VeriGen skill warning.

## [0.79.4] - 2026-06-10

### Changed

- Launched the product workbench TUI by default for bare `verigen`, with static workbench output preserved for non-TTY calls.

### Fixed

- Kept `verigen product-preview --tui` interactive on real terminals while preserving static layout output for redirected/non-TTY runs.

## [0.79.3] - 2026-06-10

### Fixed

- Renamed local binary release artifacts from the inherited pi names to VeriGen names.

## [0.79.2] - 2026-06-09

### Fixed

- Fixed release smoke verification on tag checkouts that do not yet contain the next-cycle changelog section.

## [0.79.1] - 2026-06-09

### Fixed

- Aligned the npm release line with the already-published pi package baseline so VeriGen can publish as the default installable package.

## [0.78.2] - 2026-06-09

### Added

- Added the initial VeriGen package with Verilog analysis worker bootstrap, Graphify context tools, VeriGen CLI commands, EDA ToolRunner, quality probe fix loop, mock board flows, S15 product workbench TUI, coding-agent workbench extension, npm-vendored Python worker assets, release smoke checks, and root release/publish pipeline integration.
