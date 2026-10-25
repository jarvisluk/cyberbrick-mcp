import { connect, disconnect, evaluate, evaluateAsync } from '../src/connection.js';
import { scanPorts, knownDevices } from '../src/core/connection_plan.js';
import { getFirmwareConfig, listEditingActions } from '../src/core/firmware.js';

async function main() {
  await connect();
  console.log('=== scanPorts ===');
  console.log(JSON.stringify(await scanPorts().catch(e => ({ error: e.message })), null, 2));
  console.log('=== knownDevices ===');
  console.log(JSON.stringify(await knownDevices().catch(e => ({ error: e.message })), null, 2));
  console.log('=== getFirmwareConfig ===');
  const cfg = await getFirmwareConfig().catch(e => ({ error: e.message }));
  console.log(JSON.stringify(cfg && { keys: cfg && Object.keys(cfg), version: cfg?.firmwareConfig?.version, configType: cfg?.configType, senderChannels: cfg?.firmwareConfig?.sender?.channels?.length, receiver1Keys: cfg?.firmwareConfig?.receiver_1 ? Object.keys(cfg.firmwareConfig.receiver_1) : null }, null, 2));
  console.log('=== listEditingActions (count) ===');
  const acts = await listEditingActions().catch(e => ({ error: e.message }));
  console.log(Array.isArray(acts) ? acts.length + ' actions' : acts);
  await disconnect();
}
main();
