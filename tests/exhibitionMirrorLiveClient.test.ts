import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ExhibitionLiveConnection, type ExhibitionLiveDeps } from '../src/exhibition/useExhibitionLive';
import type { CreatedSession } from '../src/api';
import type { SdkSession } from '../src/liveTryOn';

const connections: ExhibitionLiveConnection[] = [];
const sessionId = '11111111-1111-4111-8111-111111111111';
type LocalSession = CreatedSession & { exhibition: { mirrorId?: string; deviceId: string; lookId: string; sessionNumber: number; generationNumber: number } };
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; }
async function flush() { for (let index = 0; index < 30; index++) await Promise.resolve(); }
function local(mirrorId: string): LocalSession {
  return { id: sessionId, token: 'temporary-fixture-token', model: 'x2.0', status: 'active', sourceId: 'camera-fixture', sourceKind: 'camera',
    sourceName: '展会摄像头', targetItemId: 'exhibition-commute', referenceAsset: '/assets/exhibition/commute-cutout.png',
    expiresAt: new Date(Date.now() + 120000).toISOString(), pointsLimit: 30, consumedCredits: 0, refImageUrl: '', referenceVersion: 0,
    resultAvailable: false, verification: 'none', exhibition: { mirrorId, deviceId: 'screen-fixture', lookId: 'commute', sessionNumber: 1, generationNumber: 1 } };
}
function fixture(mirrorId = 'default', terminal?: { terminalId: string; token: string }) {
  const track = { readyState: 'live', stop: vi.fn(), onended: null };
  const stream = { getVideoTracks: () => [track], getTracks: () => [track] } as unknown as MediaStream;
  const sdk: SdkSession = { getSessionUid: vi.fn(() => 'provider-fixture'), set: vi.fn(async () => {}), disconnect: vi.fn(async () => {}),
    stopGeneration: vi.fn(async () => {}), stopLocalStream: vi.fn(async () => {}) };
  const deps = { reference: vi.fn(async () => new File(['garment'], 'garment.png', { type: 'image/png' })),
    prepare: vi.fn(async () => {}), upload: vi.fn(async () => 'https://reference.example/garment.png'),
    connect: vi.fn(async () => sdk), clone: vi.fn(() => stream), now: () => 1000 } satisfies Partial<ExhibitionLiveDeps>;
  const events = { status: vi.fn(), stream: vi.fn(), refresh: vi.fn() };
  const connection = new ExhibitionLiveConnection({ mirrorId, terminalId: terminal?.terminalId, terminalToken: terminal?.token, deviceId: 'screen-fixture', lookId: 'commute', sessionNumber: 1,
    generationNumber: 1, expectedRevision: 3, image: local(mirrorId).referenceAsset!, stream }, events, deps);
  connections.push(connection);
  return { connection, deps, sdk, events };
}
function respond(url: string, init?: RequestInit) {
  const mirrorId = /\/mirrors\/([^/]+)/.exec(url)?.[1] ?? 'unexpected';
  const created = local(mirrorId);
  const input = init?.body ? JSON.parse(init.body as string) : {};
  if (url.endsWith('/reference')) return Response.json({ ...created, refImageUrl: input.refImageUrl, referenceVersion: 1 });
  if (url.endsWith('/link')) return Response.json({ ...created, providerSessionId: input.providerSessionId, referenceVersion: 1 });
  if (url.endsWith('/stop')) return Response.json({ ...created, status: 'stopped' });
  return Response.json(created);
}
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(10000); });
afterEach(async () => {
  for (const connection of connections.splice(0)) await connection.stop();
  vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals();
});

