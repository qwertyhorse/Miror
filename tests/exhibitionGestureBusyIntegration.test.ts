import { materialCatalogFixture } from './support/materialCatalogFixture';
import { act, createElement, type ComponentProps } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExhibitionState } from '../shared/exhibition';
import { resolveExhibitionGestureSettings, type ExhibitionGestureSettings } from '../shared/exhibitionGestures';
import { Kiosk } from '../src/exhibition/ExhibitionApp';
import { exhibitionLooks } from '../src/exhibition/catalog';
import type { ExhibitionGestureHand } from '../src/exhibition/gestureDetector';
import type { ExhibitionLiveController } from '../src/exhibition/useExhibitionLive';
import { createReactHost, flushReact } from './support/reactHost';

// Exercise the actual Kiosk, hook and detector together. The boundary doubles
// stand in only for camera decoding, ML inference and the command transport.
class InferenceWorker {
  static instances: InferenceWorker[] = [];
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  onmessageerror: (() => void) | null = null;
  postMessage = vi.fn();
  terminate = vi.fn();
  constructor() { InferenceWorker.instances.push(this); }
  emit(data: unknown) { this.onmessage?.({ data } as MessageEvent); }
}

const openPalm = [
  [0, 0], [-0.04, -0.05], [-0.09, -0.09], [-0.12, -0.14], [-0.16, -0.17],
  [-0.06, -0.17], [-0.065, -0.29], [-0.07, -0.37], [-0.075, -0.44],
  [0, -0.19], [0, -0.32], [0, -0.41], [0, -0.49],
  [0.06, -0.17], [0.065, -0.29], [0.07, -0.37], [0.075, -0.44],
  [0.115, -0.13], [0.13, -0.23], [0.14, -0.3], [0.15, -0.36],
];
const hand = (x = 0.3, handedness = 'Left'): ExhibitionGestureHand => ({ handedness,
  landmarks: openPalm.map(([px, py]) => ({ x: x + px * 0.5, y: 0.42 + py * 0.5 })) });
const wave = (time: number) => hand(0.3 + Math.sin(time / 1000 * Math.PI * 4) * 0.1);

let host: Awaited<ReturnType<typeof createReactHost>> | undefined;
beforeEach(() => { vi.useFakeTimers(); InferenceWorker.instances = []; });
afterEach(async () => {
  await host?.close(); host = undefined;
  await vi.runOnlyPendingTimersAsync();
  vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks();
});

