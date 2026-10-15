import { afterEach, describe, expect, it, vi } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { request as httpRequest, type OutgoingHttpHeaders } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ExhibitionMirrors } from '../server/exhibitionMirrors.ts';
import { createApiServer } from '../server/http.ts';
import { TryOnService } from '../server/service.ts';
import { SecretBox, SessionStore } from '../server/store.ts';
import { RemoteGestureCoordinator } from '../server/remoteGestures.ts';
import type { GestureInference, GestureInferenceResult } from '../server/gestureInference.ts';
import type { RemoteGestureSnapshot } from '../shared/remoteGestures.ts';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const finish of cleanup.splice(0)) await finish(); });
const origin = 'https://xuxin.local:10202';
const jpeg = Buffer.from([0xff, 0xd8, 0x01, 0xff, 0xd9]);
const palm = [[0, 0], [-.04, -.05], [-.09, -.09], [-.12, -.14], [-.16, -.17],
  [-.06, -.17], [-.065, -.29], [-.07, -.37], [-.075, -.44],
  [0, -.19], [0, -.32], [0, -.41], [0, -.49],
  [.06, -.17], [.065, -.29], [.07, -.37], [.075, -.44],
  [.115, -.13], [.13, -.23], [.14, -.3], [.15, -.36]];
const hand = { handedness: 'Left', landmarks: palm.map(([x, y]) => ({ x: .30 + x * .5, y: .42 + y * .5, z: 0 })) };
const result = (hands: GestureInferenceResult['hands'] = []): GestureInferenceResult => ({ hands, poses: [], width: 480, height: 480, inferenceMs: 10 });
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
class FakeInference implements GestureInference {
  hands: GestureInferenceResult['hands'] = [];
  pending: Promise<GestureInferenceResult> | null = null;
  infer = vi.fn(async () => {
    const pending = this.pending; this.pending = null;
    return pending ? await pending : result(this.hands);
  });
  close = vi.fn(async () => {});
}

