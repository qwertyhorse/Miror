import { act, createElement, type ComponentProps } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ExhibitionState } from '../shared/exhibition';
import type { ExhibitionLiveController } from '../src/exhibition/useExhibitionLive';
import type { useExhibitionGestures } from '../src/exhibition/useExhibitionGestures';
import { Kiosk } from '../src/exhibition/ExhibitionApp';
import { exhibitionLooks } from '../src/exhibition/catalog';
import { createReactHost, flushReact } from './support/reactHost';

type GestureOptions = Parameters<typeof useExhibitionGestures>[0];
const capture = vi.hoisted(() => ({ options: null as GestureOptions | null, status: 'ready', error: '',
  handDetected: false, captureStatus: 'active', fps: 15, retry: vi.fn() }));
vi.mock('../src/exhibition/useExhibitionGestures', () => ({ useExhibitionGestures: (options: GestureOptions) => {
  capture.options = options;
  return { status: capture.status, error: capture.error, handDetected: capture.handDetected, captureStatus: capture.captureStatus,
    fps: capture.fps, retry: capture.retry };
} }));
vi.mock('../src/exhibition/LiveCameraPanel', () => ({ StreamVideo: () => null }));
vi.mock('../src/exhibition/MoXDragSurface', () => ({ MoXDragSurface: () => null }));

let host: Awaited<ReturnType<typeof createReactHost>> | undefined;
afterEach(async () => { await host?.close(); host = undefined; capture.options = null; capture.status = 'ready'; capture.error = '';
  capture.handDetected = false; capture.captureStatus = 'active'; capture.retry.mockClear(); });
function snapshot(overrides: Partial<ExhibitionState> = {}): ExhibitionState {
  return { mirrorId: 'default', revision: 1, phase: 'idle', experienceMode: 'clothx', looks: structuredClone(exhibitionLooks),
    enabledLookIds: ['commute', 'city', 'evening'], selectedLookId: 'commute', displayedLookId: null,
    categories: [], tags: [], sessionNumber: 1, generationNumber: 1, updatedAt: 1, generationReadyAt: null,
    providerMode: 'xmax', live: null, logs: [], settings: { autoReturnSeconds: 90, uploadLimits: { maxFileSizeMB: 10, minWidth: 64, minHeight: 64, maxWidth: 4096, maxHeight: 4096 } }, ...overrides };
}
async function fixture(overrides: Partial<ExhibitionState> = {}, props: Partial<ComponentProps<typeof Kiosk>> = {}) {
  host = await createReactHost();
  let state = snapshot(overrides);
  const live = { cameraStream: { getVideoTracks: () => [{ readyState: 'live' }] }, outputStream: null, opening: false,
    error: '', status: 'preview', deviceId: 'wave-screen', mirrored: true, secure: true } as unknown as ExhibitionLiveController;
  const send = vi.fn(async (_command: unknown) => true);
  const render = () => host!.render(createElement(Kiosk, { state, live, send, ...props }));
  await render();
  return { live, send, render, update: async (next: Partial<ExhibitionState>) => { state = { ...state, ...next }; await render(); },
    wave: async () => { await act(async () => capture.options!.onGesture('wave')); await flushReact(); } };
}

