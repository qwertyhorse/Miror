import { act, createElement, useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useExhibitionLive, type ExhibitionLiveController, type ExhibitionLiveDeps } from '../src/exhibition/useExhibitionLive';
import { exhibitionPromptForLook, type ExhibitionState } from '../shared/exhibition';
import { createReactHost, flushReact } from './support/reactHost';

const mocks = vi.hoisted(() => {
  const sdk = { getSessionUid: vi.fn(() => 'provider-stable'), set: vi.fn(async () => {}), disconnect: vi.fn(async () => {}) };
  const connect = vi.fn(); const uploadAndCheckImage = vi.fn(async (file: File) => ({ url: `https://reference.fixture/${file.name}` }));
  return { api: vi.fn(), sdk, connect, uploadAndCheckImage, createXmaxClient: vi.fn(() => ({ files: { uploadAndCheckImage }, realtime: { connect, connectMedia: connect } })),
    models: { realtime: (name: string) => ({ name }) } };
});
vi.mock('../src/api', () => ({ api: mocks.api, backend: {} }));
vi.mock('@xmaxai/sdk', () => ({ createXmaxClient: mocks.createXmaxClient, models: mocks.models }));
vi.mock('@xmaxai/sdk-global', () => ({ createXmaxClient: mocks.createXmaxClient, models: mocks.models }));
let host: Awaited<ReturnType<typeof createReactHost>> | undefined;
afterEach(async () => { await host?.close(); host = undefined; vi.unstubAllGlobals(); vi.clearAllMocks(); vi.useRealTimers(); });

function snapshot(overrides: Partial<ExhibitionState> = {}): ExhibitionState {
  return { mirrorId: 'default', revision: 1, phase: 'generating', experienceMode: 'clothx', selectedLookId: 'first', displayedLookId: null,
    looks: ['first', 'second', 'third'].map(id => ({ id, mode: 'clothx', name: id, image: `/assets/${id}.png`, source: 'sample', description: '', category: '', tags: [], palette: '' })),
    enabledLookIds: ['first', 'second', 'third'], categories: [], tags: [], sessionNumber: 1, generationNumber: 1, updatedAt: 1, generationReadyAt: null,
    providerMode: 'xmax', live: null, logs: [], settings: { autoReturnSeconds: 0, uploadLimits: { maxFileSizeMB: 10, minWidth: 64, minHeight: 64, maxWidth: 4096, maxHeight: 4096 } }, ...overrides };
}
function track() { const value = { readyState: 'live', onended: null, getSettings: () => ({ deviceId: 'camera-fixture' }), clone: () => track(),
  stop: vi.fn(() => { value.readyState = 'ended'; }) }; return value; }
