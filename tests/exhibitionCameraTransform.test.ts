import { act, createElement, useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useExhibitionLive, type ExhibitionLiveController } from '../src/exhibition/useExhibitionLive';
import type { ExhibitionCameraTransform } from '../src/exhibition/cameraOrientation';
import type { ExhibitionState } from '../shared/exhibition';
import { createReactHost, flushReact } from './support/reactHost';

const mocks = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock('../src/api', () => ({ api: mocks.api, backend: {} }));
type Transform = (source: MediaStream, signal: AbortSignal) => Promise<ExhibitionCameraTransform>;
let host: Awaited<ReturnType<typeof createReactHost>> | undefined;
afterEach(async () => { await host?.close(); host = undefined; vi.clearAllMocks(); vi.unstubAllGlobals(); });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
function media(deviceId: string) {
  const track = { readyState: 'live', onended: null as (() => void) | null, getSettings: () => ({ deviceId }), stop: vi.fn(() => { track.readyState = 'ended'; }) };
  const stream = { getTracks: () => [track], getVideoTracks: () => [track] } as unknown as MediaStream;
  return { stream, track };
}
function transformed(deviceId = 'canvas') {
  const output = media(deviceId);
  const dispose = vi.fn(() => output.track.stop());
  return { ...output, dispose };
}
async function mount(transform?: Transform, dimensions?: { width: number; height: number }) {
  host = await createReactHost();
  vi.stubGlobal('localStorage', { getItem: () => null });
  const captures: ReturnType<typeof media>[] = [];
  const getUserMedia = vi.fn(async (_constraints: MediaStreamConstraints) => { const next = media(`camera-${captures.length}`); captures.push(next); return next.stream; });
  const mediaDevices = Object.assign(new EventTarget(), { getUserMedia, enumerateDevices: vi.fn(async (): Promise<MediaDeviceInfo[]> => []) });
  vi.stubGlobal('navigator', { mediaDevices });
  mocks.api.mockResolvedValue({ configured: true });
  const state: ExhibitionState = { mirrorId: 'east', revision: 1, phase: 'idle', experienceMode: 'clothx', selectedLookId: 'look', displayedLookId: null,
    looks: [{ id: 'look', mode: 'clothx', name: '测试', image: '/test.png', source: 'sample', description: '', category: '', tags: [], palette: '' }],
    enabledLookIds: ['look'], categories: [], tags: [], sessionNumber: 0, generationNumber: 0, updatedAt: 1, generationReadyAt: null,
    providerMode: 'xmax', live: null, logs: [], settings: { autoReturnSeconds: 90, uploadLimits: { maxFileSizeMB: 10, minWidth: 64, minHeight: 64, maxWidth: 4096, maxHeight: 4096 } } };
  let live!: ExhibitionLiveController;
  let change!: (next?: Transform) => void;
  const refresh = vi.fn();
  function Harness() {
    const [value, setValue] = useState({ transform });
    change = next => setValue({ transform: next });
    live = useExhibitionLive({ state, active: true, mirrorId: 'east', cameraPreferenceScope: 'computer-east', cameraTransform: value.transform, cameraCaptureDimensions: dimensions, refresh });
    return null;
  }
  await host.render(createElement(Harness)); await flushReact();
  return { get live() { return live; }, captures, getUserMedia, change, mediaDevices };
}

