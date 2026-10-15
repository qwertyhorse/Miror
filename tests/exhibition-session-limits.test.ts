import { LifecycleTryOnService } from './support/lifecycleReferenceFixture';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ExhibitionMirrors } from '../server/exhibitionMirrors.ts';
import { TryOnService, type ServiceOptions } from '../server/service.ts';
import { SecretBox, SessionStore } from '../server/store.ts';
import { createApiServer } from '../server/http.ts';
import type { ExhibitionService } from '../server/exhibition.ts';
import type { IssuedKey, KeyStatus, Provider } from '../server/types.ts';
import { SESSION_CREDIT_MAX, SESSION_EXPIRY_MAX } from '../shared/sessionLimits.ts';

const cleanup: (() => void)[] = [];
afterEach(() => cleanup.splice(0).forEach(fn => fn()));
const code = (value: string) => expect.objectContaining({ code: value });
const deviceId = 'session-limits-screen';
const origin = 'http://xuminghong.local:10200';

function fixture(defaults: Pick<ServiceOptions, 'perSessionLimit' | 'expireSeconds'> = {}) {
  let time = Date.now();
  const directory = mkdtempSync(join(tmpdir(), 'openbuy-session-limits-'));
  const store = new SessionStore(':memory:'); const keys = new Map<string, KeyStatus>();
  cleanup.push(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  const issue = vi.fn(async (_credits: number, seconds: number): Promise<IssuedKey> => {
    const token = `tk-limits-${keys.size + 1}`; const expiresAt = new Date(time + seconds * 1000).toISOString();
    keys.set(token, { status: 'active', consumedCredit: 0, expireTimestamp: expiresAt });
    return { token, expiresAt };
  });
  const deactivate = vi.fn(async (token: string) => {
    const value = { ...keys.get(token)!, status: 'inactive' as const }; keys.set(token, value); return value;
  });
  const provider: Provider = { configured: true, issueKey: issue, keyStatus: async token => keys.get(token)!, deactivate,
    sessionStatus: async (_token, sessionUid) => ({ sessionUid, status: 'ACTIVE', consumedCredit: 0 }) };
  const options: ServiceOptions = { provider, store, secrets: new SecretBox(randomBytes(32)), resolveHost: async () => ['8.8.8.8'], ...defaults };
  const service = new LifecycleTryOnService(options);
  const mirrors = new ExhibitionMirrors(directory, { now: () => time }); mirrors.attachLiveService(service);
  const exhibition = mirrors.getMirror();
  return { directory, store, keys, issue, deactivate, provider, options, service, mirrors, exhibition, now: () => time,
    advance: (ms: number) => { time += ms; } };
}
function start(exhibition: ExhibitionService) {
  exhibition.command({ action: 'configure', providerMode: 'xmax', autoReturnSeconds: 0 });
  return exhibition.command({ action: 'begin' });
}
function create(exhibition: ExhibitionService, extra: Record<string, unknown> = {}) {
  const state = exhibition.get();
  return exhibition.createLiveSession({ deviceId, lookId: state.selectedLookId, generationNumber: state.generationNumber, ...extra });
}

describe('per-mirror session limits', () => {
  it('defaults missing persisted settings to continuous while preserving the configured credential duration', () => {
    const { exhibition, service, directory, now } = fixture({ perSessionLimit: 70, expireSeconds: 450 });
    expect(exhibition.get().settings.sessionLimits).toEqual({ credits: null, expireSeconds: 450 });
    expect(exhibition.liveStatus()).toMatchObject({ perSessionLimit: 3000, expireSeconds: 450 });
    const filename = join(directory, 'exhibition-mirrors/default/exhibition.json');
    expect(JSON.parse(readFileSync(filename, 'utf8')).state.settings).not.toHaveProperty('sessionLimits');
    const restored = new ExhibitionMirrors(directory, { now }); restored.attachLiveService(service);
    expect(restored.getMirror().get()).toEqual(exhibition.get());
    expect(JSON.parse(readFileSync(filename, 'utf8')).state.settings).not.toHaveProperty('sessionLimits');
  });

  it('issues numeric bounded segments by default without changing standalone credential defaults', async () => {
    const { exhibition, issue, service, store } = fixture();
    expect(service.perSessionLimit).toBe(30); expect(service.expireSeconds).toBe(120);
    start(exhibition); const session = await create(exhibition);
    expect(issue).toHaveBeenCalledExactlyOnceWith(3000, 120);
    expect(session).toMatchObject({ pointsLimit: 3000, exhibition: { continuous: true } });
    expect(store.get(session.id)).toMatchObject({ pointsLimit: 3000, exhibition: { continuous: true } });
  });

  it.each([1, 59])('raises a short service duration of %s only for the missing continuous setting', async expireSeconds => {
    const { exhibition, issue, service } = fixture({ expireSeconds });
    expect(service.expireSeconds).toBe(expireSeconds);
    expect(exhibition.get().settings.sessionLimits).toEqual({ credits: null, expireSeconds: 60 });
    start(exhibition); await create(exhibition);
    expect(issue).toHaveBeenCalledExactlyOnceWith(3000, 60);
  });

  it('preserves an explicitly saved old finite default and short duration after restart', () => {
    const { exhibition, service, directory, now } = fixture({ expireSeconds: 450 });
    exhibition.command({ action: 'configure', sessionLimits: { credits: 30, expireSeconds: 1 } });
    const restored = new ExhibitionMirrors(directory, { now }); restored.attachLiveService(service);
    expect(restored.getMirror().get().settings.sessionLimits).toEqual({ credits: 30, expireSeconds: 1 });
    expect(restored.getMirror().liveStatus()).toMatchObject({ perSessionLimit: 30, expireSeconds: 1 });
  });

  it('persists and clones an isolated mirror setting without creating a session', () => {
    const { exhibition, mirrors, directory, service, now, issue } = fixture();
    const other = mirrors.getMirror(mirrors.create({ name: '第二台镜' }).id);
    const value = { credits: 150, expireSeconds: 600 };
    const saved = exhibition.command({ action: 'configure', sessionLimits: value, expectedRevision: exhibition.get().revision });
    expect(saved.settings.sessionLimits).toEqual(value);
    value.credits = 1; saved.settings.sessionLimits!.expireSeconds = 1;
    expect(exhibition.get().settings.sessionLimits).toEqual({ credits: 150, expireSeconds: 600 });
    expect(other.get().settings.sessionLimits).toEqual({ credits: null, expireSeconds: 120 });
    const restored = new ExhibitionMirrors(directory, { now }); restored.attachLiveService(service);
    expect(restored.getMirror().get()).toEqual(exhibition.get());
    expect(restored.getMirror(other.mirrorId).get()).toEqual(other.get());
    expect(issue).not.toHaveBeenCalled();
  });

  it('accepts the finite boundaries without clamping service or mirror values', async () => {
    const { options, exhibition, issue, store } = fixture();
    const upper = new LifecycleTryOnService({ ...options, perSessionLimit: SESSION_CREDIT_MAX, expireSeconds: SESSION_EXPIRY_MAX });
    expect(upper.perSessionLimit).toBe(SESSION_CREDIT_MAX); expect(upper.expireSeconds).toBe(SESSION_EXPIRY_MAX);
    for (const value of [{ credits: 1, expireSeconds: 1 }, { credits: SESSION_CREDIT_MAX, expireSeconds: SESSION_EXPIRY_MAX }]) {
      expect(exhibition.command({ action: 'configure', sessionLimits: value }).settings.sessionLimits).toEqual(value);
    }
    start(exhibition); const session = await create(exhibition);
    expect(issue).toHaveBeenCalledWith(SESSION_CREDIT_MAX, SESSION_EXPIRY_MAX);
    expect(store.get(session.id).pointsLimit).toBe(SESSION_CREDIT_MAX);
  });

  it.each([
    { perSessionLimit: 0 }, { perSessionLimit: -1 }, { perSessionLimit: 30.5 }, { perSessionLimit: NaN },
    { perSessionLimit: Infinity }, { perSessionLimit: SESSION_CREDIT_MAX + 1 },
    { expireSeconds: 0 }, { expireSeconds: -1 }, { expireSeconds: 120.5 }, { expireSeconds: NaN },
    { expireSeconds: Infinity }, { expireSeconds: SESSION_EXPIRY_MAX + 1 },
  ])('rejects invalid service defaults %j', invalid => {
    const { options } = fixture();
    expect(() => new LifecycleTryOnService({ ...options, ...invalid })).toThrow('Invalid temporary credential configuration');
  });

  it('rejects invalid and incomplete settings without touching memory or disk', () => {
    const { exhibition, directory } = fixture(); const before = exhibition.get();
    const file = join(directory, 'exhibition-mirrors/default/exhibition.json'); const persisted = readFileSync(file);
    const valid = { credits: 100, expireSeconds: 600 };
    const invalid = [null, [], {}, '30', { credits: 30 }, { expireSeconds: 120 }, { ...valid, unknown: true },
      ...[0, -1, 1.5, NaN, Infinity, '30', undefined, SESSION_CREDIT_MAX + 1].map(credits => ({ ...valid, credits })),
      { credits: null, expireSeconds: 59 },
      ...[0, -1, 1.5, NaN, Infinity, '120', undefined, null, SESSION_EXPIRY_MAX + 1].map(expireSeconds => ({ ...valid, expireSeconds }))];
    for (const sessionLimits of invalid) {
      expect(() => exhibition.command({ action: 'configure', sessionLimits, autoReturnSeconds: 180 })).toThrow(code('EXHIBITION_INVALID_SETTINGS'));
      expect(exhibition.get()).toEqual(before); expect(readFileSync(file)).toEqual(persisted);
    }
    expect(() => exhibition.command({ action: 'configure', sessionLimits: valid, autoReturnSeconds: 14 })).toThrow(code('EXHIBITION_INVALID_SETTINGS'));
    expect(exhibition.get()).toEqual(before); expect(readFileSync(file)).toEqual(persisted);
  });

  it('rejects stale settings and prevents changes during a round or an unreleased live lease', async () => {
    const { exhibition } = fixture(); const revision = exhibition.get().revision;
    const limits = { credits: 80, expireSeconds: 300 };
    exhibition.command({ action: 'configure', sessionLimits: limits, expectedRevision: revision });
    expect(() => exhibition.command({ action: 'configure', sessionLimits: { credits: 90, expireSeconds: 900 }, expectedRevision: revision })).toThrow(code('EXHIBITION_STALE_REVISION'));
    start(exhibition); await create(exhibition);
    expect(() => exhibition.command({ action: 'configure', sessionLimits: limits })).toThrow(code('EXHIBITION_INVALID_PHASE'));
    exhibition.command({ action: 'end' });
    expect(exhibition.get().live?.status).toBe('stopping');
    expect(() => exhibition.command({ action: 'configure', sessionLimits: limits })).toThrow(code('EXHIBITION_MIRROR_BUSY'));
  });

  it('issues both server-owned parameters independently for concurrent mirrors, ignoring client overrides', async () => {
    const { exhibition, mirrors, issue, store } = fixture();
    const other = mirrors.getMirror(mirrors.create({ name: '第二台镜' }).id);
    exhibition.command({ action: 'configure', sessionLimits: { credits: 100, expireSeconds: 600 } });
    other.command({ action: 'configure', sessionLimits: { credits: 45, expireSeconds: 240 } });
    start(exhibition); start(other);
    const [first, second] = await Promise.all([
      create(exhibition, { sessionLimits: { credits: 999, expireSeconds: 999 }, credits: 999, expireSeconds: 999, pointsLimit: 999 }), create(other),
    ]);
    expect(issue.mock.calls).toEqual([[100, 600], [45, 240]]);
    expect(store.get(first.id)).toMatchObject({ pointsLimit: 100, exhibition: { mirrorId: 'default' } });
    expect(store.get(second.id)).toMatchObject({ pointsLimit: 45, exhibition: { mirrorId: other.mirrorId } });
    expect(Date.parse(first.expiresAt!) - Date.parse(second.expiresAt!)).toBe(360_000);
  });

  it('keeps the active record limit authoritative for exhaustion rather than the global default', async () => {
    const { exhibition, service, store, keys, deactivate } = fixture();
    exhibition.command({ action: 'configure', sessionLimits: { credits: 80, expireSeconds: 600 } });
    start(exhibition); const session = await create(exhibition);
    keys.get(session.token)!.consumedCredit = 40;
    await service.get(session.id);
    await exhibition.sweepLive();
    expect(store.get(session.id).status).toBe('active'); expect(deactivate).not.toHaveBeenCalled();
    keys.get(session.token)!.consumedCredit = 80;
    await service.get(session.id);
    await exhibition.sweepLive();
    expect(store.get(session.id).status).toBe('stopped'); expect(deactivate).toHaveBeenCalledTimes(1);
  });

  it('copies session limits only when settings are selected', () => {
    const { exhibition, mirrors } = fixture();
    const target = mirrors.getMirror(mirrors.create({ name: '第二台镜' }).id);
    exhibition.command({ action: 'configure', sessionLimits: { credits: 150, expireSeconds: 600 } });
    target.command({ action: 'configure', sessionLimits: { credits: 60, expireSeconds: 300 } });
    const copiedLooks = target.copyFrom(exhibition, { expectedRevision: target.get().revision, copyLooks: true, copySettings: false });
    expect(copiedLooks.settings.sessionLimits).toEqual({ credits: 60, expireSeconds: 300 });
    const copiedSettings = target.copyFrom(exhibition, { expectedRevision: target.get().revision, copyLooks: false, copySettings: true });
    expect(copiedSettings.settings.sessionLimits).toEqual({ credits: 150, expireSeconds: 600 });
    copiedSettings.settings.sessionLimits!.credits = 1;
    expect(exhibition.get().settings.sessionLimits?.credits).toBe(150); expect(target.get().settings.sessionLimits?.credits).toBe(150);
  });

  it('guards direct service callers before reserving and uses valid service defaults when omitted', async () => {
    const { service, issue, store } = fixture({ perSessionLimit: 55, expireSeconds: 400 });
    const input = { mirrorId: 'default', lookId: 'commute', deviceId, name: '测试', referenceAsset: '/assets/exhibition/commute-cutout.png', sessionNumber: 1, generationNumber: 1 };
    for (const sessionLimits of [{ credits: null, expireSeconds: 59 }, { credits: 0, expireSeconds: 300 }, { credits: 100, expireSeconds: SESSION_EXPIRY_MAX + 1 }]) {
      await expect(service.createExhibition({ ...input, sessionLimits })).rejects.toMatchObject({ code: 'EXHIBITION_INVALID_SETTINGS' });
    }
    expect(store.list()).toEqual([]); expect(issue).not.toHaveBeenCalled();
    const session = await service.createExhibition(input);
    expect(issue).toHaveBeenCalledWith(55, 400); expect(store.get(session.id).pointsLimit).toBe(55);
  });

  it('exposes effective limits on HTTP state/status and preserves origin checks and server authority', async () => {
    const { service, mirrors, issue } = fixture({ perSessionLimit: 40, expireSeconds: 200 });
    const server = createApiServer(service, [origin], undefined, mirrors);
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/exhibition/mirrors/default`;
    const post = (path: string, value: unknown, headers: Record<string, string> = {}) => fetch(base + path, {
      method: 'POST', headers: { 'X-Miror-Protocol': '2', 'X-Miror-Material': 'binding-v1', 'Content-Type': 'application/json', Origin: origin, ...headers }, body: JSON.stringify(value),
    });
    try {
      expect(await (await fetch(base)).json()).toMatchObject({ settings: { sessionLimits: { credits: null, expireSeconds: 200 } } });
      expect(await (await fetch(base + '/live/status')).json()).toMatchObject({ perSessionLimit: 3000, expireSeconds: 200 });
      const configure = { action: 'configure', sessionLimits: { credits: 120, expireSeconds: 600 } };
      for (const headers of [{ Origin: 'http://untrusted.example' }, { 'Sec-Fetch-Site': 'cross-site' }]) {
        const response = await post('/command', configure, headers); expect(response.status).toBe(403);
      }
      const saved = await post('/command', configure); expect(saved.status).toBe(200);
      expect(await saved.json()).toMatchObject({ settings: { sessionLimits: configure.sessionLimits } });
      expect(await (await fetch(base + '/live/status')).json()).toMatchObject({ perSessionLimit: 120, expireSeconds: 600 });
      expect(await (await fetch(base + '/credentials')).json()).toMatchObject({ perSessionLimit: 120 });
      expect((await post('/command', { action: 'configure', providerMode: 'xmax', autoReturnSeconds: 0 })).status).toBe(200);
      const state = await (await post('/command', { action: 'begin' })).json();
      const response = await post('/live/session', { deviceId, lookId: state.selectedLookId, generationNumber: state.generationNumber,
        sessionLimits: { credits: null, expireSeconds: 1 }, perSessionLimit: 1, expireSeconds: 1 });
      expect(response.status).toBe(201); expect(await response.json()).toMatchObject({ pointsLimit: 120 });
      expect(issue).toHaveBeenCalledWith(120, 600);
    } finally { server.close(); await once(server, 'close'); }
  });
});

async function runningContinuous() {
  const context = fixture(); const { exhibition, service } = context;
  exhibition.command({ action: 'configure', sessionLimits: { credits: null, expireSeconds: 120 } });
  start(exhibition); const session = await create(exhibition);
  await service.link(session.id, 'ums-continuous-test'); await service.firstFrame(session.id, 400); exhibition.liveFirstFrame(session.id, 400);
  return { ...context, session };
}
function prepare(exhibition: ExhibitionService, id: string, overrides: Record<string, unknown> = {}) {
  const state = exhibition.get();
  return exhibition.prepareLiveRenewal(id, { deviceId, sessionNumber: state.sessionNumber, generationNumber: state.generationNumber, ...overrides });
}
function due(context: Awaited<ReturnType<typeof runningContinuous>>) {
  for (let i = 0; i < 7; i++) { context.advance(15_000); context.exhibition.heartbeat({ deviceId, sessionId: context.session.id }); }
}

describe('continuous experience renewal', () => {
  it('persists unlimited intent but issues, reports and stores a bounded numeric segment', async () => {
    const { exhibition, service, session, issue, store, mirrors, directory, now } = await runningContinuous();
    expect(issue).toHaveBeenCalledWith(3000, 120);
    expect(session).toMatchObject({ pointsLimit: 3000, exhibition: { continuous: true } });
    expect(store.get(session.id).pointsLimit).toBe(3000);
    expect(exhibition.get().settings.sessionLimits).toEqual({ credits: null, expireSeconds: 120 });
    expect(exhibition.liveStatus()).toMatchObject({ perSessionLimit: 3000, expireSeconds: 120 });
    const target = mirrors.getMirror(mirrors.create({ name: '无限镜' }).id);
    target.copyFrom(exhibition, { expectedRevision: target.get().revision, copyLooks: false, copySettings: true });
    expect(target.get().settings.sessionLimits?.credits).toBeNull();
    const restored = new ExhibitionMirrors(directory, { now }); restored.attachLiveService(service);
    expect(restored.getMirror().get().settings.sessionLimits).toEqual({ credits: null, expireSeconds: 120 });
    expect(restored.getMirror().get().phase).toBe('select');
  });

  it('preserves the lease across stop/sweep, commits once, and hands the new generation only to its owner', async () => {
    const context = await runningContinuous(); const { exhibition, service, session, issue } = context; due(context);
    const before = exhibition.get(); expect(before.live?.renewalDue).toBe(true);
    const { renewalId } = await prepare(exhibition, session.id);
    expect(await prepare(exhibition, session.id)).toEqual({ renewalId });
    expect(exhibition.get().live?.renewal?.id).toBe(renewalId);
    for (const action of ['switch', 'next', 'previous', 'select']) {
      expect(() => exhibition.command({ action, lookId: 'city' })).toThrow(code('EXHIBITION_RENEWAL_PENDING'));
    }
    await service.stop(session.id); await exhibition.sweepLive();
    expect(exhibition.get()).toMatchObject({ phase: 'showcase', live: { sessionId: session.id, renewal: { id: renewalId } } });
    const commit = () => exhibition.commitLiveRenewal(session.id, { deviceId, renewalId });
    const results = await Promise.all([commit(), commit()]);
    for (const result of results) expect(result).toMatchObject({ phase: 'generating', live: null, sessionNumber: before.sessionNumber, generationNumber: before.generationNumber + 1 });
    expect((await commit()).generationNumber).toBe(before.generationNumber + 1);
    await expect(create(exhibition, { deviceId: 'other-screen-001' })).rejects.toMatchObject({ code: 'EXHIBITION_OWNER_MISMATCH' });
    const next = await create(exhibition);
    expect(next.exhibition).toMatchObject({ continuous: true, sessionNumber: before.sessionNumber, generationNumber: before.generationNumber + 1 });
    expect(issue).toHaveBeenCalledTimes(2); expect(issue.mock.calls).toEqual([[3000, 120], [3000, 120]]);
    await expect(create(exhibition)).rejects.toMatchObject({ code: 'EXHIBITION_DEVICE_BUSY' });
    expect((await commit()).live?.sessionId).toBe(next.id); expect(issue).toHaveBeenCalledTimes(2);
  });

  it('accepts synchronized credit proximity before expiry, while rejecting early or caller-invented proximity', async () => {
    const context = await runningContinuous(); const { exhibition, service, keys, session } = context;
    expect(exhibition.get().live?.renewalDue).toBeUndefined();
    await expect(prepare(exhibition, session.id, { consumedCredits: 3000, expiresAt: new Date().toISOString() })).rejects.toMatchObject({ code: 'EXHIBITION_RENEWAL_UNAVAILABLE' });
    keys.get(session.token)!.consumedCredit = 2969; await service.get(session.id);
    expect(exhibition.heartbeat({ deviceId, sessionId: session.id }).live?.renewalDue).toBeUndefined();
    keys.get(session.token)!.consumedCredit = 2970; await service.get(session.id);
    expect(exhibition.heartbeat({ deviceId, sessionId: session.id }).live?.renewalDue).toBe(true);
    expect(await prepare(exhibition, session.id)).toHaveProperty('renewalId');
  });

  it('does not renew finite rounds or connecting sessions without a genuine first frame', async () => {
    const context = fixture(); const { exhibition, advance } = context;
    exhibition.command({ action: 'configure', sessionLimits: { credits: null, expireSeconds: 120 } });
    start(exhibition); const session = await create(exhibition); for (let i = 0; i < 7; i++) { advance(15_000); exhibition.heartbeat({ deviceId, sessionId: session.id }); }
    await expect(prepare(exhibition, session.id)).rejects.toMatchObject({ code: 'EXHIBITION_RENEWAL_UNAVAILABLE' });
    const finite = fixture(); finite.exhibition.command({ action: 'configure', sessionLimits: { credits: 30, expireSeconds: 120 } });
    start(finite.exhibition); const finiteSession = await create(finite.exhibition);
    finite.store.update(finiteSession.id, { firstFrameMs: 400, providerSessionId: 'ums-finite' }); finite.exhibition.liveFirstFrame(finiteSession.id, 400);
    for (let i = 0; i < 7; i++) { finite.advance(15_000); finite.exhibition.heartbeat({ deviceId, sessionId: finiteSession.id }); }
    await expect(prepare(finite.exhibition, finiteSession.id)).rejects.toMatchObject({ code: 'EXHIBITION_RENEWAL_UNAVAILABLE' });
  });

  it('requires an active unexpired cloud record even when the numeric credit threshold is reached', async () => {
    for (const ending of ['expired', 'inactive', 'error'] as const) {
      const context = await runningContinuous(); const { exhibition, session, keys, service, store } = context;
      keys.get(session.token)!.consumedCredit = 2970; await service.get(session.id);
      if (ending === 'expired') { for (let i = 0; i < 8; i++) { context.advance(15_000); exhibition.heartbeat({ deviceId, sessionId: session.id }); } }
      else if (ending === 'inactive') { keys.get(session.token)!.status = 'inactive'; await service.get(session.id); }
      else store.update(session.id, { status: 'error' });
      expect(exhibition.get().live?.renewalDue).toBeUndefined();
      await expect(prepare(exhibition, session.id)).rejects.toMatchObject({ code: 'EXHIBITION_RENEWAL_UNAVAILABLE' });
    }
  });

  it('keeps HTTP mirror ownership, origin validation and the two-step stop contract for renewal', async () => {
    const context = await runningContinuous(); const { service, exhibition, mirrors, session, issue } = context; due(context);
    const other = mirrors.create({ name: '另一台镜' });
    const server = createApiServer(service, [origin], undefined, mirrors); server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/exhibition/mirrors`;
    const post = (mirrorId: string, path: string, input: unknown, requestOrigin = origin) => fetch(`${base}/${mirrorId}${path}`, {
      method: 'POST', headers: { 'X-Miror-Protocol': '2', 'X-Miror-Material': 'binding-v1', 'Content-Type': 'application/json', Origin: requestOrigin }, body: JSON.stringify(input),
    });
    try {
      const state = exhibition.get(); const path = `/live/session/${session.id}/renewal`;
      const input = { deviceId, sessionNumber: state.sessionNumber, generationNumber: state.generationNumber };
      expect((await post('default', path, input, 'https://untrusted.example')).status).toBe(403);
      const mismatch = await post(other.id, path, input); expect(mismatch.status).toBe(409); expect(await mismatch.json()).toMatchObject({ code: 'EXHIBITION_MIRROR_MISMATCH' });
      const planned = await post('default', path, input); expect(planned.status).toBe(200);
      const { renewalId } = await planned.json();
      expect((await post('default', `/sessions/${session.id}/stop`, {})).status).toBe(200);
      const polled = await (await fetch(`${base}/default`)).json(); expect(polled.live.renewal.id).toBe(renewalId);
      const continued = await post('default', path + '/commit', { deviceId, renewalId }); expect(continued.status).toBe(200);
      expect(await continued.json()).toMatchObject({ live: null, phase: 'generating', sessionNumber: state.sessionNumber, generationNumber: state.generationNumber + 1 });
      expect(issue).toHaveBeenCalledTimes(1); // Committing grants one handoff; it does not sign a key itself.
    } finally { server.close(); await once(server, 'close'); }
  });

  it.each(['deviceId', 'sessionNumber', 'generationNumber'] as const)('rejects an incorrect %s without stopping the healthy stream', async field => {
    const context = await runningContinuous(); due(context);
    await expect(prepare(context.exhibition, context.session.id, { [field]: field === 'deviceId' ? 'other-screen' : 999 })).rejects.toMatchObject({ code: 'EXHIBITION_OWNER_MISMATCH' });
    expect(context.exhibition.get().live?.renewal).toBeUndefined(); expect(context.deactivate).not.toHaveBeenCalled();
  });

  it.each(['end', 'idle', 'pause'] as const)('never resumes after a manual %s during renewal', async action => {
    const context = await runningContinuous(); const { exhibition, service, session, issue } = context; due(context);
    const before = exhibition.get(); const { renewalId } = await prepare(exhibition, session.id);
    exhibition.command({ action }); await service.stop(session.id); await exhibition.sweepLive();
    await expect(exhibition.commitLiveRenewal(session.id, { deviceId, renewalId })).rejects.toMatchObject({ code: 'EXHIBITION_RENEWAL_UNAVAILABLE' });
    expect(exhibition.get().generationNumber).toBe(before.generationNumber); expect(exhibition.get().phase).toBe(action === 'end' ? 'select' : action === 'idle' ? 'idle' : 'paused');
    expect(issue).toHaveBeenCalledTimes(1);
  });

  it('consumes a failed commit, requires confirmed revocation and cannot be retried into an automatic restart', async () => {
    const context = await runningContinuous(); const { exhibition, service, session, issue, deactivate, keys } = context; due(context);
    const { renewalId } = await prepare(exhibition, session.id);
    deactivate.mockImplementationOnce(async token => keys.get(token)!);
    await expect(service.stop(session.id)).rejects.toMatchObject({ code: 'STOP_NOT_CONFIRMED' });
    await expect(exhibition.commitLiveRenewal(session.id, { deviceId, renewalId })).rejects.toMatchObject({ code: 'EXHIBITION_RENEWAL_UNAVAILABLE' });
    expect(exhibition.get().phase).toBe('paused');
    await service.stop(session.id); await exhibition.sweepLive();
    await expect(exhibition.commitLiveRenewal(session.id, { deviceId, renewalId })).rejects.toMatchObject({ code: 'EXHIBITION_RENEWAL_UNAVAILABLE' });
    expect(exhibition.get()).toMatchObject({ phase: 'paused', live: null }); expect(issue).toHaveBeenCalledTimes(1);
  });

  it('loses renewal permission when the owner disappears, and also expires plans despite continued heartbeats', async () => {
    for (const heartbeat of [false, true]) {
      const context = await runningContinuous(); const { exhibition, service, session, advance, issue } = context; due(context);
      const { renewalId } = await prepare(exhibition, session.id); await service.stop(session.id);
      advance(10_000); if (heartbeat) exhibition.heartbeat({ deviceId, sessionId: session.id }); advance(10_000);
      await exhibition.sweepLive();
      await expect(exhibition.commitLiveRenewal(session.id, { deviceId, renewalId })).rejects.toMatchObject({ code: 'EXHIBITION_RENEWAL_UNAVAILABLE' });
      expect(exhibition.get()).toMatchObject({ phase: 'paused', live: null }); expect(issue).toHaveBeenCalledTimes(1);
    }
  });

  it('pauses a lost handoff, and preserves a failed new issuance without trying another segment', async () => {
    const context = await runningContinuous(); const { exhibition, service, session, advance, issue } = context; due(context);
    const { renewalId } = await prepare(exhibition, session.id); await service.stop(session.id);
    await exhibition.commitLiveRenewal(session.id, { deviceId, renewalId }); advance(20_000);
    await expect(create(exhibition)).rejects.toMatchObject({ code: 'EXHIBITION_INVALID_PHASE' }); expect(issue).toHaveBeenCalledTimes(1);
    const failed = await runningContinuous(); due(failed);
    const plan = await prepare(failed.exhibition, failed.session.id); await failed.service.stop(failed.session.id);
    await failed.exhibition.commitLiveRenewal(failed.session.id, { deviceId, ...plan });
    failed.issue.mockRejectedValueOnce(new Error('network failure'));
    await expect(create(failed.exhibition)).rejects.toMatchObject({ code: 'PROVIDER_UNKNOWN_ERROR' });
    await failed.exhibition.sweepLive();
    expect(failed.exhibition.get()).toMatchObject({ phase: 'paused', live: { status: 'error' } });
    await expect(create(failed.exhibition)).rejects.toMatchObject({ code: 'EXHIBITION_RECOVERY_REQUIRED' });
    expect(failed.issue).toHaveBeenCalledTimes(2);
  });

  it('keeps an active continuous round past idle timeout but still stops on heartbeat loss', async () => {
    const context = await runningContinuous(); const { exhibition, session, advance, issue, store } = context;
    // This test uses the stored setting to restore the regular 90-second timeout before the next round.
    exhibition.command({ action: 'end' }); await context.service.stop(session.id); await exhibition.sweepLive();
    exhibition.command({ action: 'configure', autoReturnSeconds: 90 }); exhibition.command({ action: 'begin' });
    const active = await create(exhibition); for (let i = 0; i < 19; i++) { advance(5_000); exhibition.heartbeat({ deviceId, sessionId: active.id }); }
    expect(exhibition.get().phase).toBe('generating');
    advance(20_000); await exhibition.sweepLive();
    expect(store.get(active.id).status).toBe('stopped'); expect(exhibition.get().phase).toBe('paused'); expect(issue).toHaveBeenCalledTimes(2);
  });
});