class FixtureStream { constructor(private tracks: ReturnType<typeof track>[]) {} getTracks() { return this.tracks; } getVideoTracks() { return this.tracks; } }
async function fixture(initialState = snapshot(), continuous = false) {
  host = await createReactHost(); vi.stubGlobal('MediaStream', FixtureStream); vi.stubGlobal('localStorage', { getItem: () => null });
  const cameraTrack = track(); const camera = new FixtureStream([cameraTrack]) as unknown as MediaStream;
  const output = new FixtureStream([track()]) as unknown as MediaStream;
  const getUserMedia = vi.fn(async () => camera); vi.stubGlobal('navigator', { mediaDevices: { getUserMedia, enumerateDevices: async () => [] } });
  vi.stubGlobal('fetch', vi.fn(async () => new Response('reference', { headers: { 'Content-Type': 'image/png' } })));
  mocks.connect.mockImplementation(async (_stream, options: Parameters<ExhibitionLiveDeps['connect']>[2]) => { options.onRemoteStream(output); return mocks.sdk; });
  let value = { state: initialState, active: true, selectionPending: false };
  let live!: ExhibitionLiveController; let update!: (state: ExhibitionState, selectionPending?: boolean) => void;
  let record: any;
  let segments = 0;
  mocks.api.mockImplementation(async (path: string, _method?: string, input?: Record<string, any>) => {
    if (path.endsWith('/live/status')) return { configured: true, perSessionLimit: 30 };
    if (path.endsWith('/live/session')) {
      record = { id: continuous ? `segment-${++segments}` : 'same-session', token: 'temporary-fixture', model: 'x2.0', status: 'active', sourceId: 'camera', sourceKind: 'camera', sourceName: '摄像头',
        targetItemId: 'exhibition-first', lookId: input!.lookId, referenceAsset: '/assets/first.png', refImageUrl: '', referenceVersion: 0,
        expiresAt: new Date(Date.now() + 120_000).toISOString(), pointsLimit: 30, consumedCredits: 0, resultAvailable: false, verification: 'none',
        exhibition: { mirrorId: 'default', deviceId: input!.deviceId, lookId: input!.lookId, sessionNumber: 1, generationNumber: input!.generationNumber,
          mode: 'clothx', prompt: exhibitionPromptForLook({ mode: 'clothx' }), ...(continuous ? { continuous: true } : {}) } };
      return { ...record };
    }
    if (path.endsWith('/reference')) { record = { ...record, refImageUrl: input!.refImageUrl, referenceVersion: 1 }; return { ...record }; }
    if (path.endsWith('/link')) { record = { ...record, providerSessionId: input!.providerSessionId }; return { ...record }; }
    if (path.endsWith('/condition')) {
      if (record.exhibition.generationNumber !== input!.generationNumber) record = { ...record, lookId: input!.lookId, referenceAsset: `/assets/${input!.lookId}.png`,
        refImageUrl: input!.refImageUrl, referenceVersion: record.referenceVersion + 1, exhibition: { ...record.exhibition, lookId: input!.lookId, generationNumber: input!.generationNumber } };
      return { ...record };
    }
    if (path.endsWith('/condition/applied')) return {};
    if (path.endsWith('/first-frame')) {
      if (continuous) update({ ...value.state, phase: 'showcase', displayedLookId: record.lookId, revision: value.state.revision + 1,
        live: { deviceId: record.exhibition.deviceId, generationNumber: record.exhibition.generationNumber, sessionId: record.id, lookId: record.lookId,
          status: 'running', heartbeatAt: Date.now(), updatedAt: Date.now(), firstFrameMs: 100 } });
      return { ...record };
    }
    if (continuous && path.endsWith('/renewal')) {
      update({ ...value.state, revision: value.state.revision + 1, live: { ...value.state.live!, renewal: { id: 'renewal-fixture', requestedAt: Date.now() } } });
      return { renewalId: 'renewal-fixture' };
    }
    if (continuous && path.endsWith('/renewal/commit')) {
      expect(record.status).toBe('stopped');
      update({ ...value.state, revision: value.state.revision + 1, phase: 'generating', generationNumber: value.state.generationNumber + 1, live: null });
      return {};
    }
    if (path.endsWith('/live/heartbeat') || path.endsWith('/live/error')) return {};
    if (path.endsWith('/stop')) { if (continuous) record.status = 'stopped'; return { ...record, status: 'stopped' }; }
    throw new Error(`Unexpected fixture path: ${path}`);
  });
  function Harness() {
    const [current, setCurrent] = useState(value); value = current;
    update = (state, selectionPending = false) => setCurrent({ ...current, state, selectionPending });
    live = useExhibitionLive({ ...current, refresh: () => {} }); return null;
  }
  await host.render(createElement(Harness)); await flushReact();
  await act(async () => live.reportFirstFrame(output)); await flushReact();
  const lease = { deviceId: live.deviceId, generationNumber: 1, sessionId: record.id, lookId: 'first', status: 'running', heartbeatAt: Date.now(), firstFrameMs: 100 } as ExhibitionState['live'];
  await act(async () => update({ ...initialState, phase: 'showcase', displayedLookId: 'first', live: lease, revision: 2 })); await flushReact();
  return { get live() { return live; }, update, camera, output, cameraTrack, getUserMedia, lease,
    allocations: () => mocks.api.mock.calls.filter(([path]) => String(path).endsWith('/live/session')).length,
    calls: (suffix: string) => mocks.api.mock.calls.filter(([path]) => String(path).endsWith(suffix)) };
}