async function fixture(settings: Partial<ExhibitionGestureSettings> = {}, initial: Partial<ExhibitionState> = {}) {
  host = await createReactHost();
  let clock = 0;
  vi.spyOn(performance, 'now').mockImplementation(() => clock);
  const track = Object.assign(new EventTarget(), { readyState: 'live', enabled: true, muted: false, stop: vi.fn() });
  const stream = { getVideoTracks: () => [track] } as unknown as MediaStream;
  const original = document.createElement.bind(document);
  const videos: HTMLVideoElement[] = [];
  vi.spyOn(document, 'createElement').mockImplementation(((tag: string) => {
    if (tag === 'canvas') return { width: 0, height: 0, getContext: () => ({ drawImage: vi.fn() }) };
    const element = original(tag);
    if (tag === 'video') {
      Object.assign(element, { videoWidth: 640, videoHeight: 480, currentTime: 0, readyState: 2,
        play: vi.fn(async () => {}), pause: vi.fn() });
      videos.push(element as unknown as HTMLVideoElement);
    }
    return element;
  }) as typeof document.createElement);
  vi.stubGlobal('Worker', InferenceWorker);
  vi.stubGlobal('createImageBitmap', vi.fn(async () => ({ close: vi.fn() })));
  Object.assign(document, { hidden: false });
  let state: ExhibitionState = materialCatalogFixture({
    mirrorId: 'busy-integration', revision: 1, phase: 'showcase', experienceMode: 'clothx',
    looks: structuredClone(exhibitionLooks), enabledLookIds: ['commute', 'city', 'evening'],
    selectedLookId: 'commute', displayedLookId: 'commute', categories: [], tags: [],
    sessionNumber: 1, generationNumber: 1, updatedAt: 1, generationReadyAt: null,
    providerMode: 'xmax', live: null, logs: [], settings: { autoReturnSeconds: 90,
      uploadLimits: { maxFileSizeMB: 10, minWidth: 64, minHeight: 64, maxWidth: 4096, maxHeight: 4096 },
      gestureRecognition: { ...resolveExhibitionGestureSettings(), ...settings } }, ...initial,
  });
  state.catalog = { revision: 1, providerId: 'xmax', looks: structuredClone(state.looks), availableLookIds: [...state.enabledLookIds] };
  const live = { cameraStream: stream, outputStream: null, opening: false, error: '', status: 'running',
    deviceId: 'integration-camera', mirrored: false, secure: true, stopGeneration: vi.fn(async () => true) } as unknown as ExhibitionLiveController;
  const send = vi.fn(async (_command: unknown) => true);
  const props: Partial<ComponentProps<typeof Kiosk>> = {};
  const render = async () => { await host!.render(createElement(Kiosk, { state, live, send, ...props })); await flushReact(); };
  const worker = () => InferenceWorker.instances.at(-1)!;
  const control = () => host!.find(node => node.getReactProps().className === 'ex-mirror-gesture')!;
  const ready = async () => { await act(async () => worker().emit({ type: 'ready' })); };
  const capture = async (timestamp: number) => {
    clock = timestamp;
    for (const video of videos) video.currentTime += 1 / 15;
    const before = worker().postMessage.mock.calls.filter(([data]) => data.type === 'detect').length;
    await act(async () => { await vi.advanceTimersByTimeAsync(70); });
    const calls = worker().postMessage.mock.calls.filter(([data]) => data.type === 'detect');
    expect(calls).toHaveLength(before + 1);
    const frame = calls.at(-1)![0] as { frameId: number; timestamp: number };
    expect(frame.timestamp).toBe(timestamp);
    return frame;
  };
  const reply = async (frame: { frameId: number; timestamp: number }, hands: ExhibitionGestureHand[] = [hand()]) => {
    await act(async () => worker().emit({ ...frame, type: 'result', poses: [], hands, inferenceMs: 20 }));
    await flushReact();
  };
  const sample = async (timestamp: number, hands: ExhibitionGestureHand[] = [hand()]) => reply(await capture(timestamp), hands);
  const frames = async (from: number, to: number, hands: (time: number) => ExhibitionGestureHand[] = () => [hand()]) => {
    for (let time = from; time <= to; time += 100) await sample(time, hands(time));
  };
  await render(); await ready();
  return { send, live, props, render, ready, sample, frames, capture, reply, control, worker, track,
    update: async (next: Partial<ExhibitionState>) => { state = { ...state, ...next }; await render(); } };
}

