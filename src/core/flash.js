/**
 * Flashing / burning (workflow 3 of the user request).
 *
 * Each function is a thin pass-through to the app's own device methods
 * (window.app.local.*), executed immediately, exactly as if the user triggered
 * it from the app UI.
 *
 * OPERATIONS:
 *  - config   : SET_DEVICE_CONFIG file protocol to one device (default, the
 *               live-verified path); the app's runSendConfigTask only when
 *               hardwareMappings is passed
 *  - check    : checkDeviceConfigSync — dry-run of a hardwareMappings burn's upgrades
 *  - mpy      : updateLoaderFirmwareMpy — MicroPython update (reboots board)
 *  - firmware : updateLoaderFirmwareMpy with shouldUpgradeFirmware — full system upgrade
 *  - test     : sendTestCommand — send a control/test command to a connected device
 *
 * Safety posture:
 *  - every device-targeting operation resolves its target to exactly ONE
 *    device (resolveDevice) and refuses ambiguous or empty matches;
 *  - firmware/MPY upgrades require confirm === true (repo CLAUDE.md: firmware
 *    upgrade needs explicit user confirmation);
 *  - BIND_DEVICE / SET_PRIVATE_KEY / certificates / PIN are not wired up.
 */
import { createHash } from 'node:crypto';
import { evaluate, evaluateAsync, sanitize } from '../connection.js';
import { APP_CONFIG_VERSION } from './project.js';

const TARGET_KEYS = ['bluetoothDeviceId', 'deviceId', 'deviceIndex', 'deviceName'];

/**
 * Resolve a target descriptor to exactly one device of the app's device list.
 * Pass at most one of bluetoothDeviceId / deviceId / deviceIndex / deviceName;
 * with none, the device list must contain exactly one device.
 */
export async function resolveDevice(target = {}) {
  checkTargetKeys(target);
  const list = await evaluate(`(() => {
    const s = window.app?.deviceListStore;
    if (!s) return null;
    return (s.deviceList || []).map(d => ({
      deviceId: d.deviceId ?? null,
      bluetoothDeviceId: d.bluetoothDeviceId || d.bluetoothDevice?.id || null,
      deviceName: d.deviceName || d.name || null,
      deviceType: d.deviceType ?? null,
      connectStatus: d.deviceConnectStatus ?? null,
    }));
  })()`);
  if (!Array.isArray(list)) throw new Error('NO_APP_MANAGER: window.app.deviceListStore is unavailable');
  return pickDevice(list, target);
}

function checkTargetKeys(target) {
  const given = TARGET_KEYS.filter(k => target?.[k] !== undefined && target?.[k] !== null && target?.[k] !== '');
  if (given.length > 1) {
    throw new Error(`AMBIGUOUS_TARGET: pass exactly one of ${TARGET_KEYS.join(' / ')} (got ${given.join(', ')})`);
  }
  return given[0];
}

/** Pure matching step of resolveDevice: list = [{deviceId, bluetoothDeviceId, deviceName}]. */
export function pickDevice(list, target = {}) {
  const key = checkTargetKeys(target);
  let matches;
  if (!key) matches = list;
  else if (key === 'deviceIndex') matches = list[target.deviceIndex] ? [list[target.deviceIndex]] : [];
  else matches = list.filter(d => d[key] === target[key]);
  const available = list.map(d => d.deviceName ?? d.deviceId);
  if (matches.length === 0) {
    throw new Error(`DEVICE_NOT_FOUND: ${key ? `${key}=${JSON.stringify(target[key])}` : 'device list is empty'} (available: ${JSON.stringify(available)})`);
  }
  if (matches.length > 1) {
    throw new Error(`AMBIGUOUS_TARGET: ${key ? `${key}=${JSON.stringify(target[key])} matches` : 'no target given and there are'} ${matches.length} devices — pass target.deviceId or target.bluetoothDeviceId (available: ${JSON.stringify(available)})`);
  }
  if (!matches[0].deviceId) throw new Error('DEVICE_WITHOUT_ID: the matched device record has no deviceId');
  return matches[0];
}

