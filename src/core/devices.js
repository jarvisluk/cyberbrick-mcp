/**
 * Device store access (read-only surface over window.app.deviceListStore).
 *
 * Per-device fields are derived from the zustand persist storage
 * (`device-list-storage`) and the live store actions probed in
 * docs/设计与踩坑笔记.md §2 (field shape verified on a real RC_MODULE receiver). We return
 * whole sanitized entries rather than cherry-picking fields.
 */
import { createHash } from 'node:crypto';
import { evaluate, sanitize } from '../connection.js';

export async function listDevices() {
  const raw = await evaluate(`(() => {
    const s = window.app?.deviceListStore;
    if (!s) return { error: 'NO_APP_MANAGER' };
    return {
      deviceCount: s.deviceList.length,
      deviceList: s.deviceList,
      displayNames: typeof s.getDeviceListDisplayNames === 'function'
        ? s.getDeviceListDisplayNames()
        : null,
    };
  })()`);
  if (!raw || raw.error) return raw ?? { error: 'EVALUATE_FAILED' };
  return {
    deviceCount: raw.deviceCount,
    devices: sanitize(raw.deviceList),
    displayNames: sanitize(raw.displayNames),
  };
}

export async function deviceByIndex(index) {
  const devices = await listDevices();
  const entry = devices?.devices?.[index];
  if (!entry) {
    throw new Error(`No device at index ${index} (deviceCount=${devices?.deviceCount ?? '?'})`);
  }
  return entry;
}

/**
 * Connection-pool state. Verified live (docs/设计与踩坑笔记.md §2): the real
 * connection pool lives on `window.app.bluetoothDeviceManager.bluetoothDevicePool`,
 * keyed by the device's MAC (deviceId), NOT on connectionPoolManager. Read-only.
 */
export async function poolState() {
  return sanitize(await evaluate(`(() => {
    const mgr = window.app?.bluetoothDeviceManager;
    if (!mgr) return { error: 'NO_APP_MANAGER' };
    const pool = mgr.bluetoothDevicePool ?? {};
    const keys = Object.keys(pool);
    return {
      poolSize: keys.length,
      poolKeys: keys,
      entries: keys.map(k => {
        const e = pool[k] || {};
        return {
          key: k,
          bluetoothDeviceId: e.bluetoothDeviceId ?? null,
          name: e.name ?? null,
          status: e.status ?? null,
        };
      }),
    };
  })()`));
}

/**
 * Send a B0 command via the app's protocol layer (window.app.local.sendGetMessage).
 * Verified live on real hardware (RC_MODULE receiver):
 *   259 SYSTEM_VERSION, 3 DEVICE_STATUS, 11 GET_BOARD_INFO, 16 GET_BOARD_TYPE,
 *   4 GET_DEVICE_CONFIG (payload {reqType:0} = GET_FILE_INFO) all answer.
 * Commands outside the plaintext whitelist (CE) are auto-encrypted by the app.
 */
export const COMMANDS = Object.freeze({
  BIND_DEVICE: 0, UNBIND_DEVICE: 1, BIND_RECEIVER_LIST: 2, DEVICE_STATUS: 3,
  GET_DEVICE_CONFIG: 4, SET_DEVICE_CONFIG: 5, EXECUTE_COMMAND: 6, SET_PIN_CODE: 7,
  SET_DEVICE_NAME: 8, RAPID_RECOGNITION: 9, GET_DEVICE_WIFI_MAC: 10, GET_BOARD_INFO: 11,
  SET_PRIVATE_KEY: 12, REQUEST_CERTIFICATE_FILE_INFO: 13, REQUEST_CERTIFICATE_FILE_BLOCK: 14,
  COMMUNICATION_ENCRYPTION_READY: 15, GET_BOARD_TYPE: 16, DISCONNECT_DEVICE: 17,
  KEEP_ALIVE: 18, MPY_DEV_MODE: 19, START_MPY_UPDATE: 20, MPY_PROJECT_INFO: 21,
  MPY_CHECKSUM_INFO: 22, SYSTEM_VERSION: 259, SYSTEM_UPGRADE: 262, SYSTEM_REBOOT: 263,
});

