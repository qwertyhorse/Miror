import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ExhibitionMirrorClient, type ExhibitionCommandObservation } from '../src/exhibition/useExhibition';
import type { ExhibitionCommand, ExhibitionState } from '../shared/exhibition';

const clients: ExhibitionMirrorClient[] = [];
function deferred<T>() { let resolve!: (value: T) => void; return { promise: new Promise<T>(done => { resolve = done; }), resolve }; }
async function flush() { for (let index = 0; index < 40; index++) await Promise.resolve(); }
function state(revision = 1, selectedLookId = 'a', generationNumber = revision, phase: ExhibitionState['phase'] = 'generating'): ExhibitionState {
  return { mirrorId: 'east', revision, phase, experienceMode: 'clothx', selectedLookId, displayedLookId: null,
    looks: ['a', 'b', 'c', 'd'].map(id => ({ id, name: id, mode: 'clothx', image: '/fixture.png', source: 'sample', description: '', category: '', palette: '', tags: [] })),
    enabledLookIds: ['a', 'b', 'c', 'd'], categories: [], tags: [], sessionNumber: 1, generationNumber, updatedAt: 1,
    generationReadyAt: null, providerMode: 'xmax', live: null, logs: [],
    settings: { autoReturnSeconds: 0, uploadLimits: { maxFileSizeMB: 10, minWidth: 64, minHeight: 64, maxWidth: 4096, maxHeight: 4096 } } };
}
const response = (value: unknown, status = 200) => Response.json(value, { status });
function create() { const client = new ExhibitionMirrorClient('east'); clients.push(client); client.start(); return client; }
beforeEach(() => vi.useFakeTimers());
afterEach(() => { clients.splice(0).forEach(client => client.stop()); vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('command diagnostics report actual sends and returned state', () => {
  it('reports accepted B even when its boolean is false and sends C against the actual B generation', async () => {
    const first = deferred<Response>(); const second = deferred<Response>();
    const requests: ExhibitionCommand[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method !== 'POST') return response(state());
      requests.push(JSON.parse(init.body as string)); return requests.length === 1 ? first.promise : second.promise;
    }));
    const client = create(); await flush();
    const bTrace: ExhibitionCommandObservation[] = []; const cTrace: ExhibitionCommandObservation[] = [];
    const acceptedBeforeAdopt: string[] = [];
    const b = client.sendDiagnosed({ action: 'switch', lookId: 'b' }, event => {
      bTrace.push(event); if (event.type === 'accepted') acceptedBeforeAdopt.push(client.getSnapshot().state!.selectedLookId!);
    });
    const c = client.sendDiagnosed({ action: 'switch', lookId: 'c' }, event => cTrace.push(event));
    expect(cTrace).toEqual([]);
    first.resolve(response(state(2, 'b', 2))); await flush(); expect(await b).toBe(false);
    expect(bTrace.map(event => event.type)).toEqual(['sent', 'accepted']);
    expect(bTrace[1].state).toMatchObject({ selectedLookId: 'b', generationNumber: 2 });
    expect(acceptedBeforeAdopt).toEqual(['a']);
    expect(cTrace[0]).toMatchObject({ type: 'sent', attempt: 1, command: { lookId: 'c', expectedRevision: 2 },
      state: { selectedLookId: 'b', generationNumber: 2 } });
    second.resolve(response(state(3, 'c', 3))); expect(await c).toBe(true);
    expect(cTrace[1]).toMatchObject({ type: 'accepted', state: { selectedLookId: 'c', generationNumber: 3 } });
    expect(requests.map(command => command.lookId)).toEqual(['b', 'c']);
    expect(cTrace.every(event => Number.isFinite(event.at))).toBe(true);
  });

  it('cancels only the replaced unsent choice with attempt zero', async () => {
    const pending = deferred<Response>(); const requests: ExhibitionCommand[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method !== 'POST') return response(state());
      const command = JSON.parse(init.body as string); requests.push(command);
      return requests.length === 1 ? pending.promise : response(state(3, command.lookId));
    }));
    const client = create(); await flush(); const trace: ExhibitionCommandObservation[] = [];
    const b = client.send({ action: 'switch', lookId: 'b' });
    const c = client.sendDiagnosed({ action: 'switch', lookId: 'c' }, event => trace.push(event));
    const d = client.send({ action: 'switch', lookId: 'd' });
    expect(await c).toBe(false);
    expect(trace).toMatchObject([{ type: 'cancelled', attempt: 0, command: { lookId: 'c' } }]);
    pending.resolve(response(state(2, 'b'))); expect(await b).toBe(false); expect(await d).toBe(true);
    expect(requests.map(command => command.lookId)).toEqual(['b', 'd']);
    expect(trace.some(event => event.type === 'rejected')).toBe(false);
  });

  it('keeps one observer across a 409 retry and reports each actual attempt with its fresh state', async () => {
    let current = state(); let posts = 0;
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method !== 'POST') return response(current);
      if (++posts === 1) { current = state(5, 'a', 4); return response({ code: 'EXHIBITION_STALE_REVISION' }, 409); }
      current = state(6, 'b', 5); return response(current);
    }));
    const client = create(); await flush(); const observer = vi.fn();
    expect(await client.sendDiagnosed({ action: 'switch', lookId: 'b' }, observer)).toBe(true);
    const trace = observer.mock.calls.map(([event]) => event as ExhibitionCommandObservation);
    expect(trace.map(event => event.type)).toEqual(['sent', 'rejected', 'sent', 'accepted']);
    expect(trace.map(event => event.attempt)).toEqual([1, 1, 2, 2]);
    expect(trace[2]).toMatchObject({ command: { expectedRevision: 5 }, state: { revision: 5, generationNumber: 4 } });
    expect(trace[3].state).toMatchObject({ revision: 6, generationNumber: 5, selectedLookId: 'b' });
    expect(posts).toBe(2);
  });

  it('cancels queued and in-flight choices on stop without reporting late accepted or rejected events', async () => {
    const pending = deferred<Response>();
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method !== 'POST') return response(state());
      return JSON.parse(init.body as string).action === 'end' ? response(state(4, 'a', 4, 'select')) : pending.promise;
    }));
    const client = create(); await flush();
    const bTrace: ExhibitionCommandObservation[] = []; const cTrace: ExhibitionCommandObservation[] = [];
    const b = client.sendDiagnosed({ action: 'switch', lookId: 'b' }, event => bTrace.push(event));
    const c = client.sendDiagnosed({ action: 'switch', lookId: 'c' }, event => cTrace.push(event));
    expect(await client.stopExperience()).toBe(true);
    expect(await Promise.all([b, c])).toEqual([false, false]);
    expect(bTrace.map(event => event.type)).toEqual(['sent', 'cancelled']);
    expect(cTrace).toMatchObject([{ type: 'cancelled', attempt: 0 }]);
    pending.resolve(response(state(999, 'b'))); await flush();
    expect(bTrace.map(event => event.type)).toEqual(['sent', 'cancelled']);
    expect(client.getSnapshot().state).toMatchObject({ revision: 4, phase: 'select', selectedLookId: 'a' });
  });

  it.each(['begin', 'resume'] as const)('observes %s through the same mutation path and ignores a response after stop', async action => {
    const pending = deferred<Response>(); const trace: ExhibitionCommandObservation[] = [];
    const requests: ExhibitionCommand[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method !== 'POST') return response(state(1, 'a', 1, 'select'));
      const command = JSON.parse(init.body as string); requests.push(command);
      return command.action === 'end' ? response(state(3, 'a', 3, 'select')) : pending.promise;
    }));
    const client = create(); await flush(); const starting = client.sendDiagnosed({ action }, event => trace.push(event));
    expect(trace[0]).toMatchObject({ type: 'sent', attempt: 1, command: { action, expectedRevision: 1 } });
    await client.stopExperience(); expect(trace.map(event => event.type)).toEqual(['sent', 'cancelled']);
    pending.resolve(response(state(999, 'a'))); expect(await starting).toBe(false);
    expect(trace.map(event => event.type)).toEqual(['sent', 'cancelled']);
    expect(requests.map(command => command.action)).toEqual([action, 'end']);
  });

  it.each(['http', 'exception'] as const)('reports a real %s failure once, without leaking the error message into the observation', async failure => {
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method !== 'POST') return response(state());
      if (failure === 'exception') throw new Error('https://private.fixture?token=private');
      return response({ code: 'INVALID_COMMAND', message: 'https://private.fixture?token=private' }, 400);
    }));
    const client = create(); await flush(); const trace: ExhibitionCommandObservation[] = [];
    expect(await client.sendDiagnosed({ action: 'switch', lookId: 'b' }, event => trace.push(event))).toBe(false);
    expect(trace.map(event => event.type)).toEqual(['sent', 'rejected']);
    expect(JSON.stringify(trace)).not.toContain('token=private');
  });

  it('keeps ordinary and diagnosed sends on the same protocol when the observer is absent or mutates and throws', async () => {
    const requests: ExhibitionCommand[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method !== 'POST') return response(state());
      const command = JSON.parse(init.body as string); requests.push(command); return response(state(2, command.lookId));
    }));
    for (const receive of [undefined, (event: ExhibitionCommandObservation) => {
      event.command.lookId = 'd'; event.state.looks.length = 0; throw new Error('observer-only');
    }]) {
      const client = create(); await flush();
      expect(await client.sendDiagnosed({ action: 'switch', lookId: 'b' }, receive)).toBe(true);
      expect(client.getSnapshot().state?.looks).toHaveLength(4); client.stop();
    }
    const ordinary = create(); await flush(); expect(await ordinary.send({ action: 'switch', lookId: 'b' })).toBe(true);
    expect(new Set(requests.map(command => command.commandId)).size).toBe(3);
    expect(requests.map(({ commandId: _id, ...command }) => command)).toEqual(Array.from({ length: 3 }, () => ({ action: 'switch', lookId: 'b', expectedRevision: 1 })));
  });
});