function requireConfirm(options, tool) {
  if (options.confirm !== true) {
    throw new Error(`CONFIRMATION_REQUIRED: ${tool} needs confirm=true, set only after the user explicitly approved this operation on this device.`);
  }
}

/* ----------------------------- CONFIG ----------------------------- */

/**
 * Write a firmwareConfig to the board.
 *
 * Default path — the app's SET_DEVICE_CONFIG file protocol (what its own M7()
 * sender does, minus the pairing stage): FILE_INFO(md5,size) then
 * FILE_BLOCK(index,is_tail,data) chunks via window.app.local.sendGetMessage.
 * Works for a lone receiver. The payload is JSON.stringify({...config,
 * version: "2"}); MD5 is computed here in Node because renderer
 * crypto.subtle has no MD5.
 *
 * High-level path — only when options.hardwareMappings is passed: the app's
 * runSendConfigTask, which burns a saved project (firmwareListId, defaulting to
 * the editor's current config id) and hardcodes
 * finalMode='send_config_and_pairing', so it needs a sender board. Never
 * creates a project (no addFirmware).
 */
export async function burnConfig(options = {}) {
  if (Array.isArray(options.hardwareMappings) && options.hardwareMappings.length) {
    return runSendConfigTask(options);
  }

  let dev;
  try {
    dev = await resolveDevice(options.target);
  } catch (e) {
    return sanitize({ stage: 'RESOLVE_DEVICE', error: e.message });
  }
  if (!dev.bluetoothDeviceId) return sanitize({ stage: 'RESOLVE_DEVICE', error: 'NO_BLUETOOTH_DEVICE_ID', deviceName: dev.deviceName });
  if (dev.connectStatus !== 'connected') {
    return sanitize({
      stage: 'RESOLVE_DEVICE', error: 'DEVICE_NOT_CONNECTED',
      deviceName: dev.deviceName, connectStatus: dev.connectStatus,
      hint: 'Connect the board first with connect_bluetooth, then retry.',
    });
  }

  let configText;
  if (options.firmwareConfig != null) {
    if (typeof options.firmwareConfig !== 'object') return { stage: 'CONFIG', error: 'INVALID_FIRMWARE_CONFIG' };
    configText = JSON.stringify({ ...options.firmwareConfig, version: APP_CONFIG_VERSION });
  } else {
    configText = await evaluateAsync(`(() => {
      const fw = window.app?.useFirmwareConfigStore;
      const st = fw && (fw.getState ? fw.getState() : fw);
      if (!st?.firmwareConfig) return null;
      return JSON.stringify({ ...st.firmwareConfig, version: ${JSON.stringify(APP_CONFIG_VERSION)} });
    })()`);
    if (typeof configText !== 'string') return { stage: 'CONFIG', error: 'NO_FIRMWARE_CONFIG' };
  }

  const bytes = Buffer.from(configText, 'utf8');
  const md5 = createHash('md5').update(bytes).digest('hex');
  const result = await evaluateAsync(`(async () => {
    const l = window.app?.local;
    if (!l || typeof l.sendGetMessage !== 'function') return { stage: 'FILE_INFO', error: 'NO_SEND_GET_MESSAGE' };
    const btid = ${JSON.stringify(dev.bluetoothDeviceId)};
    const bytes = ${JSON.stringify(Array.from(bytes))};
    const md5 = ${JSON.stringify(md5)};
    const send = (payload) => l.sendGetMessage({ command: 5, payload, bluetoothDeviceId: btid, timeout: 8000 })
      .catch(e => ({ error: String(e?.message ?? e) }));
    const info = await send({ file_type: 0, cmd_type: 0, md5, file_size: bytes.length });
    if (!info || info.err_code !== 0) return { stage: 'FILE_INFO', info, md5 };
    const chunkSize = info.chunk_size ? info.chunk_size : 1024;
    const blocks = Math.ceil(bytes.length / chunkSize);
    for (let index = 0; index < blocks; index++) {
      const data = bytes.slice(index * chunkSize, (index + 1) * chunkSize);
      const r = await send({ file_type: 0, cmd_type: 1, index, is_tail: index === blocks - 1 ? 1 : 0, data });
      if (!r || r.err_code !== 0) return { stage: 'FILE_BLOCK', failedAt: index, blocks, response: r, md5 };
    }
    // Read back the stored file info so the caller sees whether the board kept it.
    const readback = await l.sendGetMessage({ command: 4, payload: { reqType: 0 }, bluetoothDeviceId: btid, timeout: 8000 })
      .catch(e => ({ error: String(e?.message ?? e) }));
    return { ok: true, bytes: bytes.length, chunkSize, blocks, md5, readback: JSON.parse(JSON.stringify(readback ?? null)) };
  })()`, 120000);
  const verified = result?.ok ? result.readback?.file_size === bytes.length : false;
  return sanitize({ device: { deviceId: dev.deviceId, deviceName: dev.deviceName }, verified, ...result });
}

