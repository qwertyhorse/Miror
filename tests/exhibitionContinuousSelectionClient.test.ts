import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ExhibitionMirrorClient } from '../src/exhibition/useExhibition';
import type { ExhibitionState } from '../shared/exhibition';

const clients: ExhibitionMirrorClient[] = [];
function deferred<T>() { let resolve!: (value: T) => void; return { promise: new Promise<T>(done => { resolve = done; }), resolve }; }
async function flush() { for (let i = 0; i < 35; i++) await Promise.resolve(); }
function state(revision = 1, selectedLookId = 'a', phase: ExhibitionState['phase'] = 'generating'): ExhibitionState {
  return { mirrorId: 'east', revision, phase, experienceMode: 'clothx', selectedLookId, displayedLookId: null,
    looks: ['a', 'b', 'c', 'd'].map(id => ({ id, name: id, mode: 'clothx', description: '', image: '/fixture.png', source: 'sample', category: '', palette: '', tags: [] })),
    enabledLookIds: ['a', 'b', 'c', 'd'], categories: [], tags: [], sessionNumber: 1, generationNumber: revision,
    updatedAt: 1, generationReadyAt: null, providerMode: 'xmax', live: null, logs: [],
    settings: { autoReturnSeconds: 0, uploadLimits: { maxFileSizeMB: 10, minWidth: 64, minHeight: 64, maxWidth: 4096, maxHeight: 4096 } } };
}
function create() { const client = new ExhibitionMirrorClient('east'); clients.push(client); client.start(); return client; }
const response = (value: unknown, status = 200) => Response.json(value, { status });
beforeEach(() => vi.useFakeTimers());
afterEach(() => { clients.splice(0).forEach(client => client.stop()); vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('continuous material selection', () => {
  it('sends only the latest unsent choice, using the confirmed revision while keeping selection pending', async () => {
    const first = deferred<Response>(); const last = deferred<Response>();
    const requests: any[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method !== 'POST') return response(state());
      requests.push(JSON.parse(init.body as string));
      return requests.length === 1 ? first.promise : last.promise;
    }));
    const client = create(); await flush();
    const b = client.send({ action: 'switch', lookId: 'b' });
    const c = client.send({ action: 'switch', lookId: 'c' });
    const d = client.send({ action: 'switch', lookId: 'd' });
    expect(await c).toBe(false);
    expect(requests.map(x => x.lookId)).toEqual(['b']);
    expect(client.getSnapshot()).toMatchObject({ pending: true, selectionPending: true });
    first.resolve(response(state(2, 'b'))); await flush();
    expect(await b).toBe(false);
    expect(requests.map(x => x.lookId)).toEqual(['b', 'd']);
    expect(requests[1].expectedRevision).toBe(2);
    expect(client.getSnapshot().selectionPending).toBe(true);
    last.resolve(response(state(3, 'd'))); expect(await d).toBe(true); await flush();
    expect(client.getSnapshot()).toMatchObject({ pending: false, selectionPending: false, state: { selectedLookId: 'd' } });
  });

  it('lets stop discard queued selections and prevents a late response from restoring generation', async () => {
    const first = deferred<Response>(); const requests: any[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method !== 'POST') return response(state());
      const input = JSON.parse(init.body as string); requests.push(input);
      return input.action === 'end' ? response(state(4, 'a', 'select')) : first.promise;
    }));
    const client = create(); await flush();
    const b = client.send({ action: 'switch', lookId: 'b' });
    const c = client.send({ action: 'switch', lookId: 'c' });
    expect(await client.stopExperience()).toBe(true);
    expect(await Promise.all([b, c])).toEqual([false, false]);
    first.resolve(response(state(999, 'b'))); await flush();
    expect(requests.map(x => x.action)).toEqual(['switch', 'end']);
    expect(client.getSnapshot()).toMatchObject({ pending: false, selectionPending: false, state: { phase: 'select', selectedLookId: 'a', revision: 4 } });
  });

  it('retries a fresh revision conflict once and never retries a superseded choice', async () => {
    let current = state(); let posts = 0;
    const requests: any[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method !== 'POST') return response(current);
      requests.push(JSON.parse(init.body as string)); posts++;
      if (posts === 1) { current = state(2); return response({ code: 'EXHIBITION_STALE_REVISION' }, 409); }
      current = state(3, 'c'); return response(current);
    }));
    const client = create(); await flush();
    const b = client.send({ action: 'switch', lookId: 'b' });
    const c = client.send({ action: 'switch', lookId: 'c' });
    expect(await b).toBe(false); expect(await c).toBe(true);
    expect(requests.map(x => x.lookId)).toEqual(['b', 'c']);
    expect(requests[1].expectedRevision).toBe(2);
  });

  it('does not overlap selection with another mutation or accept it during a stop', async () => {
    const pending = deferred<Response>();
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => init?.method === 'POST' ? pending.promise : response(state(1, 'a', 'select'))));
    const client = create(); await flush();
    const begin = client.send({ action: 'begin' });
    expect(await client.send({ action: 'select', lookId: 'b' })).toBe(false);
    pending.resolve(response(state(2))); await begin;
    const stop = client.stopExperience();
    expect(await client.send({ action: 'switch', lookId: 'c' })).toBe(false);
    await stop;
  });
});
