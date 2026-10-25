import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeImportedProject, APP_CONFIG_VERSION } from '../src/core/project.js';

test('pads a minimal project to the store schema', () => {
  const p = normalizeImportedProject('{"config_name":"x"}');
  assert.equal(p.sender.channels.length, 10);
  for (const k of ['receiver_1', 'receiver_2']) {
    assert.deepEqual(Object.keys(p[k]).sort(),
      ['BUZZER1', 'BUZZER2', 'CODE', 'LED1', 'LED2', 'MOTOR1', 'MOTOR2', 'PWM1', 'PWM2', 'PWM3', 'PWM4']);
  }
  assert.equal(p.switches.list.length, 2);
  assert.equal(p.version, APP_CONFIG_VERSION);
});

test('rewrites design_id/region and names from the file name', () => {
  const p = normalizeImportedProject('{"design_id":"abc","region":"cn","config_name":"old"}', 'New.json');
  assert.equal(p.design_id, '00000000000000000000');
  assert.equal(p.region, 'xx');
  assert.equal(p.config_name, 'New');
});

test('keeps existing receiver slots', () => {
  const p = normalizeImportedProject(JSON.stringify({ receiver_1: { PWM1: { a: 1 } } }));
  assert.deepEqual(p.receiver_1.PWM1, { a: 1 });
});

test('rejects bad content', () => {
  assert.throws(() => normalizeImportedProject('not json'), /not valid JSON/);
  assert.throws(() => normalizeImportedProject('null'), /JSON object/);
  assert.throws(() => normalizeImportedProject('[1]'), /JSON object/);
  assert.throws(() => normalizeImportedProject('{"version":"9"}'), /config_version_unsupported/);
});
