# cyberbrick-mcp

English | [简体中文](README.zh-CN.md)

An MCP server that drives the Bambu Lab CyberBrick desktop app (Electron) over the Chrome DevTools Protocol.

It covers the entire device setup workflow: hardware connection planning → firmware authoring → flashing.

## Tools (41)

> This server is a **thin pass-through layer** over the CyberBrick app: every tool calls the app's own API (store actions / device methods) and runs immediately. Exceptions: `flash_mpy`, `flash_firmware`, and `flash_config` with `hardwareMappings` (which upgrades firmware first) require `confirm: true`, set only after the user explicitly agrees. For device write operations, `target` must match exactly one device or the call is rejected.

**Read-only / probing (`readOnlyHint: true`)**
- Infrastructure: `cb_health`, `app_logs` (app console logs, for following long flows such as upgrades or pairing)
- Devices: `device_list`, `device_detail`, `board_info`, `device_status`, `device_config_get`, `device_config_block`, `device_config_read` (full readback + MD5), `device_ble_state` (live GATT / connectionCount state), `device_pool_state`, `device_request`
- Connection planning: `connect_scan_ports`
- Flash preflight: `flash_check` (which firmware / MPY / loader upgrades a `hardwareMappings` flash would trigger)
- Firmware reading: `firmware_config_get`, `firmware_edit_actions` (semantic parameter docs for all 60 actions)
- Project reading: `project_state` (page awareness + `nextTools` progressive disclosure), `project_list`, `project_export`

**Write / flash (runs directly, MUTATING)**
- Launch: `cb_launch` (if the app is running without the debug port, it is only killed when `kill_existing: true`)
- Connection: `connect_bluetooth`, `connect_serial`, `device_ble_heal` (repairs a NaN connectionCount so reconnects work without restarting)
- Firmware authoring: `firmware_config_set`, `firmware_config_edit`, `firmware_config_reset`, `firmware_config_load_template` (loads a built-in template into the editor)
- Flashing: `flash_config` (defaults to the `SET_DEVICE_CONFIG` file protocol; works with a single receiver and creates no new project), `flash_mpy` (`destructiveHint: true`), `flash_firmware` (`destructiveHint: true`), `flash_test`
- Project management: `project_create` (6 built-in templates), `project_import`, `project_rename`, `project_delete` (`destructiveHint: true`), `project_load`, `project_save`, `project_open_editor`
- Windows: `window_list` (read-only), `window_close`, `window_close_others`

## Verification scripts
- Unit tests (no app or hardware needed): `npm test`
- Release version check: `node scripts/check_release.mjs [vX.Y.Z]`
- Read-only path: `node scripts/verify_readonly.mjs`
- Server and tool registration: `node scripts/mcp_list.mjs`
- Local smoke test (needs the running app): `node scripts/smoke.js`
- Project management smoke test (create → rename → export → import → load → save → delete): `node scripts/smoke_project.mjs`
- Project management MCP E2E: `node scripts/mcp_e2e_project.mjs`
- RC car end-to-end example (sender + receiver mappings → save → readback assertions → export; `--flash` adds flashing and an LED test): `node scripts/demo_rc_car.mjs`
- Ad-hoc call to any tool: `node scripts/mcp_call.mjs <tool> '<json>' [...]`
- Re-extract template data (after an app upgrade): `python3 scripts/extract_templates.py`

## Running

Requires Node.js 18+ and the CyberBrick desktop app on the same machine.

MCP client config (JSON), installed from npm:

```json
{
  "command": "npx",
  "args": ["-y", "cyberbrick-mcp"]
}
```

From a local checkout:

```bash
npm install
node src/server.js        # stdio MCP server
```

## CDP port

Defaults to `127.0.0.1:9223` (kept off the common 9222). Override with `CB_CDP_HOST` / `CB_CDP_PORT`. `cb_launch` starts `/Applications/CyberBrick.app/Contents/MacOS/CyberBrick` by default; override with `CB_APP_BINARY`.

## Safety rules

- Never reads or exports auth tokens, private keys or AES keys (`sanitize` in `connection.js` filters by key name).
- Destructive tools (`flash_mpy`, `flash_firmware`) carry `destructiveHint` and require `confirm: true` — the agent must first explain the impact to the user (writes the board / reboots / can brick) and get consent.
- `device_request` only allows read-only methods (`isInLoader`, `getDeviceById`, and `sendGetMessage` for commands on the read-only allowlist).
- `cb_launch` does not kill an already-running app by default (unsaved work would be lost); this needs an explicit `kill_existing: true`.
- Deliberately not exposed: BIND_DEVICE, SET_PRIVATE_KEY, certificate flows, PIN flows (see `ALLOWED_COMMANDS` in `src/core/devices.js`).

## Releasing

CI (`.github/workflows/ci.yml`) runs on every push to `main` and every PR: tests on Node 18/20/22/24, a server start-up check, the version check and `npm pack --dry-run`.

Pushing a `vX.Y.Z` tag runs `.github/workflows/release.yml`: verify → publish to npm (with provenance) → publish `server.json` to the MCP Registry → create the GitHub Release from the CHANGELOG section. Each step skips itself if that version is already out, so a failed run can simply be re-run.

1. Bump the version in `package.json` / `package-lock.json` (`npm version X.Y.Z --no-git-tag-version`), `server.json` (both `version` fields) and `src/server.js`.
2. Add a `## [X.Y.Z] - YYYY-MM-DD` section to `CHANGELOG.md`.
3. `node scripts/check_release.mjs vX.Y.Z` — must pass.
4. Commit, then `git tag vX.Y.Z && git push origin main vX.Y.Z`.

A tag with a suffix (`v1.0.0-rc.1`) publishes to npm under the `next` dist-tag and is marked as a pre-release.

One-time setup:
- **npm**: on npmjs.com, add a trusted publisher for this package (GitHub Actions, workflow `release.yml`, environment `release`). Trusted publishing can only be configured once the package exists, so for the very first release either publish once by hand or add an `NPM_TOKEN` repository secret (an npm automation token); remove the secret once trusted publishing is on.
- **MCP Registry**: nothing to configure. The workflow signs in with GitHub OIDC, which is valid for the `io.github.<owner>/` namespace of the repository it runs in.

## License

[MIT](LICENSE)
