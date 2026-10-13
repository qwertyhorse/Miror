import { act, createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ExhibitionLiveConnection, useExhibitionLive, type ExhibitionLiveDeps } from '../src/exhibition/useExhibitionLive';
import type { DiagnosticEventInput } from '../src/exhibition/diagnostics';
import { createExhibitionDiagnostics } from '../src/exhibition/diagnostics';
import { exhibitionPromptForLook, type ExhibitionState } from '../shared/exhibition';
import { createReactHost, flushReact } from './support/reactHost';

const apiMock = vi.hoisted(() => vi.fn(async () => ({ configured: true })));
vi.mock('../src/api', () => ({ api: apiMock, backend: {} }));

type Input = Parameters<ExhibitionLiveDeps['create']>[0];
const connections: ExhibitionLiveConnection[] = [];
let host: Awaited<ReturnType<typeof createReactHost>> | undefined;
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; }
async function flush() { for (let index = 0; index < 40; index++) await Promise.resolve(); }
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(10_000); });
afterEach(async () => {
  await host?.close(); host = undefined;
  for (const connection of connections.splice(0)) await connection.stop();
  vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); apiMock.mockClear();
});

function fixture(diagnostic?: (event: DiagnosticEventInput) => void, prefetchImages?: string[]) {
  const originalStop = vi.fn(); const cloneStop = vi.fn();
  const stream = { getVideoTracks: () => [{ readyState: 'live', stop: originalStop }] } as unknown as MediaStream;
  const clone = { getVideoTracks: () => [{ readyState: 'live' }], getTracks: () => [{ stop: cloneStop, onended: null }] } as unknown as MediaStream;
  const output = { id: 'remote-fixture' } as MediaStream;
  const first: Input = { mirrorId: 'default', deviceId: 'screen-a', sessionNumber: 1, generationNumber: 1,
    lookId: 'first', expectedRevision: 1, image: '/assets/first.png', stream, mode: 'clothx', prefetchImages };
  let record = { id: 'local-session', token: 'secret-fixture-token', model: 'x2.0', status: 'active', sourceKind: 'camera' as const,
    referenceAsset: first.image, refImageUrl: '', referenceVersion: 0, providerSessionId: undefined as string | undefined,
    expiresAt: new Date(Date.now() + 120_000).toISOString(), exhibition: { mirrorId: 'default', deviceId: first.deviceId,
      sessionNumber: 1, generationNumber: 1, lookId: 'first', mode: 'clothx' as const, prompt: exhibitionPromptForLook({ mode: 'clothx' }) } };
  let callbacks!: Parameters<ExhibitionLiveDeps['connect']>[2];
  let clock = 100;
  const sdk = { getSessionUid: vi.fn(() => 'provider-fixture'), set: vi.fn(async (_context: { prompt: string; refImageUrl?: string | null }) => {}),
    disconnect: vi.fn(async () => {}), stopGeneration: vi.fn(async () => {}), stopLocalStream: vi.fn(async () => {}) };
  const condition = async (_id: string, intent: Parameters<NonNullable<ExhibitionLiveDeps['updateCondition']>>[1]) => {
    if (record.exhibition.generationNumber !== intent.generationNumber) record = { ...record, referenceAsset: `/assets/${intent.lookId}.png`,
      refImageUrl: intent.refImageUrl!, referenceVersion: record.referenceVersion + 1,
      exhibition: { ...record.exhibition, lookId: intent.lookId, generationNumber: intent.generationNumber } };
    return { ...record, exhibition: { ...record.exhibition } };
  };
  const deps = {
    create: vi.fn(async () => ({ ...record })), reference: vi.fn(async (input: Input) => new File(['reference'], input.image.split('/').pop()!, { type: 'image/png' })),
    upload: vi.fn(async (file: File) => `https://upload.fixture/${file.name}?credential=private-fixture`), prepare: vi.fn(async () => {}),
    bind: vi.fn(async (_id, input) => { record = { ...record, refImageUrl: input.refImageUrl, referenceVersion: 1 }; return { ...record }; }),
    updateCondition: vi.fn(condition), conditionApplied: vi.fn(async () => ({})),
    connect: vi.fn(async (_source, _local, value) => { callbacks = value; return sdk; }),
    link: vi.fn(async (_id, providerSessionId) => { record = { ...record, providerSessionId }; return { ...record }; }),
    firstFrame: vi.fn(async () => ({ ...record })), stop: vi.fn(async () => ({ ...record, status: 'stopped' })),
    heartbeat: vi.fn(async () => ({})), reportError: vi.fn(async () => ({})), clone: vi.fn(() => clone), now: vi.fn(() => clock),
  } satisfies ExhibitionLiveDeps;
  const events = { status: vi.fn(), stream: vi.fn(), refresh: vi.fn(), updateError: vi.fn(), diagnostic };
  const controller = new ExhibitionLiveConnection(first, events, deps); connections.push(controller);
  const next = (lookId: string, generationNumber = 2): Input => ({ ...first, lookId, generationNumber, image: `/assets/${lookId}.png` });
  const ready = async () => {
    await controller.start(); callbacks.onRemoteStream(output); controller.reportRenderedFrame(output); await flush();
  };
  return { controller, deps, events, sdk, first, next, ready, output,
    advance: (now: number) => { clock = now; }, callbacks: () => callbacks };
}

