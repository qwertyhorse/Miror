import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ExhibitionLiveConnection, type ExhibitionLiveDeps } from '../src/exhibition/useExhibitionLive';
import { exhibitionPromptForLook } from '../shared/exhibition';

type Input = Parameters<ExhibitionLiveDeps['create']>[0];
const connections: ExhibitionLiveConnection[] = [];
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; }
async function flush() { for (let index = 0; index < 30; index++) await Promise.resolve(); }
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(10_000); });
afterEach(async () => { for (const connection of connections.splice(0)) await connection.stop(); vi.clearAllTimers(); vi.useRealTimers(); });

function fixture(mode: 'clothx' | 'free' = 'clothx', prefetchImages?: string[]) {
  const originalStop = vi.fn(); const cloneStop = vi.fn();
  const track = { readyState: 'live', stop: originalStop };
  const cloneTrack = { readyState: 'live', stop: cloneStop, onended: null };
  const stream = { getVideoTracks: () => [track], getTracks: () => [track] } as unknown as MediaStream;
  const clone = { getVideoTracks: () => [cloneTrack], getTracks: () => [cloneTrack] } as unknown as MediaStream;
  const output = { id: 'unchanged-remote-output' } as MediaStream;
  const first: Input = { mirrorId: 'default', deviceId: 'screen-a', sessionNumber: 1, generationNumber: 1, lookId: 'first', expectedRevision: 1,
    image: '/assets/first.png', stream, mode, prefetchImages };
  let record = { id: 'same-credential', token: 'temporary-fixture', model: 'x2.0', status: 'active', sourceId: 'camera-a', sourceKind: 'camera' as const,
    sourceName: '摄像头', targetItemId: 'exhibition-first', lookId: first.lookId, referenceAsset: first.image, refImageUrl: '', referenceVersion: 0,
    providerSessionId: undefined as string | undefined, expiresAt: new Date(Date.now() + 120_000).toISOString(), pointsLimit: 30, consumedCredits: 0,
    resultAvailable: false, verification: 'none' as const, exhibition: { mirrorId: 'default', deviceId: first.deviceId, sessionNumber: 1, generationNumber: 1,
      lookId: first.lookId, mode, prompt: exhibitionPromptForLook({ mode }) } };
  let callbacks!: Parameters<ExhibitionLiveDeps['connect']>[2];
  const sdk = { getSessionUid: vi.fn(() => 'stable-provider-uid'), set: vi.fn(async (_context: { prompt: string; refImageUrl?: string | null }) => {}),
    disconnect: vi.fn(async () => {}), stopGeneration: vi.fn(async () => {}), stopLocalStream: vi.fn(async () => {}) };
  const condition = async (_id: string, intent: Parameters<NonNullable<ExhibitionLiveDeps['updateCondition']>>[1]) => {
    if (record.exhibition.generationNumber !== intent.generationNumber) {
      record = { ...record, lookId: intent.lookId, targetItemId: `exhibition-${intent.lookId}`, referenceAsset: intent.refImageUrl ? `/assets/${intent.lookId}.png` : '',
        refImageUrl: intent.refImageUrl ?? '', referenceVersion: record.referenceVersion + 1,
        exhibition: { ...record.exhibition, generationNumber: intent.generationNumber, lookId: intent.lookId } };
    }
    return { ...record, exhibition: { ...record.exhibition } };
  };
  const deps = {
    create: vi.fn(async () => ({ ...record })), reference: vi.fn(async (input: Input) => new File(['garment'], input.image.split('/').pop()!, { type: 'image/png' })),
    prepare: vi.fn(async () => {}), upload: vi.fn(async (file: File) => `https://reference.fixture/${file.name}`),
    bind: vi.fn(async (_id, input) => { record = { ...record, refImageUrl: input.refImageUrl, referenceVersion: 1 }; return { ...record }; }),
    updateCondition: vi.fn(condition), conditionApplied: vi.fn(async () => ({})),
    connect: vi.fn(async (_source, _local, value) => { callbacks = value; return sdk; }),
    link: vi.fn(async (_id, providerSessionId) => { record = { ...record, providerSessionId }; return { ...record }; }),
    firstFrame: vi.fn(async () => ({ ...record })), stop: vi.fn(async () => ({ ...record, status: 'stopped' })),
    heartbeat: vi.fn(async () => ({})), reportError: vi.fn(async () => ({})), clone: vi.fn(() => clone), now: vi.fn(() => 1000),
  } satisfies ExhibitionLiveDeps;
  const events = { status: vi.fn(), stream: vi.fn(), refresh: vi.fn(), updateError: vi.fn() };
  const controller = new ExhibitionLiveConnection(first, events, deps); connections.push(controller);
  const next = (lookId: string, generationNumber = 2): Input => ({ ...first, lookId, generationNumber, image: `/assets/${lookId}.png` });
  const ready = async () => { await controller.start(); callbacks.onRemoteStream(output); controller.reportRenderedFrame(output); await flush(); };
  return { controller, deps, events, sdk, first, next, ready, stream, output, originalStop, cloneStop, condition, record: () => record };
}

