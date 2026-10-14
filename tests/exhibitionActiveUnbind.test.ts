import { afterEach, describe, expect, it, vi } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtempSync, rmSync, readFileSync, renameSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { createApiServer } from '../server/http';
import { ExhibitionMirrors } from '../server/exhibitionMirrors';
import { TryOnService } from '../server/service';
import { SecretBox, SessionStore } from '../server/store';
import { ApiError, type IssuedKey, type KeyStatus, type Provider } from '../server/types';

const resources: { server: Server; store: SessionStore; directory: string }[] = [];
afterEach(async () => {
  for (const { server, store, directory } of resources.splice(0)) {
    const closed = once(server, 'close'); server.closeAllConnections(); server.close(); await closed;
    store.close(); rmSync(directory, { recursive: true, force: true });
  }
});
function deferred<T>() { let resolve!: (value: T) => void; return { promise: new Promise<T>(done => { resolve = done; }), resolve }; }
function terminal(label = '主动解绑镜端') { return { terminalId: `terminal-${randomUUID()}`, token: randomBytes(32).toString('hex'), label, platform: 'android' }; }
async function fixture() {
  let now = 1_800_000_000_000;
  const directory = mkdtempSync(join(tmpdir(), 'exhibition-active-unbind-')); const store = new SessionStore(':memory:');
  const key = 'uk-unbind-original-credential';
  const stopped = (): KeyStatus => ({ status: 'inactive', consumedCredit: 5, expireTimestamp: new Date(now + 120_000).toISOString() });
  const issue = vi.fn(async (): Promise<IssuedKey> => ({ token: `tk-unbind-${randomUUID()}`, expiresAt: new Date(now + 120_000).toISOString() }));
  const deactivate = vi.fn(async (_key: string, _token: string): Promise<KeyStatus> => stopped());
  const provider = (credential: string): Provider => ({ configured: true, credentialSnapshot: () => credential, issueKey: issue,
    keyStatus: async () => ({ ...stopped(), status: 'active' }), deactivate: token => deactivate(credential, token),
    sessionStatus: async (_token, sessionUid) => ({ sessionUid, status: 'active', consumedCredit: 1 }),
  });
  const service = new TryOnService({ provider: provider(key), providerForApiKey: provider, store, secrets: new SecretBox(randomBytes(32)), catalog: async () => [] });
  const mirrors = new ExhibitionMirrors(directory, { now: () => now }); mirrors.attachLiveService(service);
  const mirror = mirrors.getMirror(); mirror.command({ action: 'configure', providerMode: 'xmax', autoReturnSeconds: 0 });
  const device = terminal(); const pairing = mirrors.connectDevice(device); mirrors.bindDevice('default', { code: pairing.code });
  const server = createApiServer(service, ['http://xuminghong.local:10200'], undefined, mirrors);
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); resources.push({ server, store, directory });
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/exhibition/mirrors/default`;
  const request = (path: string, input: unknown, method = 'POST') => fetch(base + path, { method,
    headers: { Origin: 'http://xuminghong.local:10200', 'Content-Type': 'application/json' }, body: JSON.stringify(input) });
  const start = () => request('/live/session', { terminalId: device.terminalId, terminalToken: device.token, deviceId: 'active-unbind-browser',
    lookId: mirror.get().selectedLookId, generationNumber: mirror.get().generationNumber });
  const unbind = (id = device.terminalId) => request('/binding', { terminalId: id }, 'DELETE');
  return { now: () => now, advance: (ms: number) => { now += ms; }, directory, store, key, stopped, issue, deactivate, service, mirrors, mirror,
    device, pairing, request, start, unbind, rotate: () => { service.options.provider = provider('uk-unbind-replacement-credential'); } };
}

describe('staff unbinding ends the local experience independently of cloud revocation', () => {
  it('returns immediately during slow revocation, removes ownership, and blocks replacement binding until confirmation', async () => {
    const f = await fixture(); f.mirror.command({ action: 'begin' }); const created = await f.start(); const session = await created.json();
    const revocation = deferred<KeyStatus>(); f.deactivate.mockImplementationOnce(() => revocation.promise);
    f.mirror.command({ action: 'pause' }); f.advance(31_000); f.rotate();
    expect(f.mirrors.devices.binding('default')?.online).toBe(false);
    const response = await f.unbind(); expect(response.status).toBe(200); expect(await response.json()).toEqual({ binding: null });
    expect(f.mirror.get()).toMatchObject({ phase: 'idle', live: { sessionId: session.id, status: 'stopping' } });
    expect(f.mirrors.devices.binding('default')).toBeNull();
    await vi.waitFor(() => expect(f.deactivate).toHaveBeenCalledWith(f.key, session.token));
    const reconnect = f.mirrors.connectDevice(f.device); expect(reconnect).toMatchObject({ mirrorId: null, code: expect.stringMatching(/^\d{4}$/) });
    expect(reconnect.code).not.toBe(f.pairing.code);
    expect(() => f.mirrors.bindDevice('default', { code: reconnect.code })).toThrow(expect.objectContaining({ code: 'EXHIBITION_MIRROR_BUSY' }));
    expect((await f.start()).status).toBe(403); expect(f.issue).toHaveBeenCalledOnce();
    revocation.resolve(f.stopped()); await f.mirror.reconcileLive();
    expect(f.store.get(session.id)).toMatchObject({ status: 'stopped', consumedCredits: 5 }); expect(f.mirror.get().live).toBeNull();
    expect(f.mirrors.bindDevice('default', { code: reconnect.code })).toMatchObject({ terminalId: f.device.terminalId });
  });

  it('retains known-token revocation failures and retries without recreating a binding or issuing another key', async () => {
    const f = await fixture(); f.mirror.command({ action: 'begin' }); const session = await (await f.start()).json();
    f.deactivate.mockRejectedValue(new Error('provider temporarily unavailable'));
    expect((await f.unbind()).status).toBe(200); await f.mirror.reconcileLive();
    expect(f.mirror.get()).toMatchObject({ phase: 'idle', live: { sessionId: session.id, status: 'error' } });
    expect(f.store.get(session.id)).toMatchObject({ status: 'stopping', errorCode: 'REVOCATION_FAILED' });
    expect(f.store.get(session.id).providerKeyCipher).toBeTruthy();
    expect(f.store.db.prepare('SELECT code FROM errors WHERE session_id=?').all(session.id)).toContainEqual(expect.objectContaining({ code: 'REVOCATION_FAILED' }));
    const replacement = terminal('替代镜端'); const pairing = f.mirrors.connectDevice(replacement);
    expect(() => f.mirrors.bindDevice('default', { code: pairing.code })).toThrow(expect.objectContaining({ code: 'EXHIBITION_MIRROR_BUSY' }));
    expect(() => f.mirror.command({ action: 'begin' })).toThrow(expect.objectContaining({ code: 'EXHIBITION_LIVE_STOP_PENDING' }));
    f.deactivate.mockResolvedValue(f.stopped()); await f.mirror.sweepLive();
    expect(f.mirror.get()).toMatchObject({ phase: 'idle', live: null }); expect(f.mirrors.devices.binding('default')).toBeNull();
    expect(f.mirrors.bindDevice('default', { code: pairing.code }).terminalId).toBe(replacement.terminalId);
    expect((await f.start()).status).toBe(403); expect(f.issue).toHaveBeenCalledOnce();
  });

  it('keeps unknown issuance and its original key after offline unbinding and restart', async () => {
    const f = await fixture(); f.issue.mockRejectedValue(new ApiError('PROVIDER_NETWORK_ERROR', 'isolated unknown issuance', 502));
    f.mirror.command({ action: 'begin' }); expect((await f.start()).status).toBe(502);
    const record = f.store.list()[0]; const beforeRecord = structuredClone(record);
    expect(f.mirror.get().phase).toBe('paused'); f.advance(31_000);
    expect((await f.unbind()).status).toBe(200); await f.mirror.reconcileLive();
    const ended = f.mirror.get();
    expect(ended).toMatchObject({ phase: 'idle', live: { sessionId: record.id, status: 'error', localEnded: true } });
    expect(f.mirrors.devices.binding('default')).toBeNull(); expect(f.store.get(record.id)).toEqual(beforeRecord);
    expect(f.deactivate).not.toHaveBeenCalled(); expect(f.issue).toHaveBeenCalledOnce();
    const restarted = new ExhibitionMirrors(f.directory, { now: f.now }); restarted.attachLiveService(f.service); await restarted.sweepLive();
    expect(restarted.getMirror().get()).toEqual(ended); expect(restarted.devices.binding('default')).toBeNull();
    const pairing = restarted.connectDevice(f.device);
    expect(() => restarted.bindDevice('default', { code: pairing.code })).toThrow(expect.objectContaining({ code: 'EXHIBITION_MIRROR_BUSY' }));
    expect(f.store.get(record.id)).toEqual(beforeRecord);
  });

  it('cancels pending issuance and revokes a late key without returning it to the former terminal', async () => {
    const f = await fixture(); const entered = deferred<void>(); const issued = deferred<IssuedKey>();
    f.issue.mockImplementationOnce(() => { entered.resolve(); return issued.promise; });
    f.mirror.command({ action: 'begin' }); const starting = f.start(); await entered.promise;
    const sessionId = f.mirror.get().live!.sessionId!;
    expect((await f.unbind()).status).toBe(200); await f.mirror.reconcileLive();
    expect(f.store.get(sessionId).status).toBe('stopping'); expect(f.deactivate).not.toHaveBeenCalled();
    expect(f.mirrors.devices.binding('default')).toBeNull();
    const replacement = terminal('新镜端'); const pairing = f.mirrors.connectDevice(replacement);
    expect(() => f.mirrors.bindDevice('default', { code: pairing.code })).toThrow(expect.objectContaining({ code: 'EXHIBITION_MIRROR_BUSY' }));
    issued.resolve({ token: 'tk-late-unbound-terminal', expiresAt: new Date(f.now() + 120_000).toISOString() });
    const late = await starting; expect(late.status).toBe(409); expect(await late.json()).toMatchObject({ code: 'SESSION_CANCELLED' });
    expect(f.deactivate).toHaveBeenCalledWith(f.key, 'tk-late-unbound-terminal'); expect(f.store.get(sessionId).status).toBe('stopped');
    expect(f.mirror.get()).toMatchObject({ phase: 'idle', live: null }); expect(f.issue).toHaveBeenCalledOnce();
    expect(f.mirrors.bindDevice('default', { code: pairing.code }).terminalId).toBe(replacement.terminalId);
    expect((await f.start()).status).toBe(403);
  });

  it('rejects a stale confirmation without cancelling the real owner or affecting another mirror', async () => {
    const f = await fixture(); f.mirror.command({ action: 'begin' }); const session = await (await f.start()).json();
    const otherId = f.mirrors.create({ name: '另一台智能镜' }).id; const otherTerminal = terminal('另一台镜端');
    f.mirrors.bindDevice(otherId, { code: f.mirrors.connectDevice(otherTerminal).code });
    const other = f.mirrors.getMirror(otherId); other.command({ action: 'begin' }); other.command({ action: 'pause' });
    const before = f.mirror.get(); const otherBefore = other.get(); const otherBinding = f.mirrors.devices.binding(otherId);
    const stale = await f.unbind(otherTerminal.terminalId); expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ code: 'EXHIBITION_DEVICE_BINDING_CHANGED' });
    expect(f.mirror.get()).toEqual(before); expect(f.store.get(session.id).status).toBe('active'); expect(f.deactivate).not.toHaveBeenCalled();
    expect((await f.unbind()).status).toBe(200); await f.mirror.reconcileLive();
    expect(other.get()).toEqual(otherBefore); expect(f.mirrors.devices.binding(otherId)).toEqual(otherBinding);
    expect(f.store.get(session.id).status).toBe('stopped');
  });

  it('continues revocation after a binding registry write fails, retaining the original pairing', async () => {
    const f = await fixture(); f.mirror.command({ action: 'begin' }); const session = await (await f.start()).json();
    const file = join(f.directory, 'exhibition-devices.json'); const original = readFileSync(file);
    renameSync(file, file + '.saved'); mkdirSync(file);
    const response = await f.unbind(); expect(response.status).toBe(500); await f.mirror.reconcileLive();
    expect(f.mirrors.devices.binding('default')?.terminalId).toBe(f.device.terminalId);
    expect(f.mirror.get()).toMatchObject({ phase: 'idle', live: null }); expect(f.store.get(session.id).status).toBe('stopped');
    expect(readFileSync(file + '.saved')).toEqual(original); expect(f.deactivate).toHaveBeenCalledWith(f.key, session.token);
  });
});
