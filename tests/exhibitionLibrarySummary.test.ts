import { act, createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ExhibitionMirrorSummary, ExhibitionState } from '../shared/exhibition';
import { MirrorConsole } from '../src/exhibition/MirrorConsole';
import { WardrobePanel } from '../src/exhibition/WardrobePanel';
import type { ExhibitionController } from '../src/exhibition/useExhibition';
import type { ExhibitionLiveController } from '../src/exhibition/useExhibitionLive';
import type { MirrorRegistry } from '../src/exhibition/useMirrors';
import { createReactHost, flushReact } from './support/reactHost';

let host: Awaited<ReturnType<typeof createReactHost>> | undefined;
let restoreSelectOptions: (() => void) | undefined;
afterEach(async () => { await host?.close(); host = undefined; restoreSelectOptions?.(); restoreSelectOptions = undefined; vi.unstubAllGlobals(); });

async function fixture(consoleView = false) {
  host = await createReactHost();
  const prototype = Object.getPrototypeOf(document.createElement('select'));
  const previousOptions = Object.getOwnPropertyDescriptor(prototype, 'options');
  Object.defineProperty(prototype, 'options', { configurable: true, get() { return this.childNodes.filter((node: { nodeName: string }) => node.nodeName === 'option'); } });
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
  restoreSelectOptions = () => {
    if (previousOptions) Object.defineProperty(prototype, 'options', previousOptions); else Reflect.deleteProperty(prototype, 'options');
    descriptors.forEach((value, key) => { if (value) Object.defineProperty(prototype, key, value); else Reflect.deleteProperty(prototype, key); });
  };
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ configured: true, source: 'default', revision: 1, editable: true,
    perSessionLimit: 30, totalLimit: 360, allocatedCredits: 0, remainingCredits: 360 })));
  const state: ExhibitionState = { mirrorId: 'east', revision: 7, phase: 'idle', experienceMode: 'clothx', selectedLookId: 'a', displayedLookId: null,
    looks: ['a', 'b', 'c'].map((id, index) => ({ id, mode: index === 2 ? 'free' : 'clothx', name: `素材${id}`, description: '', image: '/test.webp', source: 'sample', palette: '', category: '', tags: [] })),
    enabledLookIds: ['a', 'c'], categories: [], tags: [], sessionNumber: 0, generationNumber: 0, updatedAt: 1000, generationReadyAt: null, providerMode: 'xmax', live: null, logs: [],
    settings: { autoReturnSeconds: 90, uploadLimits: { maxFileSizeMB: 10, minWidth: 64, minHeight: 64, maxWidth: 4096, maxHeight: 4096 } } };
  const controller: ExhibitionController = { state, mirrorId: 'east', pending: false, stopPending: false, stopExperience: vi.fn(async () => true), connected: true, error: '', send: vi.fn(async () => true), upload: vi.fn(async () => null),
    updateLook: vi.fn(async () => true), deleteLook: vi.fn(async () => true), saveTaxonomy: vi.fn(async () => true), copyData: vi.fn(async () => true), uploadUiSkin: vi.fn(async () => true), removeUiSkin: vi.fn(async () => true),
    refresh: vi.fn(async () => {}), clearError: vi.fn() };
  const mirror: ExhibitionMirrorSummary = { id: 'east', name: '智能镜 East', revision: 7, phase: 'idle', providerMode: 'xmax', updatedAt: 1000, binding: null };
  const registry = { data: { defaultMirrorId: 'east', mirrors: [mirror] }, error: '', refresh: vi.fn(async () => {}) } as unknown as MirrorRegistry;
  const summary = vi.fn();
  const render = () => host!.render(consoleView ? createElement(MirrorConsole, { controller, live: { liveStatus: null, refreshStatus: vi.fn(async () => {}) } as unknown as ExhibitionLiveController, mirror, registry, selectMirror: vi.fn(), preview: null }) : createElement(WardrobePanel, { controller, onSummaryChange: summary }));
  const chooseMode = async (value: string) => { await act(async () => { host!.find(node => node.getReactProps().type === 'radio' && node.getReactProps().value === value)!.getReactProps().onChange(); }); };
  const chooseTab = async (tab: 'looks' | 'live') => { await act(async () => { host!.find(node => node.getReactProps().id === `mirror-tab-${tab}`)!.getReactProps().onClick(); }); await flushReact(); };
  const headerSummary = () => host!.find(node => node.getReactProps().className === 'ex-mirror-library-summary');
  await render(); await flushReact();
  return { state, controller, mirror, summary, render, chooseMode, chooseTab, headerSummary };
}

