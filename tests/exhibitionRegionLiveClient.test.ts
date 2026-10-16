import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ExhibitionLiveConnection, type ExhibitionLiveDeps } from '../src/exhibition/useExhibitionLive';
import type { XmaxRegion } from '../shared/xmax';

const sdkMocks = vi.hoisted(() => {
  const sdk = { getSessionUid: vi.fn(() => 'provider-fixture'), set: vi.fn(async () => {}), disconnect: vi.fn(async () => {}),
    stopGeneration: vi.fn(async () => {}), stopLocalStream: vi.fn(async () => {}) };
  const makeRegion = (region: string) => {
    const uploadAndCheckImage = vi.fn(async () => ({ url: `https://${region}.fixture.test/reference.png` }));
    const connect = vi.fn(async (_source: MediaStream | File, _options: Parameters<ExhibitionLiveDeps['connect']>[2]) => sdk);
    return { uploadAndCheckImage, connect, models: { realtime: vi.fn((name: string) => ({ name })) },
      createXmaxClient: vi.fn((_options: { apiKey: string; locale: string; telemetry: boolean }) => ({ files: { uploadAndCheckImage }, realtime: { connect, connectMedia: connect } })) };
  };
  return { sdk, cn: makeRegion('cn'), global: makeRegion('global') };
});
vi.mock('@xmaxai/sdk', () => ({ createXmaxClient: sdkMocks.cn.createXmaxClient, models: sdkMocks.cn.models }));
vi.mock('@xmaxai/sdk-global', () => ({ createXmaxClient: sdkMocks.global.createXmaxClient, models: sdkMocks.global.models }));

type LocalSession = Parameters<ExhibitionLiveDeps['connect']>[1];
const connections: ExhibitionLiveConnection[] = [];
beforeEach(() => { vi.clearAllMocks(); vi.useFakeTimers(); });
afterEach(async () => {
  for (const connection of connections.splice(0)) await connection.stop();
  vi.clearAllTimers(); vi.useRealTimers();
});

function fixture(providerRegion?: XmaxRegion, boundRegion = providerRegion, prefetchImages?: string[]) {
  const originalTrack = { readyState: 'live', stop: vi.fn() };
  const clonedTrack = { readyState: 'live', stop: vi.fn(), onended: null };
  const stream = { getVideoTracks: () => [originalTrack], getTracks: () => [originalTrack] } as unknown as MediaStream;
  const cloned = { getVideoTracks: () => [clonedTrack], getTracks: () => [clonedTrack] } as unknown as MediaStream;
  const created: LocalSession = {
    id: 'region-session', token: 'temporary-fixture', model: 'x2.0', status: 'active', sourceId: 'source-fixture', sourceKind: 'camera',
    sourceName: 'Fixture camera', targetItemId: 'look-fixture', referenceScope: 'account-scope', referenceAsset: '/reference.png', refImageUrl: `https://${providerRegion ?? 'global'}.fixture.test/reference.png`, referenceVersion: 1,
    expiresAt: new Date(Date.now() + 120000).toISOString(), pointsLimit: 30, consumedCredits: 0, resultAvailable: false, verification: 'none',
    ...(providerRegion ? { providerRegion } : {}),
    exhibition: { mirrorId: 'default', deviceId: 'device-fixture', lookId: 'look-fixture', sessionNumber: 1, generationNumber: 1 },
  };
  const deps = {
    create: vi.fn(async () => ({ ...created })), reference: vi.fn(async () => new File(['fixture'], 'reference.png', { type: 'image/png' })),
    link: vi.fn(async (_id, providerSessionId) => ({ ...created, providerSessionId, referenceVersion: 1 })),
    firstFrame: vi.fn(async () => created), stop: vi.fn(async () => ({ ...created, status: 'stopped' })),
    heartbeat: vi.fn(async () => ({})), reportError: vi.fn(async () => ({})), clone: vi.fn(() => cloned), now: () => 0,
  } satisfies Partial<ExhibitionLiveDeps>;
  const events = { status: vi.fn(), stream: vi.fn(), refresh: vi.fn() };
  const connection = new ExhibitionLiveConnection({ deviceId: 'device-fixture', lookId: 'look-fixture', sessionNumber: 1,
    generationNumber: 1, expectedRevision: 1, image: '/reference.png', stream, prefetchImages }, events, deps);
  connections.push(connection);
  const ready = async () => {
    await connection.start();
    const output = { id: 'remote-fixture' } as MediaStream;
    sdkMocks[providerRegion ?? 'global'].connect.mock.calls.at(-1)![1].onRemoteStream(output);
    connection.reportRenderedFrame(output);
    for (let index = 0; index < 40; index++) await Promise.resolve();
  };
  return { connection, deps, events, cloned, originalTrack, created, ready };
}

