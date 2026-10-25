import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { sanitize } from '../connection.js';
import {
  burnConfig, checkUpgrade, updateMpy, upgradeFirmware, sendTest,
} from '../core/flash.js';

const targetSchema = {
  target: z.object({
    bluetoothDeviceId: z.string().optional(),
    deviceId: z.string().optional(),
    deviceIndex: z.number().int().nonnegative().optional(),
    deviceName: z.string().optional(),
  }).optional().describe('Which device to target — pass exactly one field. If omitted, the app must know exactly one device; ambiguous or unmatched targets are refused.'),
};

const confirmSchema = {
  confirm: z.literal(true).describe('Must be true. Set it only after the user has explicitly approved this specific upgrade on this specific device.'),
};

const WRITE_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
};

export function registerFlashTools(server) {
  /* ---- CONFIG (SET_DEVICE_CONFIG file protocol; runSendConfigTask with hardwareMappings) ---- */
  server.registerTool('flash_config',
    {
      title: 'Burn firmware config to board',
      description: 'Write a firmwareConfig to the board. Default: the app\'s SET_DEVICE_CONFIG file protocol (FILE_INFO(md5,size) → chunked FILE_BLOCK via sendGetMessage) — works for a lone receiver, burns firmwareConfig if given else the current editor config, to exactly one target device (ambiguous or unmatched targets are refused). The device must be connected (else DEVICE_NOT_CONNECTED → call connect_bluetooth). Returns {ok, verified, bytes, chunkSize, blocks, md5, readback} — verified=true when the board reports the written size — or {stage, ...} on failure. Passing hardwareMappings switches to the app\'s runSendConfigTask (burns a saved project, needs a sender board; never creates a project). That path can also upgrade firmware / MPY / loader first — preview with flash_check and pass confirm=true only after the user approved those upgrades. Executes immediately — OVERWRITES the board\'s stored config. MUTATING / writes to hardware.',
      annotations: { ...WRITE_ANNOTATIONS, openWorldHint: true },
      inputSchema: {
        ...targetSchema,
        firmwareConfig: z.record(z.string(), z.any()).optional().describe('Config object to burn (defaults to the current editor config). File-protocol path only.'),
        hardwareMappings: z.array(z.object({
          hardwareKey: z.string().describe("'sender' | 'receiver_1' | 'receiver_2'"),
          boardId: z.string(),
        }).passthrough()).optional().describe('Opt into the high-level runSendConfigTask path (requires a sender board).'),
        firmwareListId: z.string().optional().describe('runSendConfigTask path only: saved project id to burn (defaults to the editor\'s current config id; must exist in project_list).'),
        confirm: z.boolean().optional().describe('runSendConfigTask path only, required true: set only after the user approved the upgrades flash_check reports.'),
      },
    },
    async ({ target, firmwareConfig, hardwareMappings, firmwareListId, confirm }) => {
      try {
        const result = await burnConfig({ target, firmwareConfig, hardwareMappings, firmwareListId, confirm });
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: `ERROR: ${err.message}` }], isError: true };
      }
    }
  );

  server.registerTool('flash_check',
    {
      title: 'Preview upgrades for a hardwareMappings burn',
      description: 'Dry-run of flash_config\'s hardwareMappings path: calls the app\'s checkDeviceConfigSync and reports, per board, which firmware / MPY / loader upgrades runSendConfigTask would run before sending the config and pairing. Nothing is written. Use it to get the user\'s consent for upgrades first. upgradeTargets is exactly what the run executes (the app\'s log may still mention a loader upgrade it then skips). Read-only.',
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      inputSchema: {
        hardwareMappings: z.array(z.object({
          hardwareKey: z.string().describe("'sender' | 'receiver_1' | 'receiver_2'"),
          boardId: z.string().describe('Board MAC deviceId from device_list.'),
        }).passthrough()).min(1),
        firmwareListId: z.string().optional().describe('Saved project id (defaults to the editor\'s current config id).'),
      },
    },
    async ({ hardwareMappings, firmwareListId }) => {
      try {
        const result = await checkUpgrade({ hardwareMappings, firmwareListId });
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: `ERROR: ${err.message}` }], isError: true };
      }
    }
  );

  /* ---- MPY (updateLoaderFirmwareMpy, mpy-only upgrade) ---- */
  server.registerTool('flash_mpy',
    {
      title: 'MicroPython firmware update',
      description: 'Run a MicroPython firmware update via the app\'s updateLoaderFirmwareMpy (START_MPY_UPDATE). Writes mpy.img and REBOOTS the board. DESTRUCTIVE — requires confirm=true after explicit user approval. Default path upgrades to the built-in RC MPY (mpyType=1); passing userMpyConfig targets a design MPY. Experimental: the built-in path still needs live validation.',
      annotations: { ...WRITE_ANNOTATIONS, destructiveHint: true, openWorldHint: true },
      inputSchema: {
        ...targetSchema,
        ...confirmSchema,
        mpyType: z.number().int().default(1).describe('0 = user_mpy (design MPY, requires userMpyConfig), 1 = cb_rc (built-in RC MPY).'),
        designId: z.string().optional(),
        region: z.string().optional(),
        checksum0: z.string().optional().describe('MPY checksum for the upgrade check; defaults to empty (built-in path).'),
        userMpyConfig: z.any().optional().describe('Design MPY config {title, microPython:{uniKey, checkSum0}} — required when mpyType=0.'),
        eraseFirmwareConfig: z.boolean().default(false).describe('Also erase the board RC config after upgrade (app behavior step 13).'),
      },
    },
    async ({ target, confirm, mpyType, designId, region, checksum0, userMpyConfig, eraseFirmwareConfig }) => {
      try {
        const result = await updateMpy({ target, confirm, mpyType, designId, region, checksum0, userMpyConfig, eraseFirmwareConfig });
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: `ERROR: ${err.message}` }], isError: true };
      }
    }
  );

  /* ---- FIRMWARE (SYSTEM_UPGRADE via updateLoaderFirmwareMpy) ---- */
  server.registerTool('flash_firmware',
    {
      title: 'Full system firmware upgrade',
      description: 'Run a full system firmware flash (SYSTEM_UPGRADE) via the app\'s updateLoaderFirmwareMpy with shouldUpgradeFirmware=true. Executes immediately — multiple reboots, CAN BRICK the device if interrupted. Requires firmwareBinaryB64: the MCP does not replicate the app\'s cloud package fetch (auth headers + certificate decryption are out of scope), so you must supply the .bin yourself (base64). Requires confirm=true after explicit user approval. DESTRUCTIVE.',
      annotations: { ...WRITE_ANNOTATIONS, destructiveHint: true, openWorldHint: true },
      inputSchema: {
        ...targetSchema,
        ...confirmSchema,
        firmwareBinaryB64: z.string().describe('Base64 of the firmware .bin image. Required — the app fetches its own copies only via its cloud check, which this tool does not replicate.'),
        targetVersion: z.string().optional().describe('Target firmware version string (recorded in checkResult.upgradeFirmwareTo).'),
        region: z.string().optional(),
      },
    },
    async ({ target, confirm, firmwareBinaryB64, targetVersion, region }) => {
      try {
        const result = await upgradeFirmware({ target, confirm, firmwareBinaryB64, targetVersion, region });
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: `ERROR: ${err.message}` }], isError: true };
      }
    }
  );

  /* ---- TEST COMMAND (sendTestCommand) ---- */
  server.registerTool('flash_test',
    {
      title: 'Send test/control command',
      description: 'Send a control/test command to a connected device via the app\'s sendTestCommand. Executes immediately — drives an actuator/output on the board. MUTATING.',
      annotations: WRITE_ANNOTATIONS,
      inputSchema: {
        ...targetSchema,
        command: z.record(z.string(), z.unknown()).describe('sendTestCommand payload {config, actuator, set_value, receiver, data}; deviceId is taken from target.'),
      },
    },
    async ({ target, command }) => {
      try {
        const result = await sendTest({ target, command });
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: `ERROR: ${err.message}` }], isError: true };
      }
    }
  );
}
