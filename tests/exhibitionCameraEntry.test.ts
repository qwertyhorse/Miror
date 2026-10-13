import { act, createElement, StrictMode, useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ExhibitionApp from '../src/exhibition/ExhibitionApp';
import { defaultMirrorCameraEntry, exhibitionCameraUrl } from '../src/exhibition/cameraEntry';
import { useExhibitionLive, type ExhibitionLiveController } from '../src/exhibition/useExhibitionLive';
import type { ExhibitionState } from '../shared/exhibition';
import { createReactHost, flushReact } from './support/reactHost';
import { scopedStorageKey } from '../src/versionScope';

const mocks = vi.hoisted(() => ({ api: vi.fn(), registry: vi.fn(), terminal: vi.fn(), prepare: vi.fn(), release: vi.fn() }));
vi.mock('../src/api', () => ({ api: mocks.api, backend: {} }));
vi.mock('../src/exhibition/useMirrors', () => ({ useMirrors: mocks.registry }));
vi.mock('../src/exhibition/useTerminalBinding', () => ({ useTerminalBinding: mocks.terminal }));
vi.mock('../src/exhibition/sdkPreparation', async importOriginal => ({
  ...await importOriginal<typeof import('../src/exhibition/sdkPreparation')>(),
  prepareExhibitionEntry: mocks.prepare,
}));

let host: Awaited<ReturnType<typeof createReactHost>> | undefined;
afterEach(async () => { await host?.close(); host = undefined; vi.useRealTimers(); vi.unstubAllGlobals(); vi.clearAllMocks(); });

const snapshot = (overrides: Partial<ExhibitionState> = {}): ExhibitionState => ({
  mirrorId: 'default', revision: 1, phase: 'idle', experienceMode: 'clothx', selectedLookId: 'look', displayedLookId: null,
  looks: [{ id: 'look', mode: 'clothx', name: '测试', image: '/test.png', source: 'sample', description: '', category: '', tags: [], palette: '' }],
  enabledLookIds: ['look'], categories: [], tags: [], sessionNumber: 0, generationNumber: 0, updatedAt: 1, generationReadyAt: null,
  providerMode: 'xmax', live: null, logs: [],
  settings: { autoReturnSeconds: 90, uploadLimits: { maxFileSizeMB: 10, minWidth: 64, minHeight: 64, maxWidth: 4096, maxHeight: 4096 } },
  ...overrides,
});

async function cameraFixture(initial = snapshot(), options: { active?: boolean; denied?: boolean; pending?: Promise<MediaStream>; strict?: boolean; preference?: unknown; region?: string; configured?: boolean } = {}) {
  host = await createReactHost();
  const getItem = vi.fn(() => options.preference === undefined ? null : JSON.stringify(options.preference));
  vi.stubGlobal('localStorage', { getItem });
  const track = { readyState: 'live', stop: vi.fn(), getSettings: () => ({ deviceId: 'camera-a' }), onended: null };
  const stream = { getTracks: () => [track], getVideoTracks: () => [track] } as unknown as MediaStream;
  const getUserMedia = vi.fn((_constraints: MediaStreamConstraints) => options.pending ?? (options.denied ? Promise.reject(new DOMException('denied', 'NotAllowedError')) : Promise.resolve(stream)));
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia, enumerateDevices: vi.fn(async () => []) } });
  mocks.api.mockResolvedValue({ configured: options.configured ?? true, providerRegion: options.region, remainingCredits: 0, perSessionLimit: 30 });
  mocks.prepare.mockReturnValue(mocks.release);
  const refresh = vi.fn();
  let live!: ExhibitionLiveController;
  let update!: (state: ExhibitionState, active?: boolean) => void;
  function Harness() {
    const [value, setValue] = useState({ state: initial, active: options.active ?? true });
    update = (state, active = value.active) => setValue({ state, active });
    live = useExhibitionLive({ state: value.state, active: value.active, refresh });
    return null;
  }
  await host.render(options.strict ? createElement(StrictMode, null, createElement(Harness)) : createElement(Harness)); await flushReact();
  return { get live() { return live; }, update, getUserMedia, stream, track, getItem };
}

