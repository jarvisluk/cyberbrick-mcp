import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { sanitize, callAppManager } from '../connection.js';
import {
  isReadCommand, listDevices, deviceStatus, poolState, deviceByIndex,
  boardInfo, adcStatus, deviceConfigFileInfo, deviceConfigFileBlock,
  deviceConfigFull,
} from '../core/devices.js';
import { bleState, healBle } from '../core/ble.js';

const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

// window.app.local methods device_request may call. Everything else on that
// surface (runSendConfigTask, updateLoaderFirmwareMpy, sendTestCommand, bind /
// PIN / private-key flows, ...) writes to hardware and is out of bounds here.
// sendGetMessage is allowed only for the read-only B0 command allowlist.
const READ_ONLY_LOCAL_METHODS = new Set(['isInLoader', 'getDeviceById', 'sendGetMessage']);

function checkDeviceRequest(method, args) {
  if (!READ_ONLY_LOCAL_METHODS.has(method)) {
    throw new Error(`Method ${method} is not in the read-only allowlist (${[...READ_ONLY_LOCAL_METHODS].join(', ')})`);
  }
  if (method === 'sendGetMessage' && !isReadCommand(args?.[0]?.command)) {
    throw new Error(`sendGetMessage command ${args?.[0]?.command} is not in the read-only command allowlist (see src/core/devices.js)`);
  }
}

export function registerDeviceTools(server) {
  server.tool(
    'device_list',
    'List devices known to the CyberBrick app (zustand deviceListStore). Read-only.',
    {},
    READ,
    async () => {
      const result = await listDevices();
      return { content: [{ type: 'text', text: JSON.stringify(sanitize(result), null, 2) }] };
    },
  );

  server.tool(
    'device_detail',
    'Get detailed status for one device: connect state, loader mode, connection-pool entry. Read-only.',
    {
      device_id: z.string().describe('Device identifier as reported by device_list.'),
    },
    READ,
    async ({ device_id }) => {
      try {
        const result = await deviceStatus(device_id);
        return { content: [{ type: 'text', text: JSON.stringify(sanitize(result), null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: `ERROR: ${err.message}` }], isError: true };
      }
    },
  );

  server.tool(
    'device_pool_state',
    'Inspect the internal Bluetooth connection pool (size + ids). Read-only.',
    {},
    READ,
    async () => {
      const result = await poolState();
      return { content: [{ type: 'text', text: JSON.stringify(sanitize(result), null, 2) }] };
    },
  );

  server.tool(
    'device_request',
    'Call a read-only window.app.local method: isInLoader, getDeviceById, or sendGetMessage with a read-only B0 command (DEVICE_STATUS, GET_DEVICE_CONFIG, GET_BOARD_INFO, GET_BOARD_TYPE, GET_DEVICE_WIFI_MAC, SYSTEM_VERSION, MPY_PROJECT_INFO, MPY_CHECKSUM_INFO). Any other method or command is refused.',
    {
      method: z.string().describe('Method name on window.app.local, e.g. getDeviceById.'),
      args: z.array(z.unknown()).default([]).describe('JSON-serializable arguments.'),
    },
    READ,
    async ({ method, args }) => {
      try {
        checkDeviceRequest(method, args);
        const result = await callAppManager('local', method, args);
        return { content: [{ type: 'text', text: JSON.stringify(sanitize(result), null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: `ERROR: ${err.message}` }], isError: true };
      }
    },
  );

  server.tool(
    'board_info',
    'Aggregated board info for one device: firmware/loader versions, hardware string, project string, SN, board type — read via B0 SYSTEM_VERSION + GET_BOARD_INFO + GET_BOARD_TYPE.',
    {
      device_id: z.string().describe('Device identifier (bluetoothDeviceId) from device_list.'),
    },
    READ,
    async ({ device_id }) => {
      try {
        const result = await boardInfo(device_id);
        // Apply sanitize() for consistency with the other device tools so any
        // unexpected sensitive key surfacing from the board is redacted too.
        return { content: [{ type: 'text', text: JSON.stringify(sanitize(result), null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: `ERROR: ${err.message}` }], isError: true };
      }
    },
  );

  server.tool(
    'device_status',
    'ADC / channel status vector (DEVICE_STATUS, 10 bytes). Read-only.',
    {
      device_id: z.string().describe('Device identifier (bluetoothDeviceId) from device_list.'),
    },
    READ,
    async ({ device_id }) => {
      try {
        const result = await adcStatus(device_id);
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: `ERROR: ${err.message}` }], isError: true };
      }
    },
  );

  server.tool(
    'device_config_get',
    'Board config file metadata (GET_DEVICE_CONFIG reqType=GET_FILE_INFO). file_size=0 means no config stored. Read-only.',
    {
      device_id: z.string().describe('Device identifier (bluetoothDeviceId) from device_list.'),
    },
    READ,
    async ({ device_id }) => {
      try {
        const result = await deviceConfigFileInfo(device_id);
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: `ERROR: ${err.message}` }], isError: true };
      }
    },
  );

  server.tool(
    'device_config_block',
    'Fetch one board-config file block (GET_DEVICE_CONFIG reqType=GET_FILE_BLOCK). Use after device_config_get reports file_size>0. Read-only.',
    {
      device_id: z.string().describe('Device identifier (bluetoothDeviceId) from device_list.'),
      index: z.number().int().nonnegative().describe('Block index (0-based).'),
    },
    READ,
    async ({ device_id, index }) => {
      try {
        const result = await deviceConfigFileBlock(device_id, index);
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: `ERROR: ${err.message}` }], isError: true };
      }
    },
  );

  server.tool(
    'device_config_read',
    'Read back the whole board config file (GET_FILE_INFO + every GET_FILE_BLOCK), trimmed to file_size, with its MD5 (compare with flash_config\'s md5) and the parsed config JSON. Read-only.',
    {
      device_id: z.string().describe('Device identifier (bluetoothDeviceId) from device_list.'),
    },
    READ,
    async ({ device_id }) => {
      try {
        const result = await deviceConfigFull(device_id);
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: `ERROR: ${err.message}` }], isError: true };
      }
    },
  );

  server.tool(
    'device_ble_state',
    'Live BLE link state per device: GATT connected, store vs. manager status, pool membership, loader mode and the BluetoothDevice connectionCount. connectionCountOk=false means every reconnect (enterLoader during upgrades, BLE drops) will fail with RECONNECTION_INTERRUPTED — fix with device_ble_heal. Read-only.',
    {},
    READ,
    async () => {
      try {
        const result = await bleState();
        return { content: [{ type: 'text', text: JSON.stringify(sanitize(result), null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: `ERROR: ${err.message}` }], isError: true };
      }
    },
  );

  server.tool(
    'device_ble_heal',
    'Reset a non-finite (NaN/undefined) BluetoothDevice.connectionCount to 0 on live devices — the state markBluetoothDevice would have set — so the app\'s reconnect logic works again without power-cycling the board. No BLE I/O. Run before upgrades/pairing when device_ble_state shows connectionCountOk=false.',
    {},
    { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    async () => {
      try {
        const result = await healBle();
        return { content: [{ type: 'text', text: JSON.stringify(sanitize(result), null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: `ERROR: ${err.message}` }], isError: true };
      }
    },
  );
}