describe('exhibition live diagnostics preserve evidence boundaries', () => {
  it('records one initial session frame and separate versioned condition-submission milestones without private data', async () => {
    const trace: DiagnosticEventInput[] = [];
    const f = fixture(event => trace.push(event)); await f.ready();
    const initial = trace[0].operationId;
    expect(trace.map(event => event.type)).toEqual(['reference_started', 'reference_ready', 'upload_started', 'upload_ready',
      'bind_started', 'bind_ready', 'sdk_set_started', 'sdk_set_resolved', 'session_first_frame']);
    f.advance(700); expect(await f.controller.update(f.next('second'))).toBe(true);
    f.controller.reportRenderedFrame(f.output); f.callbacks().onRemoteVideoFirstFrame(); await flush();
    expect(trace.filter(event => event.type === 'session_first_frame')).toHaveLength(1);
    expect(trace.find(event => event.type === 'session_first_frame')?.operationId).toBe(initial);
    const submitted = trace.find(event => event.type === 'condition_committed')!;
    expect(submitted.operationId).not.toBe(initial);
    expect(submitted).toMatchObject({ at: 700, context: { mirrorId: 'default', sessionNumber: 1, generationNumber: 2,
      lookId: 'second', sessionId: 'local-session', referenceVersion: 2 } });
    expect(trace.find(event => event.type === 'sdk_set_resolved' && event.operationId === submitted.operationId)?.context).toEqual(submitted.context);
    expect(trace.some(event => /visual|garment.*visible/.test(event.type))).toBe(false);
    expect(JSON.stringify(trace)).not.toMatch(/secret-fixture-token|credential=|https:|prompt|refImageUrl|referenceAsset/);
  });

  it('retains captured contexts when an older set resolves after a newer update request', async () => {
    const trace: DiagnosticEventInput[] = []; const f = fixture(event => trace.push(event)); await f.ready();
    const waiting = deferred<void>(); f.sdk.set.mockImplementationOnce(() => waiting.promise);
    const secondInput = f.next('second'); const second = f.controller.update(secondInput); await flush();
    const secondStarted = trace.find(event => event.type === 'sdk_set_started' && event.context.lookId === 'second')!;
    const third = f.controller.update(f.next('third', 3)); secondInput.lookId = 'mutated-outside'; f.advance(900); waiting.resolve();
    expect(await second).toBe(false); expect(await third).toBe(true);
    const secondResolved = trace.find(event => event.type === 'sdk_set_resolved' && event.operationId === secondStarted.operationId)!;
    expect(secondResolved.context).toEqual(secondStarted.context);
    expect(secondResolved.context).toMatchObject({ lookId: 'second', generationNumber: 2, referenceVersion: 2 });
    expect(trace.filter(event => event.type === 'condition_committed').map(event => event.context.lookId)).toEqual(['third']);
    expect(trace.find(event => event.type === 'condition_committed')?.context).toMatchObject({ generationNumber: 3, referenceVersion: 3 });
    expect(trace.some(event => event.context.lookId === 'mutated-outside')).toBe(false);
  });

  it('keeps the first session frame and delayed initial set associated with the initial operation', async () => {
    const trace: DiagnosticEventInput[] = []; const f = fixture(event => trace.push(event));
    const waiting = deferred<void>(); f.sdk.set.mockImplementationOnce(() => waiting.promise);
    const starting = f.controller.start(); await flush();
    f.callbacks().onRemoteStream(f.output); f.controller.reportRenderedFrame(f.output); await flush();
    const firstFrame = trace.find(event => event.type === 'session_first_frame')!;
    const updating = f.controller.update(f.next('second')); await flush();
    waiting.resolve(); await starting; expect(await updating).toBe(true);
    expect(trace.find(event => event.type === 'sdk_set_resolved' && event.operationId === firstFrame.operationId)?.context).toEqual(firstFrame.context);
    expect(firstFrame.context).toMatchObject({ lookId: 'first', generationNumber: 1, referenceVersion: 1 });
    expect(trace.filter(event => event.type === 'session_first_frame')).toHaveLength(1);
  });

  it('enables manual observation only after the actual versioned SDK submission and local commit are recorded', async () => {
    const store = createExhibitionDiagnostics({ now: () => 100 });
    const context = { mirrorId: 'default', sessionNumber: 1, generationNumber: 1, lookId: 'first' };
    store.observe(context, { active: true });
    const f = fixture(event => { store.record(event); }); await f.ready();
    expect(store.getSnapshot().canMarkVisible).toBe(true);
    store.observe({ ...context, generationNumber: 2, lookId: 'second' }, { active: true });
    const waiting = deferred<void>(); f.sdk.set.mockImplementationOnce(() => waiting.promise);
    const updating = f.controller.update(f.next('second')); await flush();
    expect(store.getSnapshot().canMarkVisible).toBe(false);
    waiting.resolve(); expect(await updating).toBe(true);
    expect(store.getSnapshot().canMarkVisible).toBe(true);
    expect(store.getSnapshot().events.some(event => event.type === 'manual_visible')).toBe(false);
    await f.controller.stop(); expect(store.getSnapshot().canMarkVisible).toBe(false);
  });

  it.each(['upload', 'set'] as const)('invalidates diagnostics immediately on stop while %s is unresolved', async stage => {
    const trace: DiagnosticEventInput[] = []; const f = fixture(event => trace.push(event)); await f.ready();
    const upload = deferred<string>(); const set = deferred<void>();
    if (stage === 'upload') f.deps.upload.mockImplementationOnce(() => upload.promise);
    else f.sdk.set.mockImplementationOnce(() => set.promise);
    const updating = f.controller.update(f.next('second')); await flush();
    const stopping = f.controller.stop();
    expect(trace.at(-1)).toMatchObject({ type: 'stopped', reason: 'stopped', context: { lookId: 'second', generationNumber: 2 } });
    const lengthAtStop = trace.length;
    upload.resolve('https://late.fixture/private'); set.resolve(); await stopping; expect(await updating).toBe(false);
    f.callbacks().onRemoteVideoFirstFrame(); f.controller.reportRenderedFrame(f.output); await f.controller.stop();
    expect(trace).toHaveLength(lengthAtStop);
    expect(f.deps.conditionApplied).not.toHaveBeenCalled();
  });

  it('does not attribute neighbour prewarming or its cached upload to a foreground update', async () => {
    const trace: DiagnosticEventInput[] = []; const f = fixture(event => trace.push(event), ['/assets/second.png']);
    await f.ready(); await flush();
    expect(f.deps.upload).toHaveBeenCalledTimes(2);
    expect(trace.filter(event => event.type === 'upload_started')).toHaveLength(1);
    const before = trace.length; expect(await f.controller.update(f.next('second'))).toBe(true);
    expect(trace.slice(before).map(event => event.type)).toEqual(['bind_started', 'bind_ready', 'sdk_set_started', 'sdk_set_resolved', 'condition_committed']);
    expect(f.deps.upload).toHaveBeenCalledTimes(2);
  });

  it('records sanitized failure reasons and permits a new retry operation', async () => {
    const trace: DiagnosticEventInput[] = []; const f = fixture(event => trace.push(event)); await f.ready();
    f.sdk.set.mockRejectedValueOnce(new Error('https://private.fixture?token=secret-error'));
    expect(await f.controller.update(f.next('second'))).toBe(false);
    const failed = trace.find(event => event.type === 'failed')!;
    expect(failed).toMatchObject({ reason: 'update_error', context: { lookId: 'second', generationNumber: 2, referenceVersion: 2 } });
    expect(JSON.stringify(trace)).not.toContain('secret-error');
    expect(await f.controller.retryUpdate()).toBe(true);
    expect(trace.find(event => event.type === 'condition_committed')?.operationId).not.toBe(failed.operationId);
  });

  it('does not change session, upload or condition calls when diagnostics are absent or throw', async () => {
    for (const receive of [undefined, () => { throw new Error('diagnostic-only'); }]) {
      const f = fixture(receive); await f.ready(); expect(await f.controller.update(f.next('second'))).toBe(true);
      expect(f.deps.create).toHaveBeenCalledOnce(); expect(f.deps.connect).toHaveBeenCalledOnce();
      expect(f.deps.upload).toHaveBeenCalledTimes(2); expect(f.sdk.set).toHaveBeenCalledTimes(2);
      expect(f.deps.updateCondition).toHaveBeenCalledOnce(); expect(f.deps.conditionApplied).toHaveBeenCalledOnce();
      expect(f.deps.firstFrame).toHaveBeenCalledOnce(); expect(f.deps.reportError).not.toHaveBeenCalled();
      expect(await f.controller.stop()).toBe(true);
    }
  });

  it('forwards a changed optional hook callback through a ref without rebuilding its connection', async () => {
    host = await createReactHost(); vi.stubGlobal('localStorage', { getItem: () => null });
    const camera = { getVideoTracks: () => [track], getTracks: () => [track] } as unknown as MediaStream;
    const track = { readyState: 'live', onended: null, stop: vi.fn(), getSettings: () => ({ deviceId: 'camera-fixture' }) };
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: vi.fn(async () => camera), enumerateDevices: async () => [] } });
    let events!: { diagnostic?: (event: DiagnosticEventInput) => void };
    const start = vi.spyOn(ExhibitionLiveConnection.prototype, 'start').mockImplementation(function (this: ExhibitionLiveConnection) {
      events = (this as unknown as { events: typeof events }).events; return Promise.resolve();
    });
    const state: ExhibitionState = { mirrorId: 'default', revision: 1, phase: 'generating', experienceMode: 'clothx', selectedLookId: 'first', displayedLookId: null,
      looks: [{ id: 'first', name: 'first', image: '/assets/first.png', mode: 'clothx', source: 'sample', description: '', category: '', tags: [], palette: '' }],
      enabledLookIds: ['first'], categories: [], tags: [], sessionNumber: 1, generationNumber: 1, updatedAt: 1, generationReadyAt: null,
      providerMode: 'xmax', live: null, logs: [], settings: { autoReturnSeconds: 90, uploadLimits: { maxFileSizeMB: 10, minWidth: 64, minHeight: 64, maxWidth: 4096, maxHeight: 4096 } } };
    const first = vi.fn(); const second = vi.fn(); let callback: ((event: DiagnosticEventInput) => void) | undefined = first;
    function Harness() { useExhibitionLive({ state, active: true, refresh: () => {}, onDiagnostic: callback }); return null; }
    await host.render(createElement(Harness)); await flushReact(); expect(start).toHaveBeenCalledOnce();
    const event: DiagnosticEventInput = { type: 'sdk_set_started', at: 100, operationId: 'fixture:start',
      context: { mirrorId: 'default', sessionNumber: 1, generationNumber: 1, lookId: 'first' } };
    await act(async () => events.diagnostic?.(event)); expect(first).toHaveBeenCalledExactlyOnceWith(event);
    callback = second; await host.render(createElement(Harness)); await flushReact();
    await act(async () => events.diagnostic?.(event)); expect(second).toHaveBeenCalledExactlyOnceWith(event);
    callback = undefined; await host.render(createElement(Harness)); await flushReact();
    expect(events.diagnostic).toBeUndefined(); expect(start).toHaveBeenCalledOnce();
  });
});
