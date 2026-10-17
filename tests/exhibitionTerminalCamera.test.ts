import { materialCatalogFixture } from './support/materialCatalogFixture';
import { act, createElement, useEffect, useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TerminalCameraEntry, TerminalCameraSettings, terminalCameraAvailable, terminalCameraRequestMatches, useTerminalCameraRequest, useTerminalCameraReport } from '../src/exhibition/TerminalCameraSettings';
import { Kiosk } from '../src/exhibition/ExhibitionApp';
import { useExhibitionLive, type ExhibitionLiveController } from '../src/exhibition/useExhibitionLive';
import { readCameraPreference, type ExhibitionCameraPreference } from '../src/exhibition/cameraPreference';
import { scopedStorageKey } from '../src/versionScope';
import type { TerminalBinding } from '../src/exhibition/useTerminalBinding';
import type { ExhibitionState } from '../shared/exhibition';
import type { ExhibitionCameraRequest } from '../shared/exhibitionCamera';
import { DEFAULT_EXHIBITION_GESTURE_SETTINGS } from '../shared/exhibitionGestures';
import { createReactHost, flushReact } from './support/reactHost';

const mocks = vi.hoisted(() => ({ api: vi.fn(), orient: vi.fn() }));
vi.mock('../src/api', () => ({ api: mocks.api, backend: {} }));
vi.mock('../src/exhibition/cameraOrientation', () => ({ orientExhibitionCamera: mocks.orient }));
vi.mock('../src/exhibition/LiveCameraPanel', () => ({ StreamVideo: ({ stream, label, onFirstFrame }: { stream: MediaStream; label?: string; onFirstFrame?: (stream: MediaStream) => void }) => {
  useEffect(() => { if (stream) onFirstFrame?.(stream); }, [stream, onFirstFrame]);
  return createElement('video', { 'aria-label': label, ref: (video: HTMLVideoElement | null) => { if (video) video.srcObject = stream; } });
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
  const track = { readyState: 'live', stop: vi.fn(function () { track.readyState = 'ended'; }), getSettings: () => id ? { deviceId: id } : {}, onended: null };
  return { stream: { getTracks: () => [track], getVideoTracks: () => [track] } as unknown as MediaStream, track };
}
function makeTransform() {
  const output = makeStream('');
  return { ...output, dispose: vi.fn(() => output.track.stop()) };
}
async function fixture(initialRequest: ExhibitionCameraRequest | null = request(), initialState = state(), includeMetadataReport = false, localPreview = false,
  options: { cameraPreferenceScope?: string; initialPreference?: ExhibitionCameraPreference; renderKiosk?: boolean } = {}) {
  host = await createReactHost();
  const createNode = document.createElement.bind(document);
  document.createElement = ((tag: string) => {
    const node = createNode(tag);
    if (tag === 'select') Object.defineProperty(node, 'options', { get: () => node.childNodes });
    return node;
  }) as typeof document.createElement;
  const saved = new Map<string, string>();
  if (options.initialPreference) saved.set(scopedStorageKey('exhibition-camera-preference'), JSON.stringify(options.initialPreference));
  const storage = { getItem: vi.fn((key: string) => saved.get(key) ?? null), setItem: vi.fn((key: string, value: string) => saved.set(key, value)) };
  vi.stubGlobal('localStorage', storage);
  const devices = ['camera-a', 'camera-b'].map((deviceId, index) => ({ deviceId, label: `USB ${index + 1}`, kind: 'videoinput' as const }));
  const streams: ReturnType<typeof makeStream>[] = [];
  const transforms: ReturnType<typeof makeTransform>[] = [];
  mocks.orient.mockReset().mockImplementation(async () => {
    const transformed = makeTransform(); transforms.push(transformed); return transformed;
  });
  const getUserMedia = vi.fn(async (constraints: MediaStreamConstraints) => {
    const id = typeof constraints.video === 'object' ? (constraints.video.deviceId as ConstrainDOMStringParameters)?.exact as string : undefined;
    const capture = makeStream(id || 'camera-a'); streams.push(capture); return capture.stream;
  });
  const enumerateDevices = vi.fn(async () => devices);
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia, enumerateDevices, addEventListener: vi.fn(), removeEventListener: vi.fn() } });
  mocks.api.mockResolvedValue({ configured: false });
  const report = vi.fn();
  const send = vi.fn(async () => true);
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
    live = useExhibitionLive({ state: value.state, active: value.connected, refresh: () => {}, mirrorId: 'mirror-a', cameraSettingsOpen: gate.blocksGeneration, cameraPreferenceScope: options.cameraPreferenceScope });
    useTerminalCameraReport(includeMetadataReport ? terminal : undefined, 'mirror-a', live, gate.request);
    const cameraControl = createElement(TerminalCameraEntry, { settings: gate, busy: !terminalCameraAvailable(value.state), connected: value.connected });
    return createElement('div', null, options.renderKiosk ? createElement(Kiosk, { state: value.state, live, send,
      canControl: !gate.blocksGeneration, disabled: gate.blocksGeneration, cameraControl }) : cameraControl,
      gate.request ? createElement(TerminalCameraSettings, { request: gate.request, live, report: gate.request.localPreview ? undefined : report, close: gate.close,
        cameraPreferenceScope: options.cameraPreferenceScope, keepPreview: !options.renderKiosk || (value.state.providerMode === 'xmax' && value.state.experienceMode !== 'mox') }) : null);
  }
  await host.render(createElement(Harness)); await flushReact();
  const button = (label: string) => host!.find(node => node.nodeName === 'button' && node.textContent === label);
  const click = async (label: string) => { await act(async () => { await button(label)!.getReactProps().onClick(); }); await flushReact(); };
  const select = async (id: string) => { await act(async () => { host!.find(node => node.nodeName === 'select')!.getReactProps().onChange({ target: { value: id } }); }); await flushReact(); };
  const direction = () => host!.find(node => node.nodeName === 'select' && node.getReactProps()['aria-label'] === '摄像头方向')!;
  const rotate = async (value: string) => { await act(async () => { direction().getReactProps().onChange({ target: { value } }); }); await flushReact(); };
  const resolution = () => host!.find(node => node.nodeName === 'select' && node.getReactProps()['aria-label'] === '摄像头分辨率')!;
  const quality = async (value: string) => { await act(async () => { resolution().getReactProps().onChange({ target: { value } }); }); await flushReact(); };
  return { get live() { return live; }, get gate() { return gate; }, update, report, send, openCamera, storage, getUserMedia, enumerateDevices, streams, transforms, click, select, rotate, direction, button, resolution, quality };
}

