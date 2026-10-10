import { act, createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { EXHIBITION_FREE_PROMPT_MAX_LENGTH, type ExhibitionExperienceMode, type ExhibitionLook, type ExhibitionMirrorSummary, type ExhibitionState } from '../shared/exhibition';
import { ExperienceModeChips } from '../src/exhibition/ExperienceModeChips';
import { MirrorConsole } from '../src/exhibition/MirrorConsole';
import { LookEditor, WardrobePanel } from '../src/exhibition/WardrobePanel';
import type { ExhibitionController } from '../src/exhibition/useExhibition';
import type { ExhibitionLiveController } from '../src/exhibition/useExhibitionLive';
import type { MirrorRegistry } from '../src/exhibition/useMirrors';
import { createReactHost, flushReact } from './support/reactHost';

function material(id: string, mode: ExhibitionExperienceMode = 'clothx'): ExhibitionLook {
  return { id, mode, name: `素材-${id}`, description: '用于测试的素材说明', image: '/assets/test.webp', source: 'sample', palette: '', category: '隐藏旧分类', tags: ['隐藏旧标签'], ...(mode === 'free' ? { prompt: '保留人物动作，更换背景' } : {}) };
}
function state(overrides: Partial<ExhibitionState> = {}): ExhibitionState {
  return { mirrorId: 'default', revision: 4, phase: 'idle', experienceMode: 'clothx', selectedLookId: 'cloth', displayedLookId: null,
    looks: [material('cloth'), material('character', 'charx')], enabledLookIds: ['cloth', 'character'], categories: ['隐藏旧分类'], tags: ['隐藏旧标签'],
    sessionNumber: 0, generationNumber: 0, updatedAt: 1_800_000_000_000, generationReadyAt: null, providerMode: 'demo', live: null, logs: [],
    settings: { autoReturnSeconds: 60, uploadLimits: { maxFileSizeMB: 10, minWidth: 64, maxWidth: 2048, minHeight: 64, maxHeight: 2048 } }, ...overrides };
}
function controller(snapshot: ExhibitionState, options: Partial<ExhibitionController> = {}): ExhibitionController {
  return { state: snapshot, mirrorId: snapshot.mirrorId!, pending: false, connected: true, error: '', send: vi.fn(async () => true), upload: vi.fn(async () => null),
    updateLook: vi.fn(async () => true), deleteLook: vi.fn(async () => true), saveTaxonomy: vi.fn(async () => true), copyData: vi.fn(async () => true), refresh: vi.fn(async () => {}), clearError: vi.fn(), ...options };
}
function consoleHtml(snapshot: ExhibitionState, options: Partial<ExhibitionController> = {}, liveStatus: ExhibitionLiveController['liveStatus'] = null) {
  const mirror: ExhibitionMirrorSummary = { id: 'default', name: '测试智能镜', revision: snapshot.revision, phase: snapshot.phase, providerMode: snapshot.providerMode, updatedAt: snapshot.updatedAt, binding: null };
  const registry = { data: { defaultMirrorId: 'default', mirrors: [mirror] }, error: '', refresh: vi.fn(async () => {}) } as unknown as MirrorRegistry;
  return renderToStaticMarkup(createElement(MirrorConsole, { controller: controller(snapshot, options), live: { liveStatus } as ExhibitionLiveController,
    mirror, registry, selectMirror: vi.fn(), preview: null }));
}
function primaryButton(html: string) { return html.match(/<button[^>]*class="ex-button ex-primary ex-wide"[^>]*>/)?.[0] ?? ''; }
function modeFieldset(html: string) { return html.match(/<fieldset class="ex-mode-choices"[^>]*>/)?.[0] ?? ''; }
function secondaryButtons(html: string) {
  const row = html.match(/<div class="ex-secondary-commands">(.*?)<\/div>/s)?.[1] ?? '';
  return [...row.matchAll(/<button([^>]*)>(.*?)<\/button>/gs)].map(([, attributes, content]) => ({
    label: content.replace(/<[^>]*>/g, ''), disabled: /\bdisabled=/.test(attributes),
  }));
}

describe('six-mode console presentation', () => {
  it('presents one keyboard-accessible radio group with exactly one selected mode', () => {
    const html = renderToStaticMarkup(createElement(ExperienceModeChips, { value: 'vibex', label: '当前体验模式', onChange: vi.fn() }));
    expect(html.match(/type="radio"/g)).toHaveLength(6);
    expect(new Set([...html.matchAll(/name="([^"]+)"/g)].map(match => match[1])).size).toBe(1);
    expect(html.match(/checked=""/g)).toHaveLength(1);
    expect(html).toMatch(/checked="" value="vibex"|value="vibex" checked=""/);
    for (const label of ['Free', 'CharX', 'ClothX', 'VibeX', 'DimX', 'MoX']) expect(html).toContain(`${label}</span>`);
  });

  it('shows every matching material in the scroll region, including disabled items beyond four', () => {
    const looks = [...Array.from({ length: 9 }, (_, i) => material(`cloth-${i}`)), material('other-mode', 'free')];
    const html = renderToStaticMarkup(createElement(WardrobePanel, { controller: controller(state({ looks, enabledLookIds: ['cloth-0'], selectedLookId: 'cloth-0' })) }));
    expect(html.match(/<article /g)).toHaveLength(9);
    expect(html).toContain('素材-cloth-8'); expect(html).not.toContain('素材-other-mode');
    expect(html).toContain('ClothX 素材列表，可纵向滚动');
    expect(html).not.toContain('上一页'); expect(html).not.toContain('下一页'); expect(html).not.toContain('每页');
    expect(html).not.toContain('隐藏旧分类'); expect(html).not.toContain('隐藏旧标签'); expect(html).not.toContain('分类与标签');
  });

  it('allows the final enabled material to be disabled or deleted', () => {
    const html = renderToStaticMarkup(createElement(WardrobePanel, { controller: controller(state({ looks: [material('cloth')], enabledLookIds: ['cloth'] })) }));
    const toggle = html.match(/<input[^>]*aria-label="启用素材-cloth"[^>]*>/)?.[0];
    const remove = html.match(/<button[^>]*aria-label="素材-cloth的更多操作"[^>]*>/)?.[0];
    expect(toggle).toBeDefined(); expect(toggle).not.toContain('disabled');
    expect(remove).toBeDefined(); expect(remove).not.toContain('disabled');
  });

  it('shows an empty mode without revealing materials from a different mode', () => {
    const snapshot = state({ experienceMode: 'mox', selectedLookId: null });
    const html = renderToStaticMarkup(createElement(WardrobePanel, { controller: controller(snapshot) }));
    expect(html).toContain('MoX 暂无素材'); expect(html).not.toContain('<article ');
    expect(html).not.toContain('素材-cloth'); expect(html).not.toContain('素材-character');
  });

  it('requires a bounded prompt for each Free material and uses presets for other modes', () => {
    const renderEditor = (mode: ExhibitionExperienceMode) => renderToStaticMarkup(createElement(LookEditor, {
      controller: controller(state()), look: material('editing', mode), initialMode: mode, close: vi.fn(), saved: vi.fn(), deleted: vi.fn(),
    }));
    const free = renderEditor('free');
    expect(free).toMatch(new RegExp(`<textarea[^>]*required=""[^>]*maxLength="${EXHIBITION_FREE_PROMPT_MAX_LENGTH}"`));
    expect(free).toContain('保留人物动作，更换背景'); expect(free).toContain('Free 提示词');
    expect(free).not.toContain('隐藏旧分类'); expect(free).not.toContain('隐藏旧标签');
    const preset = renderEditor('charx');
    expect(preset).toContain('CharX 使用系统预设提示词。'); expect(preset).not.toContain('Free 提示词');
    const blank = renderToStaticMarkup(createElement(LookEditor, {
      controller: controller(state()), look: { ...material('editing', 'free'), prompt: '   ' }, initialMode: 'free', close: vi.fn(), saved: vi.fn(), deleted: vi.fn(),
    }));
    expect(blank).toMatch(/<button[^>]*disabled=""[^>]*>保存素材<\/button>/);
  });

  it('keeps the opened deletion target visible after polling removes it from the current catalog', () => {
    const openedLook = material('opened-target', 'free');
    const html = renderToStaticMarkup(createElement(LookEditor, {
      controller: controller(state({ looks: [], enabledLookIds: [], selectedLookId: null })), look: openedLook, initialMode: 'free', initialDelete: true,
      close: vi.fn(), saved: vi.fn(), deleted: vi.fn(),
    }));
    expect(html).toContain('确认删除「素材-opened-target」？'); expect(html).toContain('Free · 示例素材');
    expect(html).toContain('保留素材'); expect(html).not.toContain('至少保留');
  });

  it.each(['free', 'vibex'] as const)('preserves the prompt-only kind or explicitly converts it when saving as %s', async mode => {
    const look = { ...material('prompt-only', 'free'), referenceKind: 'none' as const };
    const host = await createReactHost();
    const Node = window.HTMLElement;
    vi.stubGlobal('HTMLElement', Node);
    Object.assign(Node.prototype, { showModal: vi.fn(), close: vi.fn(), querySelector: () => null });
    const control = controller(state({ experienceMode: 'free', looks: [look], enabledLookIds: [look.id] }));
    const saved = vi.fn();
    try {
      await host.render(createElement(LookEditor, { controller: control, look, initialMode: 'free', close: vi.fn(), saved, deleted: vi.fn() }));
      expect(host.find(node => node.textContent.includes('封面用于列表展示，生成时只使用提示词。'))).toBeDefined();
      if (mode !== 'free') await act(async () => { host.find(node => node.getReactProps().type === 'radio' && node.getReactProps().value === mode)!.getReactProps().onChange(); });
      await act(async () => { host.find(node => node.nodeName === 'form')!.getReactProps().onSubmit({ preventDefault: vi.fn() }); });
      await flushReact();
      expect(control.updateLook).toHaveBeenCalledExactlyOnceWith(look.id, {
        name: look.name, description: look.description, mode, prompt: mode === 'free' ? look.prompt : '', referenceKind: mode === 'free' ? 'none' : 'image', expectedRevision: 4,
      });
      expect(saved).toHaveBeenCalledExactlyOnceWith(mode);
    } finally { await host.close(); vi.unstubAllGlobals(); }
  });

  it('identifies prompt-only Free materials in the library', () => {
    const look = { ...material('prompt-only', 'free'), referenceKind: 'none' as const };
    const html = renderToStaticMarkup(createElement(WardrobePanel, { controller: controller(state({ experienceMode: 'free', looks: [look], enabledLookIds: [look.id] })) }));
    expect(html).toContain('Free · 仅提示词');
  });

  it('keeps the MoX start available without the extra return button or status strip', () => {
    const html = consoleHtml(state({ experienceMode: 'mox', looks: [material('motion', 'mox')], enabledLookIds: ['motion'], selectedLookId: 'motion', providerMode: 'xmax' }));
    expect(html).toContain('开始体验'); expect(html).not.toContain('ex-live-session-note'); expect(html).not.toContain('返回待机展示');
  });

  it('does not present legacy local credits as the XMAX SK balance', () => {
    const html = consoleHtml(state({ providerMode: 'xmax' }), {}, {
      configured: true, mode: 'xmax', model: 'x2.0', perSessionLimit: 30, totalLimit: 360,
      allocatedCredits: 360, remainingCredits: 0, expireSeconds: 120, heartbeatTimeoutSeconds: 20, live: null,
    });
    expect(html).not.toMatch(/当前 SK 剩余|本地测试额度|每次最多预留|ex-device-budget/);
    expect(primaryButton(html)).not.toContain('disabled');
  });

  it('does not fall back to an enabled material from another mode in current control', () => {
    const html = consoleHtml(state({ experienceMode: 'mox', selectedLookId: 'cloth' }));
    expect(html).toContain('请在素材管理中为 MoX 上传并启用素材后再开始体验。');
    expect(html).not.toContain('素材-cloth'); expect(primaryButton(html)).toContain('disabled');
  });

  it('renders an entirely empty library with a disabled start button and available mode selection', () => {
    const html = consoleHtml(state({ looks: [], enabledLookIds: [], selectedLookId: null }));
    expect(primaryButton(html)).toContain('disabled'); expect(modeFieldset(html)).not.toContain('disabled');
    expect(html).toContain('请在素材管理中为 ClothX 上传并启用素材后再开始体验。');
  });

  it('only allows mode switching while idle/select with no active live session and a connected controller', () => {
    for (const phase of ['idle', 'select'] as const) expect(modeFieldset(consoleHtml(state({ phase })))).not.toContain('disabled');
    for (const phase of ['positioning', 'generating', 'showcase', 'paused'] as const) expect(modeFieldset(consoleHtml(state({ phase })))).toContain('disabled');
    expect(modeFieldset(consoleHtml(state({ live: { status: 'stopping' } as ExhibitionState['live'] })))).toContain('disabled');
    expect(modeFieldset(consoleHtml(state(), { connected: false }))).toContain('disabled');
    expect(modeFieldset(consoleHtml(state(), { pending: true }))).toContain('disabled');
  });

  it.each([
    { phase: 'idle', navigationDisabled: false, stopDisabled: true, primaryDisabled: false },
    { phase: 'select', navigationDisabled: false, stopDisabled: true, primaryDisabled: false },
    { phase: 'generating', navigationDisabled: true, stopDisabled: false, primaryDisabled: true },
    { phase: 'showcase', navigationDisabled: false, stopDisabled: false, primaryDisabled: true },
  ] as const)('offers selection and stop controls appropriate to $phase', ({ phase, navigationDisabled, stopDisabled, primaryDisabled }) => {
    const html = consoleHtml(state({ phase, looks: [material('cloth'), material('other-cloth'), material('character', 'charx')], enabledLookIds: ['cloth', 'character', 'other-cloth'] }));
    expect(secondaryButtons(html)).toEqual([
      { label: '上一份', disabled: navigationDisabled },
      { label: '下一份', disabled: navigationDisabled },
      { label: '停止生成', disabled: stopDisabled },
    ]);
    expect(primaryButton(html).includes('disabled')).toBe(primaryDisabled);
  });

  it('only enables fault recovery after the old live session has been released', () => {
    expect(primaryButton(consoleHtml(state({ phase: 'paused' })))).not.toContain('disabled');
    for (const phase of ['idle', 'select', 'paused'] as const) {
      for (const status of ['stopping', 'error'] as const) {
        const html = consoleHtml(state({ phase, live: { status } as ExhibitionState['live'] }));
        expect(primaryButton(html)).toContain('disabled');
        expect(secondaryButtons(html)).toEqual([
          { label: '上一份', disabled: true }, { label: '下一份', disabled: true }, { label: '停止生成', disabled: false },
        ]);
      }
    }
    const buttons = secondaryButtons(consoleHtml(state({ phase: 'paused' })));
    expect(buttons.map(button => button.disabled)).toEqual([true, true, false]);
  });

  it.each(['idle', 'select'] as const)('offers recovery for an ended local experience in %s even without current materials', phase => {
    const snapshot = state({ phase, looks: [], enabledLookIds: [], selectedLookId: null, live: { status: 'error', localEnded: true } as ExhibitionState['live'] });
    const html = consoleHtml(snapshot);
    expect(primaryButton(html)).not.toContain('disabled'); expect(html).toContain('恢复操作');
    expect(secondaryButtons(html).at(-1)).toEqual({ label: '停止生成', disabled: true });
  });

  it.each([{ connected: false }, { pending: true }, { stopPending: true }])('blocks console recovery while another operation cannot be accepted: %j', options => {
    const snapshot = state({ phase: 'select', live: { status: 'error', localEnded: true } as ExhibitionState['live'] });
    expect(primaryButton(consoleHtml(snapshot, options))).toContain('disabled');
  });

  it('sends only recover from the console primary control, without requiring a material', async () => {
    const snapshot = state({ phase: 'select', looks: [], enabledLookIds: [], selectedLookId: null, live: { status: 'error', localEnded: true } as ExhibitionState['live'] });
    const control = controller(snapshot, { stopExperience: vi.fn(async () => true) });
    const mirror: ExhibitionMirrorSummary = { id: 'default', name: '测试智能镜', revision: snapshot.revision, phase: snapshot.phase, providerMode: snapshot.providerMode, updatedAt: snapshot.updatedAt, binding: null };
    const registry = { data: { defaultMirrorId: 'default', mirrors: [mirror] }, error: '', refresh: vi.fn(async () => {}) } as unknown as MirrorRegistry;
    const host = await createReactHost();
    try {
      await host.render(createElement(MirrorConsole, { controller: control, live: { liveStatus: null } as ExhibitionLiveController,
        mirror, registry, selectMirror: vi.fn(), preview: null }));
      const recovery = host.find(node => node.nodeName === 'button' && node.getReactProps()['aria-label'] === '恢复操作')!;
      expect(recovery).toBeDefined(); expect(recovery.getReactProps().disabled).toBeFalsy();
      await act(async () => { recovery.getReactProps().onClick(); }); await flushReact();
      expect(control.send).toHaveBeenCalledExactlyOnceWith({ action: 'recover' });
      expect(control.stopExperience).not.toHaveBeenCalled();
    } finally { await host.close(); vi.unstubAllGlobals(); }
  });

  it.each(['generating', 'showcase', 'positioning', 'paused'] as const)('keeps stopping available during %s despite ordinary pending or a stale connection flag', phase => {
    const html = consoleHtml(state({ phase }), { pending: true, connected: false, stopPending: false });
    expect(secondaryButtons(html).at(-1)).toEqual({ label: '停止生成', disabled: false });
    expect(primaryButton(html)).toContain('disabled');
  });

  it.each(['preparing', 'connecting', 'running', 'stopping', 'error'] as const)('permits retrying a %s live lease while idle even with ordinary pending', status => {
    const html = consoleHtml(state({ phase: 'idle', live: { status } as ExhibitionState['live'] }), { pending: true, connected: false, stopPending: false });
    expect(secondaryButtons(html).at(-1)).toEqual({ label: '停止生成', disabled: false });
  });

  it('allows cancellation while begin is pending before the active state has arrived', () => {
    expect(secondaryButtons(consoleHtml(state({ phase: 'idle' }), { pending: true, stopPending: false })).at(-1)).toEqual({ label: '停止生成', disabled: false });
  });

  it('only disables stopping for its own in-flight request and blocks starts until it finishes', () => {
    const html = consoleHtml(state({ phase: 'idle' }), { pending: false, stopPending: true });
    expect(secondaryButtons(html).at(-1)).toEqual({ label: '正在停止…', disabled: true });
    expect(primaryButton(html)).toContain('disabled'); expect(modeFieldset(html)).toContain('disabled');
  });
});
