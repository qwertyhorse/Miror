import test from 'node:test';
import assert from 'node:assert/strict';
import { validateLanRequest } from './lan-preview.mjs';
import { validateCameraRequest } from './camera-https.mjs';
test('provider credentials and switch actions only write through the same-origin HTTPS gateway', () => {
  for (const suffix of ['provider-settings', 'provider-settings/verify', 'provider-settings/apply', 'credentials']) {
    for (const path of [suffix, suffix.replace('provider-', 'provider%2d')]) {
      const request = { method: 'POST', url: `/v1.1/api/exhibition/mirrors/default/${path}`, headers: { host: 'xuminghong.local:10200', origin: 'http://xuminghong.local:10200' }, socket: { remoteAddress: '127.0.0.1' } };
      assert.equal(validateLanRequest(request).code, 403);
      request.headers = { host: 'xuminghong.local:10202', origin: 'https://xuminghong.local:10202' };
      assert.equal(validateCameraRequest(request), null);
      request.headers.origin = 'https://attacker.invalid'; assert.equal(validateCameraRequest(request).code, 403);
    }
  }
});
