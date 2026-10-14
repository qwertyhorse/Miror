import { act, createElement, useEffect, useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TerminalCameraEntry, TerminalCameraSettings, terminalCameraAvailable, terminalCameraRequestMatches, useTerminalCameraRequest, useTerminalCameraReport } from '../src/exhibition/TerminalCameraSettings';
import { useExhibitionLive, type ExhibitionLiveController } from '../src/exhibition/useExhibitionLive';
import type { TerminalBinding } from '../src/exhibition/useTerminalBinding';
import type { ExhibitionState } from '../shared/exhibition';
import type { ExhibitionCameraRequest } from '../shared/exhibitionCamera';
import { createReactHost, flushReact } from './support/reactHost';

const mocks = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock('../src/api', () => ({ api: mocks.api, backend: {} }));
vi.mock('../src/exhibition/LiveCameraPanel', () => ({ StreamVideo: ({ stream, onFirstFrame }: { stream: MediaStream; onFirstFrame?: (stream: MediaStream) => void }) => {
  useEffect(() => { if (stream) onFirstFrame?.(stream); }, [stream, onFirstFrame]); return null;
} }));

const identity = { terminalId: 'terminal-12345678-1234-4234-8234-123456789abc', token: 'private-test-token', platform: 'browser' as const, label: '浏览器镜端' };
const request = (): ExhibitionCameraRequest => ({ id: 'camera-request-a', action: 'open', terminalId: identity.terminalId, mirrorId: 'mirror-a', bindingId: 'binding-a', createdAt: Date.now(), expiresAt: Date.now() + 120000 });
const connection = { terminalId: identity.terminalId, mirrorId: 'mirror-a', cameraBindingId: 'binding-a' };
const state = (): ExhibitionState => ({ mirrorId: 'mirror-a', revision: 1, phase: 'idle', experienceMode: 'clothx', selectedLookId: 'look', displayedLookId: null,
  looks: [{ id: 'look', mode: 'clothx', name: '衣服', image: '/test.png', source: 'sample', description: '', category: '', tags: [], palette: '' }],
  enabledLookIds: ['look'], categories: [], tags: [], sessionNumber: 0, generationNumber: 0, updatedAt: 1, generationReadyAt: null,
  providerMode: 'demo', live: null, logs: [], settings: { autoReturnSeconds: 90, uploadLimits: { maxFileSizeMB: 10, minWidth: 64, minHeight: 64, maxWidth: 4096, maxHeight: 4096 } } });
let host: Awaited<ReturnType<typeof createReactHost>> | undefined;
afterEach(async () => { await host?.close(); host = undefined; vi.useRealTimers(); vi.unstubAllGlobals(); vi.clearAllMocks(); });