describe('owned camera input transform', () => {
  it('lists a second plugged-in camera without restarting the first capture', async () => {
    const f = await mount();
    const devices = ['camera-0', 'camera-1'].map(deviceId => ({ kind: 'videoinput', deviceId, label: 'Insta360 Link 2 Pro' } as MediaDeviceInfo));
    f.mediaDevices.enumerateDevices.mockResolvedValue(devices);
    await act(async () => { f.mediaDevices.dispatchEvent(new Event('devicechange')); }); await flushReact();
    expect(f.live.cameras).toEqual(devices);
    expect(f.live.cameraStream).toBe(f.captures[0].stream);
    expect(f.live.selectedCameraId).toBe('camera-0');
    expect(f.getUserMedia).toHaveBeenCalledOnce();
    expect(f.captures[0].track.stop).not.toHaveBeenCalled();
  });
  it('keeps the default camera stream unchanged and releases its one original owner once', async () => {
    const f = await mount();
    expect(f.live.cameraStream).toBe(f.captures[0].stream); expect(f.live.rawCameraStream).toBe(f.live.cameraStream);
    await act(async () => f.live.stopCamera()); await flushReact();
    expect(f.captures[0].track.stop).toHaveBeenCalledOnce();
    await host!.close(); host = undefined; expect(f.captures[0].track.stop).toHaveBeenCalledOnce();
    expect(mocks.api.mock.calls.every(([path]) => String(path).endsWith('/live/status'))).toBe(true);
  });

  it('publishes only the transformed stream while retaining original device metadata separately', async () => {
    const output = transformed(); const transform = vi.fn(async () => output);
    const f = await mount(transform);
    expect(transform).toHaveBeenCalledExactlyOnceWith(f.captures[0].stream, expect.any(AbortSignal));
    expect(f.live.cameraStream).toBe(output.stream); expect(f.live.rawCameraStream).toBe(f.captures[0].stream);
    expect(f.live.selectedCameraId).toBe('camera-0'); expect(f.live.status).toBe('preview');
    await act(async () => f.live.stopCamera()); await flushReact();
    expect(output.dispose).toHaveBeenCalledOnce(); expect(f.captures[0].track.stop).toHaveBeenCalledOnce();
    expect(f.live.rawCameraStream).toBeNull(); expect(f.live.cameraStream).toBeNull();
    await host!.close(); host = undefined;
    expect(output.dispose).toHaveBeenCalledOnce(); expect(f.captures[0].track.stop).toHaveBeenCalledOnce();
  });

  it('requests a landscape source for quarter turns while default captures retain portrait constraints', async () => {
    const output = transformed(); const f = await mount(async () => output, { width: 1920, height: 1080 });
    expect(f.getUserMedia).toHaveBeenCalledExactlyOnceWith({ audio: false, video: {
      facingMode: 'user', width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30, max: 30 },
    } });
    expect(f.live.cameraStream).toBe(output.stream);
  });

  it('aborts an unfinished transform and discards its late output after manual stop', async () => {
    const pending = deferred<ExhibitionCameraTransform>(); const transform = vi.fn(() => pending.promise);
    const f = await mount(transform); const output = transformed();
    expect(f.live.cameraStream).toBeNull(); expect(f.live.opening).toBe(true);
    await act(async () => f.live.stopCamera()); await flushReact();
    expect(transform.mock.calls[0][1].aborted).toBe(true); expect(f.captures[0].track.stop).toHaveBeenCalledOnce();
    await act(async () => pending.resolve(output)); await flushReact();
    expect(output.dispose).toHaveBeenCalledOnce(); expect(f.captures[0].track.stop).toHaveBeenCalledOnce();
    expect(f.live.cameraStream).toBeNull(); expect(f.live.rawCameraStream).toBeNull(); expect(f.live.opening).toBe(false);
    expect(f.getUserMedia).toHaveBeenCalledOnce();
  });

  it('keeps the next capture when an old rotation finishes after its replacement', async () => {
    const pending = deferred<ExhibitionCameraTransform>();
    const f = await mount(() => pending.promise);
    const next = transformed('new-canvas'); const newTransform = vi.fn(async () => next);
    await act(async () => f.change(newTransform)); await flushReact();
    expect(f.getUserMedia).toHaveBeenCalledTimes(2); expect(f.captures[0].track.stop).toHaveBeenCalledOnce();
    expect(f.live.cameraStream).toBe(next.stream); expect(f.live.selectedCameraId).toBe('camera-1');
    const old = transformed('old-canvas'); await act(async () => pending.resolve(old)); await flushReact();
    expect(old.dispose).toHaveBeenCalledOnce(); expect(next.dispose).not.toHaveBeenCalled();
    expect(f.captures[1].track.stop).not.toHaveBeenCalled(); expect(f.live.cameraStream).toBe(next.stream);
    expect(mocks.api.mock.calls.every(([path]) => String(path).endsWith('/live/status'))).toBe(true);
  });

  it('releases the pending raw source at unmount and the late transformed output only once', async () => {
    const pending = deferred<ExhibitionCameraTransform>(); const f = await mount(() => pending.promise);
    await host!.close(); host = undefined;
    expect(f.captures[0].track.stop).toHaveBeenCalledOnce();
    const output = transformed(); pending.resolve(output); await flushReact();
    expect(output.dispose).toHaveBeenCalledOnce(); expect(f.captures[0].track.stop).toHaveBeenCalledOnce();
  });

  it.each(['raw', 'output'] as const)('cleans up both owners if the %s video ends', async ended => {
    const output = transformed(); const f = await mount(async () => output);
    const track = ended === 'raw' ? f.captures[0].track : output.track;
    await act(async () => track.onended?.()); await flushReact();
    expect(output.dispose).toHaveBeenCalledOnce(); expect(f.captures[0].track.stop).toHaveBeenCalledOnce();
    expect(f.live.cameraStream).toBeNull(); expect(f.live.error).toContain('摄像头已断开');
  });

  it('releases raw capture when orientation fails and does not retry until asked', async () => {
    const transform = vi.fn().mockRejectedValue(new Error('方向转换失败'));
    const f = await mount(transform);
    expect(f.captures[0].track.stop).toHaveBeenCalledOnce(); expect(f.live.status).toBe('error');
    expect(f.live.cameraStream).toBeNull(); expect(f.live.rawCameraStream).toBeNull(); expect(f.getUserMedia).toHaveBeenCalledOnce();
    const output = transformed(); transform.mockResolvedValue(output);
    await act(async () => { await f.live.startCamera(); }); await flushReact();
    expect(f.live.cameraStream).toBe(output.stream); expect(f.getUserMedia).toHaveBeenCalledTimes(2);
  });
});