describe('mirror-bound live connection transport', () => {
  it('includes binding credentials only in session creation and keeps the browser lease identity independent', async () => {
    const terminal = { terminalId: 'terminal-fixture', token: 'fixture-terminal-credential' };
    const fetcher = vi.fn(async (url: string, init?: RequestInit) => respond(url, init));
    vi.stubGlobal('fetch', fetcher);
    const east = fixture('east', terminal); await east.connection.start();
    const [, create] = fetcher.mock.calls.find(([url]) => url.endsWith('/live/session'))!;
    expect(JSON.parse(create!.body as string)).toMatchObject({ terminalId: terminal.terminalId, terminalToken: terminal.token, deviceId: 'screen-fixture' });
    expect(east.connection.key).not.toContain(terminal.terminalId);
    expect(east.connection.key).not.toContain(terminal.token);
    for (const [url, init] of fetcher.mock.calls) {
      if (url.endsWith('/live/session')) continue;
      const input = JSON.parse(init?.body as string);
      expect(input).not.toHaveProperty('terminalToken');
    }
    expect(east.sdk.set).toHaveBeenCalledTimes(1);
  });

  it('keeps simultaneous identical generations separate through reference, link, frame, heartbeat and stop', async () => {
    const fetcher = vi.fn(async (url: string, init?: RequestInit) => respond(url, init));
    vi.stubGlobal('fetch', fetcher);
    const east = fixture('east'); const west = fixture('west');
    expect(east.connection.key).not.toBe(west.connection.key);
    await Promise.all([east.connection.start(), west.connection.start()]);
    east.connection.reportFirstFrame(); west.connection.reportFirstFrame(); await flush();
    await east.connection.stop();
    expect(east.sdk.disconnect).toHaveBeenCalledTimes(1);
    expect(west.sdk.disconnect).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(5000);
    const paths = fetcher.mock.calls.map(([url]) => url);
    for (const mirror of ['east', 'west']) {
      for (const suffix of ['live/session', `live/session/${sessionId}/reference`, `sessions/${sessionId}/link`, `sessions/${sessionId}/first-frame`, 'live/heartbeat']) {
        expect(paths.some(path => path.endsWith(`/exhibition/mirrors/${mirror}/${suffix}`))).toBe(true);
      }
    }
    expect(paths.filter(path => path.endsWith(`/sessions/${sessionId}/stop`))).toEqual([expect.stringContaining('/mirrors/east/')]);
    expect(paths.every(path => path.includes('/exhibition/mirrors/'))).toBe(true);
    expect(east.sdk.set).toHaveBeenCalledTimes(1); expect(west.sdk.set).toHaveBeenCalledTimes(1);
  });

  it('disposes a late old-mirror credential on that mirror without touching the newly opened one', async () => {
    const pending = deferred<Response>();
    const fetcher = vi.fn((url: string, init?: RequestInit) => url.endsWith('/mirrors/east/live/session') ? pending.promise : Promise.resolve(respond(url, init)));
    vi.stubGlobal('fetch', fetcher);
    const east = fixture('east'); const opening = east.connection.start(); await flush();
    await east.connection.stop();
    const west = fixture('west'); await west.connection.start();
    pending.resolve(Response.json(local('east'))); await opening;
    expect(east.deps.connect).not.toHaveBeenCalled(); expect(east.sdk.set).not.toHaveBeenCalled();
    expect(west.sdk.set).toHaveBeenCalledTimes(1); expect(west.sdk.disconnect).not.toHaveBeenCalled();
    expect(fetcher.mock.calls.filter(([url]) => url.endsWith('/stop')).map(([url]) => url)).toEqual([expect.stringContaining('/mirrors/east/')]);
  });

  it('rejects wrong-mirror metadata before camera connection and reports the failure only to its owner', async () => {
    const fetcher = vi.fn(async (url: string, init?: RequestInit) => url.endsWith('/live/session') ? Response.json(local('west')) : respond(url, init));
    vi.stubGlobal('fetch', fetcher);
    const east = fixture('east'); await east.connection.start();
    expect(east.deps.upload).not.toHaveBeenCalled(); expect(east.deps.connect).not.toHaveBeenCalled();
    expect(east.events.status).toHaveBeenCalledWith('error', expect.stringContaining('不匹配'));
    expect(fetcher.mock.calls.some(([url]) => url.endsWith('/mirrors/east/live/error'))).toBe(true);
    expect(fetcher.mock.calls.every(([url]) => url.includes('/mirrors/east/'))).toBe(true);
  });

  it('routes default through its explicit mirror endpoint while accepting legacy default session metadata', async () => {
    const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/live/session')) { const legacy = local('default'); delete legacy.exhibition.mirrorId; return Response.json(legacy); }
      return respond(url, init);
    });
    vi.stubGlobal('fetch', fetcher);
    const legacy = fixture(); await legacy.connection.start(); await legacy.connection.stop();
    expect(legacy.sdk.set).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls.every(([url]) => url.includes('/exhibition/mirrors/default/'))).toBe(true);
    const [, create] = fetcher.mock.calls.find(([url]) => url.endsWith('/live/session'))!;
    expect(JSON.parse(create!.body as string)).not.toHaveProperty('terminalId');
    expect(JSON.parse(create!.body as string)).not.toHaveProperty('terminalToken');
  });
});
