import { connect, disconnect, evaluate } from '../src/connection.js';
import { listDevices, boardInfo, adcStatus, deviceConfigFileInfo } from '../src/core/devices.js';

await connect();
console.error('attached primary:', await evaluate('window.env.isPrimary'));
const list = await listDevices();
console.log('deviceCount:', list.deviceCount, JSON.stringify(list.devices.map(d => d.deviceName)));
if (list.deviceCount) {
  const d = list.devices[0];
  console.log('--- board_info ---');
  console.log(JSON.stringify((await boardInfo(d.bluetoothDeviceId)).parsed));
  console.log('--- adc ---');
  console.log(JSON.stringify(await adcStatus(d.bluetoothDeviceId)));
  console.log('--- board config ---');
  console.log(JSON.stringify(await deviceConfigFileInfo(d.bluetoothDeviceId)));
}
await disconnect();
process.exit(0);