describe('same-session exhibition condition changes', () => {
  it('waits for the initial SDK start even when its decoded frame has already been acknowledged', async () => {
    const f = fixture(); const pending = deferred<void>(); f.sdk.set.mockImplementationOnce(() => pending.promise);
    const starting = f.controller.start(); await flush();
    expect(f.sdk.set).toHaveBeenCalledOnce();
    f.deps.connect.mock.calls[0][2].onRemoteStream(f.output);
    f.controller.reportRenderedFrame(f.output); await flush();
    expect(f.deps.firstFrame).toHaveBeenCalledOnce(); expect(f.events.status).toHaveBeenLastCalledWith('running');
    const updating = f.controller.update(f.next('second')); await flush();
    expect(f.sdk.set).toHaveBeenCalledOnce(); expect(f.deps.updateCondition).not.toHaveBeenCalled(); expect(f.events.stream).not.toHaveBeenCalledWith(null);
    pending.resolve(); await starting; expect(await updating).toBe(true);
    expect(f.sdk.set).toHaveBeenCalledTimes(2); expect(f.deps.conditionApplied).toHaveBeenCalledOnce(); expect(f.deps.create).toHaveBeenCalledOnce();
  });

  it('moves between outfits on the same remote stream and reuses a previously uploaded image', async () => {
    const f = fixture(); await f.ready();
    expect(await f.controller.update(f.next('second'))).toBe(true);
    expect(await f.controller.update(f.next('first', 3))).toBe(true);
    expect(f.deps.create).toHaveBeenCalledOnce(); expect(f.deps.connect).toHaveBeenCalledOnce(); expect(f.deps.clone).toHaveBeenCalledOnce();
    expect(f.deps.upload).toHaveBeenCalledTimes(2); expect(f.sdk.set).toHaveBeenCalledTimes(3);
    expect(f.deps.conditionApplied).toHaveBeenLastCalledWith('same-credential', expect.objectContaining({ lookId: 'first', generationNumber: 3, referenceVersion: 3 }), expect.any(AbortSignal));
    expect(f.events.stream).toHaveBeenCalledExactlyOnceWith(f.output); expect(f.events.stream).not.toHaveBeenCalledWith(null);
    expect(f.deps.firstFrame).toHaveBeenCalledOnce(); expect(f.deps.stop).not.toHaveBeenCalled(); expect(f.sdk.disconnect).not.toHaveBeenCalled();
    expect(f.originalStop).not.toHaveBeenCalled(); expect(f.cloneStop).not.toHaveBeenCalled();
  });

  it('deduplicates a foreground material selection against an active-session neighbour preupload', async () => {
    const f = fixture('clothx', ['/assets/second.png']); const pending = deferred<string>();
    f.deps.upload.mockImplementationOnce(async file => `https://reference.fixture/${file.name}`).mockImplementationOnce(() => pending.promise);
    await f.ready(); expect(f.deps.upload).toHaveBeenCalledTimes(2);
    const updating = f.controller.update(f.next('second')); await flush(); expect(f.deps.upload).toHaveBeenCalledTimes(2);
    pending.resolve('https://reference.fixture/second.png'); expect(await updating).toBe(true);
    expect(f.deps.create).toHaveBeenCalledOnce(); expect(f.deps.conditionApplied).toHaveBeenCalledOnce();
  });

  it('explicitly clears the previous image when Free mode changes to a prompt-only material', async () => {
    const f = fixture('free'); await f.ready(); const promptOnly = { ...f.next('second'), referenceKind: 'none' as const };
    expect(await f.controller.update(promptOnly)).toBe(true);
    expect(f.sdk.set).toHaveBeenLastCalledWith({ prompt: exhibitionPromptForLook({ mode: 'free' }), refImageUrl: null });
    expect(f.deps.updateCondition.mock.calls[0][1]).not.toHaveProperty('refImageUrl'); expect(f.deps.upload).toHaveBeenCalledOnce();
  });

  it('skips a superseded material whose upload resolves after a newer selection', async () => {
    const f = fixture(); await f.ready(); const pending = deferred<string>(); f.deps.upload.mockImplementationOnce(() => pending.promise);
    const second = f.controller.update(f.next('second')); await flush();
    const third = f.controller.update(f.next('third', 3)); pending.resolve('https://reference.fixture/second.png');
    expect(await second).toBe(false); expect(await third).toBe(true);
    expect(f.deps.updateCondition).toHaveBeenCalledOnce(); expect(f.deps.updateCondition.mock.calls[0][1].lookId).toBe('third');
    expect(f.sdk.set).toHaveBeenCalledTimes(2); expect(f.sdk.set).toHaveBeenLastCalledWith(expect.objectContaining({ refImageUrl: 'https://reference.fixture/third.png' }));
  });

  it('records an accepted stale bind without applying it, then validates the next reference version', async () => {
    const f = fixture(); await f.ready(); const pending = deferred<void>();
    f.deps.updateCondition.mockImplementationOnce(async (id, input) => { const result = await f.condition(id, input); await pending.promise; return result; });
    const second = f.controller.update(f.next('second')); await flush(); const third = f.controller.update(f.next('third', 3));
    pending.resolve(); await Promise.all([second, third]);
    expect(f.deps.updateCondition).toHaveBeenCalledTimes(2); expect(f.deps.conditionApplied).toHaveBeenCalledOnce();
    expect(f.deps.conditionApplied.mock.calls[0][1]).toMatchObject({ lookId: 'third', referenceVersion: 3 });
    expect(f.sdk.set).toHaveBeenCalledTimes(2); expect(f.events.updateError).not.toHaveBeenCalledWith(expect.stringContaining('校验失败'));
  });

  it('serializes SDK changes and never acknowledges a superseded in-flight set', async () => {
    const f = fixture(); await f.ready(); const pending = deferred<void>(); f.sdk.set.mockImplementationOnce(() => pending.promise);
    const second = f.controller.update(f.next('second')); await flush(); const third = f.controller.update(f.next('third', 3)); await flush();
    expect(f.sdk.set).toHaveBeenCalledTimes(2); expect(f.deps.conditionApplied).not.toHaveBeenCalled();
    pending.resolve(); await Promise.all([second, third]);
    expect(f.sdk.set).toHaveBeenCalledTimes(3); expect(f.deps.conditionApplied).toHaveBeenCalledOnce();
    expect(f.deps.conditionApplied.mock.calls[0][1].lookId).toBe('third');
  });

  it('keeps the previous output after an upload failure and lets a newer selection succeed', async () => {
    const f = fixture(); await f.ready(); f.deps.upload.mockRejectedValueOnce(new Error('素材上传失败。'));
    expect(await f.controller.update(f.next('second'))).toBe(false);
    expect(f.events.updateError).toHaveBeenLastCalledWith('素材上传失败。'); expect(f.events.status).toHaveBeenLastCalledWith('running');
    expect(f.controller.stopped).toBe(false); expect(f.events.stream).not.toHaveBeenCalledWith(null); expect(f.deps.reportError).not.toHaveBeenCalled();
    expect(await f.controller.update(f.next('third', 3))).toBe(true); expect(f.deps.create).toHaveBeenCalledOnce(); expect(f.deps.stop).not.toHaveBeenCalled();
  });

  it('retries a rejected SDK update with the idempotently bound version and cached upload', async () => {
    const f = fixture(); await f.ready(); f.sdk.set.mockRejectedValueOnce(new Error('切换请求失败。'));
    expect(await f.controller.update(f.next('second'))).toBe(false); expect(f.deps.conditionApplied).not.toHaveBeenCalled();
    expect(await f.controller.retryUpdate()).toBe(true);
    expect(f.deps.upload).toHaveBeenCalledTimes(2); expect(f.deps.conditionApplied.mock.calls[0][1].referenceVersion).toBe(2);
    expect(f.deps.firstFrame).toHaveBeenCalledOnce(); expect(f.sdk.disconnect).not.toHaveBeenCalled();
  });

  it('recovers from a lost bind response without requiring a new credential or a guessed version', async () => {
    const f = fixture(); await f.ready();
    f.deps.updateCondition.mockImplementationOnce(async (id, input) => { await f.condition(id, input); throw new Error('网络连接中断。'); });
    expect(await f.controller.update(f.next('second'))).toBe(false);
    expect(await f.controller.retryUpdate()).toBe(true);
    expect(f.deps.create).toHaveBeenCalledOnce(); expect(f.deps.conditionApplied.mock.calls[0][1].referenceVersion).toBe(2);
  });

  it('bounds a stalled condition request while keeping the preceding output available for explicit retry', async () => {
    const f = fixture(); await f.ready(); const pending = deferred<Awaited<ReturnType<typeof f.condition>>>();
    f.deps.updateCondition.mockImplementationOnce(() => pending.promise);
    const updating = f.controller.update(f.next('second')); await flush(); await vi.advanceTimersByTimeAsync(12_000);
    expect(await updating).toBe(false); expect(f.controller.stopped).toBe(false); expect(f.events.stream).not.toHaveBeenCalledWith(null);
    expect(f.events.updateError).toHaveBeenLastCalledWith('连接超时，请检查网络后重试。');
    expect(await f.controller.retryUpdate()).toBe(true); expect(f.deps.create).toHaveBeenCalledOnce();
  });

  it('does not bind, generate, or resurrect output after stop while an upload is pending', async () => {
    const f = fixture(); await f.ready(); const pending = deferred<string>(); f.deps.upload.mockImplementationOnce(() => pending.promise);
    const updating = f.controller.update(f.next('second')); await flush(); await f.controller.stop(); pending.resolve('https://reference.fixture/late.png');
    expect(await updating).toBe(false); expect(f.deps.updateCondition).not.toHaveBeenCalled(); expect(f.sdk.set).toHaveBeenCalledOnce();
    expect(f.deps.stop).toHaveBeenCalledOnce(); expect(f.sdk.disconnect).toHaveBeenCalledOnce(); expect(f.events.stream).toHaveBeenLastCalledWith(null);
  });

  it('does not acknowledge a late SDK condition response after an explicit stop', async () => {
    const f = fixture(); await f.ready(); const pending = deferred<void>(); f.sdk.set.mockImplementationOnce(() => pending.promise);
    const updating = f.controller.update(f.next('second')); await flush(); await f.controller.stop(); pending.resolve();
    expect(await updating).toBe(false); expect(f.deps.conditionApplied).not.toHaveBeenCalled(); expect(f.deps.firstFrame).toHaveBeenCalledOnce();
    expect(f.events.stream).toHaveBeenLastCalledWith(null); expect(f.deps.stop).toHaveBeenCalledOnce(); expect(f.sdk.disconnect).toHaveBeenCalledOnce();
  });

  it.each(['mirror', 'round', 'mode', 'camera', 'ended-camera'] as const)('requires a new connection when %s changes', async change => {
    const f = fixture(); await f.ready(); const input = f.next('second');
    if (change === 'mirror') input.mirrorId = 'east';
    else if (change === 'round') input.sessionNumber++;
    else if (change === 'mode') input.mode = 'free';
    else if (change === 'camera') input.stream = {} as MediaStream;
    else f.stream.getVideoTracks()[0].readyState = 'ended' as MediaStreamTrackState;
    expect(f.controller.canReuse(input)).toBe(false); expect(await f.controller.update(input)).toBe(false);
    expect(f.deps.updateCondition).not.toHaveBeenCalled();
  });

  it('rejects mismatched returned metadata while preserving the active generated stream', async () => {
    const f = fixture(); await f.ready();
    f.deps.updateCondition.mockImplementationOnce(async (id, input) => ({ ...(await f.condition(id, input)), exhibition: { ...f.record().exhibition, deviceId: 'another-screen' } }));
    expect(await f.controller.update(f.next('second'))).toBe(false);
    expect(f.events.updateError).toHaveBeenLastCalledWith('换装条件校验失败，请重新选择素材。');
    expect(f.sdk.set).toHaveBeenCalledOnce(); expect(f.controller.stopped).toBe(false); expect(f.events.stream).not.toHaveBeenCalledWith(null);
  });
});