async function fixture(factory?: () => Promise<GestureInference>) {
  const directory = mkdtempSync(join(tmpdir(), 'remote-gesture-http-'));
  const store = new SessionStore(':memory:');
  const issue = vi.fn(async () => { throw new Error('This fixture must never allocate a provider session'); });
  const unavailable = async () => { throw new Error('No real provider requests are allowed'); };
  const service = new TryOnService({ store, secrets: new SecretBox(randomBytes(32)), catalog: async () => [],
    provider: { configured: true, issueKey: issue, keyStatus: unavailable, deactivate: unavailable, sessionStatus: unavailable } });
  const mirrors = new ExhibitionMirrors(directory);
  const workers: FakeInference[] = [];
  const createInference = vi.fn(factory ?? (async () => { const worker = new FakeInference(); workers.push(worker); return worker; }));
  const coordinator = new RemoteGestureCoordinator({ createInference, now: () => 0 });
  const server = createApiServer(service, [origin], undefined, mirrors, coordinator);
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const path = (mirrorId = 'default', action = 'open') => `/api/exhibition/mirrors/${mirrorId}/gestures/${action}`;
  const json = (url: string, input: unknown, headers: Record<string, string> = {}) => fetch(base + url, {
    method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(input),
  });
  const bind = (mirrorId = 'default') => {
    const device = { terminalId: `terminal-${randomUUID()}`, token: randomBytes(32).toString('hex'), label: '隔离手势镜端', platform: 'android' as const };
    const paired = mirrors.connectDevice(device); mirrors.bindDevice(mirrorId, { code: paired.code });
    const mirror = mirrors.getMirror(mirrorId);
    // Real publication contract, with Free presets that need no image upload or supplier request.
    for (const look of mirror.get().looks) mirror.updateLook(look.id, {
      mode: 'free', referenceKind: 'none', prompt: 'Isolated gesture HTTP test. No provider session.',
    });
    mirror.command({ action: 'configure', providerMode: 'xmax', experienceMode: 'free', autoReturnSeconds: 0 });
    mirror.publishPublication({});
    const credentials = { terminalId: device.terminalId, terminalToken: device.token };
    return { device, mirrorId, credentials };
  };
  const open = async (bound: ReturnType<typeof bind>) => {
    const response = await json(path(bound.mirrorId), bound.credentials);
    expect(response.status).toBe(200);
    const state = await response.json() as RemoteGestureSnapshot;
    expect(state).toMatchObject({ epoch: 0, blocked: true, needsRelease: true, event: null });
    let epoch = 1, seq = 0;
    const control = await json(path(bound.mirrorId, 'control'), { ...bound.credentials, sessionId: state.sessionId, epoch, blocked: false });
    expect(control.status).toBe(200);
    const headers = (timestamp: number, overrides: Record<string, string> = {}) => ({
      Origin: origin, 'Content-Type': 'image/jpeg', 'X-OpenBuy-Terminal-Id': bound.device.terminalId,
      'X-OpenBuy-Terminal-Token': bound.device.token, 'X-OpenBuy-Gesture-Session': state.sessionId,
      'X-OpenBuy-Gesture-Epoch': String(epoch), 'X-OpenBuy-Gesture-Seq': String(seq++),
      'X-OpenBuy-Gesture-Time': String(timestamp), 'X-OpenBuy-Gesture-Blocked': 'false', ...overrides,
    });
    const frame = (timestamp: number, overrides: Record<string, string> = {}, bytes: Buffer = jpeg) => fetch(base + path(bound.mirrorId, 'frame'), {
      method: 'POST', headers: headers(timestamp, overrides), body: bytes,
    });
    return { ...bound, id: state.sessionId, headers, frame,
      control: (blocked: boolean, reset = false) => json(path(bound.mirrorId, 'control'),
        { ...bound.credentials, sessionId: state.sessionId, epoch: ++epoch, blocked, reset }),
      release: async () => { for (let time = 0; time <= 500; time += 100) expect((await frame(time)).status).toBe(200); },
    };
  };
  const raw = (url: string, headers: OutgoingHttpHeaders) => {
    const response = deferred<{ status: number; body: Record<string, unknown> }>();
    const serverClosed = deferred<void>();
    const observed: Parameters<typeof server.on<'request'>>[1] = (incoming, outgoing) => {
      if (incoming.url !== url) return;
      server.off('request', observed);
      outgoing.once('close', () => serverClosed.resolve());
    };
    server.on('request', observed);
    const request = httpRequest(base + url, { method: 'POST', headers }, incoming => {
      let value = ''; incoming.setEncoding('utf8'); incoming.on('data', chunk => { value += chunk; });
      incoming.on('end', () => {
        try { response.resolve({ status: incoming.statusCode!, body: value ? JSON.parse(value) : {} }); }
        catch (error) { response.reject(error as Error); }
      });
    });
    request.on('error', response.reject);
    // A deliberately disconnected request is still observed, without an unhandled rejection.
    void response.promise.catch(() => {});
    return { request, response: response.promise, async disconnect() {
      const closed = new Promise<void>(resolve => { request.once('close', resolve); });
      request.destroy(); await closed; await serverClosed.promise;
    } };
  };
  cleanup.push(async () => {
    await coordinator.closeAll();
    await mirrors.browserTests.destroy();
    const closed = once(server, 'close'); server.closeAllConnections(); server.close(); await closed;
    expect(issue).not.toHaveBeenCalled(); expect(store.list()).toHaveLength(0);
    store.close(); rmSync(directory, { recursive: true, force: true });
  });
  return { server, base, path, json, bind, open, raw, coordinator, mirrors, workers, createInference, issue };
}

