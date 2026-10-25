import { connect, disconnect, evaluateAsync } from '../src/connection.js';
import { listDevices, deviceConfigFileInfo, deviceConfigFileBlock } from '../src/core/devices.js';

await connect();
const list = await listDevices();
const d = list.devices[0];
console.log('device:', d.deviceName);

// reqType 0 = FILE_INFO. Earlier live probe returned file_size=3219 — but our
// wrapper passes bluetoothDeviceId while the device answers via the pool entry.
const info = await deviceConfigFileInfo(d.bluetoothDeviceId);
console.log('info:', JSON.stringify(info));
if (info && info.file_size > 0 && !info.error) {
  const chunk = info.file_chunk_size ?? 150;
  const n = Math.ceil(info.file_size / chunk);
  const chunks = [];
  for (let i = 0; i < n; i++) {
    const b = await deviceConfigFileBlock(d.bluetoothDeviceId, i);
    if (b?.error) { console.log('block', i, 'err:', JSON.stringify(b).slice(0, 120)); break; }
    // Block data may arrive as {data:[bytes]} or raw array — normalize.
    const raw = Array.isArray(b) ? b : (b?.data ?? b?.block_data ?? b?.payload?.data ?? b);
    if (!Array.isArray(raw)) { console.log('block', i, 'unrecognized shape:', JSON.stringify(b).slice(0, 200)); break; }
    chunks.push(raw);
  }
  if (chunks.length === n) {
    const bytes = new Uint8Array(chunks.flat());
    const text = Buffer.from(bytes).toString('utf8');
    const fs = await import('fs');
    fs.writeFileSync('/tmp/board_config_baseline.json', text);
    console.log('saved', bytes.length, 'bytes; head:', text.slice(0, 150));
  } else {
    console.log('got', chunks.length, 'of', n, 'blocks');
  }
}
await disconnect();
process.exit(0);
