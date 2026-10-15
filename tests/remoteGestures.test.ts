import { afterEach, describe, expect, it, vi } from 'vitest';
import { RemoteGestureCoordinator } from '../server/remoteGestures.ts';
import type { GestureInference, GestureInferenceResult } from '../server/gestureInference.ts';
import { resolveExhibitionGestureSettings } from '../shared/exhibitionGestures.ts';
import type { RemoteGestureSnapshot } from '../shared/remoteGestures.ts';
import { createNativeGestureRuntime } from '../src/exhibition/nativeGestureRuntime.ts';

const settings = resolveExhibitionGestureSettings();
const palm = [[0, 0], [-.04, -.05], [-.09, -.09], [-.12, -.14], [-.16, -.17],
  [-.06, -.17], [-.065, -.29], [-.07, -.37], [-.075, -.44],
  [0, -.19], [0, -.32], [0, -.41], [0, -.49],
  [.06, -.17], [.065, -.29], [.07, -.37], [.075, -.44],
  [.115, -.13], [.13, -.23], [.14, -.3], [.15, -.36]];
type Hands = GestureInferenceResult['hands'];
function hand(x = .30): Hands[number] {
  return { handedness: 'Left', landmarks: palm.map(point => ({ x: x + point[0] * .5, y: .42 + point[1] * .5, z: 0 })) };
}
const result = (hands: Hands = []): GestureInferenceResult => ({ hands, poses: [], width: 480, height: 480, inferenceMs: 12 });
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

class FakeInference implements GestureInference {
  next: Promise<GestureInferenceResult> | null = null;
  active = 0;
  maximumActive = 0;
  infer = vi.fn(async (jpeg: Buffer) => {
    this.active++;
    this.maximumActive = Math.max(this.maximumActive, this.active);
    const pending = this.next;
    this.next = null;
    try { return pending ? await pending : result(JSON.parse(jpeg.toString()) as Hands); }
    finally { this.active--; }
  });
  close = vi.fn(async () => {});
}

const coordinators: RemoteGestureCoordinator[] = [];
afterEach(async () => { await Promise.all(coordinators.splice(0).map(coordinator => coordinator.closeAll())); });

function fixture(options: Partial<ConstructorParameters<typeof RemoteGestureCoordinator>[0]> = {}) {
  const workers: FakeInference[] = [];
  let now = 0;
  const createInference = vi.fn(async () => { const worker = new FakeInference(); workers.push(worker); return worker; });
  const coordinator = new RemoteGestureCoordinator({ createInference, now: () => now, ...options });
  coordinators.push(coordinator);
  return { coordinator, workers, createInference, advance: (amount: number) => { now += amount; },
    async open(terminalId = 'terminal-a', mirrorId = 'mirror-a') {
      const state = await coordinator.open({ terminalId, mirrorId, blocked: false }, settings);
      let epoch = state.epoch;
      let seq = -1;
      let blocked = false;
      const stream = {
        id: state.sessionId,
        state,
        control(value: boolean, reset = false) {
          blocked = value;
          return coordinator.control(state.sessionId, { epoch: ++epoch, blocked, reset });
        },
        frame(timestamp: number, hands: Hands = [hand()], serverBlocked = false, guard?: () => boolean) {
          return coordinator.frame(state.sessionId, { epoch, seq: ++seq, timestamp, blocked },
            Buffer.from(JSON.stringify(hands)), settings, serverBlocked, guard);
        },
        async run(start: number, end: number, hands: (time: number) => Hands = () => [hand()], serverBlocked = false) {
          const events: { timestamp: number; event: string }[] = [];
          for (let timestamp = start; timestamp <= end; timestamp += 100) {
            const current = await stream.frame(timestamp, hands(timestamp), serverBlocked);
            if (current.event) events.push({ timestamp, event: current.event });
          }
          return events;
        },
        async release(start = 0) { await stream.run(start, start + 500, () => []); },
      };
      return stream;
    } };
}

