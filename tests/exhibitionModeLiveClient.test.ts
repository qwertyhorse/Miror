import { readyReferenceFixture, resolvedBinding } from './readyReferenceFixture';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ExhibitionLiveConnection, type ExhibitionLiveDeps, type ExhibitionSdkSession } from '../src/exhibition/useExhibitionLive';
import { EXHIBITION_EXPERIENCE_MODES, exhibitionPromptForLook, type ExhibitionExperienceMode } from '../shared/exhibition';
import type { MoXInteraction } from '../src/exhibition/MoXDragSurface';

const running: ExhibitionLiveConnection[] = [];
afterEach(async () => { for (const connection of running.splice(0)) await connection.stop(); });
function setup(mode: ExhibitionExperienceMode, freePrompt = '保持人物动作，将场景换成参考图中的森林', referenceKind: 'image' | 'none' = 'image') {
  const prompt = exhibitionPromptForLook({ mode, prompt: freePrompt });
  const track = { readyState: 'live', onended: null, stop: vi.fn() };
  const stream = { getVideoTracks: () => [track], getTracks: () => [track] } as unknown as MediaStream;
  const reference = new File(['reference'], 'reference.png', { type: 'image/png' });
  const created = { id: 'session-1', token: 'test-token', model: 'x2.0', sourceKind: mode === 'mox' ? 'photo' : 'camera', referenceAsset: referenceKind === 'none' ? '' : '/asset.webp', refImageUrl: '', referenceVersion: 0, expiresAt: new Date(Date.now() + 60000).toISOString(),
    exhibition: { mirrorId: 'mirror-a', lookId: 'look-a', deviceId: 'device-a', generationNumber: 1, sessionNumber: 1, mode, prompt } } as any;
  const sdk: ExhibitionSdkSession = { getSessionUid: () => 'provider-a', set: vi.fn(async () => {}), disconnect: vi.fn(async () => {}), stopGeneration: vi.fn(async () => {}), stopLocalStream: vi.fn(async () => {}),
    media: { streamSetting: { width: 512, height: 768 } }, beginDrag: vi.fn(), endDrag: vi.fn(), sendTracks: vi.fn(async () => {}) };
  let callbacks!: Parameters<ExhibitionLiveDeps['connect']>[2];
  const deps = { create: vi.fn(async () => created), reference: vi.fn(async () => reference), prepare: vi.fn(async () => {}), readyLookup: vi.fn(async () => 'https://reference.test/image.webp'),
    bind: vi.fn(async () => ({ ...created, referenceVersion: 1, refImageUrl: 'https://reference.test/image.webp' })),
    connect: vi.fn(async (_source, _local, next) => { callbacks = next; return sdk; }), link: vi.fn(async () => ({ ...created, providerSessionId: 'provider-a', referenceVersion: referenceKind === 'none' ? 0 : 1 })),
    firstFrame: vi.fn(async () => created), stop: vi.fn(async () => created), heartbeat: vi.fn(async () => ({})), reportError: vi.fn(async () => ({})), clone: vi.fn(() => stream), now: () => 42 } satisfies Omit<ExhibitionLiveDeps, 'upload'> & { readyLookup: (...args: any[]) => Promise<string> };
  Object.assign(deps, { upload: vi.fn(async () => { throw new Error('Browser upload forbidden'); }), preparedReference: async (input: Parameters<ExhibitionLiveDeps['create']>[0]) => readyReferenceFixture(await deps.readyLookup(new File(['backend-fixture'], input.image.split('/').pop()!, { type: 'image/png' }), '', new AbortController().signal)) });
  const events = { status: vi.fn(), stream: vi.fn(), refresh: vi.fn(), interaction: vi.fn<(value: MoXInteraction | null) => void>(), presentation: vi.fn() };
  const connection = new ExhibitionLiveConnection({ mirrorId: 'mirror-a', lookId: 'look-a', deviceId: 'device-a', generationNumber: 1, sessionNumber: 1, expectedRevision: 1, image: '/asset.webp', referenceKind, mode, prompt: freePrompt, stream: mode === 'mox' ? undefined : stream }, events, deps);
  running.push(connection);
  return { connection, deps, sdk, created, events, reference, stream, track, callbacks: () => callbacks, prompt };
}

