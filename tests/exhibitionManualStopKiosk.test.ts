import { materialCatalogFixture } from './support/materialCatalogFixture';
import { act, createElement, type ComponentProps } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Kiosk } from '../src/exhibition/ExhibitionApp';
import type { ExhibitionState } from '../shared/exhibition';
import type { ExhibitionLiveController } from '../src/exhibition/useExhibitionLive';
import { createReactHost, flushReact } from './support/reactHost';

let host: Awaited<ReturnType<typeof createReactHost>> | undefined;
afterEach(async () => { await host?.close(); host = undefined; vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

async function fixture(overrides: Partial<ComponentProps<typeof Kiosk>> = {}) {
  host = await createReactHost();
  const state: ExhibitionState = materialCatalogFixture({
    mirrorId: 'default', revision: 1, phase: 'idle', providerMode: 'xmax', experienceMode: 'clothx',
    selectedLookId: 'look', displayedLookId: null, enabledLookIds: ['look'], categories: [], tags: [],
    looks: [{ id: 'look', mode: 'clothx', name: '测试服装', image: '/test.png', source: 'sample', description: '', category: '', palette: '', tags: [] }],
    sessionNumber: 1, generationNumber: 1, updatedAt: 0, generationReadyAt: null, live: null, logs: [],
    settings: { autoReturnSeconds: 90, uploadLimits: { maxFileSizeMB: 10, minWidth: 64, minHeight: 64, maxWidth: 4096, maxHeight: 4096 } },
  });
  const send = vi.fn(async () => true);
  const stopExperience = vi.fn(async () => true);
  const stopGeneration = vi.fn(async () => true);
  const startCamera = vi.fn(async () => true);
  const live: ExhibitionLiveController = {
    cameraStream: null, outputStream: null, interaction: null, presentation: null, status: 'off', error: '', opening: false,
    deviceId: 'local-screen', cameras: [], selectedCameraId: '', mirrored: true, setMirrored: vi.fn(), secure: true, liveStatus: null,
    startCamera, stopCamera: vi.fn(), stopGeneration, retry: vi.fn(async () => true), reportFirstFrame: vi.fn(), refreshStatus: vi.fn(async () => {}),
  };
  const props = { state, send, stopExperience, live, ...overrides };
  const render = () => host!.render(createElement(Kiosk, props));
  await render();
  const button = (label: string) => host!.find(node => {
    const props = node.getReactProps();
    const text = [props.children].flat().filter(value => typeof value === 'string').join('');
    return node.nodeName === 'button' && (text === label || props['aria-label'] === label);
  })?.getReactProps();
  async function click(label: string) { const target = button(label); expect(target, label).toBeDefined(); await act(async () => { target!.onClick(); }); await flushReact(); }
  return { state, props, live, send, stopExperience, stopGeneration, startCamera, render, button, click };
}

describe('mirror manual stop controls', () => {
  it('recovers an ended local experience without stopping again or starting generation', async () => {
    const f = await fixture();
    f.state.phase = 'select';
    f.state.live = { status: 'error', sessionId: 'unknown-fixture', deviceId: 'screen-fixture', generationNumber: 1, lookId: f.state.selectedLookId!, heartbeatAt: 1, updatedAt: 1,
      localEnded: true, error: '本地体验已结束，云端凭证状态待确认。' };
    await f.render();
    expect(f.button('停止生成')).toBeUndefined();
    expect(f.button('恢复操作')?.disabled).toBe(false);
    expect(host!.find(node => node.getReactProps().role === 'alert')).toBeUndefined();
    expect(host!.find(node => node.getReactProps().role === 'status' && node.textContent.includes('本地体验已结束'))).toBeDefined();
    await f.click('恢复操作');
    expect(f.send).toHaveBeenCalledExactlyOnceWith({ action: 'recover' });
    expect(f.stopExperience).not.toHaveBeenCalled(); expect(f.stopGeneration).not.toHaveBeenCalled(); expect(f.startCamera).not.toHaveBeenCalled();
  });

  it.each([
    { disabled: true }, { passive: true }, { canControl: false }, { send: undefined },
    { commandPending: true }, { stopPending: true },
  ])('blocks recovery when the mirror cannot accept another operation: %j', async overrides => {
    const f = await fixture(overrides);
    f.state.phase = 'select';
    f.state.live = { status: 'error', localEnded: true } as ExhibitionState['live'];
    await f.render();
    const label = overrides.commandPending ? '恢复中…' : '恢复操作';
    expect(f.button(label)?.disabled).toBe(true);
    await f.click(label);
    expect(f.send).not.toHaveBeenCalled(); expect(f.stopExperience).not.toHaveBeenCalled();
    expect(f.stopGeneration).not.toHaveBeenCalled(); expect(f.startCamera).not.toHaveBeenCalled();
    expect(f.button('停止生成')).toBeUndefined();
  });

  it('offers recovery even after the current mode has lost its usable materials', async () => {
    const f = await fixture();
    f.state.phase = 'idle'; f.state.looks = []; f.state.enabledLookIds = []; f.state.selectedLookId = null;
    f.state.live = { status: 'error', localEnded: true } as ExhibitionState['live'];
    await f.render();
    expect(f.button('恢复操作')?.disabled).toBe(false);
    await f.click('恢复操作');
    expect(f.send).toHaveBeenCalledExactlyOnceWith({ action: 'recover' });
    expect(f.stopExperience).not.toHaveBeenCalled(); expect(f.stopGeneration).not.toHaveBeenCalled(); expect(f.startCamera).not.toHaveBeenCalled();
  });

  it('cancels a begin waiting for camera permission and ignores the late camera result', async () => {
    const f = await fixture();
    const camera = deferred<boolean>(); f.startCamera.mockReturnValueOnce(camera.promise);
    await f.click('开始体验');
    expect(f.startCamera).toHaveBeenCalledOnce(); expect(f.send).not.toHaveBeenCalled();
    expect(f.button('停止生成')?.disabled).toBe(false);
    await f.click('停止生成');
    expect(f.stopExperience).toHaveBeenCalledOnce(); expect(f.stopGeneration).toHaveBeenCalledOnce();
    await act(async () => { camera.resolve(true); }); await flushReact();
    expect(f.send).not.toHaveBeenCalled(); expect(f.button('开始体验')).toBeDefined();
  });

  it('keeps stop available while the begin command is still pending in the welcome phase', async () => {
    const f = await fixture({ commandPending: true, disabled: true });
    expect(f.button('停止生成')?.disabled).toBe(false);
    await f.click('停止生成');
    expect(f.stopExperience).toHaveBeenCalledOnce(); expect(f.stopGeneration).toHaveBeenCalledOnce();
  });

  it('sends local and backend stop despite the general offline disabled state', async () => {
    const f = await fixture({ disabled: true });
    f.state.phase = 'generating'; await f.render();
    expect(f.button('停止生成')?.disabled).toBe(false);
    await f.click('停止生成');
    expect(f.stopGeneration).toHaveBeenCalledOnce(); expect(f.stopExperience).toHaveBeenCalledOnce();
    expect(f.send).not.toHaveBeenCalled();
  });

  it.each([{ canControl: false, disabled: true }, { passive: true }])('blocks stop for a page without mirror control: %j', async overrides => {
    const f = await fixture(overrides);
    f.state.phase = 'generating'; await f.render();
    expect(f.button('停止生成')?.disabled).toBe(true);
    await f.click('停止生成');
    expect(f.stopGeneration).not.toHaveBeenCalled(); expect(f.stopExperience).not.toHaveBeenCalled(); expect(f.send).not.toHaveBeenCalled();
  });

  it('allows a failed stop to be retried without starting a new experience', async () => {
    const f = await fixture();
    f.state.phase = 'generating'; f.stopGeneration.mockResolvedValueOnce(false); await f.render();
    await f.click('停止生成');
    expect(host!.find(node => node.getReactProps().role === 'alert')?.textContent).toContain('停止状态未确认，请联系工作人员。');
    expect(f.button('停止生成')?.disabled).toBe(false);
    await f.click('停止生成');
    expect(f.stopGeneration).toHaveBeenCalledTimes(2); expect(f.stopExperience).toHaveBeenCalledTimes(2);
    expect(host!.find(node => node.getReactProps().role === 'alert')).toBeUndefined();
    expect(f.send).not.toHaveBeenCalled(); expect(f.startCamera).not.toHaveBeenCalled();
  });

  it('starts backend stop independently when local stop throws and deduplicates concurrent controls', async () => {
    const f = await fixture();
    f.state.phase = 'showcase'; const pending = deferred<boolean>();
    f.stopGeneration.mockImplementationOnce(() => { throw new Error('SDK stop failed'); });
    f.stopExperience.mockReturnValueOnce(pending.promise); await f.render();
    await f.click('停止生成');
    expect(f.stopExperience).toHaveBeenCalledOnce(); expect(f.button('正在停止…')?.disabled).toBe(true);
    await f.click('返回首页');
    expect(f.send).not.toHaveBeenCalled(); expect(f.stopGeneration).toHaveBeenCalledOnce(); expect(f.stopExperience).toHaveBeenCalledOnce();
    await act(async () => { pending.resolve(true); }); await flushReact();
    expect(f.button('停止生成')?.disabled).toBe(false);
    expect(host!.find(node => node.getReactProps().role === 'alert')?.textContent).toContain('停止状态未确认，请联系工作人员。');
  });
});
