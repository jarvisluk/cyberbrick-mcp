#!/usr/bin/env node
/**
 * Local smoke test against the running CyberBrick app (CDP 127.0.0.1:9223).
 * Verifies connection.js + a direct device_list/health value fetch, without
 * starting the MCP stdio loop.
 */
import { endpointReachable, evaluate, evaluateAsync, disconnect } from '../src/connection.js';
import { healthCheck } from '../src/core/health.js';
import { listDevices } from '../src/core/devices.js';

const fail = (msg) => { console.error('SMOKE_FAIL:', msg); process.exit(1); };

const version = await endpointReachable();
if (!version) fail('CDP endpoint unreachable on 127.0.0.1:9223 — is the app running?');
console.log('✔ endpoint live:', version.Browser, version['User-Agent']);

const health = await healthCheck();
console.log('✔ health:', JSON.stringify(health, null, 2));
if (!health.hasBridge) fail('window.electron not reachable from main world');

const devices = await listDevices();
console.log('✔ device list:', JSON.stringify(devices, null, 2));

const storeKeys = await evaluate(`Object.keys(window.app.deviceListStore).length`);
console.log(`✔ store actions available: ${storeKeys}`);

const pool = await evaluateAsync(
  `window.app.connectionPoolManager ? 'pool-ready' : 'pool-missing'`
);
console.log('✔ pool:', pool);

// Real-device path (when at least one device is connected)
if (devices?.deviceCount > 0) {
  const btid = devices.devices[0].bluetoothDeviceId;
  const { boardInfo, adcStatus, deviceConfigFileInfo } = await import('../src/core/devices.js');
  console.log('✔ board_info:', JSON.stringify(await boardInfo(btid), null, 2));
  console.log('✔ device_status:', JSON.stringify(await adcStatus(btid), null, 2));
  console.log('✔ device_config_get:', JSON.stringify(await deviceConfigFileInfo(btid), null, 2));
}

await disconnect();
console.log('SMOKE_OK');
