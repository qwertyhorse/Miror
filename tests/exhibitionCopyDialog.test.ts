import { act, createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CopyDialog } from '../src/exhibition/CopyDialog';
import { MirrorConsole } from '../src/exhibition/MirrorConsole';
import type { ExhibitionController } from '../src/exhibition/useExhibition';
import type { ExhibitionLiveController } from '../src/exhibition/useExhibitionLive';
import type { MirrorRegistry } from '../src/exhibition/useMirrors';
import type { ExhibitionExperienceMode, ExhibitionLook, ExhibitionMirrorSummary, ExhibitionState } from '../shared/exhibition';
import { createReactHost, flushReact } from './support/reactHost';

const mocks = vi.hoisted(() => ({ controllers: new Map<string, ExhibitionController>(), targets: [] as string[] }));
vi.mock('../src/exhibition/useExhibition', () => ({ useExhibition: (id: string) => { mocks.targets.push(id); return mocks.controllers.get(id)!; } }));
let host: Awaited<ReturnType<typeof createReactHost>> | undefined;
afterEach(async () => { await host?.close(); host = undefined; mocks.controllers.clear(); mocks.targets = []; vi.unstubAllGlobals(); });

function look(mode: ExhibitionExperienceMode = 'clothx'): ExhibitionLook {
  return { id: 'original', mode, name: '银白仙侠袍', description: '保留说明', image: '/display.png', referenceImage: '/reference.png', source: 'upload', palette: '', category: '', tags: [], ...(mode === 'free' ? { prompt: '保留动作，变换场景' } : {}) };
}
function control(id: string, phase: ExhibitionState['phase'] = 'idle'): ExhibitionController {
  const state = { mirrorId: id, revision: id === 'source' ? 4 : 9, phase, experienceMode: 'clothx', selectedLookId: 'original', displayedLookId: null,
    looks: [look()], enabledLookIds: ['original'], categories: [], tags: [], sessionNumber: 0, generationNumber: 0, updatedAt: 1, generationReadyAt: null,
    providerMode: 'demo', live: null, logs: [], settings: { autoReturnSeconds: 60, uploadLimits: { maxFileSizeMB: 10, minWidth: 64, minHeight: 64, maxWidth: 4096, maxHeight: 4096 } } } as ExhibitionState;
  return { state, mirrorId: id, pending: false, connected: true, error: '', clearError: vi.fn(), copyData: vi.fn(async () => true), copyLook: vi.fn(async () => ({ lookId: 'new', index: 1 })),
    refresh: vi.fn(async () => {}), send: vi.fn(async () => true) } as unknown as ExhibitionController;
}
function summary(controller: ExhibitionController): ExhibitionMirrorSummary {
  return { id: controller.mirrorId, name: controller.mirrorId === 'source' ? '智能镜一' : controller.mirrorId === 'target' ? '智能镜二' : '智能镜三', binding: null,
    revision: controller.state!.revision, phase: controller.state!.phase, providerMode: 'demo', updatedAt: 1 };
}
async function fixture(options: { material?: ExhibitionLook; onlySource?: boolean; sourcePhase?: ExhibitionState['phase'] } = {}) {
  host = await createReactHost();
  vi.stubGlobal('HTMLElement', window.HTMLElement);
  type TestNode = ReturnType<typeof document.createElement> & { childNodes: TestNode[]; getReactProps: () => Record<string, any> };
  const find = (root: TestNode, predicate: (node: TestNode) => boolean): TestNode | null => predicate(root) ? root : root.childNodes.map(child => find(child, predicate)).find(Boolean) ?? null;
  Object.assign(window.HTMLElement.prototype, {
    showModal(this: HTMLDialogElement) { this.open = true; }, close(this: HTMLDialogElement) { this.open = false; },
    focus(this: HTMLElement) {
      let ancestor: HTMLElement | null = this;
      while (ancestor) { if (ancestor.nodeName === 'dialog' && !(ancestor as HTMLDialogElement).open) return; ancestor = ancestor.parentNode as HTMLElement | null; }
      Object.assign(document, { activeElement: this });
    },
    matches(this: TestNode, selector: string) { return selector === ':disabled' && !!this.getReactProps().disabled; },
    querySelector(this: TestNode, selector: string) { return find(this, node => node.nodeName === selector); },
  });
  Object.defineProperty(window.HTMLElement.prototype, 'options', { configurable: true, get(this: TestNode) { return this.childNodes.filter(node => node.nodeName === 'option'); } });
  Object.defineProperty(window.HTMLElement.prototype, 'isConnected', { configurable: true, get(this: Node) { return document.body.contains(this); } });
  const source = control('source', options.sourcePhase);
  const target = control('target'); const third = control('third');
  [source, target, third].forEach(item => mocks.controllers.set(item.mirrorId, item));
  const registry = { data: { defaultMirrorId: 'source', mirrors: (options.onlySource ? [source] : [source, target, third]).map(summary) }, error: '', refresh: vi.fn(async () => {}) } as unknown as MirrorRegistry;
  const copied = vi.fn(); const close = vi.fn();
  const render = () => host!.render(createElement(CopyDialog, { source: summary(source), registry, look: options.material, close, copied }));
  const node = (tag: string, label?: string) => host!.find(item => item.nodeName === tag && (label === undefined || item.textContent === label))!;
  const radio = (mode: string) => host!.find(item => item.getReactProps().type === 'radio' && item.getReactProps().value === mode)!;
  const click = async (label: string) => { await act(async () => { node('button', label).getReactProps().onClick(); }); };
  const submit = async () => { await act(async () => { node('form').getReactProps().onSubmit({ preventDefault: vi.fn() }); }); await flushReact(); };
  await render();
  return { source, target, third, registry, copied, close, render, node, radio, click, submit };
}