// Commands this server is allowed to send — READ-ONLY only. Anything else
// (bind/unbind/PIN/private-key/upgrade/reboot/config-set) must never route
// through here without an explicit user-confirmed tool of its own.
const ALLOWED_COMMANDS = new Set([
  COMMANDS.DEVICE_STATUS,
  COMMANDS.GET_DEVICE_CONFIG,
  COMMANDS.GET_BOARD_INFO,
  COMMANDS.GET_BOARD_TYPE,
  COMMANDS.GET_DEVICE_WIFI_MAC,
  COMMANDS.SYSTEM_VERSION,
  COMMANDS.MPY_PROJECT_INFO,
  COMMANDS.MPY_CHECKSUM_INFO,
]);

export function isReadCommand(command) {
  return ALLOWED_COMMANDS.has(command);
}

export async function sendReadCommand(command, payload = {}, bluetoothDeviceId, timeoutMs = 8000) {
  if (!ALLOWED_COMMANDS.has(command)) {
    throw new Error(`Command ${command} is not in the read-only allowlist (see src/core/devices.js)`);
  }
  if (!bluetoothDeviceId) throw new Error('bluetoothDeviceId is required (get it from device_list)');
  return sanitize(await evaluate(`(async () => {
    const dev = await window.app.deviceListStore.getDeviceByBluetoothDeviceId(
      ${JSON.stringify(bluetoothDeviceId)}
    );
    if (!dev) return { error: 'DEVICE_NOT_FOUND' };
    const r = await window.app.local.sendGetMessage({
      command: ${JSON.stringify(command)},
      payload: ${JSON.stringify(payload)},
      bluetoothDeviceId: ${JSON.stringify(bluetoothDeviceId)},
      timeout: ${JSON.stringify(timeoutMs)},
    });
    return JSON.parse(JSON.stringify(r ?? null));
  })()`, { awaitPromise: true }));
}

/** Aggregated board info: SYSTEM_VERSION + GET_BOARD_INFO + GET_BOARD_TYPE. */
/**
 * The board's chip MAC (Wi-Fi STA = ESP32 base MAC, e.g. "AA:BB:CC:DD:EE:FF").
 * It equals the USB serial number connect_serial reports, unlike the store's
 * deviceId, which on macOS is a Chromium pseudo-address for the BLE device.
 */
export async function chipMac(bluetoothDeviceId, timeoutMs = 8000) {
  const r = await sendReadCommand(COMMANDS.GET_DEVICE_WIFI_MAC, {}, bluetoothDeviceId, timeoutMs);
  const hex = typeof r?.mac === 'string' ? r.mac.replace(/[^0-9a-f]/gi, '') : '';
  return hex.length === 12 ? hex.toUpperCase().match(/../g).join(':') : null;
}

/** Chip MAC of every BLE-connected board: [{deviceId, deviceName, deviceType, bluetoothDeviceId, chipMac}]. */
export async function connectedChipMacs() {
  const devices = await evaluate(`(window.app?.deviceListStore?.deviceList || [])
    .filter(d => d.bluetoothDevice?.gatt?.connected)
    .map(d => ({ deviceId: d.deviceId, deviceName: d.deviceName, deviceType: d.deviceType, bluetoothDeviceId: d.bluetoothDeviceId }))`);
  const out = [];
  for (const d of devices || []) out.push({ ...d, chipMac: await chipMac(d.bluetoothDeviceId, 4000).catch(() => null) });
  return out;
}

export async function boardInfo(bluetoothDeviceId) {
  const [systemVersion, board, boardType, mac] = await Promise.all([
    sendReadCommand(COMMANDS.SYSTEM_VERSION, {}, bluetoothDeviceId),
    sendReadCommand(COMMANDS.GET_BOARD_INFO, {}, bluetoothDeviceId),
    sendReadCommand(COMMANDS.GET_BOARD_TYPE, {}, bluetoothDeviceId),
    chipMac(bluetoothDeviceId).catch(() => null),
  ]);
  return {
    systemVersion,
    board,
    boardType,
    parsed: {
      firmware: Array.isArray(systemVersion?.version) ? systemVersion.version.join('.') : null,
      loader: Array.isArray(systemVersion?.loader_version) ? systemVersion.loader_version.join('.') : null,
      hardware: systemVersion?.hardware_string ?? null,
      project: systemVersion?.project_string ?? null,
      snCode: board?.sn_code ?? null,
      boardType: boardType?.board_type ?? null,
      chipMac: mac,
    },
  };
}

/** ADC / channel status vector (DEVICE_STATUS, 10 bytes). */
export async function adcStatus(bluetoothDeviceId) {
  return sendReadCommand(COMMANDS.DEVICE_STATUS, {}, bluetoothDeviceId);
}