describe('material library summary in the mirror heading', () => {
  it('reports the current library filter without adding a library footer', async () => {
    const f = await fixture();
    expect(f.summary).toHaveBeenLastCalledWith('ClothX · 2 份素材 · 1 份已启用');
    expect(host!.find(node => node.getReactProps().className === 'ex-library-summary')).toBeUndefined();
    expect(host!.find(node => node.textContent.includes('大屏只展示当前体验模式的已启用素材'))).toBeUndefined();
    expect(host!.find(node => node.getReactProps().className === 'ex-library-filters')!.childNodes.map(node => node.getReactProps().className)).toEqual(['ex-mode-choices', 'ex-library-search', 'ex-library-actions']);
    await f.chooseMode('free');
    expect(f.summary).toHaveBeenLastCalledWith('Free · 1 份素材 · 1 份已启用');
    expect(f.state.experienceMode).toBe('clothx'); expect(f.controller.send).not.toHaveBeenCalled();
  });

  it('updates count changes and searches while keeping full-mode totals', async () => {
    const f = await fixture();
    f.state.enabledLookIds.push('b'); f.state.revision++; await f.render();
    expect(f.summary).toHaveBeenLastCalledWith('ClothX · 2 份素材 · 2 份已启用');
    await act(async () => { host!.find(node => node.getReactProps()['aria-label'] === '搜索素材')!.getReactProps().onChange({ target: { value: '素材a' } }); });
    expect(f.summary).toHaveBeenLastCalledWith('ClothX · 2 份素材 · 2 份已启用 · 搜索到 1 份');
    await host!.close(); host = undefined;
    expect(f.summary).toHaveBeenLastCalledWith(null);
  });

  it('keeps the device heading free of status and material summary rows across tabs', async () => {
    const f = await fixture(true);
    expect(f.headerSummary()).toBeUndefined();
    expect(host!.find(node => node.getReactProps().className === 'ex-mirror-status-row')).toBeUndefined();
    expect(host!.find(node => node.textContent.includes('大屏只展示此模式中已启用的素材。'))).toBeUndefined();
    await f.chooseTab('looks');
    expect(f.headerSummary()).toBeUndefined();
    await f.chooseMode('free');
    expect(f.headerSummary()).toBeUndefined();
    await f.chooseTab('live'); expect(f.headerSummary()).toBeUndefined();
    await f.chooseTab('looks');
    expect(f.headerSummary()).toBeUndefined();
    expect(host!.find(node => node.getReactProps().className === 'ex-mirror-status-row')).toBeUndefined();
  });

  it('does not carry the previous mirror library summary into another mirror', async () => {
    const f = await fixture(true); await f.chooseTab('looks'); await f.chooseMode('free');
    f.controller.mirrorId = 'west'; f.state.mirrorId = 'west'; f.mirror.id = 'west'; f.mirror.name = '智能镜 West';
    await f.render(); await flushReact();
    expect(f.headerSummary()).toBeUndefined();
    await f.chooseTab('looks');
    expect(f.headerSummary()).toBeUndefined();
  });

  it('omits the busy explanation while preserving material editing guards', async () => {
    const f = await fixture();
    f.state.phase = 'generating'; await f.render();
    expect(host!.find(node => node.getReactProps().className === 'ex-inline-note')).toBeUndefined();
    const enable = host!.find(node => node.getReactProps()['aria-label'] === '启用素材a')!;
    expect(enable.getReactProps().disabled).toBe(true);
    const upload = host!.find(node => node.nodeName === 'button' && node.textContent === '上传素材')!;
    expect(upload.getReactProps().disabled).toBe(false);
    expect(f.controller.send).not.toHaveBeenCalled();
  });
});