describe('terminal camera resolution preview and persistence', () => {
  const qualities = [
    ['1080p', 1920, 1080], ['4k', 3840, 2160], ['l1', 1920, 1024],
    ['l2', 1536, 818], ['l3', 1248, 664], ['l4', 960, 512],
  ] as const;

  it('offers default plus all supported capture sizes and ignores invalid UI values', async () => {
    const f = await fixture();
    expect(f.resolution().childNodes.map(node => node.getReactProps().value)).toEqual(['', '1080p', '4k', 'l1', 'l2', 'l3', 'l4']);
    expect(f.resolution().getReactProps().value).toBe('');
    await f.quality('2k'); await f.quality('4K'); await f.quality('__proto__');
    expect(f.getUserMedia).not.toHaveBeenCalled(); expect(f.resolution().getReactProps().value).toBe('');
    expect(f.storage.setItem).not.toHaveBeenCalled();
  });

  it.each(qualities.flatMap(([quality, width, height]) => ([0, 90, 180, 270] as const).map(rotation => ({ quality, width, height, rotation }))))
  ('applies $quality bounds to capture and orientation at $rotation degrees', async ({ quality, width, height, rotation }) => {
    const f = await fixture(request(), state(), false, false, { initialPreference: { deviceId: 'camera-a', label: 'USB 1', profile: 'screen', rotation } });
    await f.quality(quality);
    const quarterTurn = rotation === 90 || rotation === 270;
    expect(f.getUserMedia).toHaveBeenCalledExactlyOnceWith({ audio: false, video: { deviceId: { exact: 'camera-a' },
      width: { ideal: quarterTurn ? width : height }, height: { ideal: quarterTurn ? height : width }, frameRate: { ideal: 30, max: 30 } } });
    // Even 0 degrees must use the bounding transform when a size was requested;
    // getUserMedia ideal constraints alone do not cap a device's actual frames.
    expect(mocks.orient).toHaveBeenCalledExactlyOnceWith(f.streams[0].stream, rotation, expect.any(AbortSignal), expect.objectContaining({ width, height }));
    expect(f.live.cameraStream).toBe(f.transforms[0].stream); expect(f.live.rawCameraStream).toBe(f.streams[0].stream);
    expect(f.button('保存')?.getReactProps().disabled).toBe(false); expect(f.storage.setItem).not.toHaveBeenCalled();
    expect(readCameraPreference()?.quality).toBeUndefined();
    expect(mocks.api.mock.calls.every(([url]) => String(url).endsWith('/live/status'))).toBe(true);
  });

  it('saves the tested quality in its own scope and reopens capture with the saved size and rotation', async () => {
    const realPreference: ExhibitionCameraPreference = { deviceId: 'camera-a', label: '真实镜端', profile: 'screen', quality: '4k' };
    const f = await fixture(null, state(), false, true, { cameraPreferenceScope: 'quality/test-a', initialPreference: realPreference });
    await f.click('摄像头'); expect(f.resolution().getReactProps().value).toBe('');
    await f.quality('l3'); await f.select('camera-b'); await f.rotate('90');
    const tested = f.live.cameraStream; await f.click('保存');
    expect(readCameraPreference('quality/test-a')).toEqual({ deviceId: 'camera-b', label: 'USB 2', profile: 'screen', rotation: 90, quality: 'l3' });
    expect(readCameraPreference()).toEqual(realPreference); expect(readCameraPreference('quality/test-b')).toBeNull();
    expect(f.storage.setItem).toHaveBeenCalledExactlyOnceWith(scopedStorageKey('exhibition-camera-preference:quality%2Ftest-a'),
      JSON.stringify({ deviceId: 'camera-b', label: 'USB 2', profile: 'screen', rotation: 90, quality: 'l3' }));
    expect(f.live.cameraStream).toBe(tested);
    await act(async () => f.live.stopCamera()); await flushReact();
    await act(async () => { await f.live.startCamera(); }); await flushReact();
    expect(f.getUserMedia).toHaveBeenLastCalledWith({ audio: false, video: { deviceId: { exact: 'camera-b' }, width: { ideal: 1248 }, height: { ideal: 664 }, frameRate: { ideal: 30, max: 30 } } });
    expect(mocks.orient).toHaveBeenLastCalledWith(f.streams.at(-1)!.stream, 90, expect.any(AbortSignal), expect.objectContaining({ width: 1248, height: 664 }));
    await f.click('摄像头'); expect(f.resolution().getReactProps().value).toBe('l3'); expect(f.direction().getReactProps().value).toBe(90);
    expect(f.report).not.toHaveBeenCalled();
  });

  it('cancels a replacement resolution by restoring the original device, direction and quality without saving', async () => {
    const original: ExhibitionCameraPreference = { deviceId: 'camera-a', label: 'USB 1', profile: 'screen', rotation: 270, quality: 'l2' };
    const f = await fixture(null, state(), false, false, { initialPreference: original });
    await act(async () => { await f.live.startCamera(); }); await flushReact();
    await act(async () => f.update({ request: request() })); await flushReact();
    await f.quality('4k'); await f.select('camera-b'); await f.rotate('180');
    const discarded = f.transforms.at(-1)!; await f.click('取消');
    expect(f.gate.request).toBeNull(); expect(f.live.selectedCameraId).toBe('camera-a'); expect(readCameraPreference()).toEqual(original);
    expect(f.getUserMedia).toHaveBeenLastCalledWith({ audio: false, video: { deviceId: { exact: 'camera-a' }, width: { ideal: 1536 }, height: { ideal: 818 }, frameRate: { ideal: 30, max: 30 } } });
    expect(mocks.orient).toHaveBeenLastCalledWith(f.streams.at(-1)!.stream, 270, expect.any(AbortSignal), expect.objectContaining({ width: 1536, height: 818 }));
    expect(discarded.dispose).toHaveBeenCalledOnce(); expect(f.live.cameraStream).toBe(f.transforms.at(-1)!.stream);
    expect(f.storage.setItem).not.toHaveBeenCalled();
  });

  it.each(['screen', 'default'] as const)('clears a saved resolution and restores the legacy %s capture profile', async profile => {
    const f = await fixture(request(), state(), false, false, { initialPreference: { deviceId: 'camera-a', label: 'USB 1', profile, quality: '4k' } });
    await f.click('预览'); expect(mocks.orient).toHaveBeenCalledOnce();
    await f.quality('');
    const expected = { audio: false, video: profile === 'default' ? { deviceId: { exact: 'camera-a' } }
      : { deviceId: { exact: 'camera-a' }, width: { ideal: 1080 }, height: { ideal: 1920 }, frameRate: { ideal: 30, max: 30 } } };
    expect(f.getUserMedia).toHaveBeenLastCalledWith(expected); expect(f.live.cameraStream).toBe(f.streams[1].stream);
    expect(mocks.orient).toHaveBeenCalledOnce(); expect(f.transforms[0].dispose).toHaveBeenCalledOnce();
    await f.click('保存'); expect(readCameraPreference()).toEqual({ deviceId: 'camera-a', label: 'USB 1', profile });
    await act(async () => f.live.stopCamera()); await flushReact(); await act(async () => { await f.live.startCamera(); }); await flushReact();
    expect(f.getUserMedia).toHaveBeenLastCalledWith(expected); expect(mocks.orient).toHaveBeenCalledOnce();
  });

  it('keeps a failed resolution unsaved and retries the selected size before enabling save', async () => {
    const original: ExhibitionCameraPreference = { deviceId: 'camera-a', label: 'USB 1', profile: 'screen', quality: 'l2' };
    const f = await fixture(request(), state(), false, false, { initialPreference: original });
    f.getUserMedia.mockRejectedValueOnce(new DOMException('denied', 'NotAllowedError'));
    await f.quality('l4'); expect(f.live.cameraStream).toBeNull(); expect(f.live.cameraError).not.toBe('');
    expect(f.button('保存')?.getReactProps().disabled).toBe(true); await f.click('保存');
    expect(f.storage.setItem).not.toHaveBeenCalled(); expect(readCameraPreference()).toEqual(original);
    await f.click('预览');
    expect(f.getUserMedia).toHaveBeenLastCalledWith({ audio: false, video: { deviceId: { exact: 'camera-a' }, width: { ideal: 512 }, height: { ideal: 960 }, frameRate: { ideal: 30, max: 30 } } });
    expect(f.button('保存')?.getReactProps().disabled).toBe(false); await f.click('保存'); expect(readCameraPreference()?.quality).toBe('l4');
  });

  it('releases a failed bounding transform and never saves the unverified size', async () => {
    const original: ExhibitionCameraPreference = { deviceId: 'camera-a', label: 'USB 1', profile: 'screen', quality: '4k' };
    const f = await fixture(request(), state(), false, false, { initialPreference: original });
    mocks.orient.mockRejectedValueOnce(new Error('分辨率处理失败')); await f.quality('l3');
    expect(f.streams[0].track.stop).toHaveBeenCalledOnce(); expect(f.live.cameraStream).toBeNull();
    expect(f.button('保存')?.getReactProps().disabled).toBe(true); await f.click('保存');
    expect(f.storage.setItem).not.toHaveBeenCalled(); expect(readCameraPreference()).toEqual(original);
  });

  it('blocks saving and changing size while the new bounding transform is pending', async () => {
    const original: ExhibitionCameraPreference = { deviceId: 'camera-a', label: 'USB 1', profile: 'screen', quality: 'l2' };
    const f = await fixture(request(), state(), false, false, { initialPreference: original }); await f.click('预览');
    let resolve!: (value: ReturnType<typeof makeTransform>) => void;
    mocks.orient.mockReturnValueOnce(new Promise(done => { resolve = done; }));
    await f.quality('l4');
    expect(f.live.opening).toBe(true); expect(f.resolution().getReactProps().disabled).toBe(true); expect(f.button('保存')?.getReactProps().disabled).toBe(true);
    await f.click('保存'); expect(f.storage.setItem).not.toHaveBeenCalled(); expect(readCameraPreference()).toEqual(original);
    const ready = makeTransform(); await act(async () => resolve(ready)); await flushReact();
    expect(f.live.cameraStream).toBe(ready.stream); expect(f.button('保存')?.getReactProps().disabled).toBe(false);
    await f.click('保存'); expect(readCameraPreference()?.quality).toBe('l4');
  });

  it('uses saved quality for ordinary capture and permits only diagnostic quality overrides', async () => {
    const original: ExhibitionCameraPreference = { deviceId: 'camera-a', label: 'USB 1', profile: 'screen', quality: 'l2' };
    const f = await fixture(null, state(), false, false, { initialPreference: original });
    await act(async () => { await f.live.startCamera('camera-a', false, 90, '4k'); }); await flushReact();
    expect(f.getUserMedia).toHaveBeenLastCalledWith({ audio: false, video: { deviceId: { exact: 'camera-a' }, width: { ideal: 818 }, height: { ideal: 1536 }, frameRate: { ideal: 30, max: 30 } } });
    expect(mocks.orient).toHaveBeenLastCalledWith(f.streams[0].stream, 0, expect.any(AbortSignal), expect.objectContaining({ width: 1536, height: 818 }));
    await act(async () => f.update({ request: request() })); await flushReact();
    await act(async () => { await f.live.startCamera('camera-a', true); }); await flushReact();
    expect(mocks.orient).toHaveBeenLastCalledWith(f.streams[1].stream, 0, expect.any(AbortSignal), expect.objectContaining({ width: 1536, height: 818 }));
    await act(async () => { await f.live.startCamera('camera-a', true, 0, null); }); await flushReact();
    expect(f.live.cameraStream).toBe(f.streams[2].stream); expect(mocks.orient).toHaveBeenCalledTimes(2);
    expect(readCameraPreference()).toEqual(original); expect(f.storage.setItem).not.toHaveBeenCalled();
  });
});

