import { LifecycleTryOnService } from './support/lifecycleReferenceFixture';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DecartProvider } from '../server/decart';
import { MirrorCredentialStore } from '../server/mirrorCredentials';
import { ExhibitionService } from '../server/exhibition';
import { TryOnService } from '../server/service';
import { SecretBox, SessionStore } from '../server/store';
import type { IssuedKey, KeyStatus, Provider } from '../server/types';
import type { ExhibitionState } from '../shared/exhibition';
import { ExhibitionLiveConnection, type ExhibitionLiveDeps } from '../src/exhibition/useExhibitionLive';

type Input = Parameters<ExhibitionLiveDeps['create']>[0];
const connections: ExhibitionLiveConnection[] = [];
const cleanup: Array<() => void> = [];
const owner = 'renewal-owner-screen';
async function flush() { for (let index = 0; index < 80; index++) await Promise.resolve(); }
function clientData<T extends { expiresAt?: string }>(record: T): T & { expiresAt: string } {
  if (!record.expiresAt) throw new Error('Missing credential expiry');
  return { ...record, expiresAt: record.expiresAt };
}
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-14T04:00:00.000Z')); });
afterEach(async () => {
  for (const connection of connections.splice(0)) await connection.stop();
  for (const dispose of cleanup.splice(0)) dispose();
  vi.clearAllTimers(); vi.useRealTimers();
});

