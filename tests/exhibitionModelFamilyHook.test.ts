import { act, createElement, useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useExhibitionLive } from '../src/exhibition/useExhibitionLive';
import { createReactHost, flushReact } from './support/reactHost';
import { materialCatalogFixture } from './support/materialCatalogFixture';

const mocks = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock('../src/api', () => ({ api: mocks.api, backend: {} }));
vi.mock('../src/exhibition/sdkPreparation', () => ({ prepareExhibitionEntry: () => () => {}, exhibitionSdk: vi.fn() }));

let host: Awaited<ReturnType<typeof createReactHost>> | undefined;
afterEach(async () => { await host?.close(); host = undefined; vi.clearAllMocks(); vi.unstubAllGlobals(); });

async function allocation(catalogProvider: 'xmax' | 'decart' | undefined, statusProvider: 'xmax' | 'decart') {
  host = await createReactHost();
  vi.stubGlobal('localStorage', { getItem: () => null });
  const track = { readyState: 'live', onended: null, getSettings: () => ({ deviceId: 'fixture-camera' }), stop: vi.fn() };
  const stream = { getTracks: () => [track], getVideoTracks: () => [track] };
  vi.stubGlobal('navigator', { mediaDevices: {
    getUserMedia: vi.fn(async () => stream), enumerateDevices: vi.fn(async () => []),
  } });
  mocks.api.mockImplementation(async (path: string) => {
    if (path.endsWith('/live/status')) return { configured: true, providerId: statusProvider };
    // Inspect the allocation handshake without creating a credential or connecting a vendor SDK.
    if (path.endsWith('/live/session')) throw new Error('Allocation fixture finished.');
    return {};
  });
  const initial = materialCatalogFixture({ mirrorId: 'east', revision: 1, phase: 'idle', experienceMode: 'clothx',
    selectedLookId: 'look', displayedLookId: null,
    looks: [{ id: 'look', mode: 'clothx', name: '测试', image: '/test.png', source: 'sample', description: '', category: '', tags: [], palette: '' }],
    enabledLookIds: ['look'], categories: [], tags: [], sessionNumber: 1, generationNumber: 0, updatedAt: 1, generationReadyAt: null,
    providerMode: 'xmax', live: null, logs: [],
    settings: { autoReturnSeconds: 90, uploadLimits: { maxFileSizeMB: 10, minWidth: 64, minHeight: 64, maxWidth: 4096, maxHeight: 4096 } } });
  initial.catalog!.providerId = catalogProvider;
  let start!: () => void;
  function Harness() {
    const [state, setState] = useState(initial);
    start = () => setState({ ...initial, phase: 'generating', revision: 2, generationNumber: 1 });
    useExhibitionLive({ state, active: true, mirrorId: 'east', refresh: () => {} });
    return null;
  }
  await host.render(createElement(Harness)); await flushReact();
  await act(async () => start()); await flushReact();
  const calls = mocks.api.mock.calls.filter(([path]) => path.endsWith('/live/session'));
  expect(calls).toHaveLength(1);
  expect(calls[0][1]).toBe('POST');
  expect(calls[0][2]).toMatchObject({ lookId: 'look', generationNumber: 1, expectedRevision: 2 });
  return calls[0][2] as Record<string, unknown>;
}

describe('browser model-family allocation handshake', () => {
  it.each([
    ['xmax', 'decart'], [undefined, 'xmax'],
  ] as const)('requests the native XMAX model family with catalog %s and status %s', async (catalogProvider, statusProvider) => {
    expect(await allocation(catalogProvider, statusProvider)).toHaveProperty('xmaxModelFamily', 'x2.1.1-preview');
  });

  it.each([
    ['decart', 'xmax'], [undefined, 'decart'],
  ] as const)('keeps the Decart allocation free of XMAX model options with catalog %s and status %s', async (catalogProvider, statusProvider) => {
    expect(await allocation(catalogProvider, statusProvider)).not.toHaveProperty('xmaxModelFamily');
  });
});
