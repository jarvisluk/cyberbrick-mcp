// Ad-hoc MCP caller: node scripts/mcp_call.mjs <tool> '<json args>' [<tool> '<json args>' ...]
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const transport = new StdioClientTransport({ command: 'node', args: ['src/server.js'], cwd: process.cwd() });
const client = new Client({ name: 'mcp-call', version: '1.0.0' });
await client.connect(transport);
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i += 2) {
  const r = await client.callTool({ name: argv[i], arguments: JSON.parse(argv[i + 1] ?? '{}') });
  console.log(`=== ${argv[i]}${r.isError ? ' (isError)' : ''} ===\n${r.content?.[0]?.text ?? JSON.stringify(r)}`);
}
await client.close();
