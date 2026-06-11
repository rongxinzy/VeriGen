# Changelog

## [Unreleased]

## [0.79.14] - 2026-06-11

### Changed

- Restored the VeriGen TUI startup identity with a compact colored logo header and responsive narrow-terminal fallback.

## [0.79.13] - 2026-06-11

### Changed

- Reduced VeriGen TUI startup noise and changed the agent workbench integration into an on-demand status panel, preserving the pi editor flow while keeping the full product workbench as a dogfood/debug TUI.
- Reduced `verigen agent` resident prompt context by loading only the system prompt and extension at startup, with expert phase prompts and Playbook rules injected on demand through extension commands.

## [0.79.12] - 2026-06-10

### Fixed

- Fixed Python worker bootstrap to keep uv managed Python downloads on the official source instead of an incomplete npm mirror.

## [0.79.11] - 2026-06-10

### Fixed

- Fixed binary compilation by externalizing Vectra's unused optional Transformers peer dependency.

## [0.79.10] - 2026-06-10

### Fixed

- Fixed the cross-platform binary build step to bypass npm minimum release age checks for its temporary native binding install.
- Fixed binary compilation by declaring the direct Transformers dependency required by the Vectra integration.

## [0.79.9] - 2026-06-10

### Fixed

- Fixed the release binary and npm publish workflow to run on Node.js 24.16.0, matching dependencies that require a newer Node runtime.

## [0.79.8] - 2026-06-10

### Added

- Added Graphify coding-agent tools and `/init` project map generation so VeriGen sessions can rebuild and query repo context directly.
- Added DAG-based quality-probe generation mode, routed context injection, and recent failure records for fix-loop iterations.
- Added a SymbiYosys formal verification ToolRunner profile.
- Added bundled `uv`/`uvx`, install scripts, and install-time Python worker prewarming for Windows, macOS, and Linux.

### Changed

- Changed `verigen agent` to preserve the user's selected model instead of injecting a default Kimi model.
- Changed Python worker and Graphify bootstrap paths to prefer bundled native tools before PATH fallbacks.

### Fixed

- Fixed the `verigen` package dependency surface by declaring its direct `typebox` dependency.

## [0.79.7] - 2026-06-10

### Fixed

- Fixed the release test for `verigen --version` so it passes from both the repository root and the package directory.

## [0.79.6] - 2026-06-10

### Added

- Added bundled native `fd` and `ripgrep` packaging for common Windows, macOS, and Linux targets so fresh installs do not download them on first TUI startup.
- Added a default `verigen-kimi/kimi-for-coding` Anthropic-compatible provider registration and `/verigen-models` setup guidance for the chat-first TUI.

### Changed

- Changed the chat-first agent launcher to disable inherited pi startup update/download checks, prepend bundled native tools to PATH, and check `verigen` updates instead of pi updates.

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
