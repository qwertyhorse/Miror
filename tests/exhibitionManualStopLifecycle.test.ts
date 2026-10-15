import { readyReferenceFixture } from './readyReferenceFixture';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ExhibitionLiveConnection, type ExhibitionLiveDeps, type ExhibitionSdkSession } from '../src/exhibition/useExhibitionLive';
import type { ConnectOptions } from '../src/liveTryOn';

function deferred<T>() {
  let resolve!: (value: T) => void;
  return { promise: new Promise<T>(done => { resolve = done; }), resolve };
}
async function flush() { for (let i = 0; i < 35; i++) await Promise.resolve(); }
const connections: ExhibitionLiveConnection[] = [];
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(1_800_000_000_000); });
afterEach(async () => {
  for (const connection of connections.splice(0)) { try { await connection.stop(); } catch { /* The failure case must not leak into another isolated fixture. */ } }
  vi.clearAllTimers(); vi.useRealTimers();
});

function fixture() {
  const cameraTrack = { readyState: 'live', stop: vi.fn() };
  const sdkTrack = { readyState: 'live', stop: vi.fn(), onended: null };
  const camera = { getVideoTracks: () => [cameraTrack], getTracks: () => [cameraTrack] } as unknown as MediaStream;
  const cloned = { getVideoTracks: () => [sdkTrack], getTracks: () => [sdkTrack] } as unknown as MediaStream;
  const local = { id: 'manual-stop-local', token: 'tk-isolated-manual-stop', model: 'x2.0', status: 'active', sourceKind: 'camera' as const,
    sourceId: 'manual-stop-screen', sourceName: '停止测试', targetItemId: 'commute', referenceAsset: '/assets/exhibition/commute-cutout.png',
    refImageUrl: '', referenceVersion: 0, pointsLimit: 30, consumedCredits: 0, resultAvailable: false, verification: 'none' as const,
    expiresAt: new Date(Date.now() + 120_000).toISOString(), exhibition: { mirrorId: 'east', deviceId: 'manual-stop-screen', lookId: 'commute', sessionNumber: 1, generationNumber: 1 } };
  const sdk: ExhibitionSdkSession = { getSessionUid: vi.fn(() => 'ums-manual-stop'), set: vi.fn(async () => {}), disconnect: vi.fn(async () => {}), stopGeneration: vi.fn(async () => {}), stopLocalStream: vi.fn(async () => {}) };
  let callbacks!: ConnectOptions;
  const deps = {
    preparedReference: async () => readyReferenceFixture('https://fixture.example/ref.png'),
    create: vi.fn(async () => ({ ...local })), reference: vi.fn(async () => new File(['fixture'], 'fixture.png', { type: 'image/png' })),
    prepare: vi.fn(async () => {}), upload: vi.fn(async () => 'https://fixture.example/ref.png'),
    bind: vi.fn(async () => ({ ...local, refImageUrl: 'https://fixture.example/ref.png', referenceVersion: 1 })),
    connect: vi.fn(async (_source, _session, value) => { callbacks = value; return sdk; }),
    link: vi.fn(async () => ({ ...local, providerSessionId: 'ums-manual-stop', referenceVersion: 1 })),
    firstFrame: vi.fn(async () => local), stop: vi.fn(async () => ({ ...local, status: 'stopped' })),
    heartbeat: vi.fn(async () => ({})), reportError: vi.fn(async () => ({})), clone: vi.fn(() => cloned), now: vi.fn(() => 100),
  } satisfies ExhibitionLiveDeps;
  const events = { status: vi.fn(), stream: vi.fn(), refresh: vi.fn() };
  const connection = new ExhibitionLiveConnection({ mirrorId: 'east', deviceId: 'manual-stop-screen', lookId: 'commute', sessionNumber: 1, generationNumber: 1, expectedRevision: 1, image: local.referenceAsset, stream: camera }, events, deps);
  connections.push(connection);
  return { connection, deps, sdk, local, cameraTrack, sdkTrack, events, callbacks: () => callbacks, cloned };
}

