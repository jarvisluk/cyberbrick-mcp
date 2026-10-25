import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const transport = new StdioClientTransport({ command: 'node', args: ['src/server.js'], cwd: process.cwd() });
const client = new Client({ name: 'e2e', version: '1.0.0' });
await client.connect(transport);

async function call(name, args = {}) {
  const r = await client.callTool({ name, arguments: args });
  return r.content?.[0]?.text ?? JSON.stringify(r);
}

console.log('--- connect_scan_ports ---');
console.log((await call('connect_scan_ports', {})).slice(0, 400));
console.log('\n--- firmware_config_get (keys) ---');
const cfg = await call('firmware_config_get');
try {
  const o = JSON.parse(cfg);
  console.log('version:', o.firmwareConfig?.version, '| configType:', o.configType, '| senderChannels:', o.firmwareConfig?.sender?.channels?.length);
} catch { console.log(cfg.slice(0,200)); }
console.log('\n--- firmware_edit_actions (count) ---');
const acts = await call('firmware_edit_actions');
try { const o = JSON.parse(acts); console.log(Array.isArray(o) ? o.length + ' actions' : acts.slice(0,200)); } catch { console.log(acts.slice(0,200)); }

await client.close();
