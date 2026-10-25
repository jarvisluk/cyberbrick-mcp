/** Flash the current store config to the board via the app's own file protocol
 * (SET_DEVICE_CONFIG: FILE_INFO → chunked FILE_BLOCK), then read back info.
 * MD5 computed host-side (renderer crypto.subtle has no MD5). */
import { connect, disconnect, evaluateAsync } from '../src/connection.js';
import { listDevices } from '../src/core/devices.js';
import { createHash } from 'crypto';

await connect();
const list = await listDevices();
const d = list.devices[0];
if (!d) { console.log('NO DEVICE'); process.exit(1); }
console.log('device:', d.deviceName, 'status:', d.deviceConnectStatus);

const cfgText = await evaluateAsync(`(() => {
  const fw = window.app.useFirmwareConfigStore;
  const st = fw.getState ? fw.getState() : fw;
  return JSON.stringify({ ...st.firmwareConfig, version: String(2) });
})()`);
console.log('config bytes:', cfgText.length);

const md5Hex = createHash('md5').update(Buffer.from(cfgText, 'utf8')).digest('hex');
console.log('md5:', md5Hex);

const send = await evaluateAsync(`(async () => {
  const l = window.app.local;
  const bytes = ${JSON.stringify(Array.from(Buffer.from(cfgText, 'utf8')))};
  const md5Hex = ${JSON.stringify(md5Hex)};
  const btid = ${JSON.stringify(d.bluetoothDeviceId)};
  const infoResp = await l.sendGetMessage({ command: 5, payload: { file_type: 0, cmd_type: 0, md5: md5Hex, file_size: bytes.length }, bluetoothDeviceId: btid, timeout: 8000 });
  if (!infoResp || infoResp.err_code !== 0) return { stage: 'FILE_INFO', infoResp, md5: md5Hex };
  const chunkSize = infoResp.chunk_size === 0 ? 1024 : (infoResp.chunk_size ?? 1024);
  const total = Math.ceil(bytes.length / chunkSize);
  const sent = [];
  for (let idx = 0; idx < total; idx++) {
    const block = bytes.slice(idx * chunkSize, (idx + 1) * chunkSize);
    const r = await l.sendGetMessage({ command: 5, payload: { file_type: 0, cmd_type: 1, index: idx, is_tail: idx === total - 1 ? 1 : 0, data: block }, bluetoothDeviceId: btid, timeout: 8000 });
    sent.push({ i: idx, ok: r && r.err_code === 0 });
    if (!r || r.err_code !== 0) return { stage: 'FILE_BLOCK', failedAt: idx, sent };
  }
  return { ok: true, bytes: bytes.length, chunkSize, blocks: total, md5: md5Hex };
})()`, 60000);
console.log('SEND:', JSON.stringify(send, null, 2));

const info = await evaluateAsync(`(async () => {
  const l = window.app.local;
  return await l.sendGetMessage({ command: 4, payload: { reqType: 0 }, bluetoothDeviceId: ${JSON.stringify(d.bluetoothDeviceId)}, timeout: 8000 });
})()`);
console.log('READBACK INFO:', JSON.stringify(info));

await disconnect();
process.exit(0);
