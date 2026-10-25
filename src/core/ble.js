/**
 * Live BLE link state — what deviceListStore's persisted fields don't show.
 *
 * The app's reconnect logic (createGeneralServiceWithRetry) snapshots
 * BluetoothDevice.connectionCount and aborts with RECONNECTION_INTERRUPTED as
 * soon as it differs. The app initializes it in markBluetoothDevice() right
 * after every requestDevice; a device obtained without that call has
 * connectionCount undefined → NaN after the first connect, and since
 * NaN !== NaN every later reconnect (enterLoader during upgrades, BLE drops)
 * fails instantly. bleState() exposes that; healBle() repairs it in place.
 */
import { evaluate } from '../connection.js';

export async function bleState() {
  return evaluate(`(() => {
    const store = window.app?.deviceListStore;
    const Ie = window.app?.bluetoothDeviceManager;
    if (!store || !Ie) return { error: 'NO_APP_MANAGER' };
    const info = Ie.bluetoothDeviceInfo || {};
    return {
      devices: store.deviceList.map(d => {
        const bd = d.bluetoothDevice;
        const cc = bd ? bd.connectionCount : undefined;
        return {
          deviceId: d.deviceId,
          deviceName: d.deviceName,
          deviceType: d.deviceType,
          bluetoothDeviceId: d.bluetoothDeviceId ?? null,
          storeStatus: d.deviceConnectStatus,
          managerStatus: info[d.deviceId]?.status ?? null,
          hasBluetoothDevice: !!bd,
          gattConnected: bd?.gatt?.connected ?? false,
          isInLoader: bd?.isInLoader ?? null,
          connectionCount: Number.isFinite(cc) ? cc : String(cc),
          connectionCountOk: !bd || Number.isFinite(cc),
          inPool: !!(Ie.getBluetoothDeviceFromPool && Ie.getBluetoothDeviceFromPool(d.deviceId)),
        };
      }),
    };
  })()`);
}

/** Reset a non-finite connectionCount to 0 on every live BluetoothDevice (no reconnect, no I/O). */
export async function healBle() {
  return evaluate(`(() => {
    const store = window.app?.deviceListStore;
    if (!store) return { error: 'NO_APP_MANAGER' };
    const healed = [];
    for (const d of store.deviceList) {
      const bd = d.bluetoothDevice;
      if (bd && !Number.isFinite(bd.connectionCount)) {
        healed.push({ deviceId: d.deviceId, was: String(bd.connectionCount) });
        bd.connectionCount = 0;
      }
    }
    return { healed, count: healed.length };
  })()`);
}
