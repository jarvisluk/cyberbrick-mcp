/**
 * Reconnect the CyberBrick device: run the add-device flow (chooser
 * auto-select) and either refresh the existing deviceList entry or add a new
 * one. Used because BLE connections drop when the board sleeps / the app's
 * pool entry is cleaned up. Mirrors connect_bluetooth exactly.
 */
import { connect, disconnect, evaluateAsync } from '../src/connection.js';

export async function reconnectDevice({ timeoutMs = 12000 } = {}) {
  await connect();
  return evaluateAsync(`(async () => {
    const Ie = window.app.bluetoothDeviceManager;
    const ipc = window.electron.ipcRenderer;
    const offFound = ipc.on('bluetooth-devices-found', (devices) => {
      try { const pick = (devices||[])[0]; if (pick && pick.deviceId) ipc.selectBluetoothDevice(pick.deviceId); } catch (e) {}
    });
    const timer = setTimeout(() => { try { ipc.selectBluetoothDeviceCancel(); } catch (e) {} }, ${Number(timeoutMs)});
    try {
      const { promise } = Ie.requestDevice({ acceptAllDevices:false, optionalServices:['da16af4a-4ad3-4a9e-b871-79f2750f04d9','00001800-0000-1000-8000-00805f9b34fb'], filters:[{manufacturerData:[{companyIdentifier:17882,dataPrefix:new Uint8Array([99])}]}] });
      const device = await promise;
      if (!device) return { selected: null, reason: 'CHOOSER_CANCELLED' };
      const store = window.app.deviceListStore;
      const deviceId = await ipc.invoke('bluetooth-device:name-to-id', device.name);
      const existing = store.deviceList.find(d => d.deviceId === deviceId);
      if (existing) {
        Ie.addBluetoothDeviceToPool(deviceId, device);
        if (typeof store.setBluetoothDevice === 'function') store.setBluetoothDevice(deviceId, device);
        if (typeof store.updateDeviceConnectStatus === 'function') store.updateDeviceConnectStatus(deviceId, 'connected');
        existing.bluetoothDevice = device;
        existing.bluetoothDeviceId = device.id;
        existing.deviceConnectStatus = 'connected';
        return { reconnected: true, deviceId, name: device.name, btid: device.id };
      }
      const l = window.app.local;
      const boardInfo = await l.sendGetMessage({ command: 11, payload: {}, bluetoothDeviceId: device.id, timeout: 8000 }).catch(e => ({ error: String(e).slice(0,60) }));
      const boardType = await l.sendGetMessage({ command: 16, payload: {}, bluetoothDeviceId: device.id, timeout: 8000 }).catch(e => ({ error: String(e).slice(0,60) }));
      const sysVersion = await l.sendGetMessage({ command: 259, payload: { submodule: 1 }, bluetoothDeviceId: device.id, timeout: 8000 }).catch(e => ({ error: String(e).slice(0,60) }));
      const record = {
        serialNumber: boardInfo?.sn_code ?? null,
        firmwareVersion: Array.isArray(sysVersion?.version) ? sysVersion.version.join('.') : null,
        loaderVersion: Array.isArray(sysVersion?.loader_version) ? sysVersion.loader_version.join('.') : null,
        devicePinCode: '', snCode: boardInfo?.sn_code ?? null,
        deviceName: device.name || 'N5 core board',
        deviceId, bluetoothDevice: device, bluetoothDeviceId: device.id,
        deviceType: boardType?.board_type === 1 ? 'receiver' : 'sender',
        deviceConnectStatus: 'connected', pinCodeEnabled: false,
        mpyType: null, mpyProtected: false, region: 'no region',
        design_id: 'no_design_id', design_name: '', checksum0_orig: null,
        hasBoardConfigFile: false,
      };
      store.addDevice(record);
      return { added: true, deviceId, name: record.deviceName, btid: device.id, fw: record.firmwareVersion };
    } finally { clearTimeout(timer); try { offFound(); } catch(e){} }
  })()`);
}

// CLI: node scripts/reconnect.mjs
if (import.meta.url === `file://${process.argv[1]}`) {
  const r = await reconnectDevice().catch(e => ({ error: e.message }));
  console.log(JSON.stringify(r, null, 2));
  await disconnect();
  process.exit(0);
}
