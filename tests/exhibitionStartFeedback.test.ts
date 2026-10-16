import { materialCatalogFixture } from './support/materialCatalogFixture';
import { act, createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ExhibitionLiveStatus, ExhibitionState } from '../shared/exhibition';
import { Kiosk } from '../src/exhibition/ExhibitionApp';
import type { ExhibitionLiveController } from '../src/exhibition/useExhibitionLive';
import { createReactHost, flushReact } from './support/reactHost';

vi.mock('../src/exhibition/LiveCameraPanel', () => ({ StreamVideo: () => null, LiveCameraPanel: () => null }));
vi.mock('../src/exhibition/MoXDragSurface', () => ({ MoXDragSurface: () => null }));

let host: Awaited<ReturnType<typeof createReactHost>> | undefined;
afterEach(async () => { await host?.close(); host = undefined; vi.unstubAllGlobals(); });

function deferred<T>() {
  let resolve!: (value: T) => void;
  return { promise: new Promise<T>(yes => { resolve = yes; }), resolve };
}
function snapshot(overrides: Partial<ExhibitionState> = {}): ExhibitionState {
  return materialCatalogFixture({ mirrorId: 'default', revision: 1, phase: 'idle', experienceMode: 'clothx', selectedLookId: 'first', displayedLookId: null,
    looks: ['first', 'second'].map(id => ({ id, mode: 'clothx', name: id, description: '', image: '/test.png', source: 'sample', palette: '', category: '', tags: [] })),
    enabledLookIds: ['first', 'second'], categories: [], tags: [], sessionNumber: 1, generationNumber: 1, updatedAt: 1, generationReadyAt: null,
    providerMode: 'xmax', live: null, logs: [], settings: { autoReturnSeconds: 90, uploadLimits: { maxFileSizeMB: 10, minWidth: 64, minHeight: 64, maxWidth: 4096, maxHeight: 4096 } }, ...overrides });
}
function liveStatus(overrides: Partial<ExhibitionLiveStatus> = {}): ExhibitionLiveStatus {
  return { configured: true, mode: 'xmax', model: 'x2.0', perSessionLimit: 30, totalLimit: 360, allocatedCredits: 0, remainingCredits: 360,
    expireSeconds: 120, heartbeatTimeoutSeconds: 20, live: null, ...overrides };
}
async function fixture(stateOverrides: Partial<ExhibitionState> = {}, liveOverrides: Partial<ExhibitionLiveController> = {}) {
  host = await createReactHost();
  Object.assign(window.location, { hostname: 'xuminghong.local', href: 'http://xuminghong.local:10200/v1.1/exhibition/screen?mirror=default' });
  let state = snapshot(stateOverrides);
  const startCamera = vi.fn(async () => true);
  const live: ExhibitionLiveController = { cameraStream: null, outputStream: null, interaction: null, presentation: null, status: 'off', error: '', opening: false,
    deviceId: 'screen-start-fixture', cameras: [], selectedCameraId: '', mirrored: true, setMirrored: () => {}, startCamera, stopCamera: vi.fn(), retry: vi.fn(async () => true),
    reportFirstFrame: vi.fn(), secure: true, liveStatus: liveStatus(), refreshStatus: vi.fn(async () => {}), ...liveOverrides };
  const send = vi.fn(async () => true);
  const render = () => host!.render(createElement(Kiosk, { state, send, live }));
  const start = () => host!.find(node => node.nodeName === 'button' && node.textContent === '开始体验')!.getReactProps();
  const text = () => host!.find(node => node.nodeName === 'section')!.textContent;
  await render();
  return { live, startCamera, send, render, start, text, get state() { return state; },
    update: async (next: Partial<ExhibitionState>) => { state = { ...state, ...next }; await render(); } };
}