describe('remote gesture sessions use the real V1.1 detector', () => {
  it('requires observed release on startup, then confirms the first lock in the same 0 → 310 ms sampling frame', async () => {
    const f = fixture(); const s = await f.open();
    expect(s.state).toMatchObject({ event: null, needsRelease: true, blocked: true, seq: -1 });
    expect(await s.run(0, 1500)).toEqual([]);
    await s.release(1600);
    expect((await s.frame(2200)).event).toBeNull();
    expect(await s.frame(2510)).toMatchObject({ operatorStatus: 'locked', event: 'open_palm', blocked: false });
    expect(await s.run(2610, 5010)).toEqual([]);
    expect(f.workers[0].maximumActive).toBe(1);
  });

  it('does not count disconnected gaps or an intervening hand as startup release', async () => {
    const f = fixture(); const s = await f.open();
    for (const timestamp of [0, 800, 1600, 2401]) expect((await s.frame(timestamp, [])).needsRelease).toBe(true);
    await s.frame(2500, []); await s.frame(2600);
    for (const timestamp of [2700, 2800, 2900, 3000, 3100]) expect((await s.frame(timestamp, [])).needsRelease).toBe(true);
    expect((await s.frame(3200, [])).needsRelease).toBe(false);
    expect((await s.frame(3300)).event).toBeNull();
    expect((await s.frame(3610)).event).toBe('open_palm');
  });

  it('allows slow fresh empty samples to clear startup release without loosening gesture confirmation timing', async () => {
    const f = fixture(); const s = await f.open();
    expect((await s.frame(0, [])).needsRelease).toBe(true);
    expect((await s.frame(600, [])).needsRelease).toBe(false);
    for (const time of [700, 1300, 1900]) expect((await s.frame(time)).event).toBeNull();
    expect((await s.frame(2210)).event).toBe('open_palm');
  });

  it('keeps terminal state, clocks, detections and busy release independent for two devices', async () => {
    const f = fixture(); const [a, b] = await Promise.all([f.open(), f.open('terminal-b', 'mirror-b')]);
    expect(a.id).not.toBe(b.id);
    expect(f.workers).toHaveLength(2);
    await a.release(); await b.release(10_000);
    await a.frame(600); await b.frame(10_600);
    expect((await a.frame(910)).event).toBe('open_palm');
    a.control(true);
    expect((await b.frame(10_910)).event).toBe('open_palm');
    expect(await a.run(1010, 2010)).toEqual([]);
    await a.release(2110); a.control(false);
    expect(await a.run(2710, 3310)).toEqual([{ timestamp: 3010, event: 'open_palm' }]);
    expect(await b.run(11_010, 12_010)).toEqual([]);
    expect(f.coordinator.session(a.id)).toEqual({ terminalId: 'terminal-a', mirrorId: 'mirror-a' });
  });

  it('matches local detector events and mirrored coordinates for an identical hand-only trace', async () => {
    const f = fixture(); const s = await f.open(); await s.release();
    const local = createNativeGestureRuntime(); local.configure(settings);
    const remoteEvents: unknown[] = [], localEvents: unknown[] = [];
    for (let time = 600; time <= 4000; time += 100) {
      const hands = time >= 1500 && time <= 2200 ? [] : [hand(.3)];
      const remote = await s.frame(time, hands);
      const native = local.push({ timestamp: time, hands: hands.map(value => ({ ...value,
        landmarks: value.landmarks.map(point => ({ ...point, x: 1 - point.x })) })), poses: [], aspectRatio: 1 });
      if (remote.event) remoteEvents.push([time, remote.event]);
      if (native.event) localEvents.push([time, native.event]);
      expect(remote.operatorStatus).toBe(native.operatorStatus);
      expect(remote.rawHandCount).toBe(native.rawHandCount);
    }
    expect(remoteEvents).toEqual(localEvents);
    expect(remoteEvents).toHaveLength(2);
  });

  it('drops busy palms, counts release during busy, and never accumulates a busy re-raise', async () => {
    const f = fixture(); const s = await f.open(); await s.release();
    await s.frame(600); expect((await s.frame(910)).event).toBe('open_palm');
    s.control(true);
    expect(await s.run(1010, 2010)).toEqual([]);
    s.control(false);
    expect(await s.run(2110, 3110)).toEqual([]);
    s.control(true); await s.release(3210);
    s.control(false);
    expect(await s.run(3810, 4410)).toEqual([{ timestamp: 4110, event: 'open_palm' }]);
    s.control(true); await s.release(4510);
    await s.run(5110, 5310); s.control(false);
    expect(await s.run(5410, 6410)).toEqual([]);
    await s.release(6510);
    expect(await s.run(7110, 7710)).toEqual([{ timestamp: 7410, event: 'open_palm' }]);
  });

  it('consumes an unfinished palm before the busy boundary even if no busy frame arrives', async () => {
    const f = fixture(); const s = await f.open(); await s.release();
    await s.frame(600); await s.frame(700);
    s.control(true); s.control(false);
    expect(await s.run(800, 1800)).toEqual([]);
    await s.release(1900);
    expect(await s.run(2500, 3000)).toEqual([{ timestamp: 2800, event: 'open_palm' }]);
  });

  it('keeps a second busy hand from rearming the first when ambiguity resolves', async () => {
    const f = fixture(); const s = await f.open(); await s.release();
    await s.frame(600); await s.frame(910); s.control(true);
    expect(await s.run(1010, 1610, () => [hand(), hand(.7)])).toEqual([]);
    s.control(false);
    expect(await s.run(1710, 2710)).toEqual([]);
    await s.release(2810);
    expect(await s.run(3410, 4010)).toEqual([{ timestamp: 3710, event: 'open_palm' }]);
  });

  it('enforces backend busy independently of the client blocked flag', async () => {
    const f = fixture(); const s = await f.open(); await s.release();
    expect(await s.run(600, 1600, () => [hand()], true)).toEqual([]);
    expect(await s.run(1700, 2700)).toEqual([]);
    await s.release(2800);
    expect(await s.run(3400, 4000)).toEqual([{ timestamp: 3700, event: 'open_palm' }]);
  });

  it('clears busy wave trajectories and accepts a fresh wave after release', async () => {
    const f = fixture(); const initial = await f.coordinator.open({ terminalId: 'a', mirrorId: 'a', blocked: false }, { ...settings, gestures: ['wave'] });
    const waveSettings = { ...settings, gestures: ['wave' as const] };
    let seq = 0, epoch = 0, blocked = false;
    const events: string[] = [];
    const frame = async (timestamp: number, hands: Hands) => {
      const value = await f.coordinator.frame(initial.sessionId, { epoch, seq: seq++, timestamp, blocked },
        Buffer.from(JSON.stringify(hands)), waveSettings, false);
      if (value.event) events.push(value.event);
    };
    for (let time = 0; time <= 500; time += 100) await frame(time, []);
    blocked = true; f.coordinator.control(initial.sessionId, { epoch: ++epoch, blocked });
    const waving = (time: number) => [hand(.3 + Math.sin(time / 1000 * Math.PI * 4) * .10)];
    for (let time = 600; time <= 1600; time += 100) await frame(time, waving(time));
    blocked = false; f.coordinator.control(initial.sessionId, { epoch: ++epoch, blocked });
    for (let time = 1700; time <= 3000; time += 100) await frame(time, waving(time));
    expect(events).toEqual([]);
    for (let time = 3100; time <= 4200; time += 100) await frame(time, [hand()]);
    for (let time = 4300; time <= 6000; time += 100) await frame(time, waving(time));
    expect(events).toEqual(['wave']);
  });
});