function makeStream(id: string) {
  const track = { readyState: 'live', stop: vi.fn(function () { track.readyState = 'ended'; }), getSettings: () => ({ deviceId: id }), onended: null };
  return { stream: { getTracks: () => [track], getVideoTracks: () => [track] } as unknown as MediaStream, track };
}
async function fixture(initialRequest: ExhibitionCameraRequest | null = request(), initialState = state(), includeMetadataReport = false, localPreview = false) {
  host = await createReactHost();
  const createNode = document.createElement.bind(document);
  document.createElement = ((tag: string) => {
    const node = createNode(tag);
    if (tag === 'select') Object.defineProperty(node, 'options', { get: () => node.childNodes });
    return node;
  }) as typeof document.createElement;
  const saved = new Map<string, string>();
  const storage = { getItem: vi.fn((key: string) => saved.get(key) ?? null), setItem: vi.fn((key: string, value: string) => saved.set(key, value)) };
  vi.stubGlobal('localStorage', storage);
  const devices = ['camera-a', 'camera-b'].map((deviceId, index) => ({ deviceId, label: `USB ${index + 1}`, kind: 'videoinput' as const }));
  const streams: ReturnType<typeof makeStream>[] = [];
  const getUserMedia = vi.fn(async (constraints: MediaStreamConstraints) => {
    const id = typeof constraints.video === 'object' ? (constraints.video.deviceId as ConstrainDOMStringParameters)?.exact as string : undefined;
    const capture = makeStream(id || 'camera-a'); streams.push(capture); return capture.stream;
  });
  const enumerateDevices = vi.fn(async () => devices);
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia, enumerateDevices, addEventListener: vi.fn(), removeEventListener: vi.fn() } });
  mocks.api.mockResolvedValue({ configured: false });
  const report = vi.fn();
  const openCamera = vi.fn(async (_mirrorId: string, _signal?: AbortSignal) => request());
  let update!: (value: { request?: ExhibitionCameraRequest; connected?: boolean; bindingId?: string; boundMirrorId?: string; localPreview?: boolean; state?: ExhibitionState }) => void;
  let live!: ExhibitionLiveController;
  let gate!: ReturnType<typeof useTerminalCameraRequest>;
  function Harness() {
    const [value, setValue] = useState({ request: initialRequest ?? undefined, connected: true, bindingId: 'binding-a', boundMirrorId: 'mirror-a', localPreview, state: initialState });
    update = next => setValue(old => ({ ...old, ...next }));
    const terminal: TerminalBinding = { ready: true, identity: value.localPreview ? null : identity, connected: value.connected && !value.localPreview,
      connection: value.localPreview ? null : { ...connection, mirrorId: value.boundMirrorId, cameraBindingId: value.bindingId, cameraRequest: value.request }, error: '', retry: async () => {}, beginPairing: () => {}, reportCamera: report, openCamera };
    gate = useTerminalCameraRequest(terminal, 'mirror-a', value.state, false, value.localPreview);
    live = useExhibitionLive({ state: value.state, active: value.connected, refresh: () => {}, mirrorId: 'mirror-a', cameraSettingsOpen: gate.blocksGeneration });
    useTerminalCameraReport(includeMetadataReport ? terminal : undefined, 'mirror-a', live, gate.request);
    return createElement('div', null, createElement(TerminalCameraEntry, { settings: gate, busy: !terminalCameraAvailable(value.state), connected: value.connected }),
      gate.request ? createElement(TerminalCameraSettings, { request: gate.request, live, report: gate.request.localPreview ? undefined : report, close: gate.close }) : null);
  }
  await host.render(createElement(Harness)); await flushReact();
  const button = (label: string) => host!.find(node => node.nodeName === 'button' && node.textContent === label);
  const click = async (label: string) => { await act(async () => { await button(label)!.getReactProps().onClick(); }); await flushReact(); };
  const select = async (id: string) => { await act(async () => { host!.find(node => node.nodeName === 'select')!.getReactProps().onChange({ target: { value: id } }); }); await flushReact(); };
  return { get live() { return live; }, get gate() { return gate; }, update, report, openCamera, storage, getUserMedia, enumerateDevices, streams, click, select, button };
}

