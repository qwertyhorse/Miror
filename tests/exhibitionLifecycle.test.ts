import { afterEach, describe, expect, it, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ExhibitionService } from '../server/exhibition';
import { TryOnService } from '../server/service';
import { SecretBox, SessionStore } from '../server/store';
import { TerminalLease } from '../shared/exhibitionLifecycle';
import type { KeyStatus, Provider } from '../server/types';
const cleanups: (() => void)[] = [];
afterEach(() => cleanups.splice(0).forEach(fn => fn()));
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'miror-lifecycle-'));
  const store = new SessionStore(join(directory, 'sessions.sqlite'));
  let now = Date.now(); const owner = 'screen-lifecycle-owner';
  const keys = new Map<string, KeyStatus>();
  const provider: Provider = { configured: true,
    issueKey: vi.fn(async (_points, seconds) => {
      expect([...keys.values()].filter(k => k.status === 'active')).toHaveLength(0);
      const token = `tk-fixture-${keys.size}`; const expiresAt = new Date(now + seconds * 1000).toISOString();
      keys.set(token, { status: 'active', consumedCredit: 0, expireTimestamp: expiresAt }); return { token, expiresAt };
    }),
    keyStatus: async token => keys.get(token)!,
    deactivate: vi.fn(async token => { const value = { ...keys.get(token)!, status: 'inactive' as const }; keys.set(token, value); return value; }),
    sessionStatus: async (_token, sessionUid) => ({ sessionUid, status: 'ACTIVE', consumedCredit: 0 }),
  };
  const service = new TryOnService({ provider, store, secrets: new SecretBox(randomBytes(32)), resolveHost: async () => ['8.8.8.8'] });
  const open = () => { const mirror = new ExhibitionService(directory, { now: () => now }); mirror.attachLiveService(service); return mirror; };
  const mirror = open();
  mirror.command({ action: 'configure', providerMode: 'xmax', autoReturnSeconds: 0 });
  const start = () => mirror.command({ action: 'begin', commandId: 'start-command-0001' });
  const connect = async () => {
    const state = mirror.get();
    const session = await mirror.createLiveSession({ deviceId: owner, lookId: state.selectedLookId, generationNumber: state.generationNumber, expectedRevision: state.revision });
    await mirror.bindLiveReference(session.id, { deviceId: owner, lookId: state.selectedLookId, refImageUrl: 'https://fixture.example/image.webp' });
    await service.link(session.id, `ums-${session.id}`);
    await service.firstFrame(session.id, 100); mirror.liveFirstFrame(session.id, 100);
    return session;
  };
  cleanups.push(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { mirror, open, start, connect, provider, service, store, owner, advance: (ms: number) => { now += ms; } };
}
describe('experience ownership and bounded recovery', () => {
  it('deduplicates begin across reload and rejects command id reuse with different payload', () => {
    const f = fixture(); const first = f.start();
    expect(f.start().sessionNumber).toBe(first.sessionNumber);
    expect(() => f.mirror.command({ action: 'end', commandId: 'start-command-0001' })).toThrow(expect.objectContaining({ code: 'EXHIBITION_COMMAND_CONFLICT' }));
    const restored = f.open();
    expect(restored.get().lifecycle?.state).toBe('ended');
    expect(restored.command({ action: 'begin', commandId: 'start-command-0001' }).phase).toBe('select');
    expect(restored.get().sessionNumber).toBe(first.sessionNumber);
  });
  it('rejects incompatible durable lifecycle without overwriting the stored authority', () => {
    const f = fixture(); const before = f.store.mirrorState('default') as { state: { lifecycle: { protocol: number } } };
    before.state.lifecycle.protocol = 999;
    f.store.saveMirrorState('default', before, { type: 'fixture-corruption' });
    expect(() => f.open()).toThrow('Invalid durable mirror state');
    expect(f.store.mirrorState('default')).toEqual(before);
  });
  it('keeps idle grace fixed and continues only on explicit interaction', () => {
    const f = fixture();
    f.mirror.command({ action: 'configure', autoReturnSeconds: 15 }); f.start();
    f.advance(15000); const warning = f.mirror.get();
    expect(warning.lifecycle?.idleEndsAt).toBeDefined();
    f.advance(7000); expect(f.mirror.get().lifecycle?.idleEndsAt).toBe(warning.lifecycle?.idleEndsAt);
    f.mirror.command({ action: 'keepalive', commandId: 'continue-command-0001' });
    expect(f.mirror.get().lifecycle?.idleEndsAt).toBeUndefined();
    f.advance(30000); expect(f.mirror.get()).toMatchObject({ phase: 'idle', lifecycle: { reason: 'idle_end', state: 'ended' } });
  });
  it('does not acknowledge a rejected command when the timer changes state', () => {
    const f = fixture(); f.mirror.command({ action: 'configure', autoReturnSeconds: 15 }); f.start();
    f.advance(30000);
    expect(() => f.mirror.command({ action: 'next', commandId: 'rejected-command-0001' })).toThrow();
    expect(f.store.commandFingerprint('default', 'rejected-command-0001')).toBeUndefined();
    f.mirror.command({ action: 'begin' });
    expect(f.mirror.command({ action: 'next', commandId: 'rejected-command-0001' }).selectedLookId).toBe('city');
  });
  it('recovers the latest selection without ending the experience and never overlaps credentials', async () => {
    const f = fixture(); const first = f.start(); const old = await f.connect();
    f.mirror.command({ action: 'next' }); const wanted = f.mirror.get();
    await f.mirror.reportLiveError({ deviceId: f.owner, sessionId: old.id, sessionNumber: wanted.sessionNumber,
      generationNumber: wanted.generationNumber, lookId: wanted.selectedLookId, reason: 'rtc_failed', message: 'RTC interrupted' });
    const recovering = f.mirror.get();
    expect(recovering).toMatchObject({ phase: 'generating', live: null, selectedLookId: wanted.selectedLookId,
      lifecycle: { experienceId: first.lifecycle!.experienceId, connection: 'recovering', state: 'active' } });
    expect(f.store.get(old.id).status).toBe('stopped');
    f.advance(1100); await f.connect();
    expect(f.mirror.get().lifecycle?.controllerEpoch).toBeGreaterThan(first.lifecycle!.controllerEpoch);
    expect(f.provider.issueKey).toHaveBeenCalledTimes(2);
  });
  it('ends immediately and rejects a late recovery report even when the stop response is delayed', async () => {
    const f = fixture(); f.start(); const old = await f.connect(); const state = f.mirror.get();
    f.mirror.command({ action: 'end', expectedRevision: -1 });
    await expect(f.mirror.reportLiveError({ deviceId: f.owner, sessionId: old.id, sessionNumber: state.sessionNumber,
      generationNumber: state.generationNumber, lookId: state.selectedLookId, reason: 'rtc_failed', message: 'late failure' })).rejects.toMatchObject({ code: 'EXHIBITION_OWNER_MISMATCH' });
    expect(f.mirror.get()).toMatchObject({ phase: 'select', displayedLookId: null, lifecycle: { state: 'ended' } });
  });
  it('exhausts recovery allowance instead of repeatedly issuing on a failing connection', async () => {
    const f = fixture(); f.start();
    for (let i = 0; i < 3; i++) {
      const session = await f.connect(); const state = f.mirror.get();
      await f.mirror.reportLiveError({ deviceId: f.owner, sessionId: session.id, sessionNumber: state.sessionNumber,
        generationNumber: state.generationNumber, lookId: state.selectedLookId, reason: 'rtc_failed', message: 'RTC interrupted' });
      f.advance(2100);
    }
    expect(f.mirror.get()).toMatchObject({ phase: 'paused', lifecycle: { connection: 'needs_assistance' } });
    await expect(f.connect()).rejects.toThrow();
    expect(f.provider.issueKey).toHaveBeenCalledTimes(3);
  });
  it('will not resurrect an expired owner by a late heartbeat', async () => {
    const f = fixture(); f.start(); const session = await f.connect(); f.advance(20_001);
    expect(() => f.mirror.heartbeat({ deviceId: f.owner, sessionId: session.id })).toThrow(expect.objectContaining({ code: 'EXHIBITION_OWNER_MISMATCH' }));
    await f.mirror.sweepLive(); expect(f.store.get(session.id).status).toBe('stopped');
  });
  it('persists a diagnostic reason and has bounded event retention', async () => {
    const f = fixture(); f.start(); await f.connect(); f.mirror.command({ action: 'pause' }); await f.mirror.reconcileLive();
    expect(f.mirror.diagnosticTimeline()).toContainEqual(expect.objectContaining({ reason: 'staff_pause' }));
  });
  it('runs 1000 non-overlapping connection segments across more than eight simulated hours', async () => {
    const f = fixture();
    f.mirror.command({ action: 'configure', sessionLimits: { credits: 30, expireSeconds: 30 } });
    const first = f.start();
    for (let i = 0; i < 1000; i++) {
      const session = await f.connect();
      f.advance(30_000); const state = f.mirror.get();
      await f.mirror.reportLiveError({ deviceId: f.owner, sessionId: session.id,
        sessionNumber: state.sessionNumber, generationNumber: state.generationNumber, lookId: state.selectedLookId,
        reason: 'credential_expired', message: 'Scheduled segment expiry' });
      expect(f.mirror.get().lifecycle?.experienceId).toBe(first.lifecycle!.experienceId);
      expect(f.store.unreleasedMirror('default')).toHaveLength(0);
    }
    expect(f.provider.issueKey).toHaveBeenCalledTimes(1000);
    expect(f.mirror.diagnosticTimeline().length).toBeLessThanOrEqual(2000);
    f.mirror.command({ action: 'end' });
    expect(f.mirror.get().lifecycle?.state).toBe('ended');
  }, 90_000);
  it('rejects an invented expiry instead of allowing unlimited planned recovery', async () => {
    const f = fixture(); f.start(); const session = await f.connect(); const state = f.mirror.get();
    await expect(f.mirror.reportLiveError({ deviceId: f.owner, sessionId: session.id,
      sessionNumber: state.sessionNumber, generationNumber: state.generationNumber, lookId: state.selectedLookId,
      reason: 'credential_expired', message: 'caller invented expiry' })).rejects.toMatchObject({ code: 'EXHIBITION_RECOVERY_NOT_DUE' });
    expect(f.store.get(session.id).status).toBe('active');
    expect(f.provider.issueKey).toHaveBeenCalledOnce();
  });
  it('uses request-start monotonic time, so delayed receipts cannot extend an expired lease', () => {
    let now = 0; const lease = new TerminalLease(() => now); lease.acknowledge(0);
    now = 19_000; lease.acknowledge(0); expect(lease.remaining()).toBe(0);
    lease.acknowledge(30_000); expect(lease.remaining()).toBe(0);
  });
});
