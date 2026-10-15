import { readyReferenceFixture, resolvedBinding } from './readyReferenceFixture';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ExhibitionLiveConnection, type ExhibitionLiveDeps } from '../src/exhibition/useExhibitionLive';
import { exhibitionPromptForLook } from '../shared/exhibition';

type Input = Parameters<ExhibitionLiveDeps['create']>[0];
type Session = Awaited<ReturnType<ExhibitionLiveDeps['create']>>;
const connections: ExhibitionLiveConnection[] = [];
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function flush() { for (let index = 0; index < 30; index++) await Promise.resolve(); }
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(10_000); });
afterEach(async () => {
  for (const connection of connections.splice(0)) await connection.stop();
  vi.clearAllTimers(); vi.useRealTimers();
});

function fixture(continuous: boolean | 'legacy' = true) {
  const originalStop = vi.fn(); const cloneStop = vi.fn();
  const originalTrack = { readyState: 'live', stop: originalStop };
  const cloneTrack = { readyState: 'live', stop: cloneStop, onended: null };
  const stream = { getVideoTracks: () => [originalTrack], getTracks: () => [originalTrack] } as unknown as MediaStream;
  const clone = { getVideoTracks: () => [cloneTrack], getTracks: () => [cloneTrack] } as unknown as MediaStream;
  const output = { id: 'remote-output' } as MediaStream;
  const input: Input = { mirrorId: 'default', deviceId: 'screen-a', sessionNumber: 1, generationNumber: 1, lookId: 'first',
    expectedRevision: 1, image: '/assets/first.png', stream, mode: 'clothx' };
  let record: Session = { id: 'old-credential', token: 'temporary-test-token', model: 'x2.0', status: 'active', sourceKind: 'camera',
    referenceAsset: input.image, refImageUrl: '', referenceVersion: 0, expiresAt: new Date(Date.now() + 120_000).toISOString(),
    exhibition: { mirrorId: 'default', deviceId: input.deviceId, sessionNumber: 1, generationNumber: 1, lookId: input.lookId,
      mode: 'clothx', prompt: exhibitionPromptForLook({ mode: 'clothx' }), ...(continuous === 'legacy' ? {} : { continuous }) } };
  let callbacks!: Parameters<ExhibitionLiveDeps['connect']>[2];
  let renewalDue = false;
  const sdk = { getSessionUid: vi.fn(() => 'old-provider-session'), set: vi.fn(async (_context: { prompt: string; refImageUrl?: string | null }) => {}),
    disconnect: vi.fn(async () => {}), stopGeneration: vi.fn(async () => {}), stopLocalStream: vi.fn(async () => {}) };
  const deps = {
    create: vi.fn(async () => ({ ...record })), reference: vi.fn(async (value: Input) => new File(['garment'], value.image.split('/').pop()!, { type: 'image/png' })),
    prepare: vi.fn(async () => {}), readyLookup: vi.fn(async (file: File) => `https://reference.fixture/${file.name}`),
    bind: vi.fn(async (_id, value) => { record = { ...record, refImageUrl: resolvedBinding(value.bindingId), referenceVersion: 1 }; return { ...record }; }),
    updateCondition: vi.fn(async (_id, value) => {
      record = { ...record, referenceAsset: `/assets/${value.lookId}.png`, refImageUrl: resolvedBinding(value.bindingId) ?? '', referenceVersion: record.referenceVersion + 1,
        exhibition: { ...record.exhibition, lookId: value.lookId, generationNumber: value.generationNumber } };
      return { ...record };
    }), conditionApplied: vi.fn(async () => ({})),
    connect: vi.fn(async (_source, _local, value) => { callbacks = value; return sdk; }),
    link: vi.fn(async (_id, providerSessionId) => { record = { ...record, providerSessionId }; return { ...record }; }),
    firstFrame: vi.fn(async () => ({ ...record })), stop: vi.fn(async () => ({ ...record, status: 'stopped' })),
    heartbeat: vi.fn(async () => ({ live: { renewalDue } })), reportError: vi.fn(async () => ({})),
    prepareRenewal: vi.fn(async (_id: string, _value: { deviceId: string; sessionNumber: number; generationNumber: number }, _signal: AbortSignal) => ({ renewalId: 'planned-renewal' })),
    commitRenewal: vi.fn(async (_id: string, _value: { deviceId: string; renewalId: string }, _signal: AbortSignal) => ({})),
    clone: vi.fn(() => clone), now: vi.fn(() => performance.now()),
  } satisfies Omit<ExhibitionLiveDeps, 'upload'> & { readyLookup: (...args: any[]) => Promise<string> };
  Object.assign(deps, { upload: vi.fn(async () => { throw new Error('Browser upload forbidden'); }), preparedReference: async (input: Parameters<ExhibitionLiveDeps['create']>[0]) => readyReferenceFixture(await deps.readyLookup(new File(['backend-fixture'], input.image.split('/').pop()!, { type: 'image/png' }), '', new AbortController().signal)) });
  const events = { status: vi.fn(), stream: vi.fn(), refresh: vi.fn(), updateError: vi.fn() };
  const controller = new ExhibitionLiveConnection(input, events, deps); connections.push(controller);
  const showFirstFrame = () => { callbacks.onRemoteStream(output); controller.reportRenderedFrame(output); };
  const ready = async () => { await controller.start(); showFirstFrame(); await flush(); };
  return { controller, deps, sdk, events, ready, showFirstFrame, originalStop, cloneStop, input, record: () => record,
    callbacks: () => callbacks, due: () => { renewalDue = true; } };
}

