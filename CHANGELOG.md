# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

## [0.4.0] - 2026-10-25

41 tools (up from 34).

### Added
- Window management tools: `window_list`, `window_close`, `window_close_others`.
- Device tools: `device_ble_state` (live GATT / connectionCount), `device_ble_heal` (repairs a NaN connectionCount so reconnects work without restarting), `device_config_read` (full readback + MD5), `app_logs` (app console logs).
- `flash_check`: previews which firmware / MPY / loader upgrades a `hardwareMappings` flash would trigger.
- Devices now report the chip MAC, and the USB serial port is mapped to its board.
- Unit tests (`npm test`), runnable without the app or hardware.
- English README (now the primary one) with a Chinese translation in `README.zh-CN.md`.
- MIT license, npm package metadata, and `server.json` for the MCP Registry (`io.github.jarvisluk/cyberbrick-mcp`).
- GitHub Actions: CI on pushes and PRs (Node 18–24), and a tag-triggered release to npm, the MCP Registry and GitHub Releases. `scripts/check_release.mjs` checks that all version fields and the CHANGELOG agree.
- The `cyberbrick` bin entry is now executable (`#!/usr/bin/env node`).

### Changed
- `flash_config` defaults to the `SET_DEVICE_CONFIG` file protocol, so it works with a single receiver and no longer creates duplicate projects.
- Template tools use the app's native template data.
- The published package only ships `src/`, `docs/`, the READMEs and this changelog.
- `cb_launch` defaults to `/Applications/CyberBrick.app` (override with `CB_APP_BINARY`).
- Requires `@modelcontextprotocol/sdk` 1.32.1 or newer (needed for zod 4).

### Fixed
- Board targeting uses `deviceId`; `connect_serial` works again.
- `connect_bluetooth` re-pools known devices instead of returning early, recovers BLE without a board restart, and only short-circuits to `alreadyConnected` for a named board.
- `project_open_editor` renders the editor when navigating in the current window.
- Hardened device safety guards and repaired flash/launch paths.
- Review fixes (P0–P2).

## [0.3.0]

- Project management tools (10) and semantic docs for the 60 firmware edit actions (24 → 34 tools).
- Server reworked as a pure pass-through over the app's own API.