/**
 * Dry-run of runSendConfigTask's upgrade step: the app's checkDeviceConfigSync
 * reports per board which firmware / MPY / loader upgrades a hardwareMappings
 * burn would trigger, without touching the boards. upgradeTargets is what the
 * run executes: the app's log may say "shouldUpgradeLoader: true" while the
 * run still skips the loader ("不升级Loader") — trust the returned flags.
 */
export async function checkUpgrade({ hardwareMappings, firmwareListId } = {}) {
  const result = sanitize(await evaluateAsync(`(async () => {
    const local = window.app?.local;
    if (!local || typeof local.checkDeviceConfigSync !== 'function') return { error: 'NO_CHECK_DEVICE_CONFIG_SYNC' };
    const fw = window.app?.useFirmwareConfigStore;
    const st = fw && (fw.getState ? fw.getState() : fw);
    const firmwareListId = ${JSON.stringify(firmwareListId ?? null)} ?? st?.firmwareConfig?.id ?? null;
    if (!firmwareListId) return { error: 'NO_FIRMWARE_LIST_ID' };
    return await local.checkDeviceConfigSync({ hardwareMappings: ${JSON.stringify(hardwareMappings)}, firmwareListId });
  })()`, 60000));
  return result;
}

/** High-level runSendConfigTask burn of a saved project (requires a sender board). */
async function runSendConfigTask(options) {
  // The task may upgrade firmware / MPY / loader before sending the config.
  requireConfirm(options, 'flash_config with hardwareMappings');
  if (options.firmwareConfig != null) {
    return { stage: 'RUN_SEND_CONFIG_TASK', error: 'FIRMWARE_CONFIG_UNSUPPORTED', hint: 'runSendConfigTask burns a saved project (firmwareListId); omit hardwareMappings to burn firmwareConfig via the file protocol.' };
  }
  return sanitize(await evaluateAsync(`(async () => {
    const fw = window.app?.useFirmwareConfigStore;
    const st = fw && (fw.getState ? fw.getState() : fw);
    const listStore = window.app?.useFirmwareListStore;
    const ls = listStore && (listStore.getState ? listStore.getState() : listStore);
    if (!st || !ls) return { stage: 'RUN_SEND_CONFIG_TASK', error: 'NO_STORES' };
    const explicitId = ${JSON.stringify(options.firmwareListId ?? null)};
    const firmwareListId = explicitId ?? st.firmwareConfig?.id ?? null;
    // Defaulting to the editor's project burns its SAVED record — refuse while
    // the editor holds changes that the burn would silently leave out.
    if (!explicitId && st.isModified) {
      return { stage: 'RUN_SEND_CONFIG_TASK', error: 'UNSAVED_CHANGES', firmwareListId,
        hint: 'project_save the editor config first, or pass firmwareListId explicitly.' };
    }
    if (!firmwareListId || !(ls.firmwareList || []).some(f => f.id === firmwareListId)) {
      return { stage: 'RUN_SEND_CONFIG_TASK', error: 'FIRMWARE_LIST_ID_NOT_FOUND', firmwareListId,
        hint: 'Pass firmwareListId of an existing project (project_list), or project_save the editor config first.' };
    }
    const local = window.app?.local;
    if (!local || typeof local.runSendConfigTask !== 'function') return { stage: 'RUN_SEND_CONFIG_TASK', error: 'NO_RUN_SEND_CONFIG' };
    return await local.runSendConfigTask({
      displayMode: 'modal',
      firmwareListId,
      hardwareMappings: ${JSON.stringify(options.hardwareMappings)},
      design: ${JSON.stringify(options.design ?? null)} ?? undefined,
      projectId: ${JSON.stringify(options.projectId ?? null)} ?? undefined,
    });
  })()`, 3000000)); // same budget as the app's own appManager:runSendConfigTask IPC (3e6) — upgrades + pairing take minutes
}

