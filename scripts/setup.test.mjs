import test from 'node:test';
import assert from 'node:assert/strict';
import { X509Certificate } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import https from 'node:https';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { prepareCertificates } from './setup.mjs';

test('fresh certificate setup produces a trusted TLS chain and preserves it on repeat', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'openbuy-setup-'));
  let server;
  try {
    const first = await prepareCertificates(root);
    assert.equal(first.renewed, true);
    const directory = resolve(root, '.data/lan-tls');
    const [key, cert, ca] = await Promise.all(['server.key', 'server.crt', 'root-ca.crt'].map(name => readFile(resolve(directory, name))));
    assert.equal(new X509Certificate(ca).ca, true);
    assert(new X509Certificate(cert).checkHost('xuminghong.local'));
    server = https.createServer({ key, cert, ca }, (_request, response) => response.end('camera-ready'));
    await new Promise(done => server.listen(0, '127.0.0.1', done));
    const result = await new Promise((done, fail) => {
      https.get({ hostname: '127.0.0.1', port: server.address().port, servername: 'xuminghong.local', ca }, response => {
        let text = ''; response.on('data', data => { text += data; }); response.on('end', () => done(text)); response.on('error', fail);
      }).on('error', fail);
    });
    assert.equal(result, 'camera-ready');
    assert.equal((await prepareCertificates(root)).renewed, false);
    assert.deepEqual(await readFile(resolve(directory, 'server.key')), key);
    assert.deepEqual(await readFile(resolve(directory, 'root-ca.crt')), ca);
    assert.deepEqual(await readFile(resolve(root, 'public/openbuy-local-ca.crt')), ca);
    await writeFile(resolve(directory, 'root-ca.key'), 'invalid');
    await assert.rejects(prepareCertificates(root));
    assert.deepEqual(await readFile(resolve(directory, 'root-ca.crt')), ca);
  } finally {
    if (server) await new Promise(done => server.close(done));
    await rm(root, { recursive: true, force: true });
  }
});
