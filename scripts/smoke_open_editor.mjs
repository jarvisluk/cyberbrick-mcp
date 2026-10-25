// Verify project_open_editor: "current" (hash navigation) and "new" (createWindowWithPath).
import { connect, disconnect, evaluateAsync } from '../src/connection.js';
import { openProjectEditor, listProjects } from '../src/core/project.js';

await connect();
const { projects } = await listProjects();
const id = projects[0].configId;

console.log('=== open editor in CURRENT window ===');
console.log(JSON.stringify(await openProjectEditor(id, 'current'), null, 1));
await new Promise(r => setTimeout(r, 1200));
const hash1 = await evaluateAsync('location.hash');
console.log('hash now:', hash1);

console.log('\n=== navigate back to #/projects (same mechanism) ===');
await evaluateAsync(`history.pushState(history.state, '', '#/projects')`);
await new Promise(r => setTimeout(r, 800));
console.log('hash now:', await evaluateAsync('location.hash'));

console.log('\n=== open editor in NEW window ===');
console.log(JSON.stringify(await openProjectEditor(id, 'new'), null, 1));
await new Promise(r => setTimeout(r, 2500));
const pages = await (await fetch('http://127.0.0.1:9223/json/list')).json();
console.log('open pages:', pages.filter(p => p.type === 'page').map(p => ({
  url: p.url.slice(-60), title: p.title,
})));

await disconnect();