describe('remote frame ordering and lifecycle', () => {
  it('never queues frames or permits a new inference while an invalidated one is pending', async () => {
    const f = fixture(); const s = await f.open(); await s.release();
    const pending = deferred<GestureInferenceResult>(); f.workers[0].next = pending.promise;
    const old = s.frame(600);
    const rejected = expect(old).rejects.toMatchObject({ status: 409, code: 'GESTURE_STALE' });
    await expect(s.frame(700)).rejects.toMatchObject({ code: 'GESTURE_BUSY' });
    expect(f.workers[0].infer).toHaveBeenCalledTimes(7);
    s.control(true); s.control(false);
    await expect(s.frame(800)).rejects.toMatchObject({ code: 'GESTURE_BUSY' });
    pending.resolve(result([hand()])); await rejected;
    expect(f.workers[0].maximumActive).toBe(1);
    expect(await s.run(900, 1900)).toEqual([]);
    await s.release(2000);
    expect(await s.run(2600, 3100)).toEqual([{ timestamp: 2900, event: 'open_palm' }]);
  });

  it('lets the other device finish while one device has a slow inference', async () => {
    const f = fixture(); const a = await f.open(); const b = await f.open('b', 'b');
    await a.release(); await b.release();
    const pending = deferred<GestureInferenceResult>(); f.workers[0].next = pending.promise;
    const old = a.frame(600);
    await b.frame(600); expect((await b.frame(910)).event).toBe('open_palm');
    expect(f.workers[1].maximumActive).toBe(1);
    pending.resolve(result()); expect((await old).event).toBeNull();
  });

  it('rejects old epochs, duplicate sequences and decreasing timestamps before model inference', async () => {
    const f = fixture(); const s = await f.open(); await s.release();
    s.control(false);
    const bytes = Buffer.from('[]');
    for (const metadata of [
      { epoch: 0, seq: 99, timestamp: 600, blocked: false },
      { epoch: 1, seq: 5, timestamp: 600, blocked: false },
      { epoch: 1, seq: 99, timestamp: 500, blocked: false },
      { epoch: 1, seq: 99, timestamp: 400, blocked: false },
    ]) await expect(f.coordinator.frame(s.id, metadata, bytes, settings, false)).rejects.toMatchObject({ code: 'GESTURE_STALE' });
    expect(f.workers[0].infer).toHaveBeenCalledTimes(6);
    expect(f.coordinator.control(s.id, { epoch: 1, blocked: false }).event).toBeNull();
  });

  it('atomically applies newer frame epochs when control and upload arrive out of order', async () => {
    const f = fixture(); const s = await f.open(); await s.release();
    const value = await f.coordinator.frame(s.id, { epoch: 5, seq: 6, timestamp: 600, blocked: true },
      Buffer.from(JSON.stringify([hand()])), settings, false);
    expect(value).toMatchObject({ epoch: 5, event: null, blocked: true });
    expect(() => f.coordinator.control(s.id, { epoch: 4, blocked: false })).toThrow(expect.objectContaining({ code: 'GESTURE_STALE' }));
    expect(f.coordinator.control(s.id, { epoch: 6, blocked: false }).event).toBeNull();
    for (let timestamp = 700; timestamp <= 1700; timestamp += 100) {
      expect((await f.coordinator.frame(s.id, { epoch: 6, seq: timestamp, timestamp, blocked: false },
        Buffer.from(JSON.stringify([hand()])), settings, false)).event).toBeNull();
    }
  });

  it('reset/stop/mode changes require release and cannot replay a held or pending action', async () => {
    const f = fixture(); const s = await f.open(); await s.release();
    await s.frame(600); expect((await s.frame(910)).event).toBe('open_palm');
    expect(s.control(false, true)).toMatchObject({ event: null, needsRelease: true });
    expect(await s.run(1010, 2010)).toEqual([]);
    await s.release(2110);
    expect(await s.run(2710, 3310)).toEqual([{ timestamp: 3010, event: 'open_palm' }]);
    s.control(true, true); await s.release(3410); s.control(false);
    expect(await s.run(4010, 4610)).toEqual([{ timestamp: 4310, event: 'open_palm' }]);
  });

  it('a late result cannot survive a backend stop, changed ownership or a disconnected response', async () => {
    const f = fixture(); const s = await f.open(); await s.release(); await s.frame(600);
    const pending = deferred<GestureInferenceResult>(); f.workers[0].next = pending.promise;
    let allowed = true;
    const old = s.frame(910, [hand()], false, () => allowed);
    const rejected = expect(old).rejects.toMatchObject({ code: 'GESTURE_STALE' });
    allowed = false; pending.resolve(result([hand()])); await rejected;
    expect(await s.run(1010, 2010)).toEqual([]);
    await s.release(2110);
    expect(await s.run(2710, 3310)).toEqual([{ timestamp: 3010, event: 'open_palm' }]);
  });

  it('rejects processing older than the deadline without comparing Android and server clock origins', async () => {
    const f = fixture(); const s = await f.open(); await s.release(5_000_000);
    const pending = deferred<GestureInferenceResult>(); f.workers[0].next = pending.promise;
    const old = s.frame(5_000_600);
    const rejected = expect(old).rejects.toMatchObject({ code: 'GESTURE_FRAME_EXPIRED', status: 408 });
    f.advance(800); pending.resolve(result([hand()])); await rejected;
    expect((await s.frame(5_000_700)).needsRelease).toBe(true);
  });

  it('replacement closes the old model and ignores its late result; the new session first needs release', async () => {
    const f = fixture(); const a = await f.open(); await a.release();
    const pending = deferred<GestureInferenceResult>(); f.workers[0].next = pending.promise;
    const old = a.frame(600);
    const rejected = expect(old).rejects.toMatchObject({ code: 'GESTURE_STALE' });
    const b = await f.open();
    expect(b.id).not.toBe(a.id); expect(f.workers[0].close).toHaveBeenCalledTimes(1);
    expect(f.coordinator.session(a.id)).toBeNull();
    pending.resolve(result([hand()])); await rejected;
    await expect(a.frame(700)).rejects.toMatchObject({ code: 'GESTURE_SESSION_EXPIRED' });
    expect(await b.run(0, 1000)).toEqual([]);
    await b.release(1100);
    expect(await b.run(1700, 2300)).toEqual([{ timestamp: 2000, event: 'open_palm' }]);
  });

  it('model failure retires its session; retry warms another context behind a release fence', async () => {
    const f = fixture(); const a = await f.open(); await a.release();
    const pending = deferred<GestureInferenceResult>(); f.workers[0].next = pending.promise;
    const failed = a.frame(600);
    const rejected = expect(failed).rejects.toMatchObject({ code: 'GESTURE_INFERENCE_FAILED', status: 503 });
    pending.reject(new Error('private model traceback')); await rejected;
    expect(f.coordinator.session(a.id)).toBeNull();
    const b = await f.open();
    expect(await b.run(0, 500)).toEqual([]); await b.release(600);
    expect(await b.run(1200, 1800)).toEqual([{ timestamp: 1500, event: 'open_palm' }]);
  });

  it('also retires a failed worker if control invalidated its pending frame first', async () => {
    const f = fixture(); const s = await f.open();
    const pending = deferred<GestureInferenceResult>(); f.workers[0].next = pending.promise;
    const old = s.frame(0); const rejected = expect(old).rejects.toMatchObject({ code: 'GESTURE_STALE' });
    s.control(true);
    pending.reject(new Error('worker exited')); await rejected;
    expect(f.coordinator.session(s.id)).toBeNull();
    await expect(s.frame(100)).rejects.toMatchObject({ code: 'GESTURE_SESSION_EXPIRED' });
  });

  it('releases the worker slot after startup failure and exposes no private model error', async () => {
    const createInference = vi.fn().mockRejectedValueOnce(new Error('private filename and process trace'))
      .mockResolvedValue(new FakeInference());
    const f = fixture({ createInference, maxSessions: 1 });
    await expect(f.open()).rejects.toMatchObject({ code: 'GESTURE_UNAVAILABLE', message: '手势识别未能启动，请重试。' });
    expect((await f.open()).state.needsRelease).toBe(true);
  });

  it('settings changes clear partial confirmations and require a new release without changing session identity', async () => {
    const f = fixture(); const s = await f.open(); await s.release(); await s.frame(600);
    const changed = { ...settings, palmConfirmMs: 500 };
    for (let time = 700; time <= 1700; time += 100) {
      expect(await f.coordinator.frame(s.id, { epoch: 0, seq: time, timestamp: time, blocked: false },
        Buffer.from(JSON.stringify([hand()])), changed, false)).toMatchObject({ sessionId: s.id, event: null, needsRelease: true });
    }
    for (let time = 1800; time <= 2300; time += 100) await f.coordinator.frame(s.id,
      { epoch: 0, seq: time, timestamp: time, blocked: false }, Buffer.from('[]'), changed, false);
    const events = [];
    for (let time = 2400; time <= 3100; time += 100) {
      const value = await f.coordinator.frame(s.id, { epoch: 0, seq: time, timestamp: time, blocked: false },
        Buffer.from(JSON.stringify([hand()])), changed, false);
      if (value.event) events.push(time);
    }
    expect(events).toEqual([2900]);
  });

  it('expires idle sessions after 30 seconds and never lets read-only identity lookups extend their life', async () => {
    const f = fixture(); const s = await f.open();
    f.advance(29_999); expect(f.coordinator.session(s.id)).not.toBeNull();
    f.advance(1); expect(f.coordinator.session(s.id)).toBeNull();
    await expect(s.frame(0)).rejects.toMatchObject({ code: 'GESTURE_SESSION_EXPIRED', status: 404 });
    await Promise.resolve(); expect(f.workers[0].close).toHaveBeenCalledTimes(1);
  });

  it('bounds warm/active workers and permits a released slot to be reused', async () => {
    const f = fixture(); const a = await f.open(); await f.open('b', 'b');
    await expect(f.open('c', 'c')).rejects.toMatchObject({ code: 'GESTURE_CAPACITY', status: 429 });
    expect(f.createInference).toHaveBeenCalledTimes(2);
    await f.coordinator.close(a.id); await f.open('c', 'c');
    expect(f.createInference).toHaveBeenCalledTimes(3);
  });

  it('bounds replacements while initialization is pending and closes the superseded model', async () => {
    const pending = deferred<GestureInference>(); const firstWorker = new FakeInference();
    const createInference = vi.fn().mockImplementationOnce(() => pending.promise).mockImplementation(async () => new FakeInference());
    const f = fixture({ createInference });
    const first = f.open();
    const rejected = expect(first).rejects.toMatchObject({ code: 'GESTURE_STALE' });
    await vi.waitFor(() => expect(createInference).toHaveBeenCalledTimes(1));
    const second = f.open(); const third = f.open();
    const secondRejected = expect(second).rejects.toMatchObject({ code: 'GESTURE_STALE' });
    expect(createInference).toHaveBeenCalledTimes(1);
    pending.resolve(firstWorker); await rejected; await secondRejected;
    const latest = await third;
    expect(latest.state.needsRelease).toBe(true);
    expect(firstWorker.close).toHaveBeenCalledTimes(1);
    expect(createInference).toHaveBeenCalledTimes(2);
  });

  it('closing all sessions also invalidates pending frames and rejects new work', async () => {
    const f = fixture(); const s = await f.open();
    const pending = deferred<GestureInferenceResult>(); f.workers[0].next = pending.promise;
    const old = s.frame(0); const rejected = expect(old).rejects.toMatchObject({ code: 'GESTURE_STALE' });
    await f.coordinator.closeAll(); pending.resolve(result([hand()])); await rejected;
    await expect(f.open()).rejects.toMatchObject({ code: 'GESTURE_UNAVAILABLE' });
    expect(f.workers[0].close).toHaveBeenCalledTimes(1);
  });

  it('returns event=null for all control snapshots after an action', async () => {
    const f = fixture(); const s = await f.open(); await s.release();
    await s.frame(600); expect((await s.frame(910)).event).toBe('open_palm');
    const values: RemoteGestureSnapshot[] = [s.control(true), s.control(false), s.control(false, true)];
    expect(values.every(value => value.event === null)).toBe(true);
  });

  it('rejects malformed metadata and oversized frames without calling inference', async () => {
    const f = fixture(); const s = await f.open();
    for (const seq of [NaN, Infinity, -1, .5, Number.MAX_SAFE_INTEGER + 1]) {
      await expect(f.coordinator.frame(s.id, { epoch: 0, seq, timestamp: 0, blocked: false },
        Buffer.from('[]'), settings, false)).rejects.toMatchObject({ code: 'GESTURE_INVALID' });
    }
    await expect(f.coordinator.frame(s.id, { epoch: 0, seq: 0, timestamp: 0, blocked: false },
      Buffer.alloc(256 * 1024 + 1), settings, false)).rejects.toMatchObject({ code: 'GESTURE_INVALID' });
    expect(f.workers[0].infer).not.toHaveBeenCalled();
  });
});