describe('planned continuous-session renewal in the mirror client', () => {
  it('prepares 15 seconds before expiry and commits only after both the SDK and credential confirm stopping', async () => {
    const f = fixture(); const sdkStopped = deferred<void>(); const keyStopped = deferred<Session>();
    f.sdk.disconnect.mockImplementationOnce(() => sdkStopped.promise);
    f.deps.stop.mockImplementationOnce(() => keyStopped.promise);
    await f.ready();
    await vi.advanceTimersByTimeAsync(104_999);
    expect(f.deps.prepareRenewal).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(f.deps.prepareRenewal).toHaveBeenCalledExactlyOnceWith('old-credential', { deviceId: 'screen-a', sessionNumber: 1, generationNumber: 1 }, expect.any(AbortSignal));
    expect(f.sdk.disconnect).toHaveBeenCalledOnce(); expect(f.deps.stop).toHaveBeenCalledOnce();
    expect(f.deps.prepareRenewal.mock.invocationCallOrder[0]).toBeLessThan(f.sdk.disconnect.mock.invocationCallOrder[0]);
    expect(f.deps.prepareRenewal.mock.invocationCallOrder[0]).toBeLessThan(f.deps.stop.mock.invocationCallOrder[0]);
    expect(f.deps.commitRenewal).not.toHaveBeenCalled();
    sdkStopped.resolve(); await flush();
    expect(f.deps.commitRenewal).not.toHaveBeenCalled();
    keyStopped.resolve({ ...f.record(), status: 'stopped' }); await flush();
    expect(f.deps.commitRenewal).toHaveBeenCalledExactlyOnceWith('old-credential', { deviceId: 'screen-a', renewalId: 'planned-renewal' }, expect.any(AbortSignal));
    expect(f.events.refresh.mock.invocationCallOrder.at(-1)).toBeGreaterThan(f.deps.commitRenewal.mock.invocationCallOrder[0]);
    expect(f.originalStop).not.toHaveBeenCalled(); expect(f.cloneStop).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(f.deps.prepareRenewal).toHaveBeenCalledOnce(); expect(f.deps.commitRenewal).toHaveBeenCalledOnce();
    expect(f.deps.create).toHaveBeenCalledOnce(); expect(f.deps.connect).toHaveBeenCalledOnce();
  });

  it('does not commit while SDK disconnection is still pending even after credential revocation succeeds', async () => {
    const f = fixture(); const pending = deferred<void>(); f.sdk.disconnect.mockImplementationOnce(() => pending.promise);
    await f.ready(); await vi.advanceTimersByTimeAsync(105_000);
    expect(f.deps.stop).toHaveBeenCalledOnce(); expect(f.deps.commitRenewal).not.toHaveBeenCalled();
    pending.resolve(); await flush(); expect(f.deps.commitRenewal).toHaveBeenCalledOnce();
  });

  it('deduplicates heartbeat requests and the expiry timer while renewal preparation is pending', async () => {
    const f = fixture(); const pending = deferred<{ renewalId: string }>();
    f.deps.prepareRenewal.mockImplementationOnce(() => pending.promise);
    await f.ready(); await vi.advanceTimersByTimeAsync(99_000); f.due();
    await vi.advanceTimersByTimeAsync(3_000);
    expect(f.deps.prepareRenewal).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(f.deps.prepareRenewal).toHaveBeenCalledOnce(); expect(f.deps.stop).not.toHaveBeenCalled();
    pending.resolve({ renewalId: 'planned-renewal' }); await flush();
    expect(f.deps.commitRenewal).toHaveBeenCalledOnce();
  });

  it.each([false, 'legacy'] as const)('never renews a finite or older session (continuous=%s)', async continuous => {
    const f = fixture(continuous); f.due(); await f.ready(); await vi.advanceTimersByTimeAsync(120_000);
    expect(f.deps.prepareRenewal).not.toHaveBeenCalled(); expect(f.deps.commitRenewal).not.toHaveBeenCalled();
    expect(f.deps.stop).toHaveBeenCalledOnce();
  });

  it('requires backend confirmation of a decoded first frame before responding to renewalDue', async () => {
    const f = fixture(); const pending = deferred<Session>(); f.deps.firstFrame.mockImplementationOnce(() => pending.promise);
    f.due(); await f.controller.start(); await vi.advanceTimersByTimeAsync(5_000);
    expect(f.deps.prepareRenewal).not.toHaveBeenCalled();
    f.showFirstFrame(); await flush(); await vi.advanceTimersByTimeAsync(5_000);
    expect(f.deps.firstFrame).toHaveBeenCalledOnce(); expect(f.deps.prepareRenewal).not.toHaveBeenCalled();
    pending.resolve(f.record()); await flush(); await vi.advanceTimersByTimeAsync(5_000);
    expect(f.deps.prepareRenewal).toHaveBeenCalledOnce(); expect(f.deps.commitRenewal).toHaveBeenCalledOnce();
  });

  it('cancels an upcoming renewal when the user stops before it is due', async () => {
    const f = fixture(); await f.ready(); await vi.advanceTimersByTimeAsync(104_999);
    await f.controller.stop(); await vi.advanceTimersByTimeAsync(120_000);
    expect(f.deps.prepareRenewal).not.toHaveBeenCalled(); expect(f.deps.commitRenewal).not.toHaveBeenCalled();
  });

  it('cancels renewal when manual stop races with a late preparation response', async () => {
    const f = fixture(); const pending = deferred<{ renewalId: string }>(); f.deps.prepareRenewal.mockImplementationOnce(() => pending.promise);
    await f.ready(); await vi.advanceTimersByTimeAsync(105_000);
    await f.controller.stop();
    expect(f.deps.prepareRenewal.mock.calls[0][2].aborted).toBe(true);
    pending.resolve({ renewalId: 'planned-renewal' }); await flush();
    expect(f.deps.commitRenewal).not.toHaveBeenCalled(); expect(f.deps.stop).toHaveBeenCalledOnce(); expect(f.sdk.disconnect).toHaveBeenCalledOnce();
  });

  it('cancels renewal when manual stop races with resource cleanup after preparation', async () => {
    const f = fixture(); const pending = deferred<void>(); f.sdk.disconnect.mockImplementationOnce(() => pending.promise);
    await f.ready(); await vi.advanceTimersByTimeAsync(105_000);
    expect(f.deps.prepareRenewal).toHaveBeenCalledOnce(); expect(f.deps.stop).toHaveBeenCalledOnce();
    const stopped = f.controller.stop(); pending.resolve(); expect(await stopped).toBe(true); await flush();
    expect(f.deps.commitRenewal).not.toHaveBeenCalled(); expect(f.sdk.disconnect).toHaveBeenCalledOnce();
  });

  it('stops safely after preparation failure without committing or starting a retry loop', async () => {
    const f = fixture(); f.deps.prepareRenewal.mockRejectedValueOnce(new Error('renewal preparation failed'));
    await f.ready(); await vi.advanceTimersByTimeAsync(105_000); await vi.advanceTimersByTimeAsync(120_000);
    expect(f.deps.prepareRenewal).toHaveBeenCalledOnce(); expect(f.deps.commitRenewal).not.toHaveBeenCalled();
    expect(f.deps.stop).toHaveBeenCalledOnce(); expect(f.sdk.disconnect).toHaveBeenCalledOnce();
    expect(f.deps.reportError).toHaveBeenCalled(); expect(f.deps.create).toHaveBeenCalledOnce();
  });

  it('does not commit when credential stopping returns an unconfirmed active status', async () => {
    const f = fixture(); f.deps.stop.mockImplementationOnce(async () => ({ ...f.record(), status: 'active' }));
    await f.ready(); await vi.advanceTimersByTimeAsync(105_000); await vi.advanceTimersByTimeAsync(120_000);
    expect(f.deps.commitRenewal).not.toHaveBeenCalled(); expect(f.deps.stop).toHaveBeenCalledOnce();
    expect(f.events.status).toHaveBeenCalledWith('error', expect.any(String));
  });

  it('does not commit when SDK disconnection fails even after the credential is stopped', async () => {
    const f = fixture(); f.sdk.disconnect.mockRejectedValueOnce(new Error('disconnect failed'));
    await f.ready(); await vi.advanceTimersByTimeAsync(105_000); await vi.advanceTimersByTimeAsync(120_000);
    expect(f.deps.commitRenewal).not.toHaveBeenCalled(); expect(f.deps.stop).toHaveBeenCalledOnce(); expect(f.sdk.disconnect).toHaveBeenCalledOnce();
    expect(f.events.status).toHaveBeenCalledWith('error', expect.any(String));
  });

  it('does not commit if credential revocation times out', async () => {
    const f = fixture(); const pending = deferred<Session>(); f.deps.stop.mockImplementationOnce(() => pending.promise);
    await f.ready(); await vi.advanceTimersByTimeAsync(105_000); await vi.advanceTimersByTimeAsync(15_000);
    expect(f.deps.commitRenewal).not.toHaveBeenCalled(); expect(f.events.status).toHaveBeenCalledWith('error', expect.any(String));
    pending.resolve({ ...f.record(), status: 'stopped' }); await flush();
    expect(f.deps.commitRenewal).not.toHaveBeenCalled(); expect(f.deps.prepareRenewal).toHaveBeenCalledOnce();
  });

  it('does not retry a failed commit or allocate another credential in the old connection', async () => {
    const f = fixture(); f.deps.commitRenewal.mockRejectedValueOnce(new Error('renewal commit failed'));
    await f.ready(); await vi.advanceTimersByTimeAsync(105_000); await vi.advanceTimersByTimeAsync(120_000);
    expect(f.deps.prepareRenewal).toHaveBeenCalledOnce(); expect(f.deps.commitRenewal).toHaveBeenCalledOnce();
    expect(f.deps.create).toHaveBeenCalledOnce(); expect(f.deps.connect).toHaveBeenCalledOnce();
    expect(f.events.status).toHaveBeenCalledWith('error', expect.any(String));
  });

  it.each(['disconnect', 'error'] as const)('does not use an unexpected SDK %s as permission to renew', async failure => {
    const f = fixture(); await f.ready();
    if (failure === 'disconnect') f.callbacks().onDisconnect('server_error');
    else f.callbacks().onError('sdk failure', { code: 'SESSION_ERROR' });
    await flush(); await vi.advanceTimersByTimeAsync(120_000);
    expect(f.deps.prepareRenewal).not.toHaveBeenCalled(); expect(f.deps.commitRenewal).not.toHaveBeenCalled();
    expect(f.deps.stop).toHaveBeenCalledOnce(); expect(f.deps.reportError).toHaveBeenCalledOnce();
  });

  it('cancels a pending renewal when an SDK error arrives before preparation completes', async () => {
    const f = fixture(); const pending = deferred<{ renewalId: string }>(); f.deps.prepareRenewal.mockImplementationOnce(() => pending.promise);
    await f.ready(); await vi.advanceTimersByTimeAsync(105_000);
    f.callbacks().onError('sdk failure', { code: 'SESSION_ERROR' }); await flush();
    pending.resolve({ renewalId: 'planned-renewal' }); await flush();
    expect(f.deps.commitRenewal).not.toHaveBeenCalled(); expect(f.deps.reportError).toHaveBeenCalledOnce();
  });

  it('cancels a pending renewal when ownership is explicitly revoked', async () => {
    const f = fixture(); const pending = deferred<{ renewalId: string }>(); f.deps.prepareRenewal.mockImplementationOnce(() => pending.promise);
    await f.ready(); await vi.advanceTimersByTimeAsync(104_999);
    f.deps.heartbeat.mockRejectedValueOnce(Object.assign(new Error('owner revoked'), { code: 'EXHIBITION_OWNER_MISMATCH' }));
    await vi.advanceTimersByTimeAsync(1); pending.resolve({ renewalId: 'planned-renewal' }); await flush();
    expect(f.deps.commitRenewal).not.toHaveBeenCalled(); expect(f.deps.stop).toHaveBeenCalledOnce();
    expect(f.deps.reportError).toHaveBeenCalledOnce();
  });

  it('keeps the lease alive during cleanup and does not commit after that heartbeat fails', async () => {
    const f = fixture(); const pending = deferred<void>(); f.sdk.disconnect.mockImplementationOnce(() => pending.promise);
    await f.ready(); await vi.advanceTimersByTimeAsync(105_000);
    const callsDuringCleanup = f.deps.heartbeat.mock.calls.length;
    f.deps.heartbeat.mockRejectedValueOnce(Object.assign(new Error('owner revoked during cleanup'), { code: 'EXHIBITION_OWNER_MISMATCH' }));
    await vi.advanceTimersByTimeAsync(5_000);
    expect(f.deps.heartbeat).toHaveBeenCalledTimes(callsDuringCleanup + 1);
    pending.resolve(); await flush();
    expect(f.deps.commitRenewal).not.toHaveBeenCalled(); expect(f.deps.reportError).toHaveBeenCalledOnce();
    expect(f.deps.prepareRenewal).toHaveBeenCalledOnce(); expect(f.deps.stop).toHaveBeenCalledOnce();
  });

  it('ignores a delayed heartbeat renewal hint after manual stop', async () => {
    const f = fixture(); const pending = deferred<{ live: { renewalDue: boolean } }>(); await f.ready();
    f.deps.heartbeat.mockImplementationOnce(() => pending.promise);
    await vi.advanceTimersByTimeAsync(5_000); await f.controller.stop();
    pending.resolve({ live: { renewalDue: true } }); await flush();
    expect(f.deps.prepareRenewal).not.toHaveBeenCalled(); expect(f.deps.commitRenewal).not.toHaveBeenCalled();
  });

  it('aborts a pending commit on manual stop and ignores its eventual response', async () => {
    const f = fixture(); const pending = deferred<Record<string, never>>(); f.deps.commitRenewal.mockImplementationOnce(() => pending.promise);
    await f.ready(); await vi.advanceTimersByTimeAsync(105_000);
    expect(f.deps.commitRenewal).toHaveBeenCalledOnce();
    const signal = f.deps.commitRenewal.mock.calls[0][2]; expect(signal.aborted).toBe(false);
    await f.controller.stop(); const refreshCount = f.events.refresh.mock.calls.length;
    expect(signal.aborted).toBe(true); pending.resolve({}); await flush();
    expect(f.events.refresh).toHaveBeenCalledTimes(refreshCount);
    expect(f.deps.commitRenewal).toHaveBeenCalledOnce(); expect(f.deps.create).toHaveBeenCalledOnce();
  });

  it('does not commit a preparation response without a valid renewal id', async () => {
    const f = fixture(); f.deps.prepareRenewal.mockResolvedValueOnce({ renewalId: '' });
    await f.ready(); await vi.advanceTimersByTimeAsync(105_000);
    expect(f.deps.commitRenewal).not.toHaveBeenCalled(); expect(f.deps.stop).toHaveBeenCalledOnce();
    expect(f.deps.reportError).toHaveBeenCalledOnce();
  });

  it('waits for an in-flight outfit update and prepares against its accepted generation', async () => {
    const f = fixture(); const pending = deferred<void>(); await f.ready(); await vi.advanceTimersByTimeAsync(104_000);
    f.sdk.set.mockImplementationOnce(() => pending.promise);
    const updating = f.controller.update({ ...f.input, lookId: 'second', generationNumber: 2, image: '/assets/second.png' }); await flush();
    await vi.advanceTimersByTimeAsync(1_000); expect(f.deps.prepareRenewal).not.toHaveBeenCalled();
    pending.resolve(); expect(await updating).toBe(true); await flush();
    expect(f.deps.prepareRenewal).toHaveBeenCalledExactlyOnceWith('old-credential', { deviceId: 'screen-a', sessionNumber: 1, generationNumber: 2 }, expect.any(AbortSignal));
    expect(f.deps.conditionApplied.mock.invocationCallOrder[0]).toBeLessThan(f.deps.prepareRenewal.mock.invocationCallOrder[0]);
    expect(f.deps.commitRenewal).toHaveBeenCalledOnce();
  });

  it('stops without renewing if an outfit update cannot settle within the renewal grace period', async () => {
    const f = fixture(); const pending = deferred<void>(); await f.ready(); await vi.advanceTimersByTimeAsync(104_000);
    f.sdk.set.mockImplementationOnce(() => pending.promise);
    const updating = f.controller.update({ ...f.input, lookId: 'second', generationNumber: 2, image: '/assets/second.png' }); await flush();
    await vi.advanceTimersByTimeAsync(6_000);
    expect(f.deps.prepareRenewal).not.toHaveBeenCalled(); expect(f.deps.commitRenewal).not.toHaveBeenCalled();
    expect(f.deps.stop).toHaveBeenCalledOnce();
    pending.resolve(); expect(await updating).toBe(false); await flush();
    expect(f.deps.commitRenewal).not.toHaveBeenCalled();
  });
});
