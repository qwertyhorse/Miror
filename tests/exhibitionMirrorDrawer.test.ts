import { act, createElement, type ComponentProps } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ExhibitionState } from '../shared/exhibition';
import { Kiosk, MirrorPreview } from '../src/exhibition/ExhibitionApp';
import { exhibitionLooks } from '../src/exhibition/catalog';
import { createReactHost, flushReact } from './support/reactHost';

let host: Awaited<ReturnType<typeof createReactHost>> | undefined;
afterEach(async () => { await host?.close(); host = undefined; vi.unstubAllGlobals(); });
function state(overrides: Partial<ExhibitionState> = {}): ExhibitionState {
  return { mirrorId: 'default', revision: 1, phase: 'idle', experienceMode: 'clothx', looks: structuredClone(exhibitionLooks), enabledLookIds: ['commute', 'city'], selectedLookId: 'commute', displayedLookId: null,
    categories: [], tags: [], sessionNumber: 0, generationNumber: 0, updatedAt: 0, generationReadyAt: null, providerMode: 'demo', live: null, logs: [],
    settings: { autoReturnSeconds: 90, uploadLimits: { maxFileSizeMB: 10, minWidth: 64, minHeight: 64, maxWidth: 4096, maxHeight: 4096 } }, ...overrides };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  return { promise: new Promise<T>(done => { resolve = done; }), resolve };
}
async function fixture(overrides: Partial<ExhibitionState> = {}, props: Partial<ComponentProps<typeof Kiosk>> = {}) {
  host = await createReactHost();
  const snapshot = state(overrides); const send = vi.fn(async () => true);
  const render = () => host!.render(createElement(Kiosk, { state: snapshot, send, ...props }));
  const button = (label: string) => host!.find(node => node.nodeName === 'button' && (node.getReactProps()['aria-label'] === label || node.textContent === label || node.getReactProps().children?.at?.(-1) === label))?.getReactProps();
  await render();
  await act(async () => button('选择服装')!.onClick());
  return { snapshot, send, render, button };
}
describe('minimal mirror material drawer', () => {
  it('shows display covers when the generation reference is separate', async () => {
    const snapshot = state(); snapshot.looks[0].referenceImage = '/generation-reference.png';
    const f = await fixture(snapshot);
    const image = f.button('选择轻盈通勤')!.children[0];
    expect(image.props.src).toBe(snapshot.looks[0].image);
    expect(host!.find(node => node.nodeName === 'img' && node.getReactProps().src === '/generation-reference.png')).toBeUndefined();
  });
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
  it('deduplicates the current intent while keeping the other materials available during acknowledgement', async () => {
    const f = await fixture({ phase: 'showcase', displayedLookId: 'commute' });
    let complete!: (success: boolean) => void;
    f.send.mockImplementation(() => new Promise(resolve => { complete = resolve; }));
    await act(async () => { f.button('选择都市休闲')!.onClick(); f.button('选择都市休闲')!.onClick(); });
    expect(f.send).toHaveBeenCalledExactlyOnceWith({ action: 'switch', lookId: 'city' });
    expect(f.button('选择都市休闲')!['aria-pressed']).toBe(true);
    expect(f.button('选择轻盈通勤')!.disabled).toBe(false);
    await act(async () => complete(true));
  });
  it('accepts a material switch while generation is still preparing', async () => {
    const f = await fixture({ phase: 'generating' });
    expect(f.button('选择都市休闲')!.disabled).toBe(false);
    await act(async () => f.button('选择都市休闲')!.onClick());
    expect(f.send).toHaveBeenCalledExactlyOnceWith({ action: 'switch', lookId: 'city' });
  });
  it.each(['positioning', 'paused'] as const)('lets users browse but prevents changing materials during %s', async phase => {
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
  it('keeps the final rapid choice highlighted through intermediate server responses, including returning to the original material', async () => {
    const f = await fixture({ phase: 'generating', enabledLookIds: ['commute', 'city', 'evening'] });
    const first = deferred<boolean>(); const second = deferred<boolean>(); const final = deferred<boolean>();
    f.send.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise).mockReturnValueOnce(final.promise);
    await act(async () => {
      f.button('选择都市休闲')!.onClick();
      f.button('选择优雅礼服')!.onClick();
      f.button('选择轻盈通勤')!.onClick();
    });
    expect(f.send.mock.calls.map(([command]) => command)).toEqual([
      { action: 'switch', lookId: 'city' }, { action: 'switch', lookId: 'evening' }, { action: 'switch', lookId: 'commute' },
    ]);
    expect(f.button('选择轻盈通勤')!['aria-pressed']).toBe(true);
    expect(f.button('选择都市休闲')!.disabled).toBe(false);
    await act(async () => first.resolve(true));
    f.snapshot.selectedLookId = 'city'; await f.render();
    expect(f.button('选择轻盈通勤')!['aria-pressed']).toBe(true);
    await act(async () => second.resolve(false));
    expect(f.button('选择轻盈通勤')!['aria-pressed']).toBe(true);
    await act(async () => final.resolve(true));
    expect(f.button('选择轻盈通勤')!['aria-pressed']).toBe(true);
    f.snapshot.selectedLookId = 'commute'; await f.render();
    expect(f.button('选择轻盈通勤')!['aria-pressed']).toBe(true);
  });
  it('rolls back only a failed final choice to the latest server selection', async () => {
    const f = await fixture({ phase: 'generating', enabledLookIds: ['commute', 'city', 'evening'] });
    const first = deferred<boolean>(); const final = deferred<boolean>();
    f.send.mockReturnValueOnce(first.promise).mockReturnValueOnce(final.promise);
    await act(async () => { f.button('选择都市休闲')!.onClick(); f.button('选择优雅礼服')!.onClick(); });
    expect(f.button('选择优雅礼服')!['aria-pressed']).toBe(true);
    f.snapshot.selectedLookId = 'city'; await f.render();
    await act(async () => first.resolve(true));
    expect(f.button('选择优雅礼服')!['aria-pressed']).toBe(true);
    await act(async () => final.resolve(false));
    expect(f.button('选择都市休闲')!['aria-pressed']).toBe(true);
    expect(f.button('选择优雅礼服')!['aria-pressed']).toBe(false);
  });
  it.each([
    { disabled: true, selectionPending: true }, { passive: true }, { canControl: false }, { send: undefined },
    { commandPending: true }, { stopPending: true, selectionPending: true },
  ])('keeps material changes disabled when control is blocked: %j', async props => {
    const f = await fixture({ phase: 'generating' }, props);
    expect(f.button('选择都市休闲')!.disabled).toBe(true);
    await act(async () => f.button('选择都市休闲')!.onClick());
    expect(f.send).not.toHaveBeenCalled();
  });
  it('keeps selection requests available while the previous selection is pending or its old credential is stopping', async () => {
    const f = await fixture({ phase: 'generating', live: { status: 'stopping' } as ExhibitionState['live'] }, { commandPending: true, selectionPending: true });
    expect(f.button('选择都市休闲')!.disabled).toBe(false);
    await act(async () => f.button('选择都市休闲')!.onClick());
    expect(f.send).toHaveBeenCalledExactlyOnceWith({ action: 'switch', lookId: 'city' });
  });
  it.each([
    { generationNumber: 1, lookId: 'commute' },
    { generationNumber: 2, lookId: 'city' },
  ])('allows choosing another material while an older lease has an error: %j', async previous => {
    const f = await fixture({ phase: 'generating', providerMode: 'xmax', generationNumber: 2,
      live: { deviceId: 'screen-fixture', sessionId: 'old-session', status: 'error', updatedAt: 0, heartbeatAt: 0, ...previous } });
    expect(f.button('选择都市休闲')!.disabled).toBe(false);
    expect(host!.find(node => node.getReactProps().role === 'alert')).toBeUndefined();
    await act(async () => f.button('选择都市休闲')!.onClick());
    expect(f.send).toHaveBeenCalledExactlyOnceWith({ action: 'switch', lookId: 'city' });
  });
  it('blocks material changes when the current generation and material lease has an error', async () => {
    const f = await fixture({ phase: 'generating', providerMode: 'xmax', generationNumber: 2,
      live: { deviceId: 'screen-fixture', sessionId: 'current-session', status: 'error', updatedAt: 0, heartbeatAt: 0, generationNumber: 2, lookId: 'commute' } });
    expect(f.button('选择都市休闲')!.disabled).toBe(true);
    expect(host!.find(node => node.getReactProps().role === 'alert')!.textContent).toContain('换装连接状态未确认');
    await act(async () => f.button('选择都市休闲')!.onClick());
    expect(f.send).not.toHaveBeenCalled();
  });
  it('gives explicit stop priority over rapid selections and discards late optimistic acknowledgements', async () => {
    const stopping = deferred<boolean>(); const selecting = deferred<boolean>();
    const stopExperience = vi.fn(() => stopping.promise);
    const f = await fixture({ phase: 'generating' }, { stopExperience });
    f.send.mockReturnValueOnce(selecting.promise);
    await act(async () => f.button('选择都市休闲')!.onClick());
    const staleSelect = f.button('选择轻盈通勤')!.onClick;
    await act(async () => { f.button('停止生成')!.onClick(); staleSelect(); });
    await flushReact();
    expect(f.send).toHaveBeenCalledExactlyOnceWith({ action: 'switch', lookId: 'city' });
    expect(stopExperience).toHaveBeenCalledOnce();
    expect(f.button('选择都市休闲')!.disabled).toBe(true);
    expect(f.button('选择轻盈通勤')!['aria-pressed']).toBe(true);
    await act(async () => selecting.resolve(true));
    expect(f.button('选择轻盈通勤')!['aria-pressed']).toBe(true);
    f.snapshot.phase = 'select'; await f.render();
    await act(async () => stopping.resolve(true));
    expect(f.button('选择都市休闲')!.disabled).toBe(false);
    expect(f.button('开始体验')!.disabled).toBe(false);
  });
  it('allows another choice in a connected remote preview while selection is pending, but blocks disconnected previews', async () => {
    host = await createReactHost();
    const snapshot = state({ phase: 'generating' }); const send = vi.fn(async () => true);
    const controller = { send, pending: true, selectionPending: true, stopPending: false, connected: true, stopExperience: vi.fn(async () => true) };
    const render = () => host!.render(createElement(MirrorPreview, { state: snapshot, controller }));
    const button = (label: string) => host!.find(node => node.nodeName === 'button' && node.getReactProps()['aria-label'] === label)!.getReactProps();
    await render();
    await act(async () => button('选择服装').onClick());
    expect(button('选择都市休闲').disabled).toBe(false);
    await act(async () => button('选择都市休闲').onClick());
    expect(send).toHaveBeenCalledExactlyOnceWith({ action: 'switch', lookId: 'city' });
    controller.connected = false; await render();
    expect(button('选择轻盈通勤').disabled).toBe(true);
    await act(async () => button('选择轻盈通勤').onClick());
    expect(send).toHaveBeenCalledTimes(1);
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