describe('bound browser terminal camera diagnostics', () => {
  it('saves the real camera and tested rotation in the browser-test scope and restores them on reopening capture', async () => {
    const f = await fixture(null, state(), false, true, { cameraPreferenceScope: 'test-rotation' });
    await f.click('摄像头'); await f.select('camera-b'); await f.rotate('90');
    const rotated = f.transforms[0];
    expect(rotated.track.getSettings()).toEqual({});
    expect(f.live.cameraStream).toBe(rotated.stream); expect(f.live.rawCameraStream).toBe(f.streams[1].stream);
    expect(f.getUserMedia).toHaveBeenLastCalledWith({ audio: false, video: { deviceId: { exact: 'camera-b' },
      width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30, max: 30 } } });
    expect(f.button('保存')?.getReactProps().disabled).toBe(false);
    await f.click('保存');
    expect(readCameraPreference('test-rotation')).toEqual({ deviceId: 'camera-b', label: 'USB 2', profile: 'screen', rotation: 90 });
    expect(readCameraPreference()).toBeNull(); expect(readCameraPreference('test-other')).toBeNull();
    expect(rotated.dispose).not.toHaveBeenCalled();
    await act(async () => f.live.stopCamera()); await flushReact();
    expect(rotated.dispose).toHaveBeenCalledOnce(); expect(f.streams[1].track.stop).toHaveBeenCalledOnce();
    await act(async () => { await f.live.startCamera(); }); await flushReact();
    expect(mocks.orient).toHaveBeenLastCalledWith(f.streams[2].stream, 90, expect.any(AbortSignal));
    expect(f.live.selectedCameraId).toBe('camera-b'); expect(f.live.cameraStream).toBe(f.transforms[1].stream);
    await f.click('摄像头'); expect(f.direction().getReactProps().value).toBe(90);
    expect(f.report).not.toHaveBeenCalled();
    expect(mocks.api.mock.calls.every(([url]) => String(url).endsWith('/live/status'))).toBe(true);
  });

  it('restores both the previous device and angle when cancelling a rotated replacement', async () => {
    const preference: ExhibitionCameraPreference = { deviceId: 'camera-a', label: 'USB 1', profile: 'screen', rotation: 90 };
    const f = await fixture(null, state(), false, false, { initialPreference: preference });
    await act(async () => { await f.live.startCamera(); }); await flushReact();
    await act(async () => f.update({ request: request() })); await flushReact();
    await f.select('camera-b'); await f.rotate('270');
    const replacement = f.transforms[2];
    expect(f.live.selectedCameraId).toBe('camera-b');
    await f.click('取消');
    expect(f.gate.request).toBeNull(); expect(f.live.selectedCameraId).toBe('camera-a');
    expect(mocks.orient).toHaveBeenLastCalledWith(f.streams[3].stream, 90, expect.any(AbortSignal));
    expect(f.live.cameraStream).toBe(f.transforms[3].stream);
    expect(replacement.dispose).toHaveBeenCalledOnce(); expect(f.streams[2].track.stop).toHaveBeenCalledOnce();
    expect(f.storage.setItem).not.toHaveBeenCalled(); expect(readCameraPreference()).toEqual(preference);
    expect(f.report).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'closed', activeDeviceId: 'camera-a' }));
  });

  it('returns a saved quarter-turn to direct capture and persists default direction without retaining rotation', async () => {
    const f = await fixture(request(), state(), false, false,
      { initialPreference: { deviceId: 'camera-a', label: 'USB 1', profile: 'screen', rotation: 90 } });
    await f.click('预览'); expect(mocks.orient).toHaveBeenCalledOnce();
    await f.rotate('0');
    expect(f.live.cameraStream).toBe(f.streams[1].stream); expect(f.live.rawCameraStream).toBe(f.streams[1].stream);
    expect(f.transforms[0].dispose).toHaveBeenCalledOnce(); expect(mocks.orient).toHaveBeenCalledOnce();
    expect(f.getUserMedia).toHaveBeenLastCalledWith({ audio: false, video: { deviceId: { exact: 'camera-a' },
      width: { ideal: 1080 }, height: { ideal: 1920 }, frameRate: { ideal: 30, max: 30 } } });
    await f.click('保存');
    expect(readCameraPreference()).toEqual({ deviceId: 'camera-a', label: 'USB 1', profile: 'screen' });
    await act(async () => f.live.stopCamera()); await flushReact();
    await act(async () => { await f.live.startCamera(); }); await flushReact();
    expect(f.live.cameraStream).toBe(f.streams[2].stream); expect(mocks.orient).toHaveBeenCalledOnce();
  });

  it('releases a failed rotation, keeps the existing preference, and retries the chosen direction before saving', async () => {
    const original: ExhibitionCameraPreference = { deviceId: 'camera-a', label: 'USB 1', profile: 'screen' };
    const f = await fixture(request(), state(), false, false, { initialPreference: original });
    mocks.orient.mockRejectedValueOnce(new Error('旋转取景失败'));
    await f.rotate('180');
    expect(f.live.cameraStream).toBeNull(); expect(f.live.cameraError).not.toBe('');
    expect(f.streams[0].track.stop).toHaveBeenCalledOnce(); expect(f.button('保存')?.getReactProps().disabled).toBe(true);
    await f.click('保存'); expect(f.storage.setItem).not.toHaveBeenCalled(); expect(readCameraPreference()).toEqual(original);
    await f.click('预览');
    expect(mocks.orient).toHaveBeenLastCalledWith(f.streams[1].stream, 180, expect.any(AbortSignal));
    expect(f.live.cameraError).toBe(''); expect(f.button('保存')?.getReactProps().disabled).toBe(false);
    await f.click('保存'); expect(readCameraPreference()?.rotation).toBe(180);
    expect(f.transforms[0].dispose).not.toHaveBeenCalled();
  });

  it.each(['cancel', 'expiry'] as const)('disposes a rotation finishing after %s without saving or retaining either stream', async action => {
    vi.useFakeTimers(); const f = await fixture();
    let resolve!: (value: ReturnType<typeof makeTransform>) => void;
    mocks.orient.mockReturnValueOnce(new Promise(done => { resolve = done; }));
    await f.rotate('90');
    const signal = mocks.orient.mock.calls[0][2] as AbortSignal;
    expect(f.live.opening).toBe(true); expect(f.direction().getReactProps().disabled).toBe(true);
    expect(f.button('保存')?.getReactProps().disabled).toBe(true);
    if (action === 'cancel') await f.click('取消');
    else { await act(async () => { await vi.advanceTimersByTimeAsync(120001); }); await flushReact(); }
    expect(f.gate.request).toBeNull(); expect(signal.aborted).toBe(true);
    expect(f.streams[0].track.stop).toHaveBeenCalledOnce();
    const reports = f.report.mock.calls.length;
    const late = makeTransform(); await act(async () => resolve(late)); await flushReact();
    expect(late.dispose).toHaveBeenCalledOnce(); expect(late.track.stop).toHaveBeenCalledOnce();
    expect(f.streams[0].track.stop).toHaveBeenCalledOnce();
    expect(f.live.cameraStream).toBeNull(); expect(f.live.rawCameraStream).toBeNull();
    expect(f.storage.setItem).not.toHaveBeenCalled(); expect(f.report).toHaveBeenCalledTimes(reports);
    expect(mocks.api.mock.calls.every(([url]) => String(url).endsWith('/live/status'))).toBe(true);
  });

  it('keeps a saved replacement camera visible on the empty browser-test screen without allocating a session', async () => {
    const initial: ExhibitionState = { ...state(), providerMode: 'xmax', selectedLookId: null,
      publication: { revision: 1, publishedAt: 1, legacy: false, looks: [] },
      settings: { ...state().settings, gestureRecognition: { ...DEFAULT_EXHIBITION_GESTURE_SETTINGS, gestures: [] } } };
    const f = await fixture(null, initial, false, true, { renderKiosk: true, cameraPreferenceScope: 'test-empty-materials' });
    const mainVideo = () => host!.find(node => node.nodeName === 'video' && node.getReactProps()['aria-label'] === '本地取景') as unknown as HTMLVideoElement | undefined;
    expect(f.live.selectedCameraId).toBe('camera-a');
    expect(mainVideo()?.srcObject).toBe(f.streams[0].stream);
    expect(f.button('开始体验')?.getReactProps().disabled).toBe(true);

    await f.click('摄像头'); await f.select('camera-b');
    const replacement = f.streams[1];
    expect(f.streams[0].track.stop).toHaveBeenCalledOnce();
    expect(f.button('保存')?.getReactProps().disabled).toBe(false);
    await f.click('保存');

    expect(f.gate.request).toBeNull();
    expect(host!.find(node => node.nodeName === 'dialog')).toBeUndefined();
    expect(mainVideo()?.srcObject).toBe(replacement.stream);
    expect(f.live.cameraStream).toBe(replacement.stream);
    expect(replacement.track.readyState).toBe('live');
    expect(replacement.track.stop).not.toHaveBeenCalled();
    expect(f.getUserMedia).toHaveBeenCalledTimes(2);
    expect(readCameraPreference('test-empty-materials')?.deviceId).toBe('camera-b');
    expect(f.button('开始体验')?.getReactProps().disabled).toBe(true);
    expect(f.send).not.toHaveBeenCalled();
    expect(f.report).not.toHaveBeenCalled();
    expect(mocks.api.mock.calls.every(([url]) => String(url).endsWith('/live/status'))).toBe(true);
  });

  it('isolates browser-test camera capture and saved selection from the real screen and other tests', async () => {
    const realPreference: ExhibitionCameraPreference = { deviceId: 'disconnected-real-camera', label: '真实镜端摄像头', profile: 'default' };
    const f = await fixture(null, { ...state(), providerMode: 'xmax' }, false, true,
      { cameraPreferenceScope: 'test-a', initialPreference: realPreference });
    expect(f.getUserMedia).toHaveBeenCalledExactlyOnceWith({ audio: false, video: {
      facingMode: 'user', width: { ideal: 1080 }, height: { ideal: 1920 }, frameRate: { ideal: 30, max: 30 },
    } });
    expect(f.live.selectedCameraId).toBe('camera-a');
    expect(readCameraPreference('test-a')).toBeNull();
    await f.click('摄像头'); await f.select('camera-b'); await f.click('保存');
    expect(f.storage.setItem).toHaveBeenCalledExactlyOnceWith(scopedStorageKey('exhibition-camera-preference:test-a'),
      JSON.stringify({ deviceId: 'camera-b', label: 'USB 2', profile: 'screen' }));
    expect(readCameraPreference()).toEqual(realPreference);
    expect(readCameraPreference('test-a')?.deviceId).toBe('camera-b');
    expect(readCameraPreference('test-b')).toBeNull();
    await act(async () => { f.live.stopCamera(); }); await flushReact();
    await act(async () => { await f.live.startCamera(); }); await flushReact();
    expect(f.getUserMedia).toHaveBeenLastCalledWith({ audio: false, video: {
      deviceId: { exact: 'camera-b' }, width: { ideal: 1080 }, height: { ideal: 1920 }, frameRate: { ideal: 30, max: 30 },
    } });
    expect(f.report).not.toHaveBeenCalled();
    expect(mocks.api.mock.calls.every(([url]) => String(url).endsWith('/live/status'))).toBe(true);
  });

  it('opens the permanent local entry immediately with the server request and reuses healthy capture', async () => {
    const f = await fixture(null); await act(async () => { await f.live.startCamera('camera-a'); }); await flushReact();
    expect(f.button('摄像头')?.getReactProps().disabled).toBe(false);
    await f.click('摄像头');
    expect(f.openCamera).toHaveBeenCalledExactlyOnceWith('mirror-a', expect.any(AbortSignal));
    expect(f.gate.request).toMatchObject({ id: 'camera-request-a', bindingId: 'binding-a' });
    expect(f.getUserMedia).toHaveBeenCalledOnce();
    expect(mocks.api.mock.calls.every(([url]) => String(url).endsWith('/live/status'))).toBe(true);
  });

  it('hides the entry during an experience, restores it when idle, and disables it on a foreign mirror preview', async () => {
    const f = await fixture(null);
    expect(f.button('摄像头')?.getReactProps().disabled).toBe(false);
    await act(async () => f.update({ state: { ...state(), phase: 'generating' } })); await flushReact();
    expect(f.button('摄像头')).toBeUndefined();
    expect(f.openCamera).not.toHaveBeenCalled();
    await act(async () => f.update({ state: state() })); await flushReact();
    expect(f.button('摄像头')?.getReactProps().disabled).toBe(false);
    await act(async () => f.update({ state: state(), boundMirrorId: 'mirror-other' })); await flushReact();
    expect(f.button('摄像头')?.getReactProps().disabled).toBe(true);
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
    const initial = materialCatalogFixture({ ...state(), providerMode: 'xmax' as const, experienceMode: 'free' as const,
      looks: [{ ...state().looks[0], mode: 'free' as const, referenceKind: 'none' as const, prompt: '森林背景' }] });
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