describe('exhibition hook preserves generated output while the selected outfit changes', () => {
  it('automatically connects the next segment with the same camera, then honors manual stop', async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-14T04:00:00Z'));
    const state = snapshot(); state.settings.sessionLimits = { credits: null, expireSeconds: 120 };
    const f = await fixture(state, true);
    expect(f.live.status).toBe('running'); expect(f.allocations()).toBe(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(105_000); }); await flushReact();
    expect(f.calls('/renewal')).toHaveLength(1); expect(f.calls('/renewal/commit')).toHaveLength(1);
    expect(f.allocations()).toBe(2); expect(mocks.connect).toHaveBeenCalledTimes(2);
    expect(mocks.sdk.disconnect).toHaveBeenCalledTimes(1);
    expect(f.live.cameraStream).toBe(f.camera); expect(f.getUserMedia).toHaveBeenCalledOnce();
    expect(f.cameraTrack.stop).not.toHaveBeenCalled();
    await act(async () => f.live.reportFirstFrame(f.output)); await flushReact();
    expect(f.live.status).toBe('running');
    await act(async () => { expect(await f.live.stopGeneration()).toBe(true); });
    await act(async () => { await vi.advanceTimersByTimeAsync(130_000); }); await flushReact();
    expect(f.allocations()).toBe(2); expect(f.calls('/renewal')).toHaveLength(1);
    expect(mocks.sdk.disconnect).toHaveBeenCalledTimes(2); expect(f.cameraTrack.stop).not.toHaveBeenCalled();
  });
  it.each([
    ['first', 'free-fixture', 'mox-fixture', 'second', 'third'],
    ['second', 'free-fixture', 'third', 'mox-fixture', 'first'],
  ])('prefetches the next two same-mode enabled images in catalog order %j', async (...enabledLookIds) => {
    const state = snapshot();
    state.looks.push({ ...state.looks[0], id: 'free-fixture', mode: 'free', image: '/assets/free.png' },
      { ...state.looks[0], id: 'mox-fixture', mode: 'mox', image: '/assets/mox.png' });
    state.enabledLookIds = enabledLookIds;
    await fixture(state);
    expect(vi.mocked(fetch).mock.calls.map(([url]) => String(url))).toEqual([
      expect.stringMatching(/\/assets\/first\.png$/), expect.stringMatching(/\/assets\/second\.png$/), expect.stringMatching(/\/assets\/third\.png$/),
    ]);
    expect(mocks.uploadAndCheckImage).toHaveBeenCalledTimes(3); expect(mocks.createXmaxClient).toHaveBeenCalledTimes(2);
  });

  it('does not duplicate the only eligible neighbouring reference or upload prompt-only materials', async () => {
    const state = snapshot(); state.looks[1].referenceKind = 'none';
    await fixture(state);
    expect(vi.mocked(fetch).mock.calls.map(([url]) => String(url))).toEqual([
      expect.stringMatching(/\/assets\/first\.png$/), expect.stringMatching(/\/assets\/third\.png$/),
    ]);
    expect(mocks.uploadAndCheckImage).toHaveBeenCalledTimes(2);
  });

  it('keeps the camera, remote stream, SDK and credential while the server still displays the preceding outfit', async () => {
    const f = await fixture(); expect(f.live.outputStream).toBe(f.output);
    await act(async () => f.update(snapshot({ phase: 'generating', generationNumber: 2, selectedLookId: 'second', displayedLookId: 'first', live: f.lease, revision: 3 })));
    await flushReact();
    expect(f.live.outputStream).toBe(f.output); expect(f.live.cameraStream).toBe(f.camera); expect(f.live.status).toBe('running'); expect(f.live.updateError).toBe('');
    expect(f.allocations()).toBe(1); expect(mocks.connect).toHaveBeenCalledOnce(); expect(mocks.sdk.set).toHaveBeenCalledTimes(2);
    expect(f.calls('/condition')).toHaveLength(1); expect(f.calls('/condition/applied')).toHaveLength(1); expect(f.calls('/first-frame')).toHaveLength(1);
    expect(f.calls('/stop')).toHaveLength(0); expect(mocks.sdk.disconnect).not.toHaveBeenCalled(); expect(f.cameraTrack.stop).not.toHaveBeenCalled(); expect(f.getUserMedia).toHaveBeenCalledOnce();
  });

  it('keeps showing the preceding result while a material-selection command is pending', async () => {
    const f = await fixture(); const next = snapshot({ phase: 'generating', generationNumber: 2, selectedLookId: 'second', displayedLookId: 'first', live: f.lease, revision: 3 });
    await act(async () => f.update(next, true)); await flushReact();
    expect(f.live.outputStream).toBe(f.output); expect(f.calls('/condition')).toHaveLength(0); expect(f.calls('/stop')).toHaveLength(0);
    await act(async () => f.update(next)); await flushReact();
    expect(f.live.outputStream).toBe(f.output); expect(f.calls('/condition/applied')).toHaveLength(1); expect(f.allocations()).toBe(1);
  });

  it('exposes a recoverable condition error and retries it without clearing the preceding output', async () => {
    const f = await fixture(); const original = mocks.api.getMockImplementation()!;
    let failed = false;
    mocks.api.mockImplementation(async (...args) => {
      if (String(args[0]).endsWith('/condition') && !failed) { failed = true; throw new Error('素材切换失败。'); }
      return original(...args);
    });
    await act(async () => f.update(snapshot({ phase: 'generating', generationNumber: 2, selectedLookId: 'second', displayedLookId: 'first', live: f.lease, revision: 3 }))); await flushReact();
    expect(f.live.updateError).toBe('素材切换失败。'); expect(f.live.error).toBe(''); expect(f.live.outputStream).toBe(f.output);
    let retried = false; await act(async () => { retried = await f.live.retryUpdate(); }); await flushReact();
    expect(retried).toBe(true); expect(f.live.updateError).toBe(''); expect(f.live.outputStream).toBe(f.output);
    expect(f.allocations()).toBe(1); expect(f.calls('/stop')).toHaveLength(0); expect(f.getUserMedia).toHaveBeenCalledOnce();
  });

  it('clears a previous material-switch error when the user explicitly stops generation', async () => {
    const f = await fixture(); const original = mocks.api.getMockImplementation()!;
    mocks.api.mockImplementation(async (...args) => {
      if (String(args[0]).endsWith('/condition')) throw new Error('素材切换失败。');
      return original(...args);
    });
    await act(async () => f.update(snapshot({ phase: 'generating', generationNumber: 2, selectedLookId: 'second', displayedLookId: 'first', live: f.lease, revision: 3 }))); await flushReact();
    expect(f.live.updateError).toBe('素材切换失败。');
    await act(async () => { expect(await f.live.stopGeneration()).toBe(true); }); await flushReact();
    expect(f.live.updateError).toBe(''); expect(f.live.outputStream).toBeNull(); expect(f.calls('/stop')).toHaveLength(1);
    expect(f.live.cameraStream).toBe(f.camera); expect(f.cameraTrack.stop).not.toHaveBeenCalled();
  });
});
