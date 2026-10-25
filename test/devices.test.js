import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickDevice } from '../src/core/flash.js';

const A = { deviceId: 'mac-a', bluetoothDeviceId: 'bt-a', deviceName: 'RC_MODULE' };
const B = { deviceId: 'mac-b', bluetoothDeviceId: 'bt-b', deviceName: 'RC_MODULE' };
const C = { deviceId: 'mac-c', bluetoothDeviceId: null, deviceName: 'Sender' };

test('no target: only when exactly one device is known', () => {
  assert.equal(pickDevice([A]), A);
  assert.throws(() => pickDevice([A, B]), /AMBIGUOUS_TARGET/);
  assert.throws(() => pickDevice([]), /DEVICE_NOT_FOUND/);
});

test('exactly one target field', () => {
  assert.throws(() => pickDevice([A, B], { deviceId: 'mac-a', deviceName: 'RC_MODULE' }), /AMBIGUOUS_TARGET/);
});

test('match by each field', () => {
  assert.equal(pickDevice([A, B], { deviceId: 'mac-b' }), B);
  assert.equal(pickDevice([A, B], { bluetoothDeviceId: 'bt-a' }), A);
  assert.equal(pickDevice([A, B, C], { deviceIndex: 2 }), C);
  assert.equal(pickDevice([A, C], { deviceName: 'Sender' }), C);
});

test('duplicate names and misses are refused', () => {
  assert.throws(() => pickDevice([A, B], { deviceName: 'RC_MODULE' }), /AMBIGUOUS_TARGET/);
  assert.throws(() => pickDevice([A, B], { deviceId: 'nope' }), /DEVICE_NOT_FOUND/);
  assert.throws(() => pickDevice([A], { deviceIndex: 5 }), /DEVICE_NOT_FOUND/);
});

test('null fields never match an unset target', () => {
  // C has bluetoothDeviceId null; an empty-string target counts as "not given".
  assert.throws(() => pickDevice([A, C], { bluetoothDeviceId: '' }), /AMBIGUOUS_TARGET/);
});
