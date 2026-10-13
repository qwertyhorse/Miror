import { act, createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useExhibitionGestures, type ExhibitionGestureMetadata } from '../src/exhibition/useExhibitionGestures';
import { createReactHost, flushReact } from './support/reactHost';

// Use the real hook AND state machine. Only camera/ML output are simulated.
class PoseWorker {
  static current: PoseWorker;
  onmessage: ((event: MessageEvent) => void) | null = null;
  postMessage = vi.fn();
  terminate = vi.fn();
  constructor() { PoseWorker.current = this; }
  emit(data: unknown) { this.onmessage?.({ data } as MessageEvent); }
}
let host: Awaited<ReturnType<typeof createReactHost>> | undefined;
afterEach(async () => {
  await host?.close(); host = undefined;
  await vi.runOnlyPendingTimersAsync();
  vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks();
});

function body(raised: boolean) {
  const landmarks = Array.from({ length: 33 }, () => ({ x: 0.5, y: 0.5, visibility: 0.99 }));
  for (const [index, x, y] of [[11, 0.42, 0.35], [12, 0.58, 0.35], [23, 0.44, 0.65], [24, 0.56, 0.65],
    [13, 0.38, 0.42], [14, 0.62, 0.42], [15, 0.36, raised ? 0.25 : 0.65], [16, 0.64, 0.25]]) {
    landmarks[index] = { x, y, visibility: 0.99 };
  }
  return { landmarks };
}

describe('raise sequence across interaction boundaries', () => {
  it('requires a fresh lower/raise after a blocked half-raise and ignores its in-flight result', async () => {
    vi.useFakeTimers();
    host = await createReactHost();
    const track = Object.assign(new EventTarget(), { readyState: 'live', enabled: true, muted: false });
    const stream = { getVideoTracks: () => [track] } as unknown as MediaStream;
    const original = document.createElement.bind(document);
    const video = Object.assign(original('video'), { videoWidth: 720, videoHeight: 1280, readyState: 2,
      currentTime: 0, play: vi.fn(async () => {}), pause: vi.fn() });
    const canvas = { width: 0, height: 0, getContext: () => ({ drawImage: vi.fn() }) };
    vi.spyOn(document, 'createElement').mockImplementation(((tag: string) => tag === 'video' ? video
      : tag === 'canvas' ? canvas : original(tag)) as typeof document.createElement);
    vi.stubGlobal('Worker', PoseWorker);
    vi.stubGlobal('createImageBitmap', vi.fn(async () => ({ close: vi.fn() })));
    Object.assign(document, { hidden: false });
    let blocked = false;
    const accepted: string[] = [];
    const measurements: ExhibitionGestureMetadata[] = [];
    let state!: ReturnType<typeof useExhibitionGestures>;
    function Harness() {
      state = useExhibitionGestures({ stream, enabled: true, mode: 'raise', resetKey: `interaction:${blocked}`, diagnostics: true,
        onGesture: (gesture, metadata) => { if (!blocked) { accepted.push(gesture); if (metadata) measurements.push(metadata); } } });
      return null;
    }
    const render = async () => { await host!.render(createElement(Harness)); await flushReact(); };
    const capture = async () => {
      video.currentTime += 0.07;
      await act(async () => { await vi.advanceTimersByTimeAsync(70); });
      return PoseWorker.current.postMessage.mock.calls.findLast(([data]) => data.type === 'detect')![0];
    };
    const reply = async (frame: object, raised: boolean) => {
      await act(async () => PoseWorker.current.emit({ ...frame, type: 'result', poses: [body(raised)], inferenceMs: 20 }));
    };
    const frames = async (count: number, raised: boolean) => {
      const samples: { frameId: number; timestamp: number }[] = [];
      for (let index = 0; index < count; index++) {
        const frame = await capture();
        samples.push(frame);
        await reply(frame, raised);
      }
      return samples;
    };
    await render();
    await act(async () => PoseWorker.current.emit({ type: 'ready' }));
    blocked = true; await render();
    await frames(15, false); // Stable person and lowered free arm while another update is in progress.
    expect(state.armed).toBe(true);
    await frames(3, true); // Less than the raise confirmation time.
    const stale = await capture();
    blocked = false; await render();
    await reply(stale, true);
    expect(state.operatorStatus).toBe('searching');
    await frames(20, true);
    expect(state.operatorStatus).toBe('locked');
    expect(state.armed).toBe(false);
    expect(accepted).toEqual([]);
    expect(measurements).toEqual([]);
    await frames(8, false);
    expect(state.armed).toBe(true);
    const raisedFrames = await frames(6, true);
    expect(accepted).toEqual(['raise_hand']);
    expect(measurements).toHaveLength(1);
    expect(measurements[0].raiseStartedAt).toBe(raisedFrames[0].timestamp);
    expect(measurements[0].raiseStartedAt).toBeGreaterThan(stale.timestamp);
    expect(measurements[0].sampledAt - measurements[0].raiseStartedAt!).toBeGreaterThanOrEqual(250);
    expect(measurements[0].detectedAt).toBeGreaterThanOrEqual(measurements[0].sampledAt);
    await frames(20, true);
    expect(accepted).toEqual(['raise_hand']);
    expect(measurements).toHaveLength(1);
  });
});