/* ------------------------------- MPY ----------------------------- */

/**
 * MicroPython firmware update via the app's updateLoaderFirmwareMpy — the ONLY
 * public entry (see docs/MPY固件链路笔记.md). The full payload needs:
 *  - checkResult: {shouldUpgradeMpy, shouldUpgradeFirmware, shouldUpgradeLoader*,
 *    upgradeMpyTo, upgradeFirmwareTo, upgradeLoaderTo, upgradeOrderSwitchable}
 *    — produced by the app's own cloud check (t4e), which MCP cannot replicate
 *    (auth headers + cert decryption are deliberately out of scope).
 *  - files: {firmware, loader} Uint8Array binaries fetched from the cloud URLs.
 *
 * mpySource='builtin_rc' (default): use the app's bundled default RC MPY. The
 * app loads it into its own Co() singleton at startup via loadMpyMap(); if that
 * has run, startMpyUpgrade can use the built-in checksum0. This path is
 * EXPERIMENTAL — the app's C4e flow normally also re-enters loader and flashes
 * firmware first; passing an all-false checkResult with shouldUpgradeMpy=true
 * skips firmware but still requires the device to be reachable.
 *
 * options:
 *   confirm (must be true), target, mpySource ('builtin_rc'), checksum0 (defaults to the app's built-in
 *   RC checksum), designId, region, userMpyConfig (for design MPY),
 *   checkResult (override), files {firmware, loader} (override)
 */
export async function updateMpy(options = {}) {
  requireConfirm(options, 'flash_mpy');
  const device = await resolveDevice(options.target);
  const result = await evaluateAsync(`(async () => {
    const local = window.app?.local;
    if (!local || typeof local.updateLoaderFirmwareMpy !== 'function') return { error: 'NO_MPY_ENTRY' };
    const store = window.app.deviceListStore;
    const dev = (store.deviceList || []).find(d => d.deviceId === ${JSON.stringify(device.deviceId)});
    if (!dev) return { error: 'DEVICE_NOT_FOUND', deviceId: ${JSON.stringify(device.deviceId)} };

    const checkResult = ${JSON.stringify(options.checkResult ?? null)} ?? {
      shouldUpgradeLoaderBeforeFirmware: false,
      shouldUpgradeFirmware: false,
      shouldUpgradeLoaderAfterFirmware: false,
      shouldUpgradeMpy: true,
      upgradeLoaderTo: '',
      upgradeFirmwareTo: '',
      upgradeMpyTo: ${JSON.stringify(options.checksum0 ?? '')},
      upgradeOrderSwitchable: false,
    };
    const payload = {
      deviceId: dev.deviceId,
      currentBoardIndex: 0,
      mpyType: ${JSON.stringify(options.mpyType ?? 1)}, // Rn.cb_rc = 1 (built-in)
      designId: ${JSON.stringify(options.designId ?? '')},
      region: ${JSON.stringify(options.region ?? 'xx')},
      userMpyConfig: ${JSON.stringify(options.userMpyConfig ?? null)} ?? undefined,
      files: { firmware: new Uint8Array(0), loader: new Uint8Array(0) },
      checkResult,
      eraseFirmwareConfig: ${JSON.stringify(options.eraseFirmwareConfig ?? false)},
    };
    return await local.updateLoaderFirmwareMpy(payload);
  })()`, 120000);
  return sanitize({ device, result });
}