describe('exhibition session SDK region', () => {
  it.each(['cn', 'global'] as const)('uses one %s realtime client without uploading neighbouring materials', async region => {
    const f = fixture(region, region, ['/second.png', '/third.png']); await f.ready();
    expect(sdkMocks[region].uploadAndCheckImage).not.toHaveBeenCalled();
    expect(sdkMocks[region].createXmaxClient).toHaveBeenCalledTimes(1);
    expect(sdkMocks[region].connect).toHaveBeenCalledOnce();
    expect(f.deps.create).toHaveBeenCalledOnce();
  });

  it('keeps realtime clients separate between connections and never creates files clients', async () => {
    await fixture('global', 'global', ['/second.png']).ready();
    await fixture('global', 'global', ['/second.png']).ready();
    expect(sdkMocks.global.uploadAndCheckImage).not.toHaveBeenCalled();
    expect(sdkMocks.global.createXmaxClient).toHaveBeenCalledTimes(2);
    expect(sdkMocks.global.connect).toHaveBeenCalledTimes(2);
  });

  it('does not upload after a temporary-token replacement', async () => {
    const f = fixture('global', 'global', ['/second.png', '/third.png']);
    f.deps.link.mockResolvedValueOnce({ ...f.created, token: 'replacement-fixture', providerSessionId: 'provider-fixture', referenceVersion: 1 });
    await f.ready();
    expect(sdkMocks.global.uploadAndCheckImage).not.toHaveBeenCalled();
    expect(sdkMocks.global.createXmaxClient).toHaveBeenCalledTimes(1);
    expect(sdkMocks.global.createXmaxClient).toHaveBeenLastCalledWith(expect.objectContaining({ apiKey: 'temporary-fixture' }));
    expect(sdkMocks.global.connect).toHaveBeenCalledOnce();
  });

  it('does not send upload credentials to a region reported by a later link', async () => {
    const f = fixture('cn', 'cn', ['/second.png', '/third.png']);
    f.deps.link.mockResolvedValueOnce({ ...f.created, providerRegion: 'global', providerSessionId: 'provider-fixture', referenceVersion: 1 });
    await f.ready();
    expect(sdkMocks.cn.uploadAndCheckImage).not.toHaveBeenCalled();
    expect(sdkMocks.cn.createXmaxClient).toHaveBeenCalledTimes(1);
    expect(sdkMocks.global.uploadAndCheckImage).not.toHaveBeenCalled();
    expect(sdkMocks.global.createXmaxClient).not.toHaveBeenCalled();
    expect(sdkMocks.global.connect).not.toHaveBeenCalled();
  });

  it.each([
    ['cn', 'cn'], ['global', 'global'], [undefined, 'global'],
  ] as const)('uses the %s session region for realtime connection with a backend prepared reference', async (providerRegion, expectedRegion) => {
    const f = fixture(providerRegion);
    await f.connection.start();

    const selected = sdkMocks[expectedRegion];
    const unused = sdkMocks[expectedRegion === 'cn' ? 'global' : 'cn'];
    expect(selected.createXmaxClient).toHaveBeenCalledTimes(1);
    for (const [options] of selected.createXmaxClient.mock.calls)
      expect(options).toEqual({ apiKey: 'temporary-fixture', locale: 'zh-CN', telemetry: false });
    expect(selected.uploadAndCheckImage).not.toHaveBeenCalled();
    expect(selected.connect).toHaveBeenCalledWith(f.cloned, expect.objectContaining({ autoStart: false,
      context: expect.objectContaining({ refImageUrl: `https://${expectedRegion}.fixture.test/reference.png` }) }));
    expect(selected.models.realtime).toHaveBeenCalledWith('x2.0');
    expect(unused.createXmaxClient).not.toHaveBeenCalled();
    expect(sdkMocks.sdk.set).toHaveBeenCalledExactlyOnceWith({ prompt: '视频中人物衣服替换成参考图中衣服', refImageUrl: `https://${expectedRegion}.fixture.test/reference.png` });
    expect(f.deps.reportError).not.toHaveBeenCalled();
    expect(f.deps.create).toHaveBeenCalledOnce();
    expect(f.originalTrack.stop).not.toHaveBeenCalled();
  });

  it('uses the bound creation response without a second reference lookup', async () => {
    const f = fixture('cn', 'global');
    await f.connection.start();


    expect(sdkMocks.cn.createXmaxClient).toHaveBeenCalledTimes(1);
    expect(sdkMocks.cn.connect).toHaveBeenCalledOnce();
    expect(sdkMocks.global.createXmaxClient).not.toHaveBeenCalled();
    expect(f.deps.reportError).not.toHaveBeenCalled();
  });

  it.each(['unsupported', null, 17, {}])('rejects invalid runtime session region %j before either SDK receives credentials', async providerRegion => {
    const f = fixture();
    f.deps.create.mockResolvedValueOnce({ ...f.created, providerRegion: providerRegion as XmaxRegion });
    await f.connection.start();

    expect(sdkMocks.cn.createXmaxClient).not.toHaveBeenCalled();
    expect(sdkMocks.global.createXmaxClient).not.toHaveBeenCalled();

    expect(f.deps.link).not.toHaveBeenCalled();
    expect(sdkMocks.sdk.set).not.toHaveBeenCalled();
    expect(f.deps.create).toHaveBeenCalledOnce();
    expect(f.deps.stop).toHaveBeenCalledExactlyOnceWith('region-session');
    expect(f.deps.reportError).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      sessionId: 'region-session', message: '服务区域无效，请联系工作人员。',
    }));
    expect(f.events.status).toHaveBeenCalledWith('error', '服务区域无效，请联系工作人员。');
    expect(f.originalTrack.stop).not.toHaveBeenCalled();
  });
});
