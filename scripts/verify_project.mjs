/** Live verification of the project management tools (docs/设计与踩坑笔记.md §5).
 * Runs against the live app: state → list → create → rename → save →
 * export → import → load → cleanup(delete). Non-destructive: creates and
 * deletes only its own scratch project. */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const transport = new StdioClientTransport({ command: 'node', args: ['src/server.js'], cwd: process.cwd() });
const client = new Client({ name: 'project-e2e', version: '1.0.0' });
await client.connect(transport);

async function call(name, args = {}) {
  const r = await client.callTool({ name, arguments: args });
  const text = r.content?.[0]?.text ?? JSON.stringify(r);
  try { return JSON.parse(text); } catch { return text; }
}

let failures = 0;
const check = (label, cond, extra = '') => {
  console.log((cond ? '✔' : '✘ FAIL'), label, extra);
  if (!cond) failures++;
};

// 1. state
const st = await call('project_state');
check('project_state returns page', typeof st.page === 'string', `page=${st.page} projects=${st.projectCount}`);
check('project_state has nextTools', Array.isArray(st.nextTools) && st.nextTools.length > 0, st.nextTools?.join(','));

// 2. list (baseline)
const before = await call('project_list');
const baseCount = before.count ?? before.projects?.length ?? 0;
check('project_list', Array.isArray(before.projects), `count=${baseCount}`);

// 3. create from template
const scratchName = `mcp-e2e-${Date.now().toString(36)}`;
const created = await call('project_create', { template: 'custom', name: scratchName });
check('project_create', !!created.created, `id=${created.configId ?? created.id}`);
const newId = created.configId ?? created.id;

// 4. list grew
const after = await call('project_list');
check('list grew by 1', after.count === baseCount + 1, `${baseCount} -> ${after.count}`);

// 5. rename
if (newId) {
  const renamed = await call('project_rename', { id: newId, name: `${scratchName}-r` });
  check('project_rename', renamed.renamed === true);
  const lst = await call('project_list');
  const arr = Array.isArray(lst.projects) ? lst.projects : [];
  const found = arr.find(p => p.configId === newId);
  check('rename visible in list', found?.configName === `${scratchName}-r`, found?.configName);

  // 6. load into editor
  const loaded = await call('project_load', { id: newId });
  check('project_load', loaded.loaded === true, loaded.error ?? '');

  // 7. edit (firmware_config_edit on the loaded config) then save
  const edited = await call('firmware_config_edit', { action: 'updateFirmwareConfigName', args: [`${scratchName}-edited`] });
  check('firmware_config_edit (name)', !edited.error, JSON.stringify(edited).slice(0, 120));
  const saved = await call('project_save');
  check('project_save', saved.saved === true, saved.error ?? '');

  // 8. export + re-import roundtrip
  const exported = await call('project_export', { id: newId });
  // call() JSON.parses text; the export payload is a raw JSON string of the
  // project, so a successful parse yields the project object itself.
  const exportOk = exported && typeof exported === 'object' && !exported.content && (exported.config_name || exported.version);
  check('project_export content', exportOk, typeof exported === 'string' ? `${exported.length} chars` : `name=${exported?.config_name}`);
  let importOk = false;
  if (exportOk) {
    const imported = await call('project_import', { content: JSON.stringify(exported), name: `${scratchName}-copy` });
    importOk = imported.imported === true;
    check('project_import', importOk, JSON.stringify(imported).slice(0, 120));
  }

  // 9. delete scratch projects (original + imported copy)
  const finalList = await call('project_list');
  const arr2 = Array.isArray(finalList.projects) ? finalList.projects : [];
  const scratchIds = arr2.filter(p => p.configName?.startsWith(scratchName)).map(p => p.configId);
  for (const id of scratchIds) {
    const del = await call('project_delete', { id });
    check(`project_delete ${id.slice(0, 8)}`, del.deleted === true);
  }
  const final2 = await call('project_list');
  check('list restored', final2.count === baseCount, `${after.count} -> ${final2.count}`);
} else {
  failures++;
  console.log('✘ FAIL no new project id; skipping rename/load/save/export tests');
}

// 10. open_editor on a real project (loads config — non-destructive)
const lst2 = await call('project_list');
const arr3 = Array.isArray(lst2.projects) ? lst2.projects : [];
const anyProject = arr3[0];
if (anyProject) {
  const opened = await call('project_open_editor', { id: anyProject.configId, target: 'current' });
  check('project_open_editor (current)', opened.opened === true || loaded_ok(opened), JSON.stringify(opened).slice(0, 120));
}
function loaded_ok(r) { return r?.loaded?.loaded === true || r?.loaded === true; }

await client.close();
console.log(failures === 0 ? '\nALL PROJECT E2E PASSED' : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