/* ----------------------------- FIRMWARE --------------------------- */

/**
 * Full system firmware flash. Same entry as MPY (updateLoaderFirmwareMpy) but
 * with checkResult.shouldUpgradeFirmware=true — the app then enters loader,
 * fetches/downloads the firmware binary, flashes (SYSTEM_UPGRADE), reboots.
 * files.firmware must be the real binary; without the app's cloud check MCP
 * cannot fetch it, so the caller MUST supply either:
 *   - options.firmwareBinaryB64: base64 of the firmware .bin (host-side read),
 *   - or options.firmwareInfo/downloadUrl resolution done externally.
 * DESTRUCTIVE: multiple reboots, can brick if interrupted. Requires
 * options.confirm === true.
 */
export async function upgradeFirmware(options = {}) {
  requireConfirm(options, 'flash_firmware');
  const device = await resolveDevice(options.target);
  const result = await evaluateAsync(`(async () => {
    const local = window.app?.local;
    if (!local || typeof local.updateLoaderFirmwareMpy !== 'function') return { error: 'NO_FIRMWARE_ENTRY' };
    const store = window.app.deviceListStore;
    const dev = (store.deviceList || []).find(d => d.deviceId === ${JSON.stringify(device.deviceId)});
    if (!dev) return { error: 'DEVICE_NOT_FOUND', deviceId: ${JSON.stringify(device.deviceId)} };

    const b64 = ${JSON.stringify(options.firmwareBinaryB64 ?? null)};
    const bytes = b64 ? Uint8Array.from(atob(b64), c => c.charCodeAt(0)) : new Uint8Array(0);
    if (!b64) return { error: 'FIRMWARE_BINARY_REQUIRED', hint: 'Pass firmwareBinaryB64 (the .bin from the app package or a local build). The app fetches its own copies only via its cloud check, which this tool does not replicate.' };

    const checkResult = ${JSON.stringify(options.checkResult ?? null)} ?? {
      shouldUpgradeLoaderBeforeFirmware: false,
      shouldUpgradeFirmware: true,
      shouldUpgradeLoaderAfterFirmware: false,
      shouldUpgradeMpy: false,
      upgradeLoaderTo: '',
      upgradeFirmwareTo: ${JSON.stringify(options.targetVersion ?? '')},
      upgradeMpyTo: '',
      upgradeOrderSwitchable: false,
    };
    return await local.updateLoaderFirmwareMpy({
      deviceId: dev.deviceId,
      currentBoardIndex: 0,
      mpyType: 1, // Rn.cb_rc
      designId: '0',
      region: ${JSON.stringify(options.region ?? 'xx')},
      files: { firmware: bytes, loader: new Uint8Array(0) },
      checkResult,
      eraseFirmwareConfig: false,
    });
  })()`, 180000);
  return sanitize({ device, result });
}

/* ------------------------------- TEST ----------------------------- */

/** Send a control/test command to a connected device via the app's sendTestCommand. */
export async function sendTest(options = {}) {
  const command = options.command;
  if (!command || typeof command !== 'object' || Array.isArray(command)) {
    throw new Error('command must be an object (the sendTestCommand payload: config, actuator, set_value, receiver, data).');
  }
  const device = await resolveDevice(options.target);
  // The app's sendTestCommand expects {deviceId, config, actuator, set_value,
  // receiver, data} (see l4e in the bundle) — deviceId is the store deviceId
  // and always comes from the resolved target, never from the payload.
  const result = await evaluateAsync(`(async () => {
    const local = window.app?.local;
    if (!local || typeof local.sendTestCommand !== 'function') return { error: 'NO_TEST_ENTRY' };
    return await local.sendTestCommand({
      ...${JSON.stringify(command)},
      deviceId: ${JSON.stringify(device.deviceId)},
    });
  })()`);
  return sanitize({ device, result });
}
