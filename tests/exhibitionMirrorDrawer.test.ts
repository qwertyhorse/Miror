import { act, createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ExhibitionState } from '../shared/exhibition';
import { Kiosk } from '../src/exhibition/ExhibitionApp';
import { exhibitionLooks } from '../src/exhibition/catalog';
import { createReactHost } from './support/reactHost';

let host: Awaited<ReturnType<typeof createReactHost>> | undefined;
afterEach(async () => { await host?.close(); host = undefined; vi.unstubAllGlobals(); });
function state(overrides: Partial<ExhibitionState> = {}): ExhibitionState {
  return { mirrorId: 'default', revision: 1, phase: 'idle', experienceMode: 'clothx', looks: structuredClone(exhibitionLooks), enabledLookIds: ['commute', 'city'], selectedLookId: 'commute', displayedLookId: null,
    categories: [], tags: [], sessionNumber: 0, generationNumber: 0, updatedAt: 0, generationReadyAt: null, providerMode: 'demo', live: null, logs: [],
    settings: { autoReturnSeconds: 90, uploadLimits: { maxFileSizeMB: 10, minWidth: 64, minHeight: 64, maxWidth: 4096, maxHeight: 4096 } }, ...overrides };
}
async function fixture(overrides: Partial<ExhibitionState> = {}, props = { disabled: false, passive: false }) {
  host = await createReactHost();
  const snapshot = state(overrides); const send = vi.fn(async () => true);
  const render = () => host!.render(createElement(Kiosk, { state: snapshot, send, ...props }));
  const button = (label: string) => host!.find(node => node.nodeName === 'button' && (node.getReactProps()['aria-label'] === label || node.textContent === label))?.getReactProps();
  await render();
  await act(async () => button('选择服装')!.onClick());
  return { snapshot, send, render, button };
}
describe('minimal mirror material drawer', () => {
  it.each(['idle', 'select'] as const)('selects from the drawer in %s without starting an experience', async phase => {
    const f = await fixture({ phase });
    expect(f.button('选择轻盈通勤')!['aria-pressed']).toBe(true);
    expect(f.button('选择优雅礼服')).toBeUndefined();
    await act(async () => f.button('选择都市休闲')!.onClick());
    expect(f.send).toHaveBeenCalledExactlyOnceWith({ action: 'select', lookId: 'city' });
    f.snapshot.selectedLookId = 'city'; await f.render();
    expect(f.button('选择都市休闲')!['aria-pressed']).toBe(true);
    expect(f.button('收起素材选择')!['aria-expanded']).toBe(true);
  });
  it('switches once during showcase and blocks duplicate clicks until acknowledgement', async () => {
    const f = await fixture({ phase: 'showcase', displayedLookId: 'commute' });
    let complete!: (success: boolean) => void;
    f.send.mockImplementation(() => new Promise(resolve => { complete = resolve; }));
    await act(async () => { f.button('选择都市休闲')!.onClick(); f.button('选择都市休闲')!.onClick(); });
    expect(f.send).toHaveBeenCalledExactlyOnceWith({ action: 'switch', lookId: 'city' });
    expect(f.button('选择轻盈通勤')!.disabled).toBe(true);
    await act(async () => complete(true));
  });
  it.each(['positioning', 'generating', 'paused'] as const)('lets users browse but prevents changing materials during %s', async phase => {
    const f = await fixture({ phase });
    expect(f.button('选择都市休闲')!.disabled).toBe(true);
    await act(async () => f.button('选择都市休闲')!.onClick());
    expect(f.send).not.toHaveBeenCalled();
  });
  it('ignores reselecting the current material and recovers from failed changes', async () => {
    const f = await fixture();
    await act(async () => f.button('选择轻盈通勤')!.onClick()); expect(f.send).not.toHaveBeenCalled();
    f.send.mockResolvedValue(false);
    await act(async () => f.button('选择都市休闲')!.onClick());
    expect(f.button('选择轻盈通勤')!['aria-pressed']).toBe(true);
    expect(f.button('选择都市休闲')!.disabled).toBe(false);
  });
  it('does not reuse drawer visibility across experience modes', async () => {
    const f = await fixture();
    f.snapshot.looks.find(look => look.id === 'city')!.mode = 'charx'; f.snapshot.experienceMode = 'charx'; f.snapshot.selectedLookId = 'city'; await f.render();
    expect(f.button('选择素材')!['aria-expanded']).toBe(false);
    expect(f.button('选择轻盈通勤')).toBeUndefined();
  });
  it('renders the saved skin in empty and populated states with no marketing title or commentary', () => {
    const snapshot = state(); snapshot.settings.uiSkin = { image: '/api/exhibition/mirrors/default/skin/fixture', width: 1080, height: 1920, bytes: 999 };
    for (const enabledLookIds of [snapshot.enabledLookIds, []]) {
      const html = renderToStaticMarkup(createElement(Kiosk, { state: { ...snapshot, enabledLookIds } }));
      expect(html).toContain('background-image:url(/api/exhibition/mirrors/default/skin/fixture)');
      expect(html).toContain('openbuy-ai-logo-rgb.png');
      expect(html).not.toContain('AI驱动'); expect(html).not.toContain('请工作人员'); expect(html).not.toContain('ex-outfit-carousel');
    }
  });
});
