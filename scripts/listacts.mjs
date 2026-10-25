import { connect, disconnect } from '../src/connection.js';
await connect();
const acts = await (await import('../src/core/firmware.js')).listEditingActions();
console.log(acts.sort().join('\n'));
await disconnect();
