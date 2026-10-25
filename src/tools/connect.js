import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { sanitize, evaluateAsync } from '../connection.js';
import { scanPorts, knownDevices } from '../core/connection_plan.js';
import { connectedChipMacs } from '../core/devices.js';

// Post-selection B0 probe: isInLoader + 4 sendGetMessage calls, each bounded by
// PROBE_STEP_TIMEOUT_MS, plus GATT connect / name-to-id slack. The CDP evaluate
// must outlive chooser timeout + probe, or the tool reports a timeout while the
// renderer is still adding the device.
const PROBE_STEP_TIMEOUT_MS = 8000;
const PROBE_BUDGET_MS = 5 * PROBE_STEP_TIMEOUT_MS + 20000;

export function registerConnectTools(server) {
  server.registerTool(
    'connect_scan_ports',
    {
      title: 'Scan connectable ports',
      description: 'Enumerate Web Serial ports and Web Bluetooth devices currently available to the CyberBrick app. Read-only — does not pair or connect. Use this to tell the user what hardware can be connected right now.',
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      inputSchema: {
        includeKnownDevices: z.boolean().default(true).describe('Also list B0-known (paired/known) receivers from the app device list.'),
      },
    },
    async ({ includeKnownDevices }) => {
      try {
        const ports = await scanPorts();
        const known = includeKnownDevices ? await knownDevices().catch(() => null) : null;
        return { content: [{ type: 'text', text: JSON.stringify(sanitize({ ports, knownDevices: known }), null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: `ERROR: ${err.message}` }], isError: true };
      }
    },
  );

  server.registerTool(
    'connect_bluetooth',
    {
      title: 'Add device via Bluetooth',
      description: 'Drive the app\'s real add-device flow (BluetoothDeviceManager.requestDevice — the same one the MyDeviceDialog UI uses): starts a BLE scan filtered to CyberBrick devices (companyIdentifier 17882, manufacturer data prefix [99]), then auto-selects the matching device so the chooser resolves without UI. After it resolves, the app marks the device and the caller can verify with device_list. MUTATING (pairs a device).',
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      inputSchema: {
        deviceName: z.string().optional().describe('Prefer a device whose advertised name matches this substring (case-insensitive). If omitted, the first discovered CyberBrick device is selected.'),
        deviceId: z.string().optional().describe('Select the board with this deviceId (from device_list; on macOS a Chromium pseudo-address, not the chip MAC). Takes precedence over deviceName — use it for boards that share a name or were renamed (paired boards advertise as CyberBrick-[NNNN]).'),
        timeoutMs: z.number().int().positive().max(60000).default(15000).describe('How long to wait for the chooser to resolve before cancelling. The B0 probe after selection has its own budget.'),
      },
    },
    async ({ deviceName, deviceId: wantDeviceId, timeoutMs }) => {
      try {
        // Real add-device pass-through, mirroring the app's MyDeviceDialog +
        // BluetoothDeviceManager.requestDeviceForPrimaryWindow flow, collapsed
        // into one renderer-side script (no UI):
        //   1. subscribe to 'bluetooth-devices-found' (main process broadcasts
        //      every chooser batch with the resolver pending)
        //   2. start bluetoothDeviceManager.requestDevice(...) with the app's
        //      own CyberBrick filter (companyIdentifier 17882, prefix [99])
        //   3. pick a candidate (name match, else first) and resolve the
        //      chooser via ipcRenderer.selectBluetoothDevice(deviceId)
        //   4. await the requestDevice promise, clean up listeners
        const result = await evaluateAsync(`(async () => {
          const Ie = window.app?.bluetoothDeviceManager;
          if (!Ie || typeof Ie.requestDevice !== 'function') return { error: 'NO_REQUEST_DEVICE' };
          const ipc = window.electron.ipcRenderer;
          const timeoutMs = ${Number(timeoutMs || 15000)};
          const want = ${JSON.stringify((deviceName || '').toLowerCase())};
          const wantMac = ${JSON.stringify((wantDeviceId || '').toUpperCase())};

          // A board with a live GATT link stops advertising, so scanning for it
          // would only time out — report the existing connection instead. Only
          // for a named board: without a name the scan is how a new board gets
          // added, and connected boards don't advertise so they can't be picked.
          // Boards share advertised names (every RC board is RC_MODULE), so only
          // short-circuit when no known board of that name is offline.
          const named = wantMac
            ? (window.app.deviceListStore?.deviceList || []).filter(d => String(d.deviceId).toUpperCase() === wantMac)
            : want ? (window.app.deviceListStore?.deviceList || []).filter(d =>
              String(d.deviceName || '').toLowerCase().includes(want) || String(d.bluetoothDevice?.name || '').toLowerCase().includes(want)) : [];
          const live = named.length && named.every(d => d.bluetoothDevice?.gatt?.connected) && named[0];
          if (live) return { alreadyConnected: true, deviceId: live.deviceId, name: live.deviceName, bluetoothDeviceId: live.bluetoothDeviceId };

          // A chooser left pending by an earlier, aborted call (e.g. the MCP
          // client was killed mid-scan) blocks every new requestDevice and the
          // follow-up GATT connects then race into RECONNECTION_INTERRUPTED.
          try { ipc.selectBluetoothDeviceCancel(); } catch (e) {}
          await new Promise(r => setTimeout(r, 500));

          // The store keeps the name a board had when added, but a board can
          // re-advertise under another one (after pairing: CyberBrick-[NNNN]), so
          // a deviceId target is matched on the chooser's own deviceId. (On macOS
          // that id is Chromium's pseudo-address, not the chip MAC; the app's
          // name→id map is keyed by advertised name and collides on shared names.)
          let picked = false;
          const offFound = ipc.on('bluetooth-devices-found', (devices) => {
            try {
              if (picked) return;
              const list = Array.isArray(devices) ? devices : [];
              let pick = null;
              if (wantMac) {
                pick = list.find(d => String(d.deviceId || '').toUpperCase() === wantMac);
              } else {
                pick = want ? list.find(d => String(d.deviceName || '').toLowerCase().includes(want)) : list[0];
              }
              if (pick && pick.deviceId && !picked) { picked = true; ipc.selectBluetoothDevice(pick.deviceId); }
            } catch (e) {}
          });

          const timer = setTimeout(() => { try { ipc.selectBluetoothDeviceCancel(); } catch (e) {} }, timeoutMs);
          try {
            const { promise } = Ie.requestDevice({
              acceptAllDevices: false,
              optionalServices: ['da16af4a-4ad3-4a9e-b871-79f2750f04d9', '00001800-0000-1000-8000-00805f9b34fb'],
              filters: [{ manufacturerData: [{ companyIdentifier: 17882, dataPrefix: new Uint8Array([99]) }] }],
            });
            const device = await promise;
            // Chooser resolved — its cancel timer must not fire during the probe.
            clearTimeout(timer);
            if (!device) return { selected: null, hint: 'CHOOSER_CANCELLED' };
            // Every app path calls markBluetoothDevice right after requestDevice: it
            // sets connectionCount=0. Without it the first connect does undefined++
            // → NaN, and createGeneralServiceWithRetry's interruption check
            // (a !== t.connectionCount) is then always true — every later
            // reconnect (enterLoader, BLE drop) fails at once with
            // RECONNECTION_INTERRUPTED.
            Ie.markBluetoothDevice(device);

            // Mirror the app's MyDeviceDialog.U(): pool the device, probe it over
            // B0 (isInLoader, GET_BOARD_INFO, MPY_PROJECT_INFO/GET_DEVICE_CONFIG,
            // GET_BOARD_TYPE, SYSTEM_VERSION), build the device record and call
            // deviceListStore.addDevice — the same steps the UI performs.
            const probe = await (async () => {
              const local = window.app.local;
              const btid = device.id;
              // NOTE: window.app.deviceListStore is the state object itself
              // (probed live: deviceList/addDevice sit directly on it), not a
              // zustand setter with getState().
              const store = window.app.deviceListStore;
              if (!store || !Array.isArray(store.deviceList)) return { error: 'NO_DEVICE_STORE' };
              // The main process maps the advertised device name to its MAC deviceId.
              const deviceId = device.name
                ? await ipc.invoke('bluetooth-device:name-to-id', device.name)
                : null;
              if (!deviceId) return { error: 'NAME_TO_ID_FAILED', name: device.name };

              // Known device (dropped BLE link / app restart): re-pool it and point
              // the record at the fresh bluetoothDeviceId, else every device call
              // keeps hitting the stale id and the pool stays empty.
              const existing = store.deviceList.find(d => d.deviceId === deviceId);
              if (existing) {
                Ie.addBluetoothDeviceToPool(deviceId, device);
                // setBluetoothDevice is keyed by MAC; updateDeviceConnectStatus by bluetoothDevice.id.
                store.setBluetoothDevice(deviceId, device);
                store.updateDeviceConnectStatus(device.id, 'connected');
                return { alreadyAdded: true, reconnected: true, deviceId, name: device.name, bluetoothDeviceId: device.id };
              }

              Ie.addBluetoothDeviceToPool(deviceId, device);

              const probeTimeout = ${PROBE_STEP_TIMEOUT_MS};
              const inLoader = await local.isInLoader({ bluetoothDeviceId: btid }).catch(() => undefined);
              const boardInfo = await local.sendGetMessage({ command: 11, payload: {}, bluetoothDeviceId: btid, timeout: probeTimeout }).catch(e => ({ error: String(e) }));
              const boardType = await local.sendGetMessage({ command: 16, payload: {}, bluetoothDeviceId: btid, timeout: probeTimeout }).catch(e => ({ error: String(e) }));
              const sysVersion = await local.sendGetMessage({ command: 259, payload: { submodule: 1 }, bluetoothDeviceId: btid, timeout: probeTimeout }).catch(e => ({ error: String(e) }));
              const mpyInfo = await local.sendGetMessage({ command: 21, payload: {}, bluetoothDeviceId: btid, timeout: probeTimeout }).catch(e => ({ error: String(e) }));

              const record = {
                serialNumber: boardInfo?.sn_code ?? null,
                firmwareVersion: Array.isArray(sysVersion?.version) ? sysVersion.version.join('.') : (sysVersion?.version ?? null),
                loaderVersion: Array.isArray(sysVersion?.loader_version) ? sysVersion.loader_version.join('.') : null,
                devicePinCode: '',
                snCode: boardInfo?.sn_code ?? null,
                deviceName: device.name || 'N5 core board',
                deviceId,
                bluetoothDevice: device,
                bluetoothDeviceId: btid,
                deviceType: boardType?.board_type === 1 ? 'receiver' : 'sender',
                deviceConnectStatus: 'connected',
                pinCodeEnabled: false,
                mpyType: mpyInfo?.project_type ?? null,
                mpyProtected: (mpyInfo?.protected_en ?? 0) > 0,
                region: mpyInfo?.region || 'no region',
                design_id: mpyInfo?.design_id || 'no_design_id',
                design_name: mpyInfo?.design_name || '',
                checksum0_orig: mpyInfo?.checksum0_orig ?? null,
                hasBoardConfigFile: (mpyInfo?.file_size ?? 0) > 0,
              };
              store.addDevice(record);
              return { added: true, deviceId, name: record.deviceName, deviceType: record.deviceType, firmwareVersion: record.firmwareVersion };
            })();

            return { selected: { id: device.id, name: device.name || null }, ...probe };
          } catch (e) {
            const message = String(e && e.message || e);
            return /cancelled/i.test(message)
              ? { error: 'CHOOSER_CANCELLED', message, hint: 'No matching board advertised within timeoutMs — is it powered on? Paired boards advertise as CyberBrick-[NNNN]: pass deviceId (from device_list) instead of deviceName.' }
              : { error: 'REQUEST_DEVICE_FAILED', message };
          } finally {
            clearTimeout(timer);
            try { offFound && offFound(); } catch (e) {}
          }
        })()`, timeoutMs + PROBE_BUDGET_MS);
        return { content: [{ type: 'text', text: JSON.stringify(sanitize(result), null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: `ERROR: ${err.message}` }], isError: true };
      }
    },
  );

  server.registerTool(
    'connect_serial',
    {
      title: 'Select USB/Serial port',
      description: 'Ask the app\'s main process to auto-select a Web Serial (USB-C) port (window.electron.ipcRenderer.autoSelectSerialPort, strategy "first") and return its metadata plus the BLE-connected board it belongs to (USB serial number = chip MAC, matched against each board\'s GET_DEVICE_WIFI_MAC). In this app the serial link only serves the USB flash (rescue flasher) feature — config, pairing, upgrades and every other device tool go over Bluetooth, so this does not make a board usable by the other tools. Opens nothing on the board.',
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      inputSchema: {},
    },
    async () => {
      try {
        const result = await evaluateAsync(`(async () => {
          const ipc = window.electron?.ipcRenderer;
          if (!ipc || typeof ipc.autoSelectSerialPort !== 'function') return { error: 'NO_AUTO_SELECT_SERIAL_PORT' };
          const port = await ipc.autoSelectSerialPort({ strategy: 'first', currentPortId: null });
          return port ? { selected: port } : { selected: null, hint: 'No serial port available — is the board plugged in over USB-C?' };
        })()`);
        // An ESP32's USB serial number is its chip MAC; match it against the
        // chip MAC the BLE-connected boards report to tell which board this is.
        if (result?.selected?.serialNumber) {
          const sn = String(result.selected.serialNumber).toUpperCase();
          const boards = await connectedChipMacs().catch(() => []);
          const hit = boards.find(b => b.chipMac === sn);
          result.board = hit
            ? { deviceId: hit.deviceId, deviceName: hit.deviceName, deviceType: hit.deviceType, bluetoothDeviceId: hit.bluetoothDeviceId }
            : null;
          if (!hit) result.boardHint = `No BLE-connected board reports chip MAC ${sn} (checked ${boards.length}); connect it with connect_bluetooth first.`;
        }
        return { content: [{ type: 'text', text: JSON.stringify(sanitize(result), null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: `ERROR: ${err.message}` }], isError: true };
      }
    },
  );
}
