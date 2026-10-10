import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ExhibitionMirrorClient } from '../src/exhibition/useExhibition';
import type { ExhibitionState } from '../shared/exhibition';

const clients: ExhibitionMirrorClient[] = [];
const deferred = <T>() => { let resolve!: (value: T) => void; return { promise: new Promise<T>(done => { resolve = done; }), resolve }; };
async function flush() { for (let i = 0; i < 35; i++) await Promise.resolve(); }
beforeEach(() => vi.useFakeTimers());
afterEach(() => { for (const client of clients.splice(0)) client.stop(); vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); });
function state(revision = 1, phase: ExhibitionState['phase'] = 'select', live: ExhibitionState['live'] = null): ExhibitionState {
  return { mirrorId: 'east', revision, phase, experienceMode: 'clothx', selectedLookId: 'commute', displayedLookId: null,
    looks: [{ id: 'commute', name: '隔离停止素材', mode: 'clothx', description: '', image: '/fixture.png', source: 'sample', category: '', palette: '', tags: [] }], enabledLookIds: ['commute'], categories: [], tags: [],
    sessionNumber: 1, generationNumber: 1, updatedAt: 1, generationReadyAt: null, autoSwitchAt: null, providerMode: 'xmax', live, logs: [],
    settings: { autoReturnSeconds: 0, uploadLimits: { maxFileSizeMB: 10, minWidth: 64, minHeight: 64, maxWidth: 4096, maxHeight: 4096 } } };
}
function create() { const client = new ExhibitionMirrorClient('east'); clients.push(client); client.start(); return client; }
const response = (value: unknown, status = 200) => Response.json(value, { status });