describe('remote gesture authenticated HTTP boundary', () => {
  it('rejects unbound, missing, wrong and foreign-origin credentials before starting a model', async () => {
    const f = await fixture();
    for (const input of [{}, { terminalId: 'unknown', terminalToken: 'unknown' }]) {
      expect((await f.json(f.path(), input)).status).toBe(403);
    }
    const a = f.bind();
    for (const input of [{}, { ...a.credentials, terminalToken: randomBytes(32).toString('hex') },
      { ...a.credentials, terminalId: `terminal-${randomUUID()}` }]) {
      expect((await f.json(f.path(), input)).status).toBe(403);
    }
    expect((await f.json(f.path(), a.credentials, { Origin: 'https://outside.example' })).status).toBe(403);
    expect(f.createInference).not.toHaveBeenCalled();
  });

  it('isolates two authenticated mirrors and rejects cross-device session use on every endpoint', async () => {
    const f = await fixture(); const a = await f.open(f.bind());
    const other = f.mirrors.create({ name: '另一台隔离镜' }).id;
    const b = await f.open(f.bind(other));
    for (const action of ['control', 'close']) {
      const denied = await f.json(f.path(other, action), { ...b.credentials, sessionId: a.id, epoch: 2, blocked: false });
      expect(denied.status).toBe(409); expect(await denied.json()).toMatchObject({ code: 'GESTURE_SESSION_INVALID' });
      expect((await f.json(f.path('default', action), { ...b.credentials, sessionId: a.id, epoch: 2, blocked: false })).status).toBe(403);
    }
    expect((await b.frame(0, { 'X-OpenBuy-Gesture-Session': a.id })).status).toBe(409);
    await Promise.all([a.release(), b.release()]);
    expect(f.workers).toHaveLength(2);
    expect(f.coordinator.session(a.id)?.terminalId).toBe(a.device.terminalId);
    expect(f.coordinator.session(b.id)?.terminalId).toBe(b.device.terminalId);
  });

  it('runs the real detector over binary ingress and emits one current event without issuing a command', async () => {
    const f = await fixture(); const a = await f.open(f.bind()); await a.release();
    const before = f.mirrors.getMirror().get(); f.workers[0].hands = [hand];
    expect((await a.frame(600)).status).toBe(200);
    const confirmed = await a.frame(910);
    expect(confirmed.headers.get('cache-control')).toBe('no-store');
    expect(await confirmed.json()).toMatchObject({ sessionId: a.id, epoch: 1, timestamp: 910, event: 'open_palm', operatorStatus: 'locked', inferenceMs: 10 });
    for (let time = 1010; time <= 2010; time += 100) expect(await (await a.frame(time)).json()).toMatchObject({ event: null });
    expect(f.mirrors.getMirror().get()).toEqual(before);
  });

  it('rejects binary type, JPEG signature, missing headers and malformed frame counters before inference', async () => {
    const f = await fixture(); const a = await f.open(f.bind());
    for (const type of ['application/json', 'image/png', 'text/plain']) {
      expect((await a.frame(0, { 'Content-Type': type })).status).toBe(415);
    }
    expect((await a.frame(0, {}, Buffer.from('not a jpeg'))).status).toBe(400);
    for (const [key, values] of Object.entries({ Epoch: ['-1', 'NaN', '1.2'], Seq: ['-1', '1.2', '9007199254740992'], Time: ['Infinity', ''], Blocked: ['1', ''] })) {
      for (const value of values) expect((await a.frame(0, { [`X-OpenBuy-Gesture-${key}`]: value })).status).toBe(400);
    }
    expect((await a.frame(0, { 'X-OpenBuy-Terminal-Token': '' })).status).toBe(403);
    expect(f.workers[0].infer).not.toHaveBeenCalled();
  });

  it('bounds both declared and streamed payloads and accepts the next valid frame after rejection', async () => {
    const f = await fixture(); const a = await f.open(f.bind());
    const oversized = Buffer.alloc(256 * 1024 + 1); oversized[0] = 0xff; oversized[1] = 0xd8;
    expect((await a.frame(0, {}, oversized)).status).toBe(413);
    const chunked = f.raw(f.path('default', 'frame'), { ...a.headers(0), 'Transfer-Encoding': 'chunked' });
    chunked.request.end(oversized);
    expect((await chunked.response).status).toBe(413);
    expect(f.workers[0].infer).not.toHaveBeenCalled();
    expect((await a.frame(0)).status).toBe(200);
  });

  it('rejects a second upload immediately while preserving independent uploads from the other mirror', async () => {
    const f = await fixture(); const a = await f.open(f.bind());
    const other = f.mirrors.create({ name: '并行隔离镜' }).id; const b = await f.open(f.bind(other));
    const received = deferred<void>();
    f.server.prependOnceListener('request', request => { request.once('data', () => received.resolve()); });
    const slow = f.raw(f.path('default', 'frame'), { ...a.headers(0), 'Transfer-Encoding': 'chunked' });
    slow.request.write(jpeg.subarray(0, 2)); await received.promise;
    const overlapping = await a.frame(100);
    expect(overlapping.status).toBe(429); expect(await overlapping.json()).toMatchObject({ code: 'GESTURE_BUSY' });
    expect((await b.frame(0)).status).toBe(200);
    expect(f.workers[0].infer).not.toHaveBeenCalled();
    slow.request.end(jpeg.subarray(2)); expect((await slow.response).status).toBe(200);
    expect(f.workers[0].infer).toHaveBeenCalledTimes(1);
    expect((await a.frame(200)).status).toBe(200);
  });

  it('also drops overlap while inference is pending and allows control to invalidate that result', async () => {
    const f = await fixture(); const a = await f.open(f.bind()); await a.release();
    const pending = deferred<GestureInferenceResult>(); f.workers[0].pending = pending.promise;
    const old = a.frame(600); await vi.waitFor(() => expect(f.workers[0].infer).toHaveBeenCalledTimes(7));
    expect((await a.frame(700)).status).toBe(429);
    const control = await a.control(true);
    expect(await control.json()).toMatchObject({ event: null, blocked: true, needsRelease: true });
    pending.resolve(result([hand]));
    expect(await (await old).json()).toMatchObject({ code: 'GESTURE_STALE' });
    expect((await a.frame(800, { 'X-OpenBuy-Gesture-Blocked': 'true' })).status).toBe(200);
  });

  it('rechecks binding after a partial upload before any inference starts', async () => {
    const f = await fixture(); const a = await f.open(f.bind());
    const received = deferred<void>();
    f.server.prependOnceListener('request', request => { request.once('data', () => received.resolve()); });
    const slow = f.raw(f.path('default', 'frame'), { ...a.headers(0), 'Transfer-Encoding': 'chunked' });
    slow.request.write(jpeg.subarray(0, 2)); await received.promise;
    f.mirrors.unbindDevice('default', { terminalId: a.device.terminalId });
    slow.request.end(jpeg.subarray(2));
    expect((await slow.response).status).toBe(403); expect(f.workers[0].infer).not.toHaveBeenCalled();
  });

  it('discards a completed inference if its terminal was unbound while the model was running', async () => {
    const f = await fixture(); const a = await f.open(f.bind()); await a.release();
    f.workers[0].hands = [hand]; await a.frame(600);
    const pending = deferred<GestureInferenceResult>(); f.workers[0].pending = pending.promise;
    const old = a.frame(910); await vi.waitFor(() => expect(f.workers[0].infer).toHaveBeenCalledTimes(8));
    f.mirrors.unbindDevice('default', { terminalId: a.device.terminalId });
    pending.resolve(result([hand])); const rejected = await old;
    expect(rejected.status).toBe(409); expect(await rejected.json()).toMatchObject({ code: 'GESTURE_STALE' });
    expect((await a.frame(1010)).status).toBe(403);
  });

  it.each(['selection', 'provider', 'settings', 'publication', 'publication_revision', 'begin'] as const)('invalidates pending events when backend %s changes', async change => {
    const f = await fixture(); const a = await f.open(f.bind()); await a.release();
    f.workers[0].hands = [hand]; await a.frame(600);
    const pending = deferred<GestureInferenceResult>(); f.workers[0].pending = pending.promise;
    const old = a.frame(910); await vi.waitFor(() => expect(f.workers[0].infer).toHaveBeenCalledTimes(8));
    const mirror = f.mirrors.getMirror();
    if (change === 'selection') mirror.command({ action: 'select', lookId: 'city' });
    if (change === 'provider') mirror.command({ action: 'configure', providerMode: 'demo' });
    if (change === 'settings') mirror.command({ action: 'configure', gestureRecognition: { ...mirror.get().settings.gestureRecognition, gestures: [] } });
    if (change === 'publication') mirror.publishPublication({ lookIds: ['commute', 'city'] });
    if (change === 'publication_revision') mirror.publishPublication({});
    if (change === 'begin') mirror.command({ action: 'begin' });
    pending.resolve(result([hand])); const rejected = await old;
    expect(rejected.status).toBe(409); expect(await rejected.json()).toMatchObject({ code: 'GESTURE_STALE' });
  });

  it.each(['UI settings', 'draft enabled looks', 'draft material edits'] as const)('ignores %s during inference when the running publication is unchanged', async change => {
    const f = await fixture(); const a = await f.open(f.bind()); await a.release();
    f.workers[0].hands = [hand]; await a.frame(600);
    const pending = deferred<GestureInferenceResult>(); f.workers[0].pending = pending.promise;
    const old = a.frame(910); await vi.waitFor(() => expect(f.workers[0].infer).toHaveBeenCalledTimes(8));
    const mirror = f.mirrors.getMirror(); const publication = mirror.get().publication;
    if (change === 'UI settings') mirror.command({ action: 'configure', materialDrawerColumns: 1 });
    if (change === 'draft enabled looks') mirror.command({ action: 'configure', enabledLookIds: ['commute'] });
    if (change === 'draft material edits') mirror.updateLook('city', { name: '未发布的草稿名称' });
    expect(mirror.get().publication).toEqual(publication);
    pending.resolve(result([hand]));
    expect(await (await old).json()).toMatchObject({ event: 'open_palm' });
  });

  it('keeps backend generating frames blocked even when Android sends blocked=false', async () => {
    const f = await fixture(); const a = await f.open(f.bind()); await a.release();
    f.mirrors.getMirror().command({ action: 'begin' });
    f.workers[0].hands = [hand];
    for (const time of [600, 910, 1010]) expect(await (await a.frame(time)).json()).toMatchObject({ event: null, blocked: true });
  });

  it('uses published eligible look count instead of the larger draft catalog to allow gestures', async () => {
    const f = await fixture(); const a = await f.open(f.bind()); await a.release();
    const mirror = f.mirrors.getMirror(); mirror.publishPublication({ lookIds: ['commute'] });
    expect(mirror.get().enabledLookIds).toHaveLength(3);
    f.workers[0].hands = [hand];
    for (const time of [600, 910, 1010]) expect(await (await a.frame(time)).json()).toMatchObject({ event: null, blocked: true });
  });

  it('closes a warmed model if the open request disconnected before initialization completed', async () => {
    const ready = deferred<GestureInference>(); const worker = new FakeInference();
    const f = await fixture(() => ready.promise); const bound = f.bind();
    const client = f.raw(f.path(), { Origin: origin, 'Content-Type': 'application/json' });
    client.request.end(JSON.stringify(bound.credentials));
    await vi.waitFor(() => expect(f.createInference).toHaveBeenCalledTimes(1));
    await client.disconnect();
    ready.resolve(worker);
    await vi.waitFor(() => expect(worker.close).toHaveBeenCalledTimes(1));
  });

  it('rechecks binding after initialization and retires the unauthorized model', async () => {
    const ready = deferred<GestureInference>(); const worker = new FakeInference();
    const f = await fixture(() => ready.promise); const bound = f.bind();
    const opening = f.json(f.path(), bound.credentials);
    await vi.waitFor(() => expect(f.createInference).toHaveBeenCalledTimes(1));
    f.mirrors.unbindDevice('default', { terminalId: bound.device.terminalId }); ready.resolve(worker);
    expect((await opening).status).toBe(403); expect(worker.close).toHaveBeenCalledTimes(1);
  });

  it('returns a sanitized startup failure and lets the same bound device retry', async () => {
    const factory = vi.fn().mockRejectedValueOnce(new Error('private runtime filename')).mockResolvedValue(new FakeInference());
    const f = await fixture(factory); const bound = f.bind();
    const failed = await f.json(f.path(), bound.credentials);
    expect(failed.status).toBe(503); expect(await failed.json()).toMatchObject({ code: 'GESTURE_UNAVAILABLE', message: '手势识别未能启动，请重试。' });
    expect((await f.json(f.path(), bound.credentials)).status).toBe(200);
  });

  it('cancels the event on a disconnected frame response and requires observed release afterward', async () => {
    const f = await fixture(); const a = await f.open(f.bind()); await a.release(); f.workers[0].hands = [hand]; await a.frame(600);
    const pending = deferred<GestureInferenceResult>(); f.workers[0].pending = pending.promise;
    const client = f.raw(f.path('default', 'frame'), a.headers(910)); client.request.end(jpeg);
    await vi.waitFor(() => expect(f.workers[0].infer).toHaveBeenCalledTimes(8));
    await client.disconnect(); pending.resolve(result([hand]));
    let response!: Response;
    await vi.waitFor(async () => { response = await a.frame(1010); expect(response.status).toBe(200); });
    expect(await response.json()).toMatchObject({ event: null, needsRelease: true });
  });

  it('releases an interrupted upload slot so the device can send fresh frames', async () => {
    const f = await fixture(); const a = await f.open(f.bind());
    const received = deferred<void>();
    f.server.prependOnceListener('request', request => { request.once('data', () => received.resolve()); });
    const client = f.raw(f.path('default', 'frame'), { ...a.headers(0), 'Transfer-Encoding': 'chunked' });
    client.request.write(jpeg.subarray(0, 2)); await received.promise;
    await client.disconnect();
    await vi.waitFor(async () => expect((await a.frame(100)).status).toBe(200));
    expect(f.workers[0].infer).toHaveBeenCalledTimes(1);
  });

  it('close returns no event and invalidates subsequent frame and control requests', async () => {
    const f = await fixture(); const a = await f.open(f.bind());
    const closed = await f.json(f.path('default', 'close'), { ...a.credentials, sessionId: a.id });
    expect(await closed.json()).toEqual({ closed: true }); expect(f.workers[0].close).toHaveBeenCalledTimes(1);
    expect((await a.frame(0)).status).toBe(409); expect((await a.control(false)).status).toBe(409);
  });
});
