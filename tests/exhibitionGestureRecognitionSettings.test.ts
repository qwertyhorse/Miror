import { act, createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GestureRecognitionSettings } from '../src/exhibition/GestureRecognitionSettings';
import { resolveExhibitionGestureSettings } from '../shared/exhibitionGestures';
import type { ExhibitionState } from '../shared/exhibition';
import type { ExhibitionController } from '../src/exhibition/useExhibition';
import { createReactHost, flushReact } from './support/reactHost';

let host: Awaited<ReturnType<typeof createReactHost>> | undefined;
let restoreDom: (() => void) | undefined;
afterEach(async () => { await host?.close(); host = undefined; restoreDom?.(); restoreDom = undefined; vi.restoreAllMocks(); vi.unstubAllGlobals(); });

async function fixture() {
  host = await createReactHost();
  const prototype = Object.getPrototypeOf(document.createElement('button'));
  const descriptors = new Map(['children', 'getBoundingClientRect', 'focus', 'matches', 'scrollIntoView'].map(key => [key, Object.getOwnPropertyDescriptor(prototype, key)]));
  Object.defineProperties(prototype, {
    children: { configurable: true, get() { return this.childNodes; } },
    getBoundingClientRect: { configurable: true, value: () => ({ top: 100, bottom: 139, left: 20, width: 200, height: 39 }) },
    focus: { configurable: true, value: function () { Reflect.set(document, 'activeElement', this); } },
    matches: { configurable: true, value: () => false },
    scrollIntoView: { configurable: true, value: () => {} },
  });
  vi.stubGlobal('Node', prototype.constructor);
  Object.assign(window, { innerWidth: 1280, innerHeight: 900 });
  restoreDom = () => descriptors.forEach((value, key) => { if (value) Object.defineProperty(prototype, key, value); else Reflect.deleteProperty(prototype, key); });
  const state: ExhibitionState = { mirrorId: 'default', revision: 7, phase: 'idle', experienceMode: 'clothx', selectedLookId: null, displayedLookId: null,
    looks: [], enabledLookIds: [], categories: [], tags: [], sessionNumber: 1, generationNumber: 2, updatedAt: 1, generationReadyAt: null, providerMode: 'xmax', live: null, logs: [],
    settings: { autoReturnSeconds: 90, uploadLimits: { maxFileSizeMB: 10, minWidth: 64, minHeight: 64, maxWidth: 4096, maxHeight: 4096 } } };
  const send = vi.fn<ExhibitionController['send']>(async command => {
    state.settings.gestureRecognition = command.gestureRecognition;
    state.revision++; return true;
  });
  const controller = { state, send, pending: false, stopPending: false, connected: true, error: '', clearError: vi.fn() } as unknown as ExhibitionController;
  const render = () => host!.render(createElement(GestureRecognitionSettings, { controller }));
  await render();
  const props = (predicate: Parameters<NonNullable<typeof host>['find']>[0]) => host!.find(predicate)!.getReactProps();
  const checkbox = (label: string) => host!.find(node => node.nodeName === 'label' && node.textContent === label)!.childNodes.find(node => node.nodeName === 'input')!.getReactProps();
  const input = (name: string) => props(node => node.nodeName === 'input' && node.getReactProps().name === name);
  const resolution = () => host!.find(node => node.getReactProps().role === 'combobox' && node.getReactProps()['aria-label'] === '识别分辨率（长边）')!;
  const resolutionKey = async (key: string) => act(async () => { resolution().getReactProps().onKeyDown({ key, preventDefault: vi.fn(), stopPropagation: vi.fn() }); });
  const button = (label: string) => props(node => node.nodeName === 'button' && node.textContent === label);
  const toggle = async (label: string, checked: boolean) => act(async () => { checkbox(label).onChange({ target: { checked } }); });
  const change = async (name: string, value: string) => act(async () => { input(name).onChange({ target: { value } }); });
  const submit = async () => { await act(async () => { props(node => node.nodeName === 'form').onSubmit({ preventDefault: vi.fn() }); }); await flushReact(); };
  return { state, controller, send, render, checkbox, input, resolution, resolutionKey, button, toggle, change, submit };
}

