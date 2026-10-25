// E2E: doc-driven firmware edit loop on the live app (load project → edit by doc → verify → restore).
import { connect, disconnect, evaluateAsync } from '../src/connection.js';
import { getActionCatalog } from '../src/core/firmware.js';
import { listProjects, loadProjectToEditor, saveProjectFromEditor } from '../src/core/project.js';

await connect();

// 1. catalog sanity: every documented action exists on the live store
const live = await evaluateAsync(`(function(){
  const st = window.app.useFirmwareConfigStore.getState();
  return Object.keys(st).filter(k => typeof st[k] === 'function');
})()`, 10000);
const cat = getActionCatalog();
const documented = Object.keys(cat.actions);
const missing = documented.filter(a => !live.includes(a));
const extra = live.filter(a => !documented.includes(a));
console.log('documented:', documented.length, '| live:', live.length);
console.log('documented but not on store:', missing);
console.log('on store but not documented:', extra);

// 2. doc-driven edit: load 叉车 (forklift project), read a receiver channel via doc'd getter,
//    edit it via doc'd setter, then restore original and save.
const { projects } = await listProjects();
const target = projects.find(p => p.configName === '叉车');
await loadProjectToEditor(target.configId);

const before = await evaluateAsync(
  `window.app.useFirmwareConfigStore.getState().getReceiverChannel('receiver_1', 'LED1')`, 10000);
console.log('\nLED1 before:', JSON.stringify(before));

// doc: updateReceiverChannel(receiverKey, actuator, setting)
await evaluateAsync(
  `window.app.useFirmwareConfigStore.getState().updateReceiverChannel('receiver_1', 'LED1', { en: true })`, 10000);
const mid = await evaluateAsync(
  `window.app.useFirmwareConfigStore.getState().getReceiverChannelEn('receiver_1', 'LED1')`, 10000);
console.log('LED1 en after edit:', mid);

// restore + save (the app's own updateFirmware + markAsSaved)
await evaluateAsync(
  `window.app.useFirmwareConfigStore.getState().updateReceiverChannel('receiver_1', 'LED1', ${JSON.stringify(before)})`, 10000);
const after = await evaluateAsync(
  `window.app.useFirmwareConfigStore.getState().getReceiverChannel('receiver_1', 'LED1')`, 10000);
console.log('LED1 restored equal:', JSON.stringify(after) === JSON.stringify(before));
console.log(JSON.stringify(await saveProjectFromEditor()));

await disconnect();
