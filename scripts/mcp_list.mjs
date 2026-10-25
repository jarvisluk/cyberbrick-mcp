import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const transport = new StdioClientTransport({
  command: 'node',
  args: ['src/server.js'],
  cwd: process.cwd(),
});
const client = new Client({ name: 'smoke', version: '1.0.0' });
await client.connect(transport);
const { tools } = await client.listTools();
console.log('TOOL COUNT:', tools.length);
for (const t of tools) {
  const ann = t.annotations || {};
  console.log(
    t.name.padEnd(34),
    'ro=' + (ann.readOnlyHint ?? '-'),
    'dh=' + (ann.destructiveHint ?? '-'),
    'id=' + (ann.idempotentHint ?? '-')
  );
}
console.log('--- instructions snippet ---');
const { instructions } = await client.getInstructions?.() ?? {};
await client.close();
