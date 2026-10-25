// Capture the primary CyberBrick window via CDP: node scripts/screenshot.mjs <out.png>
import { writeFileSync } from 'node:fs';
import { getClient, disconnect } from '../src/connection.js';

const out = process.argv[2] || 'cyberbrick.png';
const client = await getClient();
const { data } = await client.Page.captureScreenshot({ format: 'png' });
writeFileSync(out, Buffer.from(data, 'base64'));
console.log(out);
await disconnect();
