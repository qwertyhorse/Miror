import { LifecycleTryOnService } from './support/lifecycleReferenceFixture';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { ExhibitionMirrors } from '../server/exhibitionMirrors.ts';
import { ExhibitionService } from '../server/exhibition.ts';
import { createApiServer } from '../server/http.ts';
import { TryOnService } from '../server/service.ts';
import { SecretBox, SessionStore } from '../server/store.ts';
import { ApiError, type IssuedKey, type Provider } from '../server/types.ts';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const clean of cleanups.splice(0)) await clean(); });
const code = (value: string) => expect.objectContaining({ code: value });
function deferred<T>() { let resolve!: (value: T) => void; return { promise: new Promise<T>(done => { resolve = done; }), resolve }; }
function terminal() { return { terminalId: `terminal-${randomUUID()}`, token: randomBytes(32).toString('hex'), label: '删除测试镜端', platform: 'android' }; }
async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'exhibition-delete-'));
  const now = () => 1_800_000_000_000;
  const store = new SessionStore(':memory:');
  const issue = vi.fn(async (): Promise<IssuedKey> => ({ token: `tk-delete-${randomUUID()}`, expiresAt: new Date(now() + 120_000).toISOString() }));
  const provider: Provider = { configured: true, credentialSnapshot: () => 'uk-delete-test', issueKey: issue,
    keyStatus: async () => ({ status: 'active', consumedCredit: 0, expireTimestamp: new Date(now() + 120_000).toISOString() }),
    deactivate: async () => ({ status: 'inactive', consumedCredit: 0, expireTimestamp: new Date(now() + 120_000).toISOString() }),
    sessionStatus: async (_token, sessionUid) => ({ sessionUid, status: 'active', consumedCredit: 0 }) };
  const service = new LifecycleTryOnService({ provider, providerForApiKey: () => provider, store, secrets: new SecretBox(randomBytes(32)), catalog: async () => [] });
  const mirrors = new ExhibitionMirrors(directory, { now });
  const id = mirrors.create({ name: '待删除智能镜' }).id;
  const mirror = mirrors.getMirror(id);
  const server = createApiServer(service, ['http://xuminghong.local:10200'], undefined, mirrors);
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const path = `/api/exhibition/mirrors/${id}`;
  const request = (suffix = '', value?: unknown, method = value === undefined ? 'GET' : 'POST') => fetch(base + path + suffix, {
    method, headers: { 'Content-Type': 'application/json', Origin: 'http://xuminghong.local:10200' },
    ...(value === undefined ? {} : { body: JSON.stringify(value) }),
  });
  const remove = () => mirrors.remove(id, { expectedRevision: mirror.get().revision });
  cleanups.push(async () => { const closed = once(server, 'close'); server.closeAllConnections(); server.close(); await closed; store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { directory, now, store, service, issue, mirrors, mirror, id, server, base, path, request, remove };
}
async function image() { return (await sharp({ create: { width: 512, height: 768, channels: 4, background: '#9280ee' } }).png().toBuffer()).toString('base64'); }

async function upload(mirror: ExhibitionService, bytes: string) {
  return mirror.upload({ name: '保存的素材', category: '通勤', tags: [], imageBase64: bytes, referenceImageBase64: bytes });
}

describe('recoverable smart mirror deletion', () => {
  it('removes only the selected registry entry, preserves assets and metadata, and survives restart', async () => {
    const f = await fixture(); const state = await upload(f.mirror, await image()); const look = state.looks.at(-1)!;
    const asset = f.mirror.asset(look.id).data; const beforeDefault = f.mirrors.getMirror().get();
    const durableState = f.store.mirrorState(f.id); const events = f.store.mirrorEvents(f.id);
    const result = await f.request('', { expectedRevision: state.revision }, 'DELETE');
    expect(result.status).toBe(200); expect(await result.json()).toMatchObject({ defaultMirrorId: 'default', mirrors: [{ id: 'default' }] });
    expect(f.mirrors.getMirror().get()).toEqual(beforeDefault);
    const directory = join(f.directory, 'exhibition-mirrors', f.id);
    expect(existsSync(join(directory, 'exhibition.json'))).toBe(true);
    expect(f.store.mirrorState(f.id)).toEqual(durableState); expect(f.store.mirrorEvents(f.id)).toEqual(events);
    const recovery = new ExhibitionService(directory, { now: f.now, mirrorId: f.id, assetBasePath: `${f.path}/assets`, strictStorage: true });
    recovery.attachLiveService(f.service); // The current lifecycle's authority is SQLite; the directory retains assets.
    expect(recovery.get()).toEqual(state); expect(recovery.asset(look.id).data).toEqual(asset);
    expect(JSON.parse(readFileSync(join(f.directory, 'exhibition-mirrors.json'), 'utf8')).removedMirrors).toEqual([{ id: f.id, name: '待删除智能镜', removedAt: f.now() }]);
    const restarted = new ExhibitionMirrors(f.directory, { now: f.now });
    expect(restarted.list().mirrors.map(item => item.id)).toEqual(['default']);
    expect(() => restarted.getMirror(f.id)).toThrow(code('EXHIBITION_MIRROR_NOT_FOUND'));
    expect(restarted.create({ name: '待删除智能镜' }).id).not.toBe(f.id);
    for (const suffix of ['', '/credentials', '/camera', '/diagnostics', '/live/status', '/changes?after=0', look.image.slice(f.path.length)]) expect((await f.request(suffix)).status).toBe(404);
    expect((await f.request('/command', { action: 'begin' })).status).toBe(404);
    expect((await f.request('', { expectedRevision: state.revision }, 'DELETE')).status).toBe(404);
    expect(() => f.mirror.command({ action: 'begin' })).toThrow(code('EXHIBITION_MIRROR_NOT_FOUND'));
    expect(() => f.mirror.read()).toThrow(code('EXHIBITION_MIRROR_NOT_FOUND'));
  });

  it('detaches a physical terminal and lets it pair again without changing other mirrors', async () => {
    const f = await fixture(); const device = terminal(); const pairing = f.mirrors.connectDevice(device);
    f.mirrors.bindDevice(f.id, { code: pairing.code });
    const other = terminal(); f.mirrors.bindDevice('default', { code: f.mirrors.connectDevice(other).code });
    const otherBinding = f.mirrors.devices.binding('default'); f.remove();
    expect(f.mirrors.devices.binding(f.id)).toBeNull(); expect(f.mirrors.devices.binding('default')).toEqual(otherBinding);
    const reconnected = f.mirrors.connectDevice(device);
    expect(reconnected).toMatchObject({ mirrorId: null, code: expect.stringMatching(/^\d{4}$/) }); expect(reconnected.code).not.toBe(pairing.code);
    const newId = f.mirrors.create({ name: '替换智能镜' }).id;
    expect(f.mirrors.bindDevice(newId, { code: reconnected.code }).terminalId).toBe(device.terminalId);
    const restarted = new ExhibitionMirrors(f.directory, { now: f.now });
    expect(restarted.connectDevice(device)).toMatchObject({ mirrorId: newId }); expect(restarted.connectDevice(other)).toMatchObject({ mirrorId: 'default' });
  });

  it('cancels remote camera requests and rejects their late reports after deletion and rebinding', async () => {
    const f = await fixture(); const device = { ...terminal(), cameraCapabilities: { version: 1 } };
    f.mirrors.bindDevice(f.id, { code: f.mirrors.connectDevice(device).code });
    const connected = f.mirrors.connectDevice(device);
    const request = f.mirrors.openCamera(f.id, { action: 'open', terminalId: device.terminalId, bindingId: connected.cameraBindingId }).request!;
    expect(f.mirrors.connectDevice(device).cameraRequest?.id).toBe(request.id);
    const report = { mirrorId: f.id, bindingId: connected.cameraBindingId, requestId: request.id, status: 'preview', devices: [], selectedDeviceId: null, activeDeviceId: null };
    f.remove();
    const unbound = f.mirrors.connectDevice({ ...device, cameraReport: report });
    expect(unbound).toMatchObject({ mirrorId: null, cameraReportAccepted: false });
    expect(unbound.cameraRequest).toBeUndefined(); expect(unbound.cameraBindingId).toBeUndefined();
    expect(f.mirrors.devices.cameraStatus(f.id)).toMatchObject({ state: 'unbound', request: null, devices: [] });
    const replacement = f.mirrors.create({ name: '替换摄像头镜子' });
    f.mirrors.bindDevice(replacement.id, { code: unbound.code });
    const rebound = f.mirrors.connectDevice({ ...device, cameraReport: report });
    expect(rebound.cameraBindingId).not.toBe(connected.cameraBindingId);
    expect(rebound.cameraRequest).toBeUndefined(); expect(rebound.cameraReportAccepted).toBe(false);
    expect(f.mirrors.cameraStatus(replacement.id)).toMatchObject({ state: 'idle', request: null, devices: [] });
  });

  it.each([{ state: 'active', connection: 'idle' }, { state: 'paused', connection: 'idle' }, { state: 'ended', connection: 'cleaning' }])
    ('blocks lifecycle ownership even if legacy phase is idle: %j', async lifecycle => {
      const f = await fixture();
      const persisted = f.store.mirrorState(f.id) as { state: { lifecycle: Record<string, unknown> } };
      Object.assign(persisted.state.lifecycle, lifecycle);
      f.store.saveMirrorState(f.id, persisted, { type: 'imported-lifecycle' });
      const reopened = new ExhibitionMirrors(f.directory, { now: f.now }); reopened.attachLiveService(f.service);
      const state = reopened.getMirror(f.id).read(); expect(state.phase).toBe('idle'); expect(state.live).toBeNull();
      expect(() => reopened.remove(f.id, { expectedRevision: state.revision })).toThrow(code('EXHIBITION_MIRROR_BUSY'));
      expect(reopened.getMirror(f.id).read()).toEqual(state);
    });

  it('rejects a retained service replay even when the command was already acknowledged in SQLite', async () => {
    const f = await fixture(); const command = { action: 'configure', autoReturnSeconds: 180, commandId: 'command-before-delete' };
    f.mirror.command(command); const fingerprint = f.store.commandFingerprint(f.id, command.commandId);
    expect(fingerprint).toBeDefined(); f.remove();
    expect(() => f.mirror.command(command)).toThrow(code('EXHIBITION_MIRROR_NOT_FOUND'));
    expect(f.store.commandFingerprint(f.id, command.commandId)).toBe(fingerprint);
  });

  it('rejects missing revisions, stale confirmations, default entry and active or paused experiences', async () => {
    const f = await fixture(); const revision = f.mirror.get().revision;
    expect(() => f.mirrors.remove('default', { expectedRevision: f.mirrors.getMirror().get().revision })).toThrow(code('EXHIBITION_DEFAULT_MIRROR'));
    for (const input of [{}, { expectedRevision: -1 }, { expectedRevision: '1' }]) expect(() => f.mirrors.remove(f.id, input)).toThrow(code('EXHIBITION_INVALID_REVISION'));
    f.mirror.command({ action: 'configure', autoReturnSeconds: 0 });
    expect(() => f.mirrors.remove(f.id, { expectedRevision: revision })).toThrow(code('EXHIBITION_STALE_REVISION'));
    f.mirror.command({ action: 'begin' }); expect(f.remove).toThrow(code('EXHIBITION_MIRROR_BUSY'));
    f.mirror.command({ action: 'pause' }); expect(f.remove).toThrow(code('EXHIBITION_MIRROR_BUSY'));
    f.mirror.command({ action: 'idle' }); expect(f.remove().mirrors).toHaveLength(1);
  });

  it('keeps the registry, binding and recovery data intact if the primary registry write fails', async () => {
    const f = await fixture(); const device = terminal(); f.mirrors.bindDevice(f.id, { code: f.mirrors.connectDevice(device).code });
    const file = join(f.directory, 'exhibition-mirrors.json'); const before = f.mirrors.list(); const state = f.mirror.get();
    renameSync(file, file + '.saved'); mkdirSync(file);
    expect(f.remove).toThrow(); expect(f.mirrors.list()).toEqual(before); expect(f.mirror.get()).toEqual(state);
    expect(f.mirrors.connectDevice(device).mirrorId).toBe(f.id);
    rmSync(file, { recursive: true }); renameSync(file + '.saved', file);
    expect(new ExhibitionMirrors(f.directory, { now: f.now }).list()).toMatchObject({ mirrors: expect.arrayContaining([expect.objectContaining({ id: f.id })]) });
  });

  it('repairs a failed secondary binding write and an interrupted deletion on restart', async () => {
    const f = await fixture(); const device = terminal(); f.mirrors.bindDevice(f.id, { code: f.mirrors.connectDevice(device).code });
    const file = join(f.directory, 'exhibition-devices.json'); const original = readFileSync(file);
    renameSync(file, file + '.saved'); mkdirSync(file);
    expect(f.remove().mirrors).toHaveLength(1); expect(f.mirrors.devices.binding(f.id)).toBeNull();
    rmSync(file, { recursive: true }); writeFileSync(file, original);
    const restarted = new ExhibitionMirrors(f.directory, { now: f.now });
    expect(restarted.devices.binding(f.id)).toBeNull(); expect(restarted.connectDevice(device)).toMatchObject({ mirrorId: null, code: expect.stringMatching(/^\d{4}$/) });
    expect(JSON.parse(readFileSync(file, 'utf8')).terminals[0].mirrorId).toBeNull();
  });

  it('blocks deletion during image/skin processing or reference preparation', async () => {
    const f = await fixture(); const bytes = await image(); const pendingUpload = upload(f.mirror, bytes);
    expect(f.remove).toThrow(code('EXHIBITION_MIRROR_BUSY')); await pendingUpload;
    const pendingSkin = f.mirror.uploadUiSkin({ imageBase64: bytes, expectedRevision: f.mirror.get().revision });
    expect(f.remove).toThrow(code('EXHIBITION_MIRROR_BUSY')); await pendingSkin;
    const prepared = deferred<void>(); vi.spyOn(f.service, 'prepareReference').mockImplementation(async () => { await prepared.promise; return null; });
    const preparing = f.mirror.prepareReference('commute'); expect(f.remove).toThrow(code('EXHIBITION_MIRROR_BUSY'));
    prepared.resolve(); await preparing; f.remove();
    await expect(f.mirror.prepareReference('commute')).rejects.toMatchObject({ code: 'EXHIBITION_MIRROR_NOT_FOUND' });
    await expect(upload(f.mirror, bytes)).rejects.toMatchObject({ code: 'EXHIBITION_MIRROR_NOT_FOUND' });
  });

  it('refuses every unstopped orphaned session even with no local live state', async () => {
    const f = await fixture();
    const session = await f.service.createExhibition({ mirrorId: f.id, lookId: 'commute', deviceId: 'delete-test-screen', name: '测试', referenceAsset: '/assets/exhibition/commute-cutout.png', sessionNumber: 1, generationNumber: 1 });
    expect(f.mirror.get().live).toBeNull();
    for (const status of ['active', 'reserved', 'stopping', 'issuance_unknown', 'error'] as const) {
      f.store.update(session.id, { status }); expect(f.remove).toThrow(code('EXHIBITION_MIRROR_BUSY'));
    }
    f.store.update(session.id, { status: 'stopped' }); f.remove(); expect(f.store.get(session.id).status).toBe('stopped');
  });

  it.each([true, false])('keeps historical error sessions until stopped, including after restart (known token: %s)', async knownToken => {
    const f = await fixture();
    const session = await f.service.createExhibition({ mirrorId: f.id, lookId: 'commute', deviceId: 'delete-error-screen', name: '历史错误', referenceAsset: '/assets/exhibition/commute-cutout.png', sessionNumber: 1, generationNumber: 1 });
    const original = f.store.get(session.id);
    f.store.update(session.id, { status: 'error', errorCode: 'HISTORICAL_PROVIDER_FAILURE', tokenCipher: knownToken ? original.tokenCipher : undefined });
    const record = f.store.get(session.id); const state = f.mirror.get();
    expect(state.live).toBeNull(); expect(f.service.status(f.id).activeSessions).toEqual([]);
    expect(f.remove).toThrow(code('EXHIBITION_MIRROR_BUSY')); expect(f.store.get(session.id)).toEqual(record);
    const restarted = new ExhibitionMirrors(f.directory, { now: f.now }); restarted.attachLiveService(f.service);
    const remove = () => restarted.remove(f.id, { expectedRevision: restarted.getMirror(f.id).get().revision });
    expect(remove).toThrow(code('EXHIBITION_MIRROR_BUSY'));
    const other = restarted.create({ name: '不受影响的镜子' });
    expect(restarted.remove(other.id, { expectedRevision: other.revision }).mirrors.map(mirror => mirror.id)).toContain(f.id);
    const stopped = await f.service.stop(session.id);
    if (knownToken) {
      expect(stopped.status).toBe('stopped'); expect(remove().mirrors.map(mirror => mirror.id)).not.toContain(f.id);
    } else {
      expect(stopped.status).not.toBe('stopped'); expect(remove).toThrow(code('EXHIBITION_MIRROR_BUSY'));
      expect(restarted.getMirror(f.id).get()).toEqual(state);
    }
  });

  it('retains unconfirmed issuance after the local experience ends and across restart', async () => {
    const f = await fixture(); f.issue.mockRejectedValueOnce(new ApiError('PROVIDER_NETWORK_ERROR', 'unknown issuance', 502));
    f.mirror.command({ action: 'configure', providerMode: 'xmax', autoReturnSeconds: 0 }); f.mirror.command({ action: 'begin' });
    await expect(f.mirror.createLiveSession({ deviceId: 'delete-unknown-screen', lookId: f.mirror.get().selectedLookId, generationNumber: f.mirror.get().generationNumber })).rejects.toMatchObject({ code: 'PROVIDER_NETWORK_ERROR' });
    f.mirror.command({ action: 'idle' }); await f.mirror.reconcileLive(); const before = f.store.list();
    expect(f.mirror.get()).toMatchObject({ phase: 'idle', live: { status: 'error', localEnded: true } }); expect(f.remove).toThrow(code('EXHIBITION_MIRROR_BUSY'));
    const restarted = new ExhibitionMirrors(f.directory, { now: f.now }); restarted.attachLiveService(f.service);
    expect(() => restarted.remove(f.id, { expectedRevision: restarted.getMirror(f.id).get().revision })).toThrow(code('EXHIBITION_MIRROR_BUSY'));
    expect(f.store.list()).toEqual(before);
  });

  it('archives tokenless historical unknown issuance without altering its credential or anomaly records', async () => {
    const f = await fixture(); f.mirror.command({ action: 'begin' }); f.mirror.command({ action: 'idle' });
    f.issue.mockRejectedValueOnce(new ApiError('PROVIDER_NETWORK_ERROR', 'historical unknown issuance', 502));
    await expect(f.service.createExhibition({ mirrorId: f.id, lookId: 'commute', deviceId: 'historical-unknown-screen', name: '历史异常', referenceAsset: '/assets/exhibition/commute-cutout.png', sessionNumber: 1, generationNumber: 1 }))
      .rejects.toMatchObject({ code: 'PROVIDER_NETWORK_ERROR' });
    const sessions = f.store.list(); const anomalies = f.store.db.prepare('SELECT * FROM errors').all();
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({ status: 'issuance_unknown', errorCode: 'PROVIDER_NETWORK_ERROR', providerKeyCipher: expect.any(String) });
    expect(sessions[0].tokenCipher).toBeUndefined(); expect(sessions[0].expiresAt).toBeUndefined();
    expect(f.mirror.read()).toMatchObject({ phase: 'idle', live: null, lifecycle: { state: 'ended' } });
    const state = f.store.mirrorState(f.id); const events = f.store.mirrorEvents(f.id);
    const response = await f.request('', { expectedRevision: f.mirror.read().revision }, 'DELETE'); expect(response.status).toBe(200);
    expect(f.store.list()).toEqual(sessions); expect(f.store.db.prepare('SELECT * FROM errors').all()).toEqual(anomalies);
    expect(f.store.mirrorState(f.id)).toEqual(state); expect(f.store.mirrorEvents(f.id)).toEqual(events);
    const restarted = new ExhibitionMirrors(f.directory, { now: f.now }); restarted.attachLiveService(f.service);
    expect(() => restarted.getMirror(f.id)).toThrow(code('EXHIBITION_MIRROR_NOT_FOUND'));
    expect(f.store.get(sessions[0].id)).toEqual(sessions[0]);
    expect((await f.service.stop(sessions[0].id)).status).toBe('issuance_unknown');
    expect(f.store.get(sessions[0].id)).toEqual(sessions[0]);
  });

  it('does not treat tokenless unknown rows with provider expiry or session identity as archivable', async () => {
    const f = await fixture(); f.issue.mockRejectedValueOnce(new ApiError('PROVIDER_NETWORK_ERROR', 'unknown', 502));
    await expect(f.service.createExhibition({ mirrorId: f.id, lookId: 'commute', deviceId: 'unknown-evidence-screen', name: '历史异常', referenceAsset: '/assets/exhibition/commute-cutout.png', sessionNumber: 1, generationNumber: 1 })).rejects.toThrow();
    const id = f.store.list()[0].id;
    for (const patch of [{ expiresAt: new Date(f.now() + 120_000).toISOString(), providerSessionId: undefined }, { expiresAt: undefined, providerSessionId: 'ums-existing-provider-session' }]) {
      f.store.update(id, patch); expect(f.remove).toThrow(code('EXHIBITION_MIRROR_BUSY'));
    }
    f.store.update(id, { expiresAt: undefined, providerSessionId: undefined }); expect(f.remove().mirrors).toHaveLength(1);
  });

  it('blocks delayed issuance even if recovery relabels the pending reservation as tokenless unknown', async () => {
    const f = await fixture(); const issued = deferred<IssuedKey>(); f.issue.mockImplementationOnce(() => issued.promise);
    const issuing = f.service.createExhibition({ mirrorId: f.id, lookId: 'commute', deviceId: 'late-issuance-screen', name: '迟到签发', referenceAsset: '/assets/exhibition/commute-cutout.png', sessionNumber: 1, generationNumber: 1 });
    expect(f.store.list()[0].status).toBe('reserved'); expect(f.remove).toThrow(code('EXHIBITION_MIRROR_BUSY'));
    // Recovery can reclassify a reservation, but it cannot prove an in-flight
    // provider promise has settled; the runtime issuance guard must still win.
    await f.service.recover(); const pending = f.store.list()[0];
    expect(pending).toMatchObject({ status: 'issuance_unknown', errorCode: 'RESTART_DURING_ISSUANCE' });
    expect(pending.tokenCipher).toBeUndefined(); expect(f.mirror.read().live).toBeNull();
    expect(f.remove).toThrow(code('EXHIBITION_MIRROR_BUSY'));
    const other = f.mirrors.create({ name: '其他可删除镜子' });
    expect(f.mirrors.remove(other.id, { expectedRevision: other.revision }).mirrors.map(mirror => mirror.id)).toContain(f.id);
    issued.resolve({ token: 'tk-delayed-still-owned', expiresAt: new Date(f.now() + 120_000).toISOString() });
    const session = await issuing;
    expect(f.store.get(session.id)).toMatchObject({ status: 'active', tokenCipher: expect.any(String) });
    expect(f.remove).toThrow(code('EXHIBITION_MIRROR_BUSY'));
    await f.service.stop(session.id); expect(f.store.get(session.id).status).toBe('stopped');
    expect(f.remove().mirrors).toHaveLength(1);
  });

  it('releases the in-flight guard when reservation persistence fails before contacting the provider', async () => {
    const f = await fixture(); vi.spyOn(f.store, 'reserve').mockImplementationOnce(() => { throw new Error('isolated write failure'); });
    await expect(f.service.createExhibition({ mirrorId: f.id, lookId: 'commute', deviceId: 'failed-reservation-screen', name: '写入失败', referenceAsset: '/assets/exhibition/commute-cutout.png', sessionNumber: 1, generationNumber: 1 })).rejects.toThrow('isolated write failure');
    expect(f.store.list()).toEqual([]); expect(f.issue).not.toHaveBeenCalled();
    expect(f.remove().mirrors).toHaveLength(1);
  });

  it('finishes already-open changes requests with 404 when the mirror is removed', async () => {
    const f = await fixture(); const subscribed = deferred<void>(); const subscribe = f.mirror.subscribe.bind(f.mirror);
    vi.spyOn(f.mirror, 'subscribe').mockImplementation(listener => { const unsubscribe = subscribe(listener); subscribed.resolve(); return unsubscribe; });
    const changing = f.request(`/changes?after=${f.mirror.get().revision}`); await subscribed.promise; f.remove();
    expect((await changing).status).toBe(404); expect(await (await changing).json()).toMatchObject({ code: 'EXHIBITION_MIRROR_NOT_FOUND' });
  });

  it('rejects a slow request body completed after deletion before it mutates archived state', async () => {
    const f = await fixture(); const entered = deferred<void>();
    f.server.once('request', () => entered.resolve());
    const body = JSON.stringify({ action: 'configure', autoReturnSeconds: 180 });
    const pending = httpRequest(f.base + f.path + '/command', { method: 'POST', headers: {
      Origin: 'http://xuminghong.local:10200', 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body),
    } });
    const response = new Promise<number>(resolve => { pending.on('response', value => { value.resume(); resolve(value.statusCode!); }); });
    pending.flushHeaders(); await entered.promise;
    const file = join(f.directory, 'exhibition-mirrors', f.id, 'exhibition.json'); const before = readFileSync(file);
    f.remove(); pending.end(body);
    expect(await response).toBe(404); expect(readFileSync(file)).toEqual(before);
  });
});