function fixture(expireSeconds = 120, decart = false) {
  const directory = mkdtempSync(join(tmpdir(), 'openbuy-renewal-flow-'));
  const store = new SessionStore(':memory:'); const keys = new Map<string, KeyStatus>();
  cleanup.push(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  const activeKeysAtIssue: number[] = [];
  const issue = vi.fn(async (_points: number, seconds: number): Promise<IssuedKey> => {
    activeKeysAtIssue.push([...keys.values()].filter(key => key.status === 'active').length);
    const token = `tk-renewal-flow-${keys.size + 1}`; const expiresAt = new Date(Date.now() + seconds * 1000).toISOString();
    keys.set(token, { status: 'active', consumedCredit: 0, expireTimestamp: expiresAt });
    return { token, expiresAt };
  });
  const deactivate = vi.fn(async (token: string) => {
    const stopped = { ...keys.get(token)!, status: 'inactive' as const }; keys.set(token, stopped); return stopped;
  });
  const provider: Provider = { configured: true, issueKey: issue, keyStatus: async token => keys.get(token)!, deactivate,
    sessionStatus: async (token, sessionUid) => ({ sessionUid, status: 'ACTIVE', consumedCredit: keys.get(token)!.consumedCredit }) };
  const secrets = new SecretBox(randomBytes(32));
  const credentials = new MirrorCredentialStore(directory, secrets);
  if (decart) credentials.saveProvider('default', { provider: 'decart', apiKey: 'dct_fixture', expectedRevision: 0 }, true);
  const decartFetch = vi.fn<typeof fetch>(async (_url, init) => Response.json({ apiKey: 'ek_fixture', expiresAt: new Date(Date.now() + 30_000).toISOString(), constraints: JSON.parse(init!.body as string).constraints }));
  const service = new LifecycleTryOnService({ provider, store, secrets, mirrorCredentials: credentials, decartProvider: key => new DecartProvider(key, decartFetch), resolveHost: async () => ['8.8.8.8'] });
  const exhibition = new ExhibitionService(directory, { now: () => Date.now() }); exhibition.attachLiveService(service);
  exhibition.command({ action: 'configure', providerMode: 'xmax', autoReturnSeconds: 90, sessionLimits: { credits: null, expireSeconds } });
  exhibition.command({ action: 'begin' });

  const originalStop = vi.fn(); const originalTrack = { readyState: 'live', stop: originalStop };
  const stream = { getVideoTracks: () => [originalTrack], getTracks: () => [originalTrack] } as unknown as MediaStream;
  const callbacks = new Map<string, Parameters<ExhibitionLiveDeps['connect']>[2]>();
  const sdks: Array<{ disconnect: ReturnType<typeof vi.fn>; set: ReturnType<typeof vi.fn> }> = [];
  const statesAfterStopRoute: ExhibitionState[] = [];
  const deps = {
    preparedReference: vi.fn(async (input: Input) => exhibition.readyReference(input.lookId, true)),
    create: vi.fn(async (input: Input) => {
      const created = await exhibition.createLiveSession(input);
      if (!created.exhibition) throw new Error('Missing exhibition ownership');
      return { ...clientData(created), exhibition: created.exhibition };
    }),
    reference: vi.fn(async () => new File(['garment'], 'garment.png', { type: 'image/png' })),
    prepare: vi.fn(async () => {}), upload: vi.fn(async () => decart ? 'file_fixture' : 'https://uploads.example/garment.webp'),
    bind: vi.fn(async (id, input) => clientData(await exhibition.bindLiveReference(id, input))),
    link: vi.fn(async (id, providerSessionId) => clientData(await service.link(id, providerSessionId))),
    firstFrame: vi.fn(async (id, firstFrameMs) => {
      const record = await service.firstFrame(id, firstFrameMs); exhibition.liveFirstFrame(id, record.firstFrameMs!);
      return clientData(record);
    }),
    // This is the same stop -> reconcile ordering as the actual HTTP route.
    stop: vi.fn(async id => {
      const record = await service.stop(id); await exhibition.reconcileLive();
      statesAfterStopRoute.push(exhibition.get()); return clientData(record);
    }),
    heartbeat: vi.fn(async (id, deviceId) => exhibition.heartbeat({ sessionId: id, deviceId })),
    reportError: vi.fn(async input => exhibition.reportLiveError(input)),
    prepareRenewal: vi.fn(async (id, input) => exhibition.prepareLiveRenewal(id, input)),
    commitRenewal: vi.fn(async (id, input) => exhibition.commitLiveRenewal(id, input)),
    connect: vi.fn(async (_source, local, value) => {
      callbacks.set(local.id, value);
      if (decart) await service.decartDial(local.id, local.releaseKey);
      const sdk = { getSessionUid: vi.fn(() => `ums-flow-${local.id}`), set: vi.fn(async () => {}),
        disconnect: vi.fn(async () => { if (decart) service.clientReleased(local.id, local.releaseKey); }), stopGeneration: vi.fn(async () => {}), stopLocalStream: vi.fn(async () => {}) };
      sdks.push(sdk); return sdk;
    }),
    clone: vi.fn(() => {
      const track = { readyState: 'live', stop: vi.fn(), onended: null };
      return { getVideoTracks: () => [track], getTracks: () => [track] } as unknown as MediaStream;
    }), now: () => performance.now(),
  } satisfies ExhibitionLiveDeps;
  const events = { status: vi.fn(), stream: vi.fn(), refresh: vi.fn(), updateError: vi.fn() };
  const connection = () => {
    const state = exhibition.get(); const look = state.looks.find(value => value.id === state.selectedLookId)!;
    const controller = new ExhibitionLiveConnection({ mirrorId: exhibition.mirrorId, deviceId: owner, sessionNumber: state.sessionNumber,
      generationNumber: state.generationNumber, expectedRevision: state.revision, lookId: look.id, image: look.image,
      mode: state.experienceMode, prompt: look.prompt, referenceKind: look.referenceKind, stream }, events, deps);
    connections.push(controller); return controller;
  };
  const ready = async (controller: ExhibitionLiveConnection) => {
    await controller.start();
    expect(events.status).not.toHaveBeenCalledWith('error', expect.any(String));
    const output = { id: `remote-${controller.sessionId}` } as MediaStream;
    callbacks.get(controller.sessionId!)!.onRemoteStream(output); controller.reportRenderedFrame(output); await flush();
  };
  return { exhibition, service, store, keys, issue, deactivate, activeKeysAtIssue, decartFetch, deps, sdks, statesAfterStopRoute,
    originalStop, events, connection, ready, callbacks };
}

describe('continuous exhibition renewal across the real services and client lifecycle', () => {
  it('keeps the stop-route plan, starts the next bounded segment for the same owner, then stays ended after manual stop', async () => {
    const f = fixture(); const first = f.connection(); await f.ready(first);
    const firstId = first.sessionId!; const running = f.exhibition.get();
    expect(running).toMatchObject({ phase: 'showcase', sessionNumber: 1, generationNumber: 1, live: { sessionId: firstId, deviceId: owner, status: 'running' } });
    expect(f.store.get(firstId)).toMatchObject({ pointsLimit: 3000, exhibition: { continuous: true, deviceId: owner, sessionNumber: 1, generationNumber: 1 } });
    expect(f.issue).toHaveBeenCalledExactlyOnceWith(3000, 120);
    // The real backend heartbeat announces the 20-second preparation window;
    // the client's 15-second expiry timer remains a fallback.
    await vi.advanceTimersByTimeAsync(99_999);
    expect(f.exhibition.get().phase).toBe('showcase'); expect(f.deps.prepareRenewal).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(5_001);
    expect(f.deps.prepareRenewal).toHaveBeenCalledOnce(); expect(f.deps.commitRenewal).toHaveBeenCalledOnce();
    expect(f.store.get(firstId).status).toBe('stopped'); expect(f.sdks[0].disconnect).toHaveBeenCalledOnce();
    expect(f.statesAfterStopRoute[0]).toMatchObject({ phase: 'showcase', sessionNumber: 1, generationNumber: 1,
      live: { sessionId: firstId, deviceId: owner, renewal: { id: expect.any(String) } } });
    const handoff = f.exhibition.get();
    expect(handoff).toMatchObject({ phase: 'generating', sessionNumber: 1, generationNumber: 2, live: null,
      selectedLookId: running.selectedLookId, displayedLookId: running.displayedLookId });
    await expect(f.exhibition.createLiveSession({ deviceId: 'another-screen-device', lookId: handoff.selectedLookId,
      generationNumber: handoff.generationNumber })).rejects.toMatchObject({ code: 'EXHIBITION_OWNER_MISMATCH' });
    expect(f.issue).toHaveBeenCalledOnce();

    const second = f.connection(); await f.ready(second);
    const secondId = second.sessionId!; expect(secondId).not.toBe(firstId);
    expect(f.issue.mock.calls).toEqual([[3000, 120], [3000, 120]]); expect(f.activeKeysAtIssue).toEqual([0, 0]);
    expect(f.store.get(secondId)).toMatchObject({ status: 'active', pointsLimit: 3000,
      exhibition: { continuous: true, deviceId: owner, sessionNumber: 1, generationNumber: 2, lookId: running.selectedLookId } });
    expect(f.exhibition.get()).toMatchObject({ phase: 'showcase', sessionNumber: 1, generationNumber: 2,
      live: { sessionId: secondId, deviceId: owner, status: 'running' } });
    expect(f.originalStop).not.toHaveBeenCalled();
    f.exhibition.command({ action: 'end' }); await second.stop(); await f.exhibition.reconcileLive();
    expect(f.exhibition.get()).toMatchObject({ phase: 'select', live: null });
    await vi.advanceTimersByTimeAsync(120_000); await f.exhibition.sweepLive();
    expect(f.exhibition.get()).toMatchObject({ phase: 'idle', live: null });
    expect(f.store.list()).toHaveLength(2); expect(f.store.list().every(record => record.status === 'stopped')).toBe(true);
    expect(f.issue).toHaveBeenCalledTimes(2); expect(f.deps.prepareRenewal).toHaveBeenCalledOnce();
    expect(f.deps.reportError).not.toHaveBeenCalled(); expect(f.originalStop).not.toHaveBeenCalled();
  });

  it('uses provider usage near the segment limit to plan a safe renewal before the expiry timer', async () => {
    const f = fixture(3600); const first = f.connection(); await f.ready(first);
    const firstId = first.sessionId!;
    f.keys.values().next().value!.consumedCredit = 2970;
    await f.service.get(firstId);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(f.deps.prepareRenewal).toHaveBeenCalledOnce(); expect(f.deps.commitRenewal).toHaveBeenCalledOnce();
    expect(f.store.get(firstId)).toMatchObject({ status: 'stopped', consumedCredits: 2970 });
    expect(f.exhibition.get()).toMatchObject({ phase: 'generating', sessionNumber: 1, generationNumber: 2, live: null });
    const second = f.connection(); await f.ready(second);
    expect(f.activeKeysAtIssue).toEqual([0, 0]); expect(f.issue.mock.calls).toEqual([[3000, 3600], [3000, 3600]]);
    expect(f.deps.reportError).not.toHaveBeenCalled();
  });

  it('pauses an unexpected provider disconnect without treating it as a planned continuation', async () => {
    const f = fixture(); const first = f.connection(); await f.ready(first);
    const firstId = first.sessionId!;
    f.keys.values().next().value!.status = 'inactive';
    f.callbacks.get(firstId)!.onDisconnect('server_error'); await flush();
    await f.exhibition.reconcileLive(); await vi.advanceTimersByTimeAsync(120_000);
    expect(f.exhibition.get()).toMatchObject({ phase: 'paused', live: null });
    expect(f.deps.prepareRenewal).not.toHaveBeenCalled(); expect(f.deps.commitRenewal).not.toHaveBeenCalled();
    expect(f.issue).toHaveBeenCalledOnce(); expect(f.store.get(firstId).status).toBe('stopped');
  });
});


it.each([false, true])('simulates four hours of continuous bounded segments (Decart=%s) without overlapping leases', async decart => {
  const f = fixture(120, decart);
  const segments = 138; // 138 × 105 seconds = 4h 1m 30s of simulated exhibition time.
  const dns = vi.fn(async () => { throw new Error('DNS unavailable during exhibition'); });
  f.service.options.resolveHost = dns;
  for (let segment = 0; segment < segments; segment++) {
    const connection = f.connection(); await f.ready(connection);
    const id = connection.sessionId!;
    expect(f.store.list().filter(row => row.status === 'active')).toHaveLength(1);
    expect(f.exhibition.get()).toMatchObject({ phase: 'showcase', sessionNumber: 1, generationNumber: segment + 1 });
    await vi.advanceTimersByTimeAsync(105_000);
    expect(f.store.get(id)).toMatchObject({ status: 'stopped', ...(decart ? { releaseEvidence: 'client_transport_closed' } : {}) });
    expect(f.exhibition.get()).toMatchObject({ phase: 'generating', sessionNumber: 1, live: null });
  }
  f.exhibition.command({ action: 'end' }); await f.exhibition.reconcileLive();
  await vi.advanceTimersByTimeAsync(120_000);
  expect(f.decartFetch).toHaveBeenCalledTimes(decart ? segments : 0);
  expect(f.issue).toHaveBeenCalledTimes(decart ? 0 : segments);
  expect(f.deactivate).toHaveBeenCalledTimes(decart ? 0 : segments);
  expect(f.activeKeysAtIssue.every(count => count === 0)).toBe(true);
  expect(f.store.list()).toHaveLength(segments);
  expect(f.store.list().every(record => record.status === 'stopped')).toBe(true);
  expect(dns).not.toHaveBeenCalled();
  expect(f.deps.upload).not.toHaveBeenCalled();
  expect(f.deps.reportError).not.toHaveBeenCalled(); expect(f.originalStop).not.toHaveBeenCalled();
}, 30_000);