describe('mirror start preflight and actionable feedback', () => {
  it('keeps an insecure capture idle without presenting a second camera entry', async () => {
    const f = await fixture({}, { secure: false });
    await act(async () => f.start().onClick()); await flushReact();
    expect(f.send).not.toHaveBeenCalled();
    expect(f.startCamera).not.toHaveBeenCalled();
    expect(f.text()).toContain('摄像头');
    expect(host!.find(node => node.nodeName === 'a')).toBeUndefined();
  });

  it('does not begin when camera permission fails and shows the reported camera error', async () => {
    const f = await fixture();
    f.startCamera.mockImplementationOnce(async () => {
      f.live.error = '摄像头权限未开启。请允许摄像头后重试。'; f.live.status = 'error'; await f.render(); return false;
    });
    await act(async () => f.start().onClick()); await flushReact();
    expect(f.startCamera).toHaveBeenCalledTimes(1);
    expect(f.send).not.toHaveBeenCalled();
    expect(f.text()).toContain(f.live.error);
  });

  it('offers a local-camera retry after entry permission fails with a legacy zero-credit status', async () => {
    const f = await fixture({}, { status: 'error', error: '摄像头权限未开启。', liveStatus: liveStatus({ remainingCredits: 0 }) });
    const retry = host!.find(node => node.nodeName === 'button' && node.textContent === '重试摄像头');
    expect(retry).toBeDefined();
    await act(async () => { retry!.getReactProps().onClick(); }); await flushReact();
    expect(f.startCamera).toHaveBeenCalledTimes(1); expect(f.send).not.toHaveBeenCalled();
  });

  it('waits for camera permission and accepts only one begin from duplicate taps', async () => {
    const f = await fixture(); const permission = deferred<boolean>();
    f.startCamera.mockReturnValueOnce(permission.promise);
    const click = f.start().onClick;
    await act(async () => { click(); click(); });
    expect(f.startCamera).toHaveBeenCalledTimes(1);
    expect(f.send).not.toHaveBeenCalled();
    await act(async () => permission.resolve(true)); await flushReact();
    expect(f.send).toHaveBeenCalledExactlyOnceWith({ action: 'begin' });
  });

  it.each([
    { name: 'selected material', update: { selectedLookId: 'second' } },
    { name: 'provider', update: { providerMode: 'demo' as const } },
    { name: 'round', update: { sessionNumber: 2, generationNumber: 2 } },
    { name: 'phase', update: { phase: 'generating' as const } },
  ])('discards a late camera grant after the $name changes', async ({ update }) => {
    const f = await fixture(); const permission = deferred<boolean>();
    f.startCamera.mockReturnValueOnce(permission.promise);
    await act(async () => { f.start().onClick(); });
    await f.update(update);
    await act(async () => permission.resolve(true)); await flushReact();
    expect(f.send).not.toHaveBeenCalled();
  });

  it.each([0, 29])('starts after camera permission regardless of legacy remaining credits %i', async remainingCredits => {
    const f = await fixture({}, { liveStatus: liveStatus({ remainingCredits }) });
    await act(async () => f.start().onClick()); await flushReact();
    expect(f.startCamera).toHaveBeenCalledOnce();
    expect(f.send).toHaveBeenCalledExactlyOnceWith({ action: 'begin' });
    expect(f.text()).not.toMatch(/测试额度|本地预算/);
  });

  it('does not begin against an unconfigured XMAX service', async () => {
    const f = await fixture({}, { liveStatus: liveStatus({ configured: false }) });
    await act(async () => f.start().onClick()); await flushReact();
    expect(f.send).not.toHaveBeenCalled();
    expect(f.startCamera).not.toHaveBeenCalled();
    expect(f.text()).toContain('XMAX');
    expect(f.text()).toMatch(/配置|凭证/);
  });

  it('shows the actual active connection error so a failed generation has an explanation', async () => {
    const f = await fixture({ phase: 'generating' }, { status: 'error', error: '换装连接超时，请检查网络后重新开始。' });
    expect(f.text()).toContain(f.live.error);
    expect(f.send).not.toHaveBeenCalled();
  });

  it('starts immediately with an existing camera and a legacy zero-credit status', async () => {
    const f = await fixture({}, { cameraStream: {} as MediaStream, status: 'preview', liveStatus: liveStatus({ remainingCredits: 0 }) });
    await act(async () => f.start().onClick()); await flushReact();
    expect(f.send).toHaveBeenCalledExactlyOnceWith({ action: 'begin' });
    expect(f.startCamera).not.toHaveBeenCalled();
  });

  it('lets MoX start from HTTP with a legacy zero-credit status without requesting camera permission', async () => {
    const state = snapshot(); state.looks[0].mode = 'mox';
    const f = await fixture({ experienceMode: 'mox', looks: state.looks }, { secure: false, liveStatus: liveStatus({ remainingCredits: 0 }) });
    await act(async () => f.start().onClick()); await flushReact();
    expect(f.send).toHaveBeenCalledExactlyOnceWith({ action: 'begin' });
    expect(f.startCamera).not.toHaveBeenCalled();
  });
});