describe('priority stop in the staff console', () => {
  it.each(['generating-pending', 'begin-pending', 'stopping-retry'] as const)('uses the independent stop channel for %s', async scenario => {
    const f = await fixture(true);
    f.controller.connected = false;
    if (scenario === 'generating-pending') { f.state.phase = 'generating'; f.controller.pending = true; }
    if (scenario === 'begin-pending') f.controller.pending = true;
    if (scenario === 'stopping-retry') f.state.live = { status: 'stopping' } as ExhibitionState['live'];
    await f.render();
    const stop = host!.find(node => node.nodeName === 'button' && node.textContent === '停止生成')!;
    expect(stop.getReactProps().disabled).toBe(false);
    await act(async () => stop.getReactProps().onClick());
    expect(f.controller.stopExperience).toHaveBeenCalledOnce();
    expect(f.controller.send).not.toHaveBeenCalled();
    f.controller.stopPending = true; await f.render();
    const stopping = host!.find(node => node.nodeName === 'button' && node.textContent === '正在停止…')!;
    expect(stopping).toBeDefined();
    expect(stopping.textContent).toBe('正在停止…');
    expect(stopping.getReactProps().disabled).toBe(true);
    await act(async () => stopping.getReactProps().onClick());
    expect(f.controller.stopExperience).toHaveBeenCalledOnce();
  });
});

describe('custom device setting selectors', () => {
  const combo = (label: string) => host!.find(node => node.getReactProps().role === 'combobox' && node.getReactProps()['aria-label'] === label)!;
  const key = async (label: string, value: string) => { await act(async () => combo(label).getReactProps().onKeyDown({ key: value, preventDefault: vi.fn(), stopPropagation: vi.fn() })); };

  it('uses custom controls for both device settings with no native select', async () => {
    await fixture(true);
    expect(host!.find(node => node.nodeName === 'select')).toBeUndefined();
    expect(combo('无操作返回待机').getReactProps()['data-value']).toBe('90');
    expect(combo('运行方式').getReactProps()['data-value']).toBe('xmax');
  });

  it('keeps a keyboard-selected return time bound to the original revision until saving', async () => {
    const f = await fixture(true);
    const trigger = combo('无操作返回待机'); (trigger as unknown as HTMLElement).focus();
    await key('无操作返回待机', 'ArrowDown');
    expect(combo('无操作返回待机').getReactProps()['aria-expanded']).toBe(true);
    await key('无操作返回待机', 'End'); await key('无操作返回待机', 'Enter');
    expect(combo('无操作返回待机').getReactProps()['data-value']).toBe('300');
    expect(combo('无操作返回待机').getReactProps()['aria-expanded']).toBe(false);
    expect(document.activeElement).toBe(trigger);
    expect(f.controller.send).not.toHaveBeenCalled();
    f.state.revision = 9; f.state.settings.autoReturnSeconds = 60; await f.render();
    expect(combo('无操作返回待机').getReactProps()['data-value']).toBe('300');
    await act(async () => host!.find(node => node.nodeName === 'button' && node.textContent === '保存')!.getReactProps().onClick());
    expect(f.controller.send).toHaveBeenCalledExactlyOnceWith({ action: 'configure', autoReturnSeconds: 300, expectedRevision: 7 });
  });

  it('dismisses on Escape, Tab and outside focus without applying a selection', async () => {
    const f = await fixture(true);
    await key('运行方式', 'Home'); await key('运行方式', 'Escape');
    expect(combo('运行方式').getReactProps()['aria-expanded']).toBe(false);
    await key('运行方式', 'ArrowDown'); await key('运行方式', 'Tab');
    expect(combo('运行方式').getReactProps()['aria-expanded']).toBe(false);
    await key('运行方式', 'ArrowDown');
    const event = new Event('focusin'); Object.defineProperty(event, 'target', { value: document.body });
    await act(async () => document.dispatchEvent(event));
    expect(combo('运行方式').getReactProps()['aria-expanded']).toBe(false);
    expect(f.controller.send).not.toHaveBeenCalled();
  });

  it('applies a clicked provider option and closes the list when device editing becomes locked', async () => {
    const f = await fixture(true);
    await act(async () => combo('运行方式').getReactProps().onClick());
    const option = host!.find(node => node.getReactProps().role === 'option' && node.getReactProps()['data-value'] === 'demo')!;
    await act(async () => option.getReactProps().onClick());
    expect(f.controller.send).toHaveBeenCalledExactlyOnceWith({ action: 'configure', providerMode: 'demo' });
    expect(document.activeElement).toBe(combo('运行方式'));
    await key('运行方式', 'ArrowDown');
    f.state.phase = 'generating'; await f.render();
    expect(combo('运行方式').getReactProps().disabled).toBe(true);
    expect(combo('运行方式').getReactProps()['aria-expanded']).toBe(false);
    expect(combo('无操作返回待机').getReactProps().disabled).toBe(true);
  });
});