/**
 * Board config file metadata (GET_DEVICE_CONFIG reqType=GET_FILE_INFO).
 * file_size === 0 means no board config file is stored on the device.
 * Use file_block(index) to fetch chunks when file_size > 0.
 */
export async function deviceConfigFileInfo(bluetoothDeviceId) {
  return sendReadCommand(COMMANDS.GET_DEVICE_CONFIG, { reqType: 0 }, bluetoothDeviceId);
}

export async function deviceConfigFileBlock(bluetoothDeviceId, index, timeoutMs = 8000) {
  return sendReadCommand(
    COMMANDS.GET_DEVICE_CONFIG,
    { reqType: 1, index },
    bluetoothDeviceId,
    timeoutMs,
  );
}

/**
 * Full board-config readback: INFO + ceil(size/chunk) blocks, trimmed to
 * file_size (the last block comes back padded to file_chunk_size with stale
 * bytes), with an MD5 to compare against flash_config's result. Block data
 * arrives as an index-keyed object, not an array. GET_FILE_INFO's own md5
 * field is not a digest of the file — don't compare against it.
 */
export async function deviceConfigFull(bluetoothDeviceId, { maxBlocks = 512 } = {}) {
  const info = await deviceConfigFileInfo(bluetoothDeviceId);
  if (!info || info.error) return { info };
  const { file_size: size = 0, file_chunk_size: chunk = 150 } = info;
  if (!size) return { fileSize: 0, empty: true };
  const blockCount = Math.min(Math.ceil(size / chunk), maxBlocks);
  const chunks = [];
  for (let i = 0; i < blockCount; i++) {
    const block = await deviceConfigFileBlock(bluetoothDeviceId, i);
    if (!block?.data) return { fileSize: size, error: `block ${i} returned no data` };
    chunks.push(Buffer.from(Array.isArray(block.data) ? block.data : Object.values(block.data)));
  }
  const bytes = Buffer.concat(chunks).subarray(0, size);
  const text = bytes.toString('utf8');
  let config = null;
  try { config = JSON.parse(text); } catch { /* not JSON — return raw */ }
  return {
    fileSize: size, chunkSize: chunk, blocks: blockCount,
    md5: createHash('md5').update(bytes).digest('hex'),
    configName: config?.config_name ?? null,
    config: config ? sanitize(config) : null,
    base64: config ? undefined : bytes.toString('base64'),
  };
}

/** Per-device detail: pool entry + loader state. */
export async function deviceStatus(indexOrId) {
  const id = String(indexOrId);
  return sanitize(await evaluate(`(async () => {
    const ident = ${JSON.stringify(id)};
    const s = window.app?.deviceListStore;
    if (!s) return { error: 'NO_APP_MANAGER' };
    // Store lookups may be async (sendReadCommand awaits the same accessor).
    // No "only one device" fallback: a wrong id must not silently return
    // some other device.
    let dev = undefined;
    if (typeof s.getDeviceByBluetoothDeviceId === 'function') {
      dev = await s.getDeviceByBluetoothDeviceId(ident);
    }
    if (!dev && typeof s.getDeviceById === 'function') {
      dev = await s.getDeviceById(ident);
    }
    if (!dev) {
      dev = (s.deviceList || []).find(d => d.deviceId === ident || d.bluetoothDeviceId === ident);
    }
    if (!dev) return { error: 'DEVICE_NOT_FOUND', deviceId: ident, available: (s.deviceList || []).map(d => d.deviceName ?? d.deviceId) };

    let loader = 'unknown';
    try {
      if (typeof window.app?.local?.isInLoader === 'function') {
        loader = await window.app.local.isInLoader({ bluetoothDeviceId: dev.bluetoothDeviceId });
      }
    } catch (e) {
      loader = { error: String(e) };
    }

    const pool = window.app?.bluetoothDeviceManager?.bluetoothDevicePool ?? {};
    const poolEntry = dev.deviceId ? pool[dev.deviceId] ?? null : null;

    return {
      deviceId: dev.deviceId ?? null,
      bluetoothDeviceId: dev.bluetoothDeviceId ?? null,
      name: dev.deviceName ?? null,
      connectStatus: dev.deviceConnectStatus ?? null,
      deviceType: dev.deviceType ?? null,
      isInLoader: loader,
      poolEntry: poolEntry ?? null,
    };
  })()`, { awaitPromise: true }));
}
