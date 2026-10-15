import { act, createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExhibitionState } from '../shared/exhibition';
import { MirrorPreview } from '../src/exhibition/ExhibitionApp';
import type { ExhibitionController } from '../src/exhibition/useExhibition';
import { createReactHost, flushReact } from './support/reactHost';

vi.mock('../src/exhibition/LiveCameraPanel', () => ({ StreamVideo: () => null, LiveCameraPanel: () => null }));
vi.mock('../src/exhibition/MoXDragSurface', () => ({ MoXDragSurface: () => null }));

type PreviewController = Pick<ExhibitionController, 'send' | 'stopExperience' | 'pending' | 'stopPending' | 'connected'>;
let host: Awaited<ReturnType<typeof createReactHost>> | undefined;
beforeEach(() => { vi.useFakeTimers(); });
afterEach(async () => {
  await host?.close(); host = undefined;
  vi.useRealTimers(); vi.unstubAllGlobals();
});

function snapshot(overrides: Partial<ExhibitionState> = {}): ExhibitionState {
  return { mirrorId: 'preview-test', revision: 1, phase: 'idle', experienceMode: 'clothx', selectedLookId: 'first', displayedLookId: null,
    looks: ['first', 'second'].map(id => ({ id, mode: 'clothx', name: id, description: '', image: `/${id}.png`, source: 'sample', palette: '', category: '', tags: [] })),
    enabledLookIds: ['first', 'second'], categories: [], tags: [], sessionNumber: 1, generationNumber: 1, updatedAt: 1, generationReadyAt: null,
    providerMode: 'xmax', live: null, logs: [], settings: { autoReturnSeconds: 90, uploadLimits: { maxFileSizeMB: 10, minWidth: 64, minHeight: 64, maxWidth: 4096, maxHeight: 4096 } }, ...overrides };
}

function childText(children: unknown): string {
  if (typeof children === 'string' || typeof children === 'number') return String(children);
  if (Array.isArray(children)) return children.map(childText).join('');
  if (children && typeof children === 'object' && 'props' in children) {
    return childText((children as { props: { children?: unknown } }).props.children);
  }
  return '';
}

async function fixture(controllerOverrides: Partial<PreviewController> = {}) {
  host = await createReactHost();
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}')));
  const getUserMedia = vi.fn();
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia, enumerateDevices: vi.fn(async () => []) } });
  let state = snapshot();
  const send = vi.fn(async () => true);
  const stopExperience = vi.fn(async () => true);
  let controller: PreviewController = { send, stopExperience, pending: false, stopPending: false, connected: true, ...controllerOverrides };
  const render = () => host!.render(createElement(MirrorPreview, { state, controller }));
  const button = (name: string) => {
    const node = host!.find(item => item.nodeName === 'button' && (childText(item.getReactProps().children) === name || item.attributes['aria-label'] === name));
    expect(node, `button ${name}`).toBeDefined();
    return node!;
  };
  const click = async (name: string) => { await act(async () => { button(name).getReactProps().onClick(); }); await flushReact(); };
  const kiosk = () => host!.find(node => node.nodeName === 'section' && node.getReactProps().className?.includes('ex-kiosk'))!;
  await render();
  return { send, stopExperience, getUserMedia, button, click, kiosk,
    update: async (next: Partial<ExhibitionState>) => { state = { ...state, ...next }; await render(); },
    updateController: async (next: Partial<PreviewController>) => { controller = { ...controller, ...next }; await render(); } };
}

