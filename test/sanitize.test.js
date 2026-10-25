import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sanitize, isSensitiveKey } from '../src/connection.js';

test('redacts auth material by word', () => {
  for (const k of ['token', 'devicePinCode', 'pinCodeEnabled', 'aesKey', 'private_key', 'privateKey',
    'cyberbrick_auth_token', 'refreshToken', 'certFile', 'password', 'client-secret']) {
    assert.equal(isSensitiveKey(k), true, k);
  }
});

test('keeps config keys that merely contain a sensitive substring', () => {
  for (const k of ['hardwareMappings', 'ping', 'spinSpeed', 'authorized', 'mapping', 'opinion', 'certainty', 'PWM1']) {
    assert.equal(isSensitiveKey(k), false, k);
  }
  const out = sanitize({ hardwareMappings: [{ hardwareKey: 'sender', boardId: 'b' }], ping: 1 });
  assert.deepEqual(out, { hardwareMappings: [{ hardwareKey: 'sender', boardId: 'b' }], ping: 1 });
});

test('never returns an unchecked subtree past the depth limit', () => {
  let deep = { token: 'SECRET' };
  for (let i = 0; i < 30; i++) deep = { x: deep };
  assert.equal(JSON.stringify(sanitize(deep)).includes('SECRET'), false);
});

test('truncates very long strings', () => {
  assert.ok(sanitize('a'.repeat(5000)).endsWith('…[truncated]'));
});
