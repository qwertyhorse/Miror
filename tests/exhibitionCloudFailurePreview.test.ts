import { act, createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ExhibitionState } from '../shared/exhibition';
import type { ExhibitionLiveController } from '../src/exhibition/useExhibitionLive';
import { Kiosk } from '../src/exhibition/ExhibitionApp';
import { exhibitionLooks } from '../src/exhibition/catalog';
import { createReactHost } from './support/reactHost';

const view = vi.hoisted(() => ({ stream: null as MediaStream | null, label: '', onFirstFrame: undefined as unknown }));
vi.mock('../src/exhibition/LiveCameraPanel', () => ({ StreamVideo: (props: { stream: MediaStream; label: string; onFirstFrame?: unknown }) => {
  Object.assign(view, props); return createElement('video', { 'aria-label': props.label });
} }));
vi.mock('../src/exhibition/useExhibitionGestures', () => ({ useExhibitionGestures: () => ({ status: 'ready', error: '', captureStatus: 'active', handDetected: false, retry: vi.fn() }) }));
vi.mock('../src/exhibition/MoXDragSurface', () => ({ MoXDragSurface: () => null }));

let host: Awaited<ReturnType<typeof createReactHost>> | undefined;
afterEach(async () => { await host?.close(); host = undefined; view.stream = null; view.label = ''; view.onFirstFrame = undefined; });
function snapshot(overrides: Partial<ExhibitionState> = {}): ExhibitionState {
  return { mirrorId: 'default', revision: 1, phase: 'paused', experienceMode: 'clothx', looks: structuredClone(exhibitionLooks),
    enabledLookIds: ['commute', 'city'], selectedLookId: 'commute', displayedLookId: 'commute',
    categories: [], tags: [], sessionNumber: 1, generationNumber: 1, updatedAt: 1, generationReadyAt: null,
    providerMode: 'xmax', live: null, logs: [], settings: { autoReturnSeconds: 90, uploadLimits: { maxFileSizeMB: 10, minWidth: 64, minHeight: 64, maxWidth: 4096, maxHeight: 4096 } }, ...overrides };
}
async function fixture({ ended = false, passive = false, remote = false, serverError = false } = {}) {
  host = await createReactHost();
  const camera = { getVideoTracks: () => [{ readyState: ended ? 'ended' : 'live' }] } as unknown as MediaStream;
  const output = {} as MediaStream;
  const live = { cameraStream: camera, outputStream: output, opening: false, error: 'XMax 请求超时或网络不可用。',
    status: 'error', deviceId: 'failure-screen', mirrored: true, secure: true, reportFirstFrame: vi.fn() } as unknown as ExhibitionLiveController;
  const state = snapshot(serverError ? { live: { status: 'error', deviceId: 'failure-screen', generationNumber: 1, lookId: 'commute' } as ExhibitionState['live'] } : {});
  const send = vi.fn(async () => true);
  await host.render(createElement(Kiosk, { state, live, send, passive, presentation: remote ? 'remote' : 'terminal' }));
  return { camera, output, send, live, text: host.find(node => node.nodeName === 'section')!.textContent };
}

describe('cloud generation failure retains healthy local capture', () => {
  it.each([false, true])('shows the local camera without claiming a generated frame (server error %s)', async serverError => {
    const f = await fixture({ serverError });
    expect(view.stream).toBe(f.camera); expect(view.stream).not.toBe(f.output);
    expect(view.label).toBe('本地取景'); expect(view.onFirstFrame).toBeUndefined();
    expect(f.text).toContain('XMax 请求超时或网络不可用。');
    expect(f.text).not.toContain('连接暂未恢复');
    expect(f.send).not.toHaveBeenCalled();
    expect(f.live.reportFirstFrame).not.toHaveBeenCalled();
  });

  it('does not present an ended camera as a working local preview', async () => {
    await fixture({ ended: true }); expect(view.stream).toBeNull();
  });

  it.each([{ passive: true }, { remote: true }])('keeps passive and remote pages from displaying a local capture (%j)', async options => {
    await fixture(options); expect(view.stream).toBeNull();
  });
});

describe('material updates preserve the generated view', () => {
  it.each([false, true])('retains the generated stream while switching, including a recoverable update error (%s)', async failed => {
    host = await createReactHost();
    const camera = { getVideoTracks: () => [{ readyState: 'live' }] } as unknown as MediaStream;
    const output = {} as MediaStream;
    const retryUpdate = vi.fn(async () => true);
    const live = { cameraStream: camera, outputStream: output, opening: false, error: '',
      updateError: failed ? '换装暂未完成，请重试。' : '', retryUpdate,
      status: failed ? 'running' : 'preparing', deviceId: 'failure-screen', mirrored: false, secure: true,
      reportFirstFrame: vi.fn() } as unknown as ExhibitionLiveController;
    const state = snapshot({ phase: 'generating', selectedLookId: 'city', generationNumber: 2,
      live: { status: 'running', deviceId: 'failure-screen', generationNumber: 1, lookId: 'commute' } as ExhibitionState['live'] });
    const send = vi.fn(async () => true);
    await host.render(createElement(Kiosk, { state, live, send }));
    expect(view.stream).toBe(output);
    expect(view.stream).not.toBe(camera);
    expect(view.label).toBe('生成结果');
    const section = host.find(node => node.nodeName === 'section')!;
    expect(section.textContent).toContain('正在换装');
    if (failed) {
      expect(section.textContent).toContain('换装暂未完成，请重试。');
      const retry = host.find(node => node.nodeName === 'button' && node.textContent === '重试换装')!;
      await act(async () => { await retry.getReactProps().onClick(); });
      expect(retryUpdate).toHaveBeenCalledOnce();
    }
    expect(send).not.toHaveBeenCalled();
  });
});