describe('default mirror camera entry', () => {
  it('prepares the configured SDK during local preview without allocating or uploading, then releases on leaving', async () => {
    const f = await cameraFixture(snapshot(), { region: 'cn' });
    expect(mocks.prepare).toHaveBeenCalledExactlyOnceWith('cn');
    expect(mocks.api.mock.calls.every(([path]) => String(path).endsWith('/live/status'))).toBe(true);
    await act(async () => f.update(snapshot({ revision: 2 }))); await flushReact();
    expect(mocks.prepare).toHaveBeenCalledOnce();
    await act(async () => f.update(snapshot(), false)); await flushReact();
    expect(mocks.release).toHaveBeenCalledOnce();
  });
  it.each([
    { active: false, region: 'cn' }, { region: 'cn', configured: false }, { region: 'bad' }, {},
  ])('does not speculate about an inactive or unconfigured SDK: %j', async options => {
    await cameraFixture(snapshot(), options); expect(mocks.prepare).not.toHaveBeenCalled();
  });
  it('links directly to the same host camera origin and the selected mirror', () => {
    const url = new URL(exhibitionCameraUrl('east/2', 'http://192.168.63.102:10200/v1.1/exhibition/control'));
    expect(url.origin).toBe('https://192.168.63.102:10202');
    expect(url.pathname).toMatch(/\/exhibition\/screen$/); expect(url.searchParams.get('mirror')).toBe('east/2');
  });
  it('upgrades only the V1.1 mirror while preserving hostname, options and fragments', () => {
    expect(defaultMirrorCameraEntry('http://xuminghong.local:10200/v1.1/exhibition/screen?mirror=east&mode=touch#drawer'))
      .toBe('https://xuminghong.local:10202/v1.1/exhibition/screen?mirror=east&mode=touch#drawer');
    expect(defaultMirrorCameraEntry('http://192.168.63.102:10200/v1.1/exhibition/screen/')).toBe('https://192.168.63.102:10202/v1.1/exhibition/screen/');
    for (const path of ['/', '/v1.1/', '/v1.1/exhibition/control?mirror=east', '/exhibition/screen', '/v1.1/exhibition/screening']) {
      expect(defaultMirrorCameraEntry(`http://xuminghong.local:10200${path}`)).toBeNull();
    }
    expect(defaultMirrorCameraEntry('https://xuminghong.local:10202/v1.1/exhibition/screen?mirror=east')).toBeNull();
  });

  it('preserves the diagnostics flag through the secure camera redirect', () => {
    expect(defaultMirrorCameraEntry('http://xuminghong.local:10200/v1.1/exhibition/screen?mirror=default&diagnostics=1'))
      .toBe('https://xuminghong.local:10202/v1.1/exhibition/screen?mirror=default&diagnostics=1');
  });

  it('replaces the HTTP URL before mounting any mirror or terminal clients', async () => {
    host = await createReactHost();
    const replace = vi.fn();
    Object.assign(window.location, { href: 'http://xuminghong.local:10200/v1.1/exhibition/screen?mirror=east#drawer', replace });
    await host.render(createElement(ExhibitionApp));
    expect(replace).toHaveBeenCalledExactlyOnceWith('https://xuminghong.local:10202/v1.1/exhibition/screen?mirror=east#drawer');
    expect(mocks.registry).not.toHaveBeenCalled(); expect(mocks.terminal).not.toHaveBeenCalled(); expect(mocks.api).not.toHaveBeenCalled();
  });

  it.each(['idle', 'select'] as const)('prepares local camera on %s entry despite zero budget without allocating XMAX', async phase => {
    const f = await cameraFixture(snapshot({ phase }));
    expect(f.getUserMedia).toHaveBeenCalledTimes(1);
    expect(f.live.cameraStream).toBe(f.stream); expect(f.live.status).toBe('preview');
    expect(mocks.api.mock.calls.every(([path]) => String(path).endsWith('/live/status'))).toBe(true);
    await act(async () => f.update(snapshot({ phase, revision: 2 })));
    await flushReact(); expect(f.getUserMedia).toHaveBeenCalledTimes(1);
    await act(async () => f.live.stopCamera()); await flushReact();
    expect(f.live.cameraStream).toBeNull(); expect(f.getUserMedia).toHaveBeenCalledTimes(1);
  });

  it('keeps denied permission stable across polls and allows an explicit retry', async () => {
    const f = await cameraFixture(snapshot(), { denied: true });
    expect(f.live.status).toBe('error'); expect(f.live.error).toContain('权限');
    await act(async () => f.update(snapshot({ revision: 2 }))); await flushReact();
    expect(f.getUserMedia).toHaveBeenCalledTimes(1);
    f.getUserMedia.mockResolvedValueOnce(f.stream);
    await act(async () => { await f.live.startCamera(); }); await flushReact();
    expect(f.getUserMedia).toHaveBeenCalledTimes(2); expect(f.live.cameraStream).toBe(f.stream);
  });

  it('requests permission once under the app StrictMode lifecycle probe', async () => {
    const f = await cameraFixture(snapshot(), { strict: true });
    expect(f.getUserMedia).toHaveBeenCalledTimes(1); expect(f.live.cameraStream).toBe(f.stream);
  });

  it('restores the successfully tested USB camera with browser default constraints', async () => {
    const f = await cameraFixture(snapshot(), { preference: { deviceId: 'working-usb', label: 'camera2 0, facing back', profile: 'default' } });
    expect(f.getItem).toHaveBeenCalledWith(scopedStorageKey('exhibition-camera-preference'));
    expect(f.getUserMedia).toHaveBeenCalledExactlyOnceWith({ audio: false, video: { deviceId: { exact: 'working-usb' } } });
    expect(f.live.status).toBe('preview');
    await act(async () => f.update(snapshot({ revision: 2 }))); await flushReact();
    expect(f.getUserMedia).toHaveBeenCalledTimes(1);
  });

  it('recovers an ended camera grant after diagnostic return without allocating XMAX', async () => {
    vi.useFakeTimers();
    const stoppedTrack = { readyState: 'ended', stop: vi.fn() };
    const ended = { getTracks: () => [stoppedTrack], getVideoTracks: () => [stoppedTrack] } as unknown as MediaStream;
    const f = await cameraFixture(snapshot(), { pending: Promise.resolve(ended), preference: { deviceId: 'working-usb', label: 'USB', profile: 'default' } });
    expect(f.live.opening).toBe(true); expect(f.live.cameraStream).toBeNull();
    expect(stoppedTrack.stop).toHaveBeenCalledOnce();
    f.getUserMedia.mockResolvedValueOnce(f.stream);
    await act(async () => { await vi.advanceTimersByTimeAsync(500); }); await flushReact();
    expect(f.live.cameraStream).toBe(f.stream); expect(f.live.status).toBe('preview'); expect(f.live.error).toBe('');
    expect(f.getUserMedia).toHaveBeenCalledTimes(2);
    expect(f.getUserMedia.mock.calls.map(args => args[0])).toEqual([
      { audio: false, video: { deviceId: { exact: 'working-usb' } } },
      { audio: false, video: { deviceId: { exact: 'working-usb' } } },
    ]);
    expect(mocks.api.mock.calls.every(([path]) => String(path).endsWith('/live/status'))).toBe(true);
  });

  it('cancels an automatic reopen when the mirror leaves the camera mode', async () => {
    vi.useFakeTimers();
    const empty = { getTracks: () => [], getVideoTracks: () => [] } as unknown as MediaStream;
    const f = await cameraFixture(snapshot(), { pending: Promise.resolve(empty) });
    expect(f.live.opening).toBe(true);
    await act(async () => f.update(snapshot({ experienceMode: 'mox' })));
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); }); await flushReact();
    expect(f.getUserMedia).toHaveBeenCalledOnce(); expect(f.live.cameraStream).toBeNull();
    expect(f.live.opening).toBe(false); expect(f.live.error).toBe('');
  });

  it('keeps a working Android capture when the driver cannot expose getSettings', async () => {
    let grant!: (stream: MediaStream) => void;
    const pending = new Promise<MediaStream>(resolve => { grant = resolve; });
    const f = await cameraFixture(snapshot(), { pending, preference: { deviceId: 'working-usb', label: 'USB', profile: 'default' } });
    f.track.getSettings = () => { throw new Error('driver settings unavailable'); };
    await act(async () => grant(f.stream)); await flushReact();
    expect(f.live.cameraStream).toBe(f.stream); expect(f.live.selectedCameraId).toBe('working-usb');
    expect(f.live.status).toBe('preview'); expect(f.live.error).toBe(''); expect(f.track.stop).not.toHaveBeenCalled();
  });

  it('keeps screen parameters when that is the verified capture profile', async () => {
    const f = await cameraFixture(snapshot(), { preference: { deviceId: 'working-usb', label: 'USB', profile: 'screen' } });
    expect(f.getUserMedia).toHaveBeenCalledExactlyOnceWith({ audio: false, video: {
      deviceId: { exact: 'working-usb' }, width: { ideal: 1080 }, height: { ideal: 1920 }, frameRate: { ideal: 30, max: 30 },
    } });
  });

  it('allows an explicit camera choice to override the saved device without changing the verified profile', async () => {
    const f = await cameraFixture(snapshot(), { preference: { deviceId: 'working-usb', label: 'USB', profile: 'default' } });
    await act(async () => { await f.live.startCamera('replacement-usb'); }); await flushReact();
    expect(f.getUserMedia).toHaveBeenLastCalledWith({ audio: false, video: { deviceId: { exact: 'replacement-usb' } } });
    expect(f.live.status).toBe('preview');
  });

  it('ignores a malformed local camera preference and keeps the normal capture entry', async () => {
    const f = await cameraFixture(snapshot(), { preference: { deviceId: 'untrusted', label: 'USB', profile: 'invalid' } });
    expect(f.getUserMedia).toHaveBeenCalledExactlyOnceWith({ audio: false, video: {
      facingMode: 'user', width: { ideal: 1080 }, height: { ideal: 1920 }, frameRate: { ideal: 30, max: 30 },
    } });
  });

  it('does not request camera for a passive controller, MoX, demo mode or an occupied mirror', async () => {
    const f = await cameraFixture(snapshot(), { active: false });
    expect(f.getUserMedia).not.toHaveBeenCalled();
    await act(async () => f.update(snapshot({ experienceMode: 'mox' }), true));
    await act(async () => f.update(snapshot({ providerMode: 'demo' }), true));
    await act(async () => f.update(snapshot({ live: { deviceId: 'other-screen', sessionId: 'occupied', status: 'running', lookId: 'look', generationNumber: 1 } as ExhibitionState['live'] }), true));
    await flushReact(); expect(f.getUserMedia).not.toHaveBeenCalled();
    await act(async () => f.update(snapshot(), true)); await flushReact();
    expect(f.getUserMedia).toHaveBeenCalledTimes(1);
  });

  it('stops a late camera grant after leaving the camera experience, then prepares the next mode only once', async () => {
    let grant!: (stream: MediaStream) => void;
    const pending = new Promise<MediaStream>(resolve => { grant = resolve; });
    const f = await cameraFixture(snapshot(), { pending });
    expect(f.live.opening).toBe(true);
    await act(async () => f.update(snapshot({ experienceMode: 'mox' })));
    await act(async () => { grant(f.stream); }); await flushReact();
    expect(f.track.stop).toHaveBeenCalledTimes(1); expect(f.live.cameraStream).toBeNull();
    f.getUserMedia.mockResolvedValueOnce(f.stream);
    await act(async () => f.update(snapshot({ experienceMode: 'charx' }))); await flushReact();
    expect(f.getUserMedia).toHaveBeenCalledTimes(2); expect(f.live.cameraStream).toBe(f.stream);
    await act(async () => f.update(snapshot({ experienceMode: 'charx', revision: 3 }))); await flushReact();
    expect(f.getUserMedia).toHaveBeenCalledTimes(2);
  });

  it('disposes a late camera grant when another page has acquired the mirror', async () => {
    let grant!: (stream: MediaStream) => void;
    const pending = new Promise<MediaStream>(resolve => { grant = resolve; });
    const f = await cameraFixture(snapshot(), { pending });
    await act(async () => f.update(snapshot({ live: { deviceId: 'other-screen', sessionId: 'occupied', status: 'running', lookId: 'look', generationNumber: 1 } as ExhibitionState['live'] })));
    await act(async () => grant(f.stream)); await flushReact();
    expect(f.track.stop).toHaveBeenCalledTimes(1); expect(f.live.cameraStream).toBeNull();
    await act(async () => { await f.live.startCamera(); });
    expect(f.getUserMedia).toHaveBeenCalledTimes(1);
  });
});
