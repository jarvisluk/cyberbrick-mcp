#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { registerHealthTools } from './tools/health.js';
import { registerDeviceTools } from './tools/device.js';
import { registerConnectTools } from './tools/connect.js';
import { registerFirmwareTools } from './tools/firmware.js';
import { registerFlashTools } from './tools/flash.js';
import { registerProjectTools } from './tools/project.js';

const server = new McpServer(
  {
    name: 'cyberbrick',
    version: '0.4.0',
    description: 'AI-assisted CyberBrick desktop app control via Chrome DevTools Protocol — connection planning, firmware authoring, and flashing',
  },
  {
    instructions: `CyberBrick MCP — drives the Bambu Lab CyberBrick desktop app over CDP through its UI-layer APIs.

WORKFLOW (covers the entire device setup flow — a thin pass-through to the running app):
1) CONNECTION PLANNING & SETUP
   - connect_scan_ports → enumerate Web Serial / BLE devices available now (read-only)
   - connect_bluetooth / connect_serial → actually pair/connect (MUTATING, calls the app's connect APIs)
2) FIRMWARE AUTHORING (edits window.app.useFirmwareConfigStore, mirrors the app UI)
   - firmware_config_get → read current config (read-only)
   - firmware_edit_actions → list valid edit action names (read-only)
   - firmware_config_set / firmware_config_edit / firmware_config_reset / firmware_config_load_template
     → directly call the app store actions (MUTATING, applies immediately)
3) FLASHING (burn to board)
   - flash_config → write config via the app's SET_DEVICE_CONFIG file protocol (works for a lone receiver;
     needs a connected device; hardwareMappings opts into runSendConfigTask) (MUTATING, writes board config)
   - flash_mpy → MicroPython update, reboots board (DESTRUCTIVE, needs confirm=true)
   - flash_firmware → full system flash, can brick (DESTRUCTIVE, needs confirm=true)
   - flash_test → send control command via the app's sendTestCommand (MUTATING)
   - flash_check → preview which firmware/MPY/loader upgrades a hardwareMappings burn would run (read-only;
     get the user's consent for upgrades first)
   - long runs: poll app_logs with since=<lastSeq>; before upgrades/pairing check device_ble_state and
     run device_ble_heal when connectionCountOk=false (else reconnects fail with RECONNECTION_INTERRUPTED)
   - verify: device_config_read → full readback + md5 (compare with flash_config's md5)
4) PROJECT MANAGEMENT (app project list, window.app.useFirmwareListStore)
   - project_state → current route + editor state + nextTools (call FIRST; progressive disclosure)
   - project_list → list projects (configId, configName, ...) or fetch one full record
   - project_create → new project from template (forklift/truck/forklift_and_truck/ball_car/official_remote/custom)
   - project_import / project_export → JSON project content in/out (no dialogs)
   - project_rename / project_delete (DESTRUCTIVE) → manage the list
   - project_load → load a project into the editor store; project_save → persist editor config back
   - project_open_editor → open /project/edit in a new app window or the current one
   - window_list / window_close / window_close_others → list and close app sub-windows (e.g. editors opened by project_open_editor)
   Typical loop: project_state → project_list → project_load → firmware_config_edit (…)
   → project_save → flash_config.
Read-only first: cb_health, app_logs, device_list, device_detail, board_info, device_status,
device_config_get, device_config_block, device_config_read, device_ble_state, device_pool_state, flash_check, connect_scan_ports,
firmware_config_get, firmware_edit_actions, project_state, project_list, project_export, window_list.

SAFETY RULES (repo CLAUDE.md):
- Never read, log, or export auth tokens, private keys, or AES keys.
- This server is a pass-through to the CyberBrick app: every tool calls the app's own
  APIs directly. flash_mpy / flash_firmware require confirm=true — set it only after the
  user explicitly approved that upgrade on that device. Device-targeting tools refuse a
  target that does not match exactly one device.
- cb_launch never kills a running app unless kill_existing=true (unsaved work is lost).
- BIND_DEVICE, SET_PRIVATE_KEY, certificates, and PIN flows are intentionally NOT exposed.`,
  },
);

registerHealthTools(server);
registerDeviceTools(server);
registerConnectTools(server);
registerFirmwareTools(server);
registerFlashTools(server);
registerProjectTools(server);

const transport = new StdioServerTransport();
await server.connect(transport);
console.error('[cyberbrick-mcp] server ready on stdio (CDP target: 127.0.0.1:9223)');
