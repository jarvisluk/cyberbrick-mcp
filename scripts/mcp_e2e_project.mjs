// MCP-level E2E for the project-management tools (creates and deletes its own temp project).
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const transport = new StdioClientTransport({ command: 'node', args: ['src/server.js'], cwd: process.cwd() });
const client = new Client({ name: 'e2e-project', version: '1.0.0' });
await client.connect(transport);

async function call(name, args = {}) {
  const r = await client.callTool({ name, arguments: args });
  const text = r.content?.[0]?.text ?? JSON.stringify(r);
  try { return JSON.parse(text); } catch { return { __text: text }; }
}

console.log('--- project_state ---');
const st = await call('project_state');
console.log(JSON.stringify({ page: st.page, hash: st.hash, projectCount: st.projectCount, nextTools: st.nextTools?.length }));

console.log('\n--- project_create (custom) ---');
const created = await call('project_create', { template: 'custom', name: 'MCP-e2e-可删' });
console.log(JSON.stringify(created));
const id = created.configId;

console.log('\n--- project_rename ---');
console.log(JSON.stringify(await call('project_rename', { id, name: 'MCP-e2e-改名' })));

console.log('\n--- project_export ---');
const exRaw = await client.callTool({ name: 'project_export', arguments: { id } });
const json = exRaw.content[0].text;
console.log('bytes:', json.length, '| parsed config_name:', JSON.parse(json).config_name);

console.log('\n--- project_import (roundtrip) ---');
const imported = await call('project_import', { content: json, name: 'MCP-e2e-导入' });
console.log(JSON.stringify(imported));

console.log('\n--- project_load + firmware edit via docs + project_save ---');
console.log(JSON.stringify(await call('project_load', { id })));
const doc = await call('firmware_edit_actions', { action: 'updateReceiverChannel' });
console.log('doc:', JSON.stringify(doc));
console.log(JSON.stringify(await call('firmware_config_edit', { action: 'updateReceiverChannel', args: ['receiver_1', 'LED1', { en: false, name: 'LED1', data: [] }] })));
console.log(JSON.stringify(await call('project_save')));

console.log('\n--- project_delete (both temp projects) ---');
console.log(JSON.stringify(await call('project_delete', { id })));
console.log(JSON.stringify(await call('project_delete', { id: imported.configId })));

const st2 = await call('project_state');
console.log('\nfinal projectCount:', st2.projectCount, '(expect original count:', st.projectCount + ')');

await client.close();