describe('mode-specific exhibition generation', () => {
  it.each(EXHIBITION_EXPERIENCE_MODES)('uses the server snapshot and one generation for %s', async mode => {
    const f = setup(mode); await f.connection.start();
    expect(f.sdk.set).toHaveBeenCalledExactlyOnceWith({ prompt: f.prompt, refImageUrl: 'https://reference.test/image.webp' });
    expect(f.deps.create).toHaveBeenCalledTimes(1);
    expect(f.deps.connect).toHaveBeenCalledWith(mode === 'mox' ? f.reference : f.stream, expect.objectContaining({ exhibition: expect.objectContaining({ mode, prompt: f.prompt }) }), expect.any(Object));
    expect(f.deps.clone).toHaveBeenCalledTimes(mode === 'mox' ? 0 : 1);
  });
  it('rejects mismatched mode before sending the reference or any input', async () => {
    const f = setup('charx'); f.created.exhibition.mode = 'clothx'; await f.connection.start();
    expect(f.deps.readyLookup).toHaveBeenCalledOnce(); expect(f.deps.connect).not.toHaveBeenCalled(); expect(f.deps.stop).toHaveBeenCalledWith('session-1');
  });
  it('rejects a changed Free prompt rather than generating from stale data', async () => {
    const f = setup('free'); f.created.exhibition.prompt = 'other instruction'; await f.connection.start();
    expect(f.sdk.set).not.toHaveBeenCalled(); expect(f.deps.stop).toHaveBeenCalledWith('session-1');
  });
  it('rejects camera sessions returned for a MoX image', async () => {
    const f = setup('mox'); f.created.sourceKind = 'camera'; await f.connection.start();
    expect(f.deps.connect).not.toHaveBeenCalled(); expect(f.deps.stop).toHaveBeenCalledWith('session-1');
  });
  it('forwards Instant presentation and drag through one session without a camera', async () => {
    const f = setup('mox'); await f.connection.start();
    const drag = f.events.interaction.mock.calls.at(-1)?.[0]!;
    expect(drag).toMatchObject({ width: 512, height: 768 });
    drag.beginDrag(); await drag.sendTracks([[256, 384]]); drag.endDrag();
    expect(f.sdk.beginDrag).toHaveBeenCalledTimes(1); expect(f.sdk.sendTracks).toHaveBeenCalledExactlyOnceWith([[256, 384]]); expect(f.sdk.endDrag).toHaveBeenCalledTimes(1);
    const presentation = { instant: true, inputImageUrl: 'blob:sdk-owned', showInputImage: true, suppressLoading: true };
    f.callbacks().onPresentationChange?.(presentation); expect(f.events.presentation).toHaveBeenCalledWith(presentation);
    f.callbacks().onRoomEvent({ event: 'video_completed' });
    expect(f.connection.stopped).toBe(false); expect(f.deps.create).toHaveBeenCalledTimes(1);
    await f.connection.stop(); drag.beginDrag(); await drag.sendTracks([[0, 0]]); drag.endDrag();
    expect(f.sdk.beginDrag).toHaveBeenCalledTimes(1); expect(f.sdk.sendTracks).toHaveBeenCalledTimes(1); expect(f.events.interaction).toHaveBeenLastCalledWith(null);
  });
  it('fails closed when the SDK cannot provide a MoX touch surface', async () => {
    const f = setup('mox'); f.sdk.sendTracks = undefined; await f.connection.start();
    expect(f.connection.stopped).toBe(true); expect(f.deps.stop).toHaveBeenCalledWith('session-1'); expect(f.events.interaction).toHaveBeenLastCalledWith(null);
  });

  it('runs prompt-only Free from the camera without reading, uploading or binding its cover', async () => {
    const f = setup('free', '  保持人物动作，将背景变成童话森林  ', 'none');
    await f.connection.start();
    expect(f.deps.create.mock.invocationCallOrder[0]).toBeLessThan(f.deps.prepare.mock.invocationCallOrder[0]);
    expect(f.deps.prepare).toHaveBeenCalledWith('global');
    expect(f.deps.reference).not.toHaveBeenCalled(); expect(f.deps.readyLookup).not.toHaveBeenCalled(); expect(f.deps.bind).not.toHaveBeenCalled();
    expect(f.deps.connect).toHaveBeenCalledWith(f.stream, expect.objectContaining({ referenceAsset: '', refImageUrl: '', referenceVersion: 0 }), expect.any(Object));
    expect(f.deps.link.mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(f.sdk.set).mock.invocationCallOrder[0]);
    expect(f.sdk.set).toHaveBeenCalledExactlyOnceWith({ prompt: '保持人物动作，将背景变成童话森林' });
    expect(f.deps.clone).toHaveBeenCalledTimes(1);
    f.callbacks().onRemoteStream(f.stream); f.connection.reportRenderedFrame(f.stream); f.connection.reportRenderedFrame(f.stream);
    await Promise.resolve();
    expect(f.deps.firstFrame).toHaveBeenCalledTimes(1);
    await f.connection.stop();
    expect(f.track.stop).toHaveBeenCalledTimes(1); expect(f.sdk.disconnect).toHaveBeenCalledTimes(1); expect(f.deps.stop).toHaveBeenCalledWith('session-1');
  });

  it('still requires a live camera for prompt-only Free before allocating', async () => {
    const f = setup('free', '童话森林', 'none'); f.track.readyState = 'ended';
    await f.connection.start();
    expect(f.deps.create).not.toHaveBeenCalled(); expect(f.deps.connect).not.toHaveBeenCalled();
    expect(f.events.status).toHaveBeenCalledWith('error', '摄像头已断开，请重新开启。');
  });

  it('rejects prompt-only references in other modes before allocating', async () => {
    const f = setup('charx', '', 'none'); await f.connection.start();
    expect(f.deps.create).not.toHaveBeenCalled(); expect(f.deps.connect).not.toHaveBeenCalled();
  });

  it.each([
    { referenceAsset: '/asset.webp' }, { refImageUrl: 'https://unexpected.test/ref.webp' }, { referenceVersion: 1 },
  ])('rejects an unexpected reference in a prompt-only server snapshot: %j', async change => {
    const f = setup('free', '童话森林', 'none'); Object.assign(f.created, change);
    await f.connection.start();
    expect(f.deps.connect).not.toHaveBeenCalled(); expect(f.sdk.set).not.toHaveBeenCalled(); expect(f.deps.stop).toHaveBeenCalledWith('session-1');
  });

  it('rejects a link response that binds an image to a prompt-only session', async () => {
    const f = setup('free', '童话森林', 'none');
    f.deps.link.mockResolvedValueOnce({ ...f.created, providerSessionId: 'provider-a', referenceVersion: 1 });
    await f.connection.start();
    expect(f.deps.connect).toHaveBeenCalledTimes(1); expect(f.sdk.set).not.toHaveBeenCalled();
    expect(f.sdk.disconnect).toHaveBeenCalledTimes(1); expect(f.deps.stop).toHaveBeenCalledWith('session-1');
  });
});