describe('per-mirror gesture recognition settings', () => {
  it('defaults old mirrors to palm only and displays the current working parameters', async () => {
    const f = await fixture();
    expect(f.checkbox('手掌识别').checked).toBe(true);
    expect(f.checkbox('左右挥手').checked).toBe(false);
    expect(f.input('palmConfirmMs').value).toBe('300');
    expect(f.input('minHandDetectionConfidence').value).toBe('0.35');
    expect(f.resolution().getReactProps()['data-value']).toBe('720');
    expect(host!.find(node => node.nodeName === 'select')).toBeUndefined();
    expect(f.button('保存识别设置').disabled).toBe(true);
    expect(f.send).not.toHaveBeenCalled();
  });
  it('saves multiple selected gestures and tuning parameters in one revision-protected command', async () => {
    const f = await fixture();
    await f.toggle('左右挥手', true);
    await f.change('palmConfirmMs', '450'); await f.change('maxFps', '10');
    await f.resolutionKey('ArrowDown');
    expect(f.resolution().getReactProps()['aria-expanded']).toBe(true);
    await f.resolutionKey('Home'); await f.resolutionKey('Enter');
    expect(f.resolution().getReactProps()['data-value']).toBe('480');
    expect(f.resolution().getReactProps()['aria-expanded']).toBe(false);
    expect(document.activeElement).toBe(f.resolution());
    f.state.revision = 10; await f.render();
    await f.submit();
    expect(f.send).toHaveBeenCalledExactlyOnceWith({ action: 'configure', expectedRevision: 10,
      gestureRecognition: { ...resolveExhibitionGestureSettings(), gestures: ['open_palm', 'wave'], palmConfirmMs: 450, maxFps: 10, inputLongEdge: 480 } });
    expect(f.checkbox('左右挥手').checked).toBe(true);
    expect(f.button('保存识别设置').disabled).toBe(true);
  });
  it('allows clearing all gestures and restores defaults as a reviewable draft', async () => {
    const f = await fixture(); await f.toggle('手掌识别', false); await f.submit();
    expect(f.state.settings.gestureRecognition?.gestures).toEqual([]);
    await act(async () => f.button('恢复默认').onClick());
    expect(f.checkbox('手掌识别').checked).toBe(true);
    expect(f.send).toHaveBeenCalledTimes(1);
    await f.submit();
    expect(f.send.mock.calls[1][0].gestureRecognition).toEqual(resolveExhibitionGestureSettings());
  });
  it.each([['palmConfirmMs', '149'], ['palmReleaseMs', '1501'], ['maxFps', '4'], ['maxFps', '7.5'], ['minHandDetectionConfidence', '0.01'], ['minHandPresenceConfidence', ''], ['minTrackingConfidence', 'Infinity']])('rejects invalid %s=%s without a request', async (name, value) => {
    const f = await fixture(); await f.change(name, value);
    expect(f.button('保存识别设置').disabled).toBe(true);
    await f.submit(); expect(f.send).not.toHaveBeenCalled();
  });
  it('preserves unsaved edits during polling and detects conflicting remote settings', async () => {
    const f = await fixture(); await f.change('maxFps', '10');
    f.state.revision++; await f.render(); expect(f.input('maxFps').value).toBe('10');
    f.state.settings.gestureRecognition = { ...resolveExhibitionGestureSettings(), maxFps: 20 }; await f.render();
    expect(f.input('maxFps').value).toBe('10'); expect(f.button('保存识别设置').disabled).toBe(true);
    await f.submit(); expect(f.send).not.toHaveBeenCalled();
    await act(async () => f.button('取消修改').onClick());
    expect(f.input('maxFps').value).toBe('20');
  });
  it.each(['pending', 'stopPending', 'disconnected', 'generating', 'showcase', 'paused', 'live'] as const)('blocks saving and direct checkbox handlers while %s', async reason => {
    const f = await fixture(); await f.change('maxFps', '10');
    if (reason === 'pending' || reason === 'stopPending') f.controller[reason] = true;
    else if (reason === 'disconnected') f.controller.connected = false;
    else if (reason === 'live') f.state.live = { status: 'stopping' } as ExhibitionState['live'];
    else f.state.phase = reason;
    await f.render(); expect(f.button('保存识别设置').disabled).toBe(true);
    expect(f.resolution().getReactProps().disabled).toBe(true);
    await f.resolutionKey('Home'); await f.resolutionKey('Enter');
    expect(f.resolution().getReactProps()['data-value']).toBe('720');
    await f.toggle('左右挥手', true); expect(f.checkbox('左右挥手').checked).toBe(false);
    await f.submit(); expect(f.send).not.toHaveBeenCalled();
  });
  it('blocks double submission before pending props update and retains a failed draft', async () => {
    const f = await fixture(); await f.change('maxFps', '10');
    let finish!: (saved: boolean) => void;
    f.send.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    await f.submit(); await f.submit(); expect(f.send).toHaveBeenCalledTimes(1);
    await act(async () => finish(false));
    expect(f.input('maxFps').value).toBe('10'); expect(f.button('保存识别设置').disabled).toBe(false);
    expect(host!.find(node => node.getReactProps().role === 'alert' && node.textContent.includes('未保存'))).toBeDefined();
  });
});
