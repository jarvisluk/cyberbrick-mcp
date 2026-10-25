// End-to-end demo: build a sender+receiver "遥控小车" (RC car) project FROM A BLANK PROJECT purely through
// MCP tools, live in the app's editor (main window) so every step is visible.
//   node scripts/demo_rc_car.mjs                 # build, save, verify, export
//   node scripts/demo_rc_car.mjs --step-ms 1500  # slower, to watch it in the app
//   node scripts/demo_rc_car.mjs --flash         # also connect the receiver, flash_config, read back, blink LED1
// Reuses an existing project named 遥控小车 (blanked first), otherwise creates it from the empty `custom` template.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createHash } from 'node:crypto';

const NAME = '遥控小车';
const FLASH = process.argv.includes('--flash');
const stepArg = process.argv.indexOf('--step-ms');
const STEP_MS = stepArg > 0 ? Number(process.argv[stepArg + 1]) : 600;

const transport = new StdioClientTransport({ command: 'node', args: ['src/server.js'], cwd: process.cwd() });
const client = new Client({ name: 'demo-rc-car', version: '1.0.0' });
await client.connect(transport);

const results = [];
async function call(name, args = {}) {
  const r = await client.callTool({ name, arguments: args });
  const text = r.content?.[0]?.text ?? JSON.stringify(r);
  let body; try { body = JSON.parse(text); } catch { body = { __text: text }; }
  const ok = !r.isError && !body?.error;
  results.push({ tool: name, ok });
  if (!ok) console.log(`  ✗ ${name}: ${text.slice(0, 300)}`);
  return body;
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function edit(label, action, ...args) {
  console.log(`  · ${label}`);
  const r = await call('firmware_config_edit', { action, args });
  await sleep(STEP_MS);
  return r;
}
function check(label, cond) { results.push({ tool: `assert: ${label}`, ok: !!cond }); console.log(`  ${cond ? '✓' : '✗'} ${label}`); }

// Sender = the official remote (Shield X12). Channel index ↔ port: 0 L1, 1 L2, 2 L3, 3 R1, 4 R2, 5 R3, 6 K1, 7 K2.
const stick = (name, channel, mid_value, deadzone = 200) =>
  ({ name, device: 'joystick', data: { channel, deadzone, mid_value }, controls: [], event: [] });

// ---------- 1. health + blank project, opened in the visible editor ----------
console.log('[1] health / blank project / open editor');
const health = await call('cb_health');
console.log(`  app ${health.appVersion}, devices=${health.deviceCount}`);
const list = await call('project_list');
let id = list.projects?.find(p => p.configName === NAME)?.configId;
if (!id) id = (await call('project_create', { template: 'custom', name: NAME })).configId;
console.log(`  project ${NAME} = ${id}`);
await call('project_open_editor', { id, target: 'current' });
await call('firmware_config_load_template', { template: 'custom', keepIdentity: true }); // start from empty
await sleep(STEP_MS);

// ---------- 2. sender (发送端): declare the remote's inputs ----------
console.log('[2] sender inputs');
await edit('L1 左肩三档开关', 'updateSenderChannel', 0,
  { name: '左肩三档开关', device: 'three_way_switch', data: { deadzone: 500, mid_value: 2200 }, controls: [], event: [] });
await edit('L2 左摇杆 X', 'updateSenderChannel', 1, stick('左摇杆', 'x', 2208, 300));
await edit('L3 左摇杆 Y', 'updateSenderChannel', 2, stick('左摇杆-油门', 'y', 2020));
await edit('R1 右肩摇杆', 'updateSenderChannel', 3,
  { name: '右肩摇杆', device: 'joystick_s', data: { channel: 'y', deadzone: 200, mid_value: 2048 }, controls: [], event: [] });
await edit('R2 右摇杆 X', 'updateSenderChannel', 4, stick('右摇杆-转向', 'x', 2048));
await edit('R3 右摇杆 Y', 'updateSenderChannel', 5, stick('右摇杆', 'y', 2048));
await edit('K1 左肩按键', 'updateSenderChannel', 6,
  { name: '左肩按键-大灯', device: 'button', data: {}, controls: [], event: [] });

// ---------- 3. receiver (接收端): enable receiver_1 and its actuators ----------
console.log('[3] receiver_1 actuators');
await edit('启用接收端 receiver_1', 'updateSwitchList', [{ state: 'on', name: NAME }, { state: 'off' }]);
await edit('PWM1 转向舵机', 'updateReceiverChannel', 'receiver_1', 'PWM1', {
  en: true, type: 'angle', speed: 100, min_value: 45, max_value: 135, initial_value: 90, bias: 0, name: '转向舵机',
});
await edit('MOTOR1 驱动电机（软启动）', 'updateReceiverChannel', 'receiver_1', 'MOTOR1', {
  en: true, bias: 0, max_value: 100, min_value: 100,
  advance_motor_config: { en: true, ACC: 1.45, LVZ: 60, HVZ: 40, HVD: 1 }, name: '驱动电机',
});
await edit('LED1 大灯', 'updateReceiverChannel', 'receiver_1', 'LED1', {
  en: true, name: '大灯',
  data: [
    { device: 'LED1', effect: 1, effect_name: '大灯开', sequence_number: 3, mode: 'steady', RGB: '0xffffff', device_name: '大灯' },
    { device: 'LED1', effect: 2, effect_name: '大灯关', sequence_number: 0, mode: 'steady', RGB: '0xffffff', device_name: '大灯' },
  ],
});
await edit('LED2 转向灯', 'updateReceiverChannel', 'receiver_1', 'LED2', {
  en: true, name: '转向灯',
  data: [
    { device: 'LED2', effect: 1, effect_name: '示廓灯', sequence_number: 3, mode: 'steady', RGB: '0xffffff', device_name: '转向灯' },
    { device: 'LED2', effect: 2, effect_name: '左转灯', sequence_number: 5, mode: 'blink', RGB: '0xe4e113', repeat_times: 255, time: 0.5, device_name: '转向灯' },
    { device: 'LED2', effect: 3, effect_name: '右转灯', sequence_number: 10, mode: 'blink', RGB: '0xdce013', repeat_times: 255, time: 0.5, device_name: '转向灯' },
  ],
});

// ---------- 4. wiring: sender inputs → receiver actuators ----------
console.log('[4] control mapping');
await edit('左摇杆 Y → MOTOR1', 'updateChannelControl', 2, [{ actuator: 'MOTOR1', direction: 'negative', receiver: 1 }]);
await edit('右摇杆 X → PWM1', 'updateChannelControl', 4, [{ actuator: 'PWM1', direction: 'negative', receiver: 1 }]);
await edit('右摇杆 X 偏转 → LED2 转向灯', 'updateUniEvents', 4, [
  { type: 'gt_mid', actuator: 'LED2', set_value: [3], receiver: 1 },
  { type: 'eq_mid', actuator: 'LED2', set_value: [1], receiver: 1 },
  { type: 'lt_mid', actuator: 'LED2', set_value: [2], receiver: 1 },
]);
await edit('左肩按键短按 → LED1 大灯开/关', 'updateUniEvents', 6, [{ type: 'short', actuator: 'LED1', set_value: [1, 2], receiver: 1 }]);

// ---------- 5. save → reload → verify → export ----------
console.log('[5] save / verify');
await call('project_save');
await call('project_open_editor', { id, target: 'current' }); // reload from the saved list to prove persistence
const cfg = (await call('firmware_config_get')).firmwareConfig ?? {};
const r1 = cfg.receiver_1 ?? {}, ch = cfg.sender?.channels ?? [];
check('7 sender inputs declared', ch.slice(0, 7).every(c => c.device));
check('receiver_1 enabled', cfg.switches?.list?.[0]?.state === 'on');
check('PWM1 steering 45..135', r1.PWM1?.en && r1.PWM1.min_value === 45 && r1.PWM1.max_value === 135);
check('MOTOR1 soft-start on', r1.MOTOR1?.advance_motor_config?.en === true);
check('LED1 headlight 2 effects, LED2 signals 3 effects', r1.LED1?.data?.length === 2 && r1.LED2?.data?.length === 3);
check('left stick Y → MOTOR1', ch[2]?.controls?.[0]?.actuator === 'MOTOR1');
check('right stick X → PWM1 + LED2 events', ch[4]?.controls?.[0]?.actuator === 'PWM1' && ch[4]?.event?.length === 3);
check('left shoulder button → LED1 toggle', ch[6]?.event?.[0]?.actuator === 'LED1');
const exported = await client.callTool({ name: 'project_export', arguments: { id } });
const json = exported.content[0].text;
check('export parses, name matches', JSON.parse(json).config_name === NAME);
console.log(`  export ${json.length} bytes, md5 ${createHash('md5').update(json).digest('hex')}`);

// ---------- 6. hardware (opt-in) ----------
if (FLASH) {
  console.log('[6] hardware: connect → flash_config → readback → LED test');
  let dev = (await call('device_list')).devices?.find(d => d.deviceType === 'receiver');
  if (dev?.deviceConnectStatus !== 'connected') {
    await call('connect_bluetooth', { deviceName: dev?.deviceName, timeoutMs: 20000 });
    dev = (await call('device_list')).devices?.find(d => d.deviceType === 'receiver');
  }
  console.log(`  receiver ${dev?.deviceName} ${dev?.deviceConnectStatus}`);
  if (dev?.deviceConnectStatus === 'connected') {
    const target = { bluetoothDeviceId: dev.bluetoothDeviceId };
    const flashed = await call('flash_config', { target, firmwareConfig: cfg });
    console.log(`  flash_config ${JSON.stringify(flashed)}`);
    const meta = await call('device_config_get', { device_id: dev.bluetoothDeviceId });
    console.log(`  board config ${JSON.stringify(meta)}`);
    check('board config size matches flashed bytes', flashed.bytes && meta.file_size === flashed.bytes);
    // Full readback: the last block is padded to file_chunk_size, so trim to file_size before hashing.
    const blocks = [];
    for (let i = 0; i < Math.ceil(meta.file_size / meta.file_chunk_size); i++) {
      const b = await call('device_config_block', { device_id: dev.bluetoothDeviceId, index: i });
      blocks.push(Buffer.from(Object.values(b.data ?? {})));
    }
    const readback = Buffer.concat(blocks).subarray(0, meta.file_size);
    check('board config md5 matches flashed md5', createHash('md5').update(readback).digest('hex') === flashed.md5);
    for (const v of [1, 2]) await call('flash_test', { target, command: { actuator: 'LED1', set_value: v, receiver: 1, data: r1.LED1.data } });
  } else check('receiver connected', false);
}

await client.close();
const failed = results.filter(r => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed${failed.length ? ' — failed: ' + failed.map(f => f.tool).join(', ') : ''}`);
process.exit(failed.length ? 1 : 0);