describe('priority manual stop requests', () => {
  it('confirms a local end while preserving an explicitly unconfirmed cloud lease', async () => {
    const live = { sessionId: 'unknown-fixture', deviceId: 'screen-fixture', status: 'error', generationNumber: 1, lookId: 'commute', heartbeatAt: 1, updatedAt: 1,
      error: '本地体验已结束，云端凭证状态待确认。', localEnded: true } as ExhibitionState['live'];
    const fetcher = vi.fn(async (_url: string, init?: RequestInit) => response(init?.method === 'POST' ? state(2, 'select', live) : state(1, 'paused', { ...live!, localEnded: undefined })));
    vi.stubGlobal('fetch', fetcher); const client = create(); await flush();
    expect(await client.stopExperience()).toBe(true);
    expect(client.getSnapshot()).toMatchObject({ stopPending: false, error: '', state: { phase: 'select', live: { sessionId: 'unknown-fixture', localEnded: true } } });
    expect(fetcher.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
  });

  it.each(['active', 'paused'] as const)('does not interpret an invalid local-ended marker as confirmation: %s', async invalid => {
    const live = { sessionId: 'unconfirmed-fixture', deviceId: 'screen-fixture', status: invalid === 'active' ? 'running' : 'error', generationNumber: 1, lookId: 'commute', heartbeatAt: 1, updatedAt: 1, localEnded: true } as ExhibitionState['live'];
    vi.stubGlobal('fetch', vi.fn(async () => response(state(2, invalid === 'paused' ? 'paused' : 'select', live))));
    const client = create(); await flush();
    expect(await client.stopExperience()).toBe(false);
    expect(client.getSnapshot().error).toBe('停止状态未确认，请联系工作人员。');
  });

  it('clears only the stop error after a fresh poll confirms another page ended locally', async () => {
    const live = { sessionId: 'unknown-fixture', deviceId: 'screen-fixture', status: 'error', generationNumber: 1, lookId: 'commute', heartbeatAt: 1, updatedAt: 1 } as ExhibitionState['live'];
    let current = state(3, 'paused', live);
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => init?.method === 'POST' ? response({ message: 'fixture failed' }, 409) : response(current)));
    const client = create(); await flush();
    expect(await client.stopExperience()).toBe(false); await flush();
    expect(client.getSnapshot().error).toBe('停止状态未确认，请联系工作人员。');
    current = state(2, 'select', { ...live!, localEnded: true });
    await client.refresh();
    expect(client.getSnapshot()).toMatchObject({ error: '停止状态未确认，请联系工作人员。', state: { revision: 3, phase: 'paused' } });
    current = state(4, 'select', { ...live!, localEnded: true });
    await client.refresh();
    expect(client.getSnapshot()).toMatchObject({ error: '', state: { revision: 4, phase: 'select', live: { localEnded: true } } });
  });

  it('preserves unrelated command errors when a poll confirms the local experience ended', async () => {
    let current = state();
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => init?.method === 'POST' ? response({ message: '素材未保存' }, 409) : response(current)));
    const client = create(); await flush();
    expect(await client.send({ action: 'begin' })).toBe(false);
    current = state(2, 'select', { sessionId: 'unknown-fixture', deviceId: 'screen-fixture', status: 'error', generationNumber: 1, lookId: 'commute', heartbeatAt: 1, updatedAt: 1, localEnded: true });
    await client.refresh();
    expect(client.getSnapshot().error).toBe('素材未保存');
  });

  it('aborts a pending begin, prioritizes stopping, and ignores the late begin response', async () => {
    const begin = deferred<Response>(); const stop = deferred<Response>();
    const fetcher = vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method !== 'POST') return response(state());
      const body = JSON.parse(init.body as string);
      return body.action === 'begin' ? begin.promise : stop.promise;
    });
    vi.stubGlobal('fetch', fetcher); const client = create(); await flush();
    const starting = client.send({ action: 'begin' }); await flush();
    const beginSignal = fetcher.mock.calls.find(([, init]) => init?.method === 'POST')![1]!.signal!;
    const stopping = client.stopExperience(); await flush();
    expect(beginSignal.aborted).toBe(true); expect(client.getSnapshot().stopPending).toBe(true);
    const commands = fetcher.mock.calls.filter(([, init]) => init?.method === 'POST');
    expect(commands.map(([, init]) => JSON.parse(init!.body as string).action)).toEqual(['begin', 'end']);
    expect(JSON.parse(commands[1][1]!.body as string)).toEqual({ action: 'end' });
    expect(await client.send({ action: 'begin' })).toBe(false);
    begin.resolve(response(state(999, 'generating'))); expect(await starting).toBe(false);
    stop.resolve(response(state(3))); expect(await stopping).toBe(true);
    expect(client.getSnapshot()).toMatchObject({ state: { revision: 3, phase: 'select' }, stopPending: false });
  });

  it('deduplicates repeated end or return-home actions while stop confirmation is pending', async () => {
    const pending = deferred<Response>();
    const fetcher = vi.fn(async (_url: string, init?: RequestInit) => init?.method === 'POST' ? pending.promise : response(state()));
    vi.stubGlobal('fetch', fetcher); const client = create(); await flush();
    const first = client.stopExperience(); const duplicate = client.send({ action: 'end' }); const home = client.send({ action: 'idle' }); await flush();
    expect(fetcher.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
    pending.resolve(response(state(2)));
    expect(await Promise.all([first, duplicate, home])).toEqual([true, true, true]);
  });

  it('can attempt stopping after the status poll disconnects without first requiring a mirror response', async () => {
    let online = true;
    const fetcher = vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === 'POST') return response(state(2));
      if (!online) throw new Error('isolated status interruption');
      return response(state());
    });
    vi.stubGlobal('fetch', fetcher); const client = create(); await flush();
    online = false; await client.refresh(); expect(client.getSnapshot().connected).toBe(false);
    expect(await client.stopExperience()).toBe(true);
    expect(fetcher.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
    expect(client.getSnapshot()).toMatchObject({ state: { phase: 'select', revision: 2 }, stopPending: false });
  });

  it('keeps an unconfirmed lease retryable and confirms only a released session', async () => {
    const pendingLive = { sessionId: 'isolated-stopping-session', deviceId: 'screen-isolated', status: 'error', generationNumber: 1, lookId: 'commute', heartbeatAt: 1, updatedAt: 1 } as ExhibitionState['live'];
    let postCount = 0;
    const fetcher = vi.fn(async (_url: string, init?: RequestInit) => init?.method === 'POST' ? response(++postCount === 1 ? state(2, 'select', pendingLive) : state(3)) : response(state(2, 'select', pendingLive)));
    vi.stubGlobal('fetch', fetcher); const client = create(); await flush();
    expect(await client.stopExperience()).toBe(false);
    expect(client.getSnapshot()).toMatchObject({ stopPending: false, error: expect.stringContaining('停止'), state: { live: { sessionId: 'isolated-stopping-session' } } });
    expect(client.getSnapshot().error).toBe('停止状态未确认，请联系工作人员。');
    expect(await client.stopExperience()).toBe(true); expect(postCount).toBe(2);
    expect(client.getSnapshot().state?.live).toBeNull();
  });
});