describe('bound browser terminal camera diagnostics', () => {
  it('opens the permanent local entry immediately with the server request and reuses healthy capture', async () => {
    const f = await fixture(null); await act(async () => { await f.live.startCamera('camera-a'); }); await flushReact();
    expect(f.button('摄像头')?.getReactProps().disabled).toBe(false);
    await f.click('摄像头');
    expect(f.openCamera).toHaveBeenCalledExactlyOnceWith('mirror-a', expect.any(AbortSignal));
    expect(f.gate.request).toMatchObject({ id: 'camera-request-a', bindingId: 'binding-a' });
    expect(f.getUserMedia).toHaveBeenCalledOnce();
    expect(mocks.api.mock.calls.every(([url]) => String(url).endsWith('/live/status'))).toBe(true);
  });

  it('keeps the entry visible but disabled during an experience and on a foreign mirror preview', async () => {
    const f = await fixture(null);
    await act(async () => f.update({ state: { ...state(), phase: 'generating' } })); await flushReact();
    expect(f.button('摄像头')).toBeDefined(); expect(f.button('摄像头')?.getReactProps().disabled).toBe(true);
    expect(host!.find(node => node.textContent === '结束体验后可切换')).toBeDefined();
    await f.click('摄像头'); expect(f.openCamera).not.toHaveBeenCalled();
    await act(async () => f.update({ state: state(), boundMirrorId: 'mirror-other' })); await flushReact();
    await f.click('摄像头'); expect(f.openCamera).not.toHaveBeenCalled(); expect(f.gate.request).toBeNull();
  });

  it('ignores a local open response from an earlier binding and cancels its transport', async () => {
    const f = await fixture(null); let resolve!: (value: ExhibitionCameraRequest) => void;
    f.openCamera.mockReturnValueOnce(new Promise(done => { resolve = done; }));
    await f.click('摄像头'); const signal = f.openCamera.mock.calls[0][1]!;
    expect(f.gate.blocksGeneration).toBe(true); expect(f.getUserMedia).not.toHaveBeenCalled();
    await act(async () => f.update({ bindingId: 'replacement-binding' })); await flushReact();
    expect(signal.aborted).toBe(true);
    await act(async () => resolve(request())); await flushReact();
    expect(f.gate.request).toBeNull(); expect(f.report).not.toHaveBeenCalled(); expect(f.getUserMedia).not.toHaveBeenCalled();
  });

  it('does not reopen an already closed request while its terminal report is still in flight', async () => {
    const f = await fixture(null); await f.click('摄像头'); await f.click('取消');
    expect(f.report).toHaveBeenLastCalledWith(expect.objectContaining({ requestId: 'camera-request-a', status: 'closed' }));
    const reports = f.report.mock.calls.length;
    await f.click('摄像头');
    expect(f.openCamera).toHaveBeenCalledTimes(2); expect(f.gate.request).toBeNull();
    expect(f.gate.openError).toContain('正在同步'); expect(f.report).toHaveBeenCalledTimes(reports);
    f.openCamera.mockResolvedValueOnce({ ...request(), id: 'camera-request-b' });
    await f.click('摄像头'); expect(f.gate.request?.id).toBe('camera-request-b');
  });

  it('uses a local-only dialog before pairing and closes it when a binding appears', async () => {
    const f = await fixture(null, state(), false, true); await f.click('摄像头');
    expect(f.gate.request?.localPreview).toBe(true); expect(f.openCamera).not.toHaveBeenCalled();
    await f.select('camera-b'); expect(f.live.selectedCameraId).toBe('camera-b'); expect(f.report).not.toHaveBeenCalled();
    await act(async () => f.update({ localPreview: false })); await flushReact();
    expect(f.gate.request).toBeNull(); expect(f.streams[0].track.stop).toHaveBeenCalledOnce(); expect(f.storage.setItem).not.toHaveBeenCalled();
  });

  it('requires exact terminal, mirror, binding epoch and unexpired request', () => {
    const original = request();
    expect(terminalCameraRequestMatches(original, connection, identity, 'mirror-a')).toBe(true);
    for (const mutation of [{ mirrorId: 'mirror-b' }, { terminalId: 'other' }, { bindingId: 'old' }, { expiresAt: Date.now() - 1 }, { createdAt: Date.now() + 10000 }]) {
      expect(terminalCameraRequestMatches({ ...original, ...mutation }, connection, identity, 'mirror-a')).toBe(false);
    }
    expect(terminalCameraRequestMatches(original, connection, { ...identity, platform: 'android' }, 'mirror-a')).toBe(false);
    expect(terminalCameraRequestMatches(original, { ...connection, mirrorId: null }, identity, 'mirror-a')).toBe(false);
  });

  it('rejects generation and pending commands without changing the active camera', () => {
    expect(terminalCameraAvailable(state())).toBe(true);
    expect(terminalCameraAvailable(state(), true)).toBe(false);
    for (const phase of ['generating', 'showcase', 'paused', 'positioning'] as const) expect(terminalCameraAvailable({ ...state(), phase })).toBe(false);
    expect(terminalCameraAvailable({ ...state(), live: { deviceId: 'remote' } as any })).toBe(false);
  });

  it('retains an acknowledged dialog, closes on binding change, and never executes stale requests', async () => {
    const f = await fixture();
    expect(f.gate.request?.id).toBe('camera-request-a'); expect(f.getUserMedia).not.toHaveBeenCalled();
    await act(async () => f.update({ request: undefined })); await flushReact();
    expect(f.gate.request?.id).toBe('camera-request-a');
    await act(async () => f.update({ bindingId: 'new-binding' })); await flushReact();
    expect(f.gate.request).toBeNull(); expect(f.getUserMedia).not.toHaveBeenCalled();
    await act(async () => f.update({ request: request() })); await flushReact();
    expect(f.gate.request).toBeNull();
  });

  it('lists, previews and saves one actual camera without any XMAX allocation or replay', async () => {
    const f = await fixture();
    expect(f.enumerateDevices).toHaveBeenCalledOnce(); expect(f.button('保存')?.getReactProps().disabled).toBe(true);
    await f.select('camera-b');
    expect(f.getUserMedia).toHaveBeenCalledExactlyOnceWith({ audio: false, video: { deviceId: { exact: 'camera-b' }, width: { ideal: 1080 }, height: { ideal: 1920 }, frameRate: { ideal: 30, max: 30 } } });
    expect(f.button('保存')?.getReactProps().disabled).toBe(false);
    await f.click('保存');
    expect(f.gate.request).toBeNull(); expect(f.storage.setItem).toHaveBeenCalledOnce();
    expect(JSON.parse(f.storage.setItem.mock.calls[0][1])).toMatchObject({ deviceId: 'camera-b', label: 'USB 2' });
    expect(f.report).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'closed', requestId: 'camera-request-a', activeDeviceId: 'camera-b' }));
    expect(f.streams[0].track.stop).not.toHaveBeenCalled();
    await act(async () => f.update({ request: request() })); await flushReact(); expect(f.gate.request).toBeNull();
    expect(mocks.api.mock.calls.every(([url]) => String(url).endsWith('/live/status'))).toBe(true);
  });

  it('reuses the current camera and restores it on cancelling a replacement', async () => {
    const f = await fixture(null);
    await act(async () => { await f.live.startCamera('camera-a'); }); await flushReact();
    expect(f.getUserMedia).toHaveBeenCalledOnce();
    await act(async () => f.update({ request: request() })); await flushReact();
    expect(f.getUserMedia).toHaveBeenCalledOnce();
    await f.select('camera-b'); expect(f.streams[0].track.stop).toHaveBeenCalledOnce();
    await f.click('取消');
    expect(f.getUserMedia).toHaveBeenCalledTimes(3); expect(f.live.selectedCameraId).toBe('camera-a');
    expect(f.streams[1].track.stop).toHaveBeenCalledOnce(); expect(f.storage.setItem).not.toHaveBeenCalled();
    expect(f.report).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'closed', activeDeviceId: 'camera-a' }));
  });

  it('cancels a pending camera grant at expiry and releases a late stream', async () => {
    vi.useFakeTimers(); const f = await fixture();
    let resolve!: (stream: MediaStream) => void;
    f.getUserMedia.mockReturnValueOnce(new Promise(done => { resolve = done; }));
    await f.select('camera-b'); expect(f.live.opening).toBe(true);
    await act(async () => { await vi.advanceTimersByTimeAsync(120001); }); await flushReact(); expect(f.gate.request).toBeNull();
    const late = makeStream('camera-b'); await act(async () => resolve(late.stream)); await flushReact();
    expect(late.track.stop).toHaveBeenCalledOnce(); expect(f.live.cameraStream).toBeNull();
  });

  it('cancels an unanswered permission request without saving or retaining the late grant', async () => {
    const f = await fixture(); let resolve!: (stream: MediaStream) => void;
    f.getUserMedia.mockReturnValueOnce(new Promise(done => { resolve = done; }));
    await f.select('camera-b'); await f.click('取消'); expect(f.gate.request).toBeNull();
    const late = makeStream('camera-b'); await act(async () => resolve(late.stream)); await flushReact();
    expect(late.track.stop).toHaveBeenCalledOnce(); expect(f.live.cameraStream).toBeNull(); expect(f.storage.setItem).not.toHaveBeenCalled();
    expect(f.report).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'closed' }));
  });

  it('serializes physical camera acquisition while an earlier permission request is unresolved', async () => {
    const f = await fixture(); let resolve!: (stream: MediaStream) => void;
    f.getUserMedia.mockReturnValueOnce(new Promise(done => { resolve = done; }));
    await f.select('camera-b');
    let replacement!: Promise<boolean>;
    await act(async () => { replacement = f.live.startCamera('camera-a', true); }); await flushReact();
    expect(f.getUserMedia).toHaveBeenCalledOnce();
    const late = makeStream('camera-b'); await act(async () => resolve(late.stream)); await flushReact(); await replacement;
    expect(late.track.stop).toHaveBeenCalledOnce(); expect(f.getUserMedia).toHaveBeenCalledTimes(2);
    expect(f.live.selectedCameraId).toBe('camera-a');
  });

  it('retains the same request through denied permission and an explicit successful retry', async () => {
    const f = await fixture(); f.getUserMedia.mockRejectedValueOnce(new DOMException('denied', 'NotAllowedError'));
    await f.select('camera-b');
    expect(f.report).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'permission-required', requestId: 'camera-request-a', error: expect.stringContaining('权限') }));
    expect(f.gate.request?.id).toBe('camera-request-a'); expect(f.storage.setItem).not.toHaveBeenCalled();
    await f.click('预览'); expect(f.button('保存')?.getReactProps().disabled).toBe(false);
    expect(f.report).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'preview', requestId: 'camera-request-a', activeDeviceId: 'camera-b' }));
  });

  it('keeps an XMAX allocation failure out of camera status and a healthy diagnostic preview', async () => {
    const initial = { ...state(), providerMode: 'xmax' as const, experienceMode: 'free' as const,
      looks: [{ ...state().looks[0], mode: 'free' as const, referenceKind: 'none' as const, prompt: '森林背景' }] };
    const f = await fixture(null, initial, true);
    expect(f.live.cameraStream).not.toBeNull();
    mocks.api.mockImplementation(async (path: string) => {
      if (path.endsWith('/live/session')) throw new Error('XMAX 额度不足');
      return { configured: false };
    });
    await act(async () => f.update({ state: { ...initial, phase: 'generating', sessionNumber: 1, generationNumber: 1 } })); await flushReact();
    expect(mocks.api.mock.calls.some(([path]) => String(path).endsWith('/live/session'))).toBe(true);
    expect(f.live.error).toContain('XMAX 额度不足'); expect(f.live.cameraError).toBe('');
    expect(f.report.mock.calls.some(([value]) => value.error?.includes('XMAX'))).toBe(false);
    await act(async () => f.update({ state: { ...initial, sessionNumber: 1, generationNumber: 1 }, request: request() })); await flushReact();
    expect(host!.find(node => node.getReactProps().role === 'alert')).toBeUndefined();
    expect(f.button('保存')?.getReactProps().disabled).toBe(false);
    expect(f.report).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'preview', activeDeviceId: 'camera-a' }));
    expect(f.report.mock.lastCall?.[0].error).toBeUndefined();
  });

  it('does not allocate XMAX when a begin command races an open camera dialog', async () => {
    const f = await fixture(); await f.select('camera-a');
    await act(async () => f.update({ state: { ...state(), providerMode: 'xmax', phase: 'generating' } })); await flushReact();
    expect(f.gate.request).toBeNull(); expect(f.gate.blocksGeneration).toBe(true);
    expect(mocks.api.mock.calls.every(([url]) => String(url).endsWith('/live/status'))).toBe(true);
  });
});