describe('wave advances the mirror material without beginning an experience', () => {
  it('advances each completed wave and wraps in the enabled material order', async () => {
    const f = await fixture();
    expect(capture.options).toMatchObject({ enabled: true, mode: 'wave', mirrored: true, stream: f.live.cameraStream });
    await f.wave();
    expect(f.send).toHaveBeenLastCalledWith({ action: 'select', lookId: 'city' });
    await f.update({ selectedLookId: 'city', phase: 'select' }); await f.wave();
    expect(f.send).toHaveBeenLastCalledWith({ action: 'select', lookId: 'evening' });
    await f.update({ selectedLookId: 'evening' }); await f.wave();
    expect(f.send).toHaveBeenLastCalledWith({ action: 'select', lookId: 'commute' });
    expect(f.send.mock.calls).toHaveLength(3);
    expect(f.send.mock.calls.some(([command]) => (command as { action: string }).action === 'begin')).toBe(false);
  });

  it.each(['showcase', 'generating'] as const)('uses the existing switch path in %s', async phase => {
    const f = await fixture({ phase }); await f.wave();
    expect(f.send).toHaveBeenCalledExactlyOnceWith({ action: 'switch', lookId: 'city' });
  });

  it('follows the configured order and skips disabled materials and other modes', async () => {
    const other = { ...exhibitionLooks[1], id: 'other-mode', mode: 'charx' as const };
    const f = await fixture({ selectedLookId: 'evening', looks: [...exhibitionLooks, other], enabledLookIds: ['evening', 'other-mode', 'commute'] });
    await f.wave(); expect(f.send).toHaveBeenCalledExactlyOnceWith({ action: 'select', lookId: 'commute' });
  });

  it('deduplicates gestures until the current command finishes', async () => {
    const f = await fixture(); let finish!: (accepted: boolean) => void;
    f.send.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    await f.wave(); await f.wave(); expect(f.send).toHaveBeenCalledTimes(1);
    await f.update({ phase: 'select', selectedLookId: 'city' });
    await act(async () => finish(true)); await f.wave();
    expect(f.send).toHaveBeenCalledTimes(2);
    expect(f.send).toHaveBeenLastCalledWith({ action: 'select', lookId: 'evening' });
  });

  it('resets motion across stop boundaries while retaining the latch across ordinary material switches', async () => {
    const f = await fixture({ phase: 'showcase' });
    const initialKey = capture.options!.resetKey;
    await f.wave(); await f.update({ selectedLookId: 'city', phase: 'generating', generationNumber: 2 });
    expect(capture.options!.resetKey).toBe(initialKey);
    await act(async () => host!.find(node => node.nodeName === 'button' && node.textContent === '停止生成')!.getReactProps().onClick());
    expect(capture.options!.resetKey).not.toBe(initialKey);
    const afterStop = capture.options!.resetKey;
    await f.update({ phase: 'idle' });
    expect(capture.options!.resetKey).not.toBe(afterStop);
  });

  it.each([
    { state: { phase: 'paused' as const }, props: {} },
    { state: {}, props: { disabled: true } },
    { state: {}, props: { stopPending: true } },
    { state: {}, props: { commandPending: true, selectionPending: true } },
    { state: {}, props: { canControl: false } },
    { state: {}, props: { passive: true } },
    { state: {}, props: { presentation: 'remote' as const } },
  ])('does not issue a gesture command when this screen cannot control selection: %j', async ({ state, props }) => {
    const f = await fixture(state, props); await f.wave(); expect(f.send).not.toHaveBeenCalled();
  });

  it('does nothing when only one material is enabled', async () => {
    const f = await fixture({ enabledLookIds: ['commute'] }); await f.wave(); expect(f.send).not.toHaveBeenCalled();
  });

  it('ignores horizontal swipes', async () => {
    const f = await fixture(); await act(async () => capture.options!.onGesture('swipe_right')); expect(f.send).not.toHaveBeenCalled();
  });

  it('distinguishes a ready model from an observed hand and a stalled camera', async () => {
    const f = await fixture();
    const control = () => host!.find(node => node.nodeName === 'button' && node.getReactProps()['aria-label'] === '关闭挥手换素材')!;
    expect(control().textContent).toContain('未看到手');
    expect(control().getReactProps()['data-detection']).toBe('waiting');
    capture.handDetected = true; await f.render();
    expect(control().textContent).toContain('已看到手');
    expect(control().getReactProps()['data-detection']).toBe('hand');
    capture.captureStatus = 'stalled'; await f.render();
    expect(control().textContent).toContain('取景未更新');
    expect(control().getReactProps()['data-detection']).toBe('waiting');
    await f.update({ phase: 'paused' });
    expect(control().textContent).toContain('挥手已暂停');
    expect(control().getReactProps()['data-detection']).toBe('paused');
    expect(f.send).not.toHaveBeenCalled();
  });

  it('lets the local screen turn recognition off and retry a failed model load', async () => {
    const f = await fixture();
    await act(async () => host!.find(node => node.nodeName === 'button' && node.getReactProps()['aria-label'] === '关闭挥手换素材')!.getReactProps().onClick());
    expect(capture.options?.enabled).toBe(false);
    await act(async () => host!.find(node => node.nodeName === 'button' && node.getReactProps()['aria-label'] === '开启挥手换素材')!.getReactProps().onClick());
    capture.status = 'error'; capture.error = '挥手识别加载失败，请重试。'; await f.render();
    await act(async () => host!.find(node => node.nodeName === 'button' && node.getReactProps()['aria-label'] === '重新开启挥手换素材')!.getReactProps().onClick());
    expect(capture.retry).toHaveBeenCalledOnce(); expect(f.send).not.toHaveBeenCalled();
  });
});
