/**
 * Connection discovery: enumerate what is physically connectable now (serial
 * ports / BLE devices) and the devices the app already knows.
 *
 * All functions here are READ-ONLY — they never pair, bind, or flash. The actual
 * connect actions live in tools/connect.js.
 */
import { evaluateAsync, sanitize } from '../connection.js';

/** Enumerate Web Serial ports and BLE devices currently available to the app. */
export async function scanPorts() {
  const raw = await evaluateAsync(`(async () => {
    const out = { serial: { available: false, ports: [] }, bluetooth: { available: false, devices: [] }, webApiSupport: {} };
    try { out.webApiSupport.serialInNavigator = ('serial' in navigator); } catch (e) { out.webApiSupport.serialInNavigator = 'error'; }
    try { out.webApiSupport.bluetoothInNavigator = ('bluetooth' in navigator); } catch (e) { out.webApiSupport.bluetoothInNavigator = 'error'; }

    // Web Serial: enumerate already-authorized ports read-only via the Web Serial
    // API. We intentionally do NOT call autoSelectSerialPort (its strategies are
    // 'first' | 'new' and it opens a chooser / performs a selection) — that is the
    // job of connect_serial. getPorts() is non-interactive and returns the ports the
    // user has already granted the app (verified live: 11 ports on the test host).
    try {
      if ('serial' in navigator && typeof navigator.serial.getPorts === 'function') {
        const ports = await navigator.serial.getPorts();
        out.serial.available = true;
        out.serial.ports = (ports || []).map((p, i) => ({
          index: i,
          // Browsers do not expose vendorId/productId on the port object for
          // privacy; we only report that a port exists and is authorized.
          authorized: true,
        }));
        out.serial.count = out.serial.ports.length;
      } else {
        out.serial.available = false;
        out.serial.error = 'Web Serial API unavailable in this renderer';
      }
    } catch (e) {
      out.serial.available = false;
      out.serial.error = String(e && e.message || e);
    }

    // Web Bluetooth: enumerate already-paired/known browser devices.
    try {
      const devs = await navigator.bluetooth.getDevices();
      out.bluetooth.available = true;
      out.bluetooth.devices = (devs || []).map(d => ({ id: d.id, name: d.name || null, gattConnected: d.gatt ? d.gatt.connected : null }));
    } catch (e) {
      out.bluetooth.available = false;
      out.bluetooth.error = String(e && e.message || e);
    }
    return out;
  })()`);
  return sanitize(raw);
}

/** List B0-known devices from the app device list (paired/known receivers). */
export async function knownDevices() {
  const raw = await evaluateAsync(`(async () => {
    const s = window.app?.deviceListStore;
    if (!s) return { error: 'NO_APP_MANAGER' };
    const list = s.deviceList || [];
    return list.map((d, i) => ({
      index: i,
      bluetoothDeviceId: d.bluetoothDeviceId || d.bluetoothDevice?.id || null,
      deviceName: d.deviceName || d.name || null,
      mac: d.mac || d.bluetoothDevice?.mac || null,
      connectStatus: d.deviceConnectStatus ?? d.connectStatus ?? null,
      isBound: d.isBound ?? null,
    }));
  })()`);
  return sanitize(raw);
}