describe('interactive mirror console preview', () => {
  it('opens the real-device preview without sending commands or opening a local camera', async () => {
    const f = await fixture();
    expect(host!.find(node => node.attributes['aria-label'] === '镜端预览')).toBeDefined();
    expect(f.kiosk().attributes['aria-label']).toBe('镜端远程控制');
    expect(host!.find(node => node.nodeName === 'button' && ['本地模拟', '真机控制'].includes(childText(node.getReactProps().children)))).toBeUndefined();
    expect(f.button('开始体验').getReactProps().disabled).toBeFalsy();
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    expect(f.button('开始体验').getReactProps().disabled).toBeFalsy();

    expect(f.send).not.toHaveBeenCalled();
    expect(f.stopExperience).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    expect(f.getUserMedia).not.toHaveBeenCalled();
  });

  it('routes real-device start, stop, and home actions to the controller without requesting a local camera', async () => {
    const f = await fixture();
    expect(f.kiosk().attributes['aria-label']).toBe('镜端远程控制');
    await f.click('开始体验');
    expect(f.send).toHaveBeenCalledExactlyOnceWith({ action: 'begin' });

    await f.update({ phase: 'generating' });
    await f.click('停止生成');
    expect(f.stopExperience).toHaveBeenCalledTimes(1);
    expect(f.send).toHaveBeenCalledTimes(1);
    await f.click('返回首页');
    expect(f.send).toHaveBeenLastCalledWith({ action: 'idle' });
    expect(f.getUserMedia).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('resumes a paused real device without requesting a local camera', async () => {
    const f = await fixture();
    await f.update({ phase: 'paused', live: null });
    await f.click('继续体验');
    expect(f.send).toHaveBeenCalledExactlyOnceWith({ action: 'resume' });
    expect(f.stopExperience).not.toHaveBeenCalled();
    expect(f.getUserMedia).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('recovers a locally ended real device without requesting a local camera or issuing a new start', async () => {
    const f = await fixture();
    await f.update({ phase: 'select', live: { status: 'error', localEnded: true } as ExhibitionState['live'] });
    expect(f.button('恢复操作').getReactProps().disabled).toBeFalsy();
    await f.click('恢复操作');
    expect(f.send).toHaveBeenCalledExactlyOnceWith({ action: 'recover' });
    expect(f.stopExperience).not.toHaveBeenCalled();
    expect(f.getUserMedia).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
  });

  it.each([{ connected: false }, { pending: true }, { stopPending: true }])('blocks remote recovery while the controller is unavailable: %j', async controller => {
    const f = await fixture(controller);
    await f.update({ phase: 'select', live: { status: 'error', localEnded: true } as ExhibitionState['live'] });
    const recovery = f.button(controller.pending ? '恢复中…' : '恢复操作');
    expect(recovery.getReactProps().disabled).toBe(true);
    await f.click(controller.pending ? '恢复中…' : '恢复操作');
    expect(f.send).not.toHaveBeenCalled(); expect(f.stopExperience).not.toHaveBeenCalled();
    expect(f.getUserMedia).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    { connected: false },
    { stopPending: true },
  ])('disables real-device start while the controller is unavailable: %j', async controller => {
    const f = await fixture(controller);
    const start = host!.find(node => node.nodeName === 'button' && childText(node.getReactProps().children) === '开始体验');
    const stop = host!.find(node => node.nodeName === 'button' && node.getReactProps()['aria-label'] === '正在停止…');
    expect((start ?? stop)?.getReactProps().disabled).toBe(true);
    expect(f.send).not.toHaveBeenCalled();
    expect(f.stopExperience).not.toHaveBeenCalled();
    expect(f.getUserMedia).not.toHaveBeenCalled();
  });

  it('keeps priority stop available while a real-device command is pending', async () => {
    const f = await fixture({ pending: true });
    expect(host!.find(node => node.nodeName === 'button' && childText(node.getReactProps().children) === '开始体验')).toBeUndefined();
    expect(f.button('停止生成').getReactProps().disabled).toBeFalsy();
    await f.click('停止生成');
    expect(f.stopExperience).toHaveBeenCalledTimes(1);
    expect(f.send).not.toHaveBeenCalled();
    expect(f.getUserMedia).not.toHaveBeenCalled();
  });
});
