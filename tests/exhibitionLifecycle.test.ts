import { LifecycleTryOnService } from './support/lifecycleReferenceFixture';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ExhibitionService } from '../server/exhibition';
import { TryOnService } from '../server/service';
import { SecretBox, SessionStore } from '../server/store';
import { admitRecovery, initialLifecycle, isExperienceLifecycle, TerminalLease } from '../shared/exhibitionLifecycle';
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
  const service = new LifecycleTryOnService({ provider, store, secrets: new SecretBox(randomBytes(32)), resolveHost: async () => ['8.8.8.8'] });
  const open = () => { const mirror = new ExhibitionService(directory, { now: () => now }); mirror.attachLiveService(service); return mirror; };
  const mirror = open();
  mirror.command({ action: 'configure', providerMode: 'xmax', autoReturnSeconds: 0 });
  const start = () => mirror.command({ action: 'begin', commandId: 'start-command-0001' });
  const connect = async () => {
    const state = mirror.get();
    const session = await mirror.createLiveSession({ deviceId: owner, lookId: state.selectedLookId, generationNumber: state.generationNumber, expectedRevision: state.revision });
    await service.link(session.id, `ums-${session.id}`);
    await service.firstFrame(session.id, 100); mirror.liveFirstFrame(session.id, 100);
    return session;
  };
  cleanups.push(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { mirror, open, start, connect, provider, service, store, owner, now: () => now, advance: (ms: number) => { now += ms; } };
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
  it.each(['cleanup', 'end', 'pause', 'next'])('rechecks semantic ownership after concurrent %s while reading the failure record', async action => {
    const f = fixture(); f.start(); const session = await f.connect(); const before = f.mirror.get();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const originalGet = f.service.get.bind(f.service);
    vi.spyOn(f.service, 'get').mockImplementationOnce(async id => { await gate; return originalGet(id, false); });
    const pending = f.mirror.reportLiveError({ deviceId: f.owner, sessionId: session.id, lookId: before.selectedLookId,
      sessionNumber: before.sessionNumber, generationNumber: before.generationNumber, reason: 'rtc_failed', message: 'RTC failed' });
    const outcome = pending.then(value => ({ value, error: null }), error => ({ value: null, error }));
    if (action !== 'cleanup') f.mirror.command({ action });
    await f.service.stop(session.id); await f.mirror.reconcileLive(); release();
    const result = await outcome;
    if (action === 'cleanup') {
      expect(result.error).toBeNull();
      expect(result.value).toMatchObject({ phase: 'generating', live: null, lifecycle: { connection: 'recovering', experienceId: before.lifecycle!.experienceId } });
      f.advance(1100); await f.connect(); expect(f.provider.issueKey).toHaveBeenCalledTimes(2);
    } else {
      expect(result.error).toMatchObject({ code: 'EXHIBITION_OWNER_MISMATCH' });
      expect(f.provider.issueKey).toHaveBeenCalledTimes(1);
    }
  });
  it('ends immediately and rejects a late recovery report even when the stop response is delayed', async () => {
    const f = fixture(); f.start(); const old = await f.connect(); const state = f.mirror.get();
    f.mirror.command({ action: 'end', expectedRevision: -1 });
    await expect(f.mirror.reportLiveError({ deviceId: f.owner, sessionId: old.id, sessionNumber: state.sessionNumber,
      generationNumber: state.generationNumber, lookId: state.selectedLookId, reason: 'rtc_failed', message: 'late failure' })).rejects.toMatchObject({ code: 'EXHIBITION_OWNER_MISMATCH' });
    expect(f.mirror.get()).toMatchObject({ phase: 'select', displayedLookId: null, lifecycle: { state: 'ended' } });
  });
  it('exhausts recovery allowance instead of repeatedly issuing on a failing connection', async () => {
    const f = fixture();
    f.mirror.command({ action: 'configure', sessionLimits: { credits: 30, expireSeconds: 120 } });
    f.start();
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
  it('keeps continuous camera recovery active with bounded exponential backoff and no overlapping credentials', async () => {
    const f = fixture(); const first = f.start();
    const delays = [1000, 2000, 4000, 8000, 16_000, 30_000, 30_000, 30_000];
    for (const [index, delay] of delays.entries()) {
      const session = await f.connect(); const state = f.mirror.get();
      expect(session.exhibition?.continuous).toBe(true);
      await f.mirror.reportLiveError({ deviceId: f.owner, sessionId: session.id, sessionNumber: state.sessionNumber,
        generationNumber: state.generationNumber, lookId: state.selectedLookId, reason: 'rtc_failed', message: 'Temporary RTC interruption' });
      const recovering = f.mirror.get();
      expect(recovering).toMatchObject({ phase: 'generating', live: null, lifecycle: {
        state: 'active', connection: 'recovering', experienceId: first.lifecycle!.experienceId,
        consecutiveFailures: index + 1, retryAt: f.now() + delay, ownerDeviceId: f.owner,
      } });
      expect(isExperienceLifecycle(recovering.lifecycle)).toBe(true);
      expect(f.store.unreleasedMirror('default')).toHaveLength(0);
      await expect(f.connect()).rejects.toMatchObject({ code: 'EXHIBITION_RECOVERY_WAIT' });
      expect(f.provider.issueKey).toHaveBeenCalledTimes(index + 1);
      f.advance(delay - 1);
      await expect(f.connect()).rejects.toMatchObject({ code: 'EXHIBITION_RECOVERY_WAIT' });
      f.advance(1);
    }
    await f.connect();
    expect(f.provider.issueKey).toHaveBeenCalledTimes(delays.length + 1);
    expect(f.mirror.get().lifecycle?.experienceId).toBe(first.lifecycle!.experienceId);
  });
  it('resets continuous backoff after a genuinely stable minute', async () => {
    const f = fixture(); f.start();
    for (const delay of [1000, 2000, 4000]) {
      const session = await f.connect(); const state = f.mirror.get();
      await f.mirror.reportLiveError({ deviceId: f.owner, sessionId: session.id, sessionNumber: state.sessionNumber,
        generationNumber: state.generationNumber, lookId: state.selectedLookId, reason: 'rtc_failed', message: 'RTC interrupted' });
      f.advance(delay);
    }
    const session = await f.connect();
    for (let index = 0; index < 6; index++) { f.advance(10_000); f.mirror.heartbeat({ deviceId: f.owner, sessionId: session.id }); }
    const state = f.mirror.get();
    await f.mirror.reportLiveError({ deviceId: f.owner, sessionId: session.id, sessionNumber: state.sessionNumber,
      generationNumber: state.generationNumber, lookId: state.selectedLookId, reason: 'rtc_failed', message: 'A later interruption' });
    expect(f.mirror.get().lifecycle).toMatchObject({ consecutiveFailures: 1, retryAt: f.now() + 1000 });
  });
  it('requires the recorded continuous intent as well as unlimited current settings', async () => {
    const f = fixture(); f.start();
    for (let index = 0; index < 3; index++) {
      const session = await f.connect();
      f.store.update(session.id, { exhibition: { ...session.exhibition!, continuous: false } });
      const state = f.mirror.get();
      await f.mirror.reportLiveError({ deviceId: f.owner, sessionId: session.id, sessionNumber: state.sessionNumber,
        generationNumber: state.generationNumber, lookId: state.selectedLookId, reason: 'rtc_failed', message: 'RTC interrupted' });
      f.advance(2100);
    }
    expect(f.mirror.get()).toMatchObject({ phase: 'paused', lifecycle: { connection: 'needs_assistance' } });
    await expect(f.connect()).rejects.toMatchObject({ code: 'EXHIBITION_RECOVERY_REQUIRED' });
    expect(f.provider.issueKey).toHaveBeenCalledTimes(3);
  });
  it('keeps an absent continuous owner reserved without issuing or granting another screen a key', async () => {
    const f = fixture(); f.start(); const session = await f.connect(); const state = f.mirror.get();
    await f.mirror.reportLiveError({ deviceId: f.owner, sessionId: session.id, sessionNumber: state.sessionNumber,
      generationNumber: state.generationNumber, lookId: state.selectedLookId, reason: 'rtc_failed', message: 'Temporary outage' });
    f.advance(120_000); await f.mirror.sweepLive();
    const recovering = f.mirror.get();
    expect(recovering).toMatchObject({ phase: 'generating', live: null, lifecycle: { state: 'active', connection: 'recovering', ownerDeviceId: f.owner } });
    expect(f.provider.issueKey).toHaveBeenCalledOnce();
    await expect(f.mirror.createLiveSession({ deviceId: 'screen-foreign-owner', lookId: recovering.selectedLookId, generationNumber: recovering.generationNumber }))
      .rejects.toMatchObject({ code: 'EXHIBITION_OWNER_MISMATCH' });
    await f.connect(); expect(f.provider.issueKey).toHaveBeenCalledTimes(2);
  });
  it('never issues a replacement while revocation remains unconfirmed, then resumes after confirmation', async () => {
    const f = fixture(); f.start(); const session = await f.connect(); const state = f.mirror.get();
    const deactivate = vi.mocked(f.provider.deactivate); const revoke = deactivate.getMockImplementation()!;
    deactivate.mockRejectedValue(new Error('Temporary revocation outage'));
    await f.mirror.reportLiveError({ deviceId: f.owner, sessionId: session.id, sessionNumber: state.sessionNumber,
      generationNumber: state.generationNumber, lookId: state.selectedLookId, reason: 'rtc_failed', message: 'RTC interrupted' });
    f.advance(1000);
    await expect(f.connect()).rejects.toMatchObject({ code: 'EXHIBITION_DEVICE_BUSY' });
    expect(f.provider.issueKey).toHaveBeenCalledOnce();
    expect(f.mirror.get()).toMatchObject({ phase: 'generating', live: { sessionId: session.id }, lifecycle: { connection: 'recovering' } });
    expect(f.store.unreleasedMirror('default')).toHaveLength(1);
    deactivate.mockImplementation(revoke); await f.mirror.sweepLive();
    expect(f.store.get(session.id).status).toBe('stopped');
    await f.connect(); expect(f.provider.issueKey).toHaveBeenCalledTimes(2);
  });
  it.each(['pause', 'end'] as const)('gives an explicit %s priority over pending continuous recovery', async action => {
    const f = fixture(); f.start(); const session = await f.connect(); const state = f.mirror.get();
    const report = { deviceId: f.owner, sessionId: session.id, sessionNumber: state.sessionNumber,
      generationNumber: state.generationNumber, lookId: state.selectedLookId, reason: 'rtc_failed', message: 'RTC interrupted' };
    await f.mirror.reportLiveError(report); f.mirror.command({ action }); f.advance(120_000); await f.mirror.sweepLive();
    expect(f.mirror.get()).toMatchObject({ phase: action === 'pause' ? 'paused' : 'select', live: null,
      lifecycle: { state: action === 'pause' ? 'paused' : 'ended', connection: 'idle', reason: action === 'pause' ? 'staff_pause' : 'user_end' } });
    if (action === 'pause') expect(f.mirror.get().lifecycle?.retryAt).toBeUndefined();
    await expect(f.mirror.reportLiveError(report)).rejects.toMatchObject({ code: 'EXHIBITION_OWNER_MISMATCH' });
    await expect(f.connect()).rejects.toMatchObject({ code: 'EXHIBITION_INVALID_PHASE' });
    expect(f.provider.issueKey).toHaveBeenCalledOnce();
  });
  it('cancels recovery on manual pause while retaining unconfirmed credentials until cleanup succeeds', async () => {
    const f = fixture(); f.start(); const session = await f.connect(); const state = f.mirror.get();
    const deactivate = vi.mocked(f.provider.deactivate); const revoke = deactivate.getMockImplementation()!;
    deactivate.mockRejectedValue(new Error('Temporary revocation outage'));
    const report = { deviceId: f.owner, sessionId: session.id, sessionNumber: state.sessionNumber,
      generationNumber: state.generationNumber, lookId: state.selectedLookId, reason: 'rtc_failed', message: 'RTC interrupted' };
    await f.mirror.reportLiveError(report);
    expect(f.mirror.get().lifecycle?.retryAt).toBeDefined();
    f.mirror.command({ action: 'pause' });
    expect(f.mirror.get()).toMatchObject({ phase: 'paused', live: { sessionId: session.id },
      lifecycle: { state: 'paused', connection: 'cleaning', reason: 'staff_pause' } });
    expect(f.mirror.get().lifecycle?.retryAt).toBeUndefined();
    expect(() => f.mirror.command({ action: 'resume' })).toThrow(expect.objectContaining({ code: 'EXHIBITION_LIVE_STOP_PENDING' }));
    f.advance(120_000); await f.mirror.sweepLive();
    await expect(f.connect()).rejects.toMatchObject({ code: 'EXHIBITION_INVALID_PHASE' });
    expect(f.store.unreleasedMirror('default')).toHaveLength(1);
    expect(f.provider.issueKey).toHaveBeenCalledOnce();
    deactivate.mockImplementation(revoke); await f.mirror.sweepLive();
    expect(f.mirror.get()).toMatchObject({ phase: 'paused', live: null,
      lifecycle: { state: 'paused', connection: 'idle', reason: 'staff_pause' } });
    await expect(f.mirror.reportLiveError(report)).rejects.toMatchObject({ code: 'EXHIBITION_OWNER_MISMATCH' });
    expect(f.provider.issueKey).toHaveBeenCalledOnce();
    f.mirror.command({ action: 'resume' }); await f.connect();
    expect(f.provider.issueKey).toHaveBeenCalledTimes(2);
  });
  it.each(['provider_rejected', 'issue_unknown'] as const)('does not retry the permanent or unconfirmed failure %s in continuous mode', async reason => {
    const f = fixture(); f.start(); const session = await f.connect(); const state = f.mirror.get();
    await f.mirror.reportLiveError({ deviceId: f.owner, sessionId: session.id, sessionNumber: state.sessionNumber,
      generationNumber: state.generationNumber, lookId: state.selectedLookId, reason, message: 'Credentials need attention' });
    f.advance(120_000); await f.mirror.sweepLive();
    expect(f.mirror.get()).toMatchObject({ phase: 'paused', lifecycle: { connection: 'needs_assistance', reason } });
    await expect(f.connect()).rejects.toMatchObject({ code: 'EXHIBITION_RECOVERY_REQUIRED' });
    expect(f.provider.issueKey).toHaveBeenCalledOnce();
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
  it('keeps continuous recovery history valid and never admits a manually paused lifecycle', () => {
    const lifecycle = { ...initialLifecycle(), state: 'active' as const };
    for (let index = 0; index < 100; index++) expect(admitRecovery(lifecycle, index * 1000, false, true)).toBe(true);
    expect(lifecycle.recoveryAttempts).toHaveLength(3); expect(lifecycle.consecutiveFailures).toBe(100);
    expect(isExperienceLifecycle(lifecycle)).toBe(true);
    expect(admitRecovery({ ...lifecycle, state: 'paused', reason: 'staff_pause' }, 101_000, false, true)).toBe(false);
  });
});
