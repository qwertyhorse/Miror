import { afterEach, expect, it, vi } from 'vitest';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApiServer } from '../server/http';
import { ExhibitionMirrors } from '../server/exhibitionMirrors';
import { TryOnService } from '../server/service';
import { SecretBox, SessionStore } from '../server/store';
import { ReferenceAssets } from '../server/referenceAssets';
import type { Provider } from '../server/types';
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); });
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'mirror-ready-http-'));
  const store = new SessionStore(':memory:'); let key = 'uk-fixture-account-a';
  const expiresAt = new Date(Date.now() + 120_000).toISOString();
  const issue = vi.fn(async () => ({ token: 'tk-fixture-only', expiresAt }));
  const provider: Provider = { configured: true, region: 'cn', credentialSnapshot: () => key, issueKey: issue,
    deactivate: async () => ({ status: 'inactive', consumedCredit: 0, expireTimestamp: expiresAt }),
    keyStatus: async () => ({ status: 'active', consumedCredit: 0, expireTimestamp: expiresAt }),
    sessionStatus: async (_, sessionUid) => ({ sessionUid, status: 'active', consumedCredit: 0 }) };
  const upload = vi.fn(async () => 'https://fixture-123.cos.ap-test.myqcloud.com/ready.png');
  const storage = vi.fn(() => ({ upload, check: async () => true }));
  const service = new TryOnService({ provider, store, secrets: new SecretBox(randomBytes(32)), referenceAssets: new ReferenceAssets(directory), referenceStorage: storage });
  const mirrors = new ExhibitionMirrors(directory);
  const server = createApiServer(service, undefined, undefined, mirrors);
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  cleanup.push(async () => { const closed = once(server, 'close'); server.closeAllConnections(); server.close(); await closed; store.close(); await rm(directory, { force: true, recursive: true }); });
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/exhibition/mirrors/default`;
  const get = (path: string, signal?: AbortSignal) => fetch(base + path, { signal });
  const post = (path: string, body = {}) => fetch(base + path, { method: 'POST', headers: { Origin: 'http://127.0.0.1:5173', 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { get, post, upload, storage, issue, mirror: mirrors.getMirror(), rotate: () => { key = 'uk-fixture-account-b'; } };
}
it('prepares original material without a generation key, persists its scope into a session, and isolates account rotation', async () => {
  const f = await fixture();
  expect(await (await f.get('/references/commute')).json()).toEqual({ reference: null });
  const response = await f.post('/references/commute'); expect(response.status).toBe(200);
  const { reference } = await response.json();
  expect(reference).toMatchObject({ scope: expect.stringMatching(/^[a-f0-9]{64}$/), sha256: expect.stringMatching(/^[a-f0-9]{64}$/) });
  expect(f.upload).toHaveBeenCalledOnce(); expect(f.issue).not.toHaveBeenCalled();
  expect(f.storage).toHaveBeenCalledWith('uk-fixture-account-a', 'cn');
  expect(await (await f.get('/references/commute')).json()).toEqual({ reference });
  await f.post('/references/commute'); expect(f.upload).toHaveBeenCalledOnce();
  f.mirror.command({ action: 'configure', providerMode: 'xmax', autoReturnSeconds: 0 }); f.mirror.command({ action: 'begin' });
  const session = await (await f.post('/live/session', { deviceId: 'fixture-device', lookId: 'commute', generationNumber: f.mirror.get().generationNumber })).json();
  expect(session.referenceScope).toBe(reference.scope);
  f.rotate(); expect(await (await f.get('/references/commute')).json()).toEqual({ reference: null });
  expect((await f.get('/references/missing')).status).toBe(404);
});
it('notifies a waiting screen as soon as its state changes and rejects invalid revisions', async () => {
  const f = await fixture(); const before = f.mirror.get(); const abort = new AbortController();
  const subscribed = vi.spyOn(f.mirror, 'subscribe');
  const pending = f.get(`/changes?after=${before.revision}`, abort.signal);
  await vi.waitFor(() => expect(subscribed).toHaveBeenCalledOnce());
  const changed = f.mirror.command({ action: 'begin' });
  expect(await (await pending).json()).toMatchObject({ revision: changed.revision, phase: changed.phase });
  expect(await (await f.get(`/changes?after=${before.revision}`)).json()).toMatchObject({ revision: changed.revision });
  expect((await f.get('/changes?after=NaN')).status).toBe(400);
  abort.abort();
});