describe('manual stop lifecycle under asynchronous supplier work', () => {
  it('requests backend deactivation even if SDK disconnect throws synchronously', async () => {
    const f = fixture(); await f.connection.start();
    vi.mocked(f.sdk.disconnect).mockImplementationOnce(() => { throw new Error('isolated SDK disconnect failure'); });
    let error: unknown;
    try { await f.connection.stop(); } catch (cause) { error = cause; }
    expect(f.deps.stop).toHaveBeenCalledWith(f.local.id);
    expect(error).toBeUndefined();
    expect(f.cameraTrack.stop).not.toHaveBeenCalled(); expect(f.sdkTrack.stop).toHaveBeenCalledOnce();
  });

  it('allows a failed deactivation to be retried without creating another session', async () => {
    const f = fixture(); await f.connection.start();
    f.deps.stop.mockRejectedValueOnce(new Error('isolated backend interruption'));
    await f.connection.stop();
    expect(f.events.status).toHaveBeenCalledWith('error', expect.stringMatching(/停止|确认/));
    await f.connection.stop();
    expect(f.deps.stop).toHaveBeenCalledTimes(2);
    expect(f.deps.create).toHaveBeenCalledOnce(); expect(f.sdk.set).toHaveBeenCalledOnce();
  });

  it('does not confirm stopping until the backend explicitly returns stopped', async () => {
    const f = fixture(); await f.connection.start();
    f.deps.stop.mockResolvedValueOnce({ ...f.local, status: 'stopping' });
    expect(await f.connection.stop()).toBe(false);
    expect(f.events.status).toHaveBeenCalledWith('error', expect.stringMatching(/停止|确认/));
    expect(await f.connection.stop()).toBe(true);
    expect(f.deps.stop).toHaveBeenCalledTimes(2);
  });

  it('keeps a failed late-credential deactivation visible and retryable', async () => {
    const f = fixture(); const pending = deferred<typeof f.local>();
    f.deps.create.mockReturnValueOnce(pending.promise);
    const starting = f.connection.start(); await flush();
    await f.connection.stop();
    f.deps.stop.mockRejectedValueOnce(new Error('isolated late deactivation failure'));
    pending.resolve(f.local); await starting;
    expect(f.events.status).toHaveBeenCalledWith('error', expect.stringMatching(/停止|确认/));
    await f.connection.stop();
    expect(f.deps.stop).toHaveBeenCalledTimes(2);
    expect(f.deps.connect).not.toHaveBeenCalled(); expect(f.sdk.set).not.toHaveBeenCalled();
  });

  it('deactivates the backend immediately when SDK disconnection hangs', async () => {
    const f = fixture(); await f.connection.start(); const hanging = deferred<void>();
    vi.mocked(f.sdk.disconnect).mockReturnValueOnce(hanging.promise);
    const stopping = f.connection.stop(); await flush();
    expect(f.deps.stop).toHaveBeenCalledWith(f.local.id);
    await vi.advanceTimersByTimeAsync(8_000); await stopping;
    expect(f.deps.create).toHaveBeenCalledOnce();
  });

  it('stops a late SDK connection without starting generation and releases the credential immediately', async () => {
    const f = fixture(); const pending = deferred<ExhibitionSdkSession>();
    f.deps.connect.mockReturnValueOnce(pending.promise);
    const starting = f.connection.start(); await flush();
    await f.connection.stop();
    expect(f.deps.stop).toHaveBeenCalledWith(f.local.id);
    expect(f.sdk.set).not.toHaveBeenCalled();
    pending.resolve(f.sdk); await starting;
    expect(f.sdk.disconnect).toHaveBeenCalledOnce(); expect(f.sdk.set).not.toHaveBeenCalled();
  });

  it('also disconnects an SDK arriving while the first stop is still awaiting backend confirmation', async () => {
    const f = fixture(); const connecting = deferred<ExhibitionSdkSession>(); const revoking = deferred<Awaited<ReturnType<typeof f.deps.stop>>>();
    f.deps.connect.mockReturnValueOnce(connecting.promise); f.deps.stop.mockReturnValueOnce(revoking.promise);
    const starting = f.connection.start(); await flush();
    const stopping = f.connection.stop(); await flush();
    connecting.resolve(f.sdk); await flush();
    revoking.resolve({ ...f.local, status: 'stopped' });
    await Promise.all([starting, stopping]);
    expect(f.sdk.disconnect).toHaveBeenCalledOnce(); expect(f.sdk.set).not.toHaveBeenCalled();
    expect(f.deps.stop).toHaveBeenCalledOnce();
  });

  it('revokes a credential resolving during the tokenless stop promise microtask window', async () => {
    const f = fixture(); const creating = deferred<typeof f.local>();
    f.deps.create.mockReturnValueOnce(creating.promise);
    const starting = f.connection.start(); await flush();
    const stopping = f.connection.stop(); creating.resolve(f.local);
    await Promise.all([starting, stopping]);
    expect(f.deps.stop).toHaveBeenCalledWith(f.local.id);
    expect(f.deps.connect).not.toHaveBeenCalled(); expect(f.sdk.set).not.toHaveBeenCalled();
  });

  it('ignores late generation callbacks and clears all work timers after a manual stop', async () => {
    const f = fixture(); const pending = deferred<void>();
    vi.mocked(f.sdk.set).mockReturnValueOnce(pending.promise);
    const starting = f.connection.start(); await flush();
    await f.connection.stop();
    const statusEvents = f.events.status.mock.calls.length;
    f.callbacks().onRemoteStream(f.cloned); f.callbacks().onRemoteVideoFirstFrame();
    f.callbacks().onError('late fixture error'); f.callbacks().onDisconnect();
    pending.resolve(); await starting;
    await vi.advanceTimersByTimeAsync(180_000);
    expect(f.events.status.mock.calls).toHaveLength(statusEvents);
    expect(f.deps.firstFrame).not.toHaveBeenCalled(); expect(f.deps.stop).toHaveBeenCalledOnce();
    expect(f.deps.create).toHaveBeenCalledOnce(); expect(f.cameraTrack.stop).not.toHaveBeenCalled();
  });
});
