// Smoke-test the new project tools against the running app (read-only parts + roundtrip with a temp project).
import { connect, disconnect } from '../src/connection.js';
import {
  getProjectState, listProjects, getProject,
  createProjectFromTemplate, renameProject, exportProjectContent,
  importProjectFromContent, deleteProject,
  loadProjectToEditor, saveProjectFromEditor,
} from '../src/core/project.js';

await connect();

console.log('=== project_state ===');
const state = await getProjectState();
console.log(JSON.stringify({ hash: state.hash, page: state.page, projectCount: state.projectCount, editor: state.editor, nextTools: state.nextTools }, null, 1));

console.log('\n=== project_list ===');
const { projects } = await listProjects();
console.log(JSON.stringify(projects, null, 1));

console.log('\n=== create from template (forklift, temp name) ===');
const created = await createProjectFromTemplate('forklift', 'MCP冒烟-可删');
console.log(JSON.stringify(created));

const newId = created?.configId;

console.log('\n=== rename ===');
await renameProject(newId, 'MCP冒烟-改名');
const afterRename = await getProject(newId);
console.log('name now:', afterRename?.config_name);

console.log('\n=== export content ===');
const json = await exportProjectContent(newId);
console.log('bytes:', json.length, 'version:', JSON.parse(json).version, 'name:', JSON.parse(json).config_name);

console.log('\n=== import roundtrip ===');
const imported = await importProjectFromContent(json, 'MCP冒烟-导入');
console.log(JSON.stringify(imported));
const importedId = imported?.configId;

console.log('\n=== load to editor ===');
console.log(JSON.stringify(await loadProjectToEditor(newId)));

console.log('\n=== save from editor ===');
console.log(JSON.stringify(await saveProjectFromEditor()));

console.log('\n=== delete temp projects (cleanup) ===');
console.log('delete imported:', JSON.stringify(await deleteProject(importedId)));
console.log('delete created :', JSON.stringify(await deleteProject(newId)));

const { projects: final } = await listProjects();
console.log('\nfinal count:', final.length, final.map(p => p.configName).join(' | '));

await disconnect();