describe('real camera gesture pipeline through Kiosk busy boundaries', () => {
  it.each([
    { times: [0, 310], settings: {} },
    { times: [0, 100, 200], settings: { palmConfirmMs: 150 } },
  ])('submits a palm when ownership and confirmation first complete in the same frame: $times', async ({ times, settings }) => {
    const f = await fixture(settings);
    for (const timestamp of times.slice(0, -1)) await f.sample(timestamp);
    expect(f.control().getReactProps()['data-operator']).toBe('searching');
    expect(f.send).not.toHaveBeenCalled();
    await f.sample(times.at(-1)!);
    expect(f.send).toHaveBeenCalledExactlyOnceWith({ action: 'switch', lookId: 'city' });
    await f.update({ selectedLookId: 'city', revision: 2 });
    await f.frames(410, 1010);
    expect(f.send).toHaveBeenCalledTimes(1);
    await f.frames(1110, 1710, () => []);
    await f.frames(1810, 2210);
    expect(f.send).toHaveBeenCalledTimes(2);
    expect(f.send).toHaveBeenLastCalledWith({ action: 'switch', lookId: 'evening' });
    expect(InferenceWorker.instances).toHaveLength(1);
    expect(f.track.stop).not.toHaveBeenCalled();
  });

  it('discards a partial palm when generation starts and requires release after completion', async () => {
    const f = await fixture();
    await f.sample(0); await f.sample(100);
    await f.update({ phase: 'generating' });
    await f.frames(200, 600);
    expect(f.send).not.toHaveBeenCalled();
    await f.update({ phase: 'showcase' });
    await f.frames(700, 1200);
    expect(f.send).not.toHaveBeenCalled();
    await f.frames(1300, 1900, () => []);
    await f.frames(2000, 2400);
    expect(f.send).toHaveBeenCalledExactlyOnceWith({ action: 'switch', lookId: 'city' });
    expect(InferenceWorker.instances).toHaveLength(1);
  });

  it('consumes a palm first seen just before generation completes without finishing its confirmation', async () => {
    const f = await fixture({}, { phase: 'generating' });
    await f.frames(0, 600, () => []);
    await f.sample(700);
    await f.update({ phase: 'showcase' });
    await f.frames(800, 1300);
    expect(f.send).not.toHaveBeenCalled();
    await f.frames(1400, 2000, () => []);
    await f.frames(2100, 2500);
    expect(f.send).toHaveBeenCalledExactlyOnceWith({ action: 'switch', lookId: 'city' });
  });

  it.each([false, true])('counts a real release while busy; a hand raised again during busy is consumed: $0', async raiseAgain => {
    const f = await fixture();
    await f.sample(0); await f.sample(310);
    await f.update({ phase: 'generating', selectedLookId: 'city', revision: 2 });
    await f.frames(410, 1010, () => []);
    if (raiseAgain) await f.frames(1110, 1510);
    await f.update({ phase: 'showcase' });
    await f.frames(1610, 2110);
    expect(f.send).toHaveBeenCalledTimes(raiseAgain ? 1 : 2);
    if (raiseAgain) {
      await f.frames(2210, 2810, () => []);
      await f.frames(2910, 3310);
      expect(f.send).toHaveBeenCalledTimes(2);
    }
    expect(f.send).toHaveBeenLastCalledWith({ action: 'switch', lookId: 'evening' });
  });

  it('discards repeated waves during generation instead of replaying them on completion', async () => {
    const f = await fixture({ gestures: ['wave'] }, { phase: 'generating' });
    await f.frames(0, 2000, time => [wave(time)]);
    expect(f.send).not.toHaveBeenCalled();
    await f.update({ phase: 'showcase' });
    await f.frames(2100, 2700);
    expect(f.send).not.toHaveBeenCalled();
    await f.frames(2800, 3400, () => []);
    await f.frames(3500, 5000, time => [wave(time)]);
    expect(f.send).toHaveBeenCalledExactlyOnceWith({ action: 'switch', lookId: 'city' });
  });

  it('does not turn a second hand seen during generation into a queued gesture', async () => {
    const f = await fixture({}, { phase: 'generating' });
    await f.frames(0, 400);
    await f.frames(500, 900, () => [hand(), hand(0.7, 'Right')]);
    await f.frames(1000, 1400, () => [hand(0.7, 'Right')]);
    await f.update({ phase: 'showcase' });
    await f.frames(1500, 1900, () => [hand(0.7, 'Right')]);
    expect(f.send).not.toHaveBeenCalled();
    await f.frames(2000, 2600, () => []);
    await f.frames(2700, 3100, () => [hand(0.7, 'Right')]);
    expect(f.send).toHaveBeenCalledExactlyOnceWith({ action: 'switch', lookId: 'city' });
  });

  it('ignores an in-flight confirming frame when generation begins', async () => {
    const f = await fixture();
    await f.sample(0); await f.sample(100);
    const stale = await f.capture(310);
    await f.update({ phase: 'generating' });
    await f.reply(stale);
    expect(f.send).not.toHaveBeenCalled();
    await f.frames(410, 810);
    await f.update({ phase: 'showcase' });
    await f.frames(910, 1410);
    expect(f.send).not.toHaveBeenCalled();
  });

  it('ignores an in-flight first palm when generation ends instead of adding its hold time', async () => {
    const f = await fixture({}, { phase: 'generating' });
    await f.frames(0, 600, () => []);
    const stale = await f.capture(700);
    await f.update({ phase: 'showcase' });
    await f.reply(stale);
    await f.sample(800); await f.sample(1000);
    expect(f.send).not.toHaveBeenCalled();
    await f.sample(1100);
    expect(f.send).toHaveBeenCalledExactlyOnceWith({ action: 'switch', lookId: 'city' });
  });

  it('keeps a consumed palm across Worker failure and retry without permanently locking it', async () => {
    const f = await fixture();
    await f.sample(0); await f.sample(310);
    await f.update({ selectedLookId: 'city', revision: 2 });
    const failedWorker = f.worker();
    const staleHandler = failedWorker.onmessage!;
    await act(async () => failedWorker.onerror!());
    expect(f.control().getReactProps()['data-status']).toBe('error');
    await act(async () => f.control().getReactProps().onClick());
    await f.ready();
    await act(async () => staleHandler({ data: { type: 'result', frameId: 3, timestamp: 310, poses: [], hands: [hand()] } } as MessageEvent));
    await f.frames(410, 1010);
    expect(f.send).toHaveBeenCalledTimes(1);
    await f.frames(1110, 1710, () => []);
    await f.frames(1810, 2210);
    expect(f.send).toHaveBeenCalledTimes(2);
    expect(f.send).toHaveBeenLastCalledWith({ action: 'switch', lookId: 'evening' });
    expect(InferenceWorker.instances).toHaveLength(2);
    expect(f.track.stop).not.toHaveBeenCalled();
  });

  it('releases a rejected command without retriggering the held palm', async () => {
    const f = await fixture();
    f.send.mockResolvedValueOnce(false);
    await f.sample(0); await f.sample(310);
    await f.frames(410, 1010);
    expect(f.send).toHaveBeenCalledTimes(1);
    await f.frames(1110, 1710, () => []);
    await f.frames(1810, 2210);
    expect(f.send).toHaveBeenCalledTimes(2);
    expect(f.send).toHaveBeenLastCalledWith({ action: 'switch', lookId: 'city' });
  });

  it('abandons an unresolved gesture command on stop and ignores its late response', async () => {
    const f = await fixture();
    let finishOld!: (value: boolean) => void;
    let finishCurrent!: (value: boolean) => void;
    f.send.mockImplementationOnce(() => new Promise(resolve => { finishOld = resolve; }));
    await f.sample(0); await f.sample(310);
    expect(f.send).toHaveBeenCalledTimes(1);
    await act(async () => host!.find(node => node.nodeName === 'button' && node.getReactProps()['aria-label'] === '停止生成')!.getReactProps().onClick());
    await flushReact();
    await f.update({ phase: 'idle', revision: 2, sessionNumber: 2, generationNumber: 2 });
    await f.frames(410, 1010);
    expect(f.send).toHaveBeenCalledTimes(2);
    expect(f.send).toHaveBeenLastCalledWith({ action: 'end' });
    await f.frames(1110, 1710, () => []);
    f.send.mockImplementationOnce(() => new Promise(resolve => { finishCurrent = resolve; }));
    await f.frames(1810, 2210);
    expect(f.send).toHaveBeenCalledTimes(3);
    expect(f.send).toHaveBeenLastCalledWith({ action: 'select', lookId: 'city' });
    await act(async () => finishOld(true));
    await f.frames(2310, 2910, () => []);
    await f.frames(3010, 3410);
    expect(f.send).toHaveBeenCalledTimes(3);
    await act(async () => finishCurrent(true));
    await f.update({ selectedLookId: 'city', phase: 'select', revision: 3 });
    await f.frames(3510, 4110, () => []);
    await f.frames(4210, 4610);
    expect(f.send).toHaveBeenCalledTimes(4);
    expect(f.send).toHaveBeenLastCalledWith({ action: 'select', lookId: 'evening' });
  });
});