describe('copy destination dialogs', () => {
  it('copies the current source to another mirror using that target revision and a concise replacement confirmation', async () => {
    const f = await fixture({ sourcePhase: 'generating' });
    expect(f.node('select').getReactProps().value).toBe('target');
    expect(mocks.targets.every(id => id === 'target')).toBe(true);
    await f.submit();
    expect(host!.find(node => node.getReactProps().className === 'ex-copy-direction')!.textContent).toBe('智能镜一智能镜二');
    expect(host!.find(node => node.getReactProps().className === 'ex-copy-replace')!.textContent).toBe('替换内容素材资料设备设置');
    await f.submit();
    expect(f.target.copyData).toHaveBeenCalledExactlyOnceWith({ sourceMirrorId: 'source', expectedRevision: 9, copyLooks: true, copySettings: true });
    expect(f.source.copyData).not.toHaveBeenCalled();
    expect(f.copied).toHaveBeenCalledExactlyOnceWith('target', '已复制到「智能镜二」');
    expect(f.close).toHaveBeenCalledOnce();
  });

  it('keeps the top-level copy action available while the source is experiencing', async () => {
    const f = await fixture({ sourcePhase: 'showcase' });
    await host!.render(createElement(MirrorConsole, { controller: f.source, live: { liveStatus: null } as ExhibitionLiveController, mirror: summary(f.source), registry: f.registry, selectMirror: vi.fn(), preview: null }));
    expect(f.node('button', '复制到…').getReactProps().disabled).toBe(false);
    await f.click('复制到…');
    expect(f.node('select').getReactProps().value).toBe('target');
  });

  it('preserves the chosen replacement sections', async () => {
    const f = await fixture();
    const checkbox = host!.find(node => node.getReactProps().type === 'checkbox')!;
    await act(async () => checkbox.getReactProps().onChange({ target: { checked: false } }));
    await f.submit(); await f.submit();
    expect(f.target.copyData).toHaveBeenCalledWith({ sourceMirrorId: 'source', expectedRevision: 9, copyLooks: false, copySettings: true });
  });

  it('defaults single-copy to the source group, requires a Free prompt, and guards duplicate submits', async () => {
    const f = await fixture({ material: look() });
    expect(f.node('select').getReactProps().value).toBe('target');
    expect(f.radio('clothx').getReactProps().checked).toBe(true);
    expect(f.node('img').getReactProps().src).toContain('/display.png');
    await act(async () => f.radio('free').getReactProps().onChange());
    expect(f.node('textarea').getReactProps().value).toBe('');
    expect(f.node('button', '复制').getReactProps().disabled).toBe(true);
    await f.submit(); expect(f.target.copyLook).not.toHaveBeenCalled();
    await act(async () => f.node('textarea').getReactProps().onChange({ target: { value: '  新的提示词  ' } }));
    let finish!: (result: { lookId: string; index: number }) => void;
    vi.mocked(f.target.copyLook).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    await act(async () => { const send = f.node('form').getReactProps().onSubmit; send({ preventDefault: vi.fn() }); send({ preventDefault: vi.fn() }); });
    expect(f.target.copyLook).toHaveBeenCalledExactlyOnceWith({ sourceMirrorId: 'source', sourceLookId: 'original', mode: 'free', expectedRevision: 9, prompt: '新的提示词' });
    expect(f.node('select').getReactProps().disabled).toBe(true);
    await act(async () => finish({ lookId: 'new', index: 1 }));
    expect(f.copied).toHaveBeenCalledExactlyOnceWith('target', '已复制到「智能镜二 · Free」');
  });

  it('allows same-device duplication and limits a prompt-only material to Free', async () => {
    const material = { ...look('free'), referenceKind: 'none' as const, referenceImage: undefined };
    const f = await fixture({ material, onlySource: true });
    expect(f.node('select').getReactProps().value).toBe('source');
    expect(f.node('textarea').getReactProps().value).toBe(material.prompt);
    for (const mode of ['charx', 'clothx', 'vibex', 'dimx', 'mox']) expect(f.radio(mode).getReactProps().disabled).toBe(true);
    expect(f.radio('free').getReactProps().disabled).toBe(false);
    await f.submit();
    expect(f.source.copyLook).toHaveBeenCalledExactlyOnceWith({ sourceMirrorId: 'source', sourceLookId: 'original', mode: 'free', expectedRevision: 4, prompt: material.prompt });
  });

  it('freezes the target revision, requires explicit refresh, and never auto-submits after refresh', async () => {
    const f = await fixture({ material: look() });
    f.target.state = { ...f.target.state!, revision: 10 };
    await f.render();
    expect(f.node('button', '复制').getReactProps().disabled).toBe(true);
    expect(host!.find(node => node.getReactProps().role === 'alert')!.textContent).toContain('目标数据已更新');
    await f.submit(); expect(f.target.copyLook).not.toHaveBeenCalled();
    await f.click('刷新目标');
    expect(document.activeElement).toBe(f.node('select'));
    expect(f.target.copyLook).not.toHaveBeenCalled();
    await f.submit();
    expect(f.target.copyLook).toHaveBeenCalledWith({ sourceMirrorId: 'source', sourceLookId: 'original', mode: 'clothx', expectedRevision: 10 });
  });

  it('switches to a fresh target scope, clears prior errors and preserves the selected group', async () => {
    const f = await fixture({ material: look() });
    f.target.error = '原目标保存失败';
    await f.render();
    expect(host!.find(node => node.getReactProps().role === 'alert')!.textContent).toBe('原目标保存失败');
    await act(async () => f.radio('vibex').getReactProps().onChange());
    await act(async () => f.node('select').getReactProps().onChange({ target: { value: 'third' } }));
    expect(host!.find(node => node.getReactProps().role === 'alert')).toBeUndefined();
    expect(f.radio('vibex').getReactProps().checked).toBe(true);
    await f.submit();
    expect(f.third.copyLook).toHaveBeenCalledWith({ sourceMirrorId: 'source', sourceLookId: 'original', mode: 'vibex', expectedRevision: 9 });
    expect(f.target.copyLook).not.toHaveBeenCalled(); expect(f.source.copyLook).not.toHaveBeenCalled();
  });

  it.each(['generating', 'live', 'deleted'] as const)('blocks a target that is %s', async condition => {
    const f = await fixture({ material: look() });
    if (condition === 'generating') f.target.state = { ...f.target.state!, phase: 'generating' };
    if (condition === 'live') f.target.state = { ...f.target.state!, live: { status: 'stopping' } as ExhibitionState['live'] };
    if (condition === 'deleted') f.registry.data!.mirrors = f.registry.data!.mirrors.filter(item => item.id !== 'target');
    await f.render();
    expect(f.node('button', '复制').getReactProps().disabled).toBe(true);
    await f.submit(); expect(f.target.copyLook).not.toHaveBeenCalled();
    expect(host!.find(node => node.getReactProps().role === 'alert')).toBeDefined();
  });

  it('returns focus to the original action after target changes and closing', async () => {
    const f = await fixture({ material: look() });
    await host!.render(null);
    const trigger = document.createElement('button'); document.body.appendChild(trigger); trigger.focus();
    await f.render();
    expect(document.activeElement).toBe(f.node('select'));
    await act(async () => f.node('select').getReactProps().onChange({ target: { value: 'third' } }));
    expect(document.activeElement).toBe(f.node('select'));
    await host!.render(null);
    expect(document.activeElement).toBe(trigger);
  });

  it('ignores a completion after the dialog unmounts', async () => {
    const f = await fixture({ material: look() });
    let finish!: (result: { lookId: string; index: number }) => void;
    vi.mocked(f.target.copyLook).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    await f.submit();
    await host!.render(null);
    await act(async () => finish({ lookId: 'late', index: 1 }));
    expect(f.copied).not.toHaveBeenCalled(); expect(f.close).not.toHaveBeenCalled();
  });
});
