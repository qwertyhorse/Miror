import { act, createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MirrorConsole } from '../src/exhibition/MirrorConsole';
import type { ExhibitionState, ExhibitionMirrorSummary } from '../shared/exhibition';
import type { ExhibitionController } from '../src/exhibition/useExhibition';
import type { ExhibitionLiveController } from '../src/exhibition/useExhibitionLive';
import type { MirrorRegistry } from '../src/exhibition/useMirrors';
import { createReactHost } from './support/reactHost';

let host: Awaited<ReturnType<typeof createReactHost>> | undefined;
const popups: { closed: boolean }[] = [];
afterEach(async () => { await host?.close(); host = undefined; popups.splice(0).forEach(popup => { popup.closed = true; }); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

async function fixture(phase: ExhibitionState['phase'], pageHref?: string) {
  host = await createReactHost();
  const popup = { closed: false, focus: vi.fn() };
  popups.push(popup);
  const open = vi.fn<Window['open']>(() => popup as unknown as Window);
  Object.assign(window, { open });
  if (pageHref) {
    const page = new URL(pageHref);
    Object.assign(window.location, { protocol: page.protocol, href: page.href });
  }
  // Native select behavior is unrelated to command navigation. Supply its option
  // collection locally so the existing small host needs no new DOM features.
  const create = document.createElement.bind(document);
  vi.spyOn(document, 'createElement').mockImplementation(((name: string, options?: ElementCreationOptions) => {
    const node = create(name, options);
    if (name === 'select') Object.defineProperty(node, 'options', { get: () => Array.from(node.childNodes).filter(child => child.nodeName === 'option') });
    return node;
  }) as typeof document.createElement);
  const looks = ['first', 'other-mode', 'middle', 'last'].map(id => ({ id, mode: id === 'other-mode' ? 'charx' as const : 'clothx' as const, name: id, description: '', image: '/test.png', source: 'sample' as const, palette: '', category: '', tags: [] }));
  const state: ExhibitionState = { mirrorId: 'default', revision: 4, phase, experienceMode: 'clothx', selectedLookId: 'first', displayedLookId: null, looks,
    enabledLookIds: looks.map(look => look.id), categories: [], tags: [], sessionNumber: 1, generationNumber: 1, updatedAt: 1000, generationReadyAt: null, providerMode: 'demo', live: null, logs: [],
    settings: { autoReturnSeconds: 90, uploadLimits: { maxFileSizeMB: 10, minWidth: 64, minHeight: 64, maxWidth: 4096, maxHeight: 4096 } } };
  const send = vi.fn(async () => true);
  const stopExperience = vi.fn(async () => true);
  const controller = { state, mirrorId: 'default', connected: true, pending: false, stopPending: false, stopExperience, error: '', send, clearError: vi.fn() } as unknown as ExhibitionController;
  const mirror: ExhibitionMirrorSummary = { id: 'default', name: '测试智能镜', revision: 4, phase, providerMode: 'demo', updatedAt: 1000, binding: null };
  const registry = { data: { defaultMirrorId: 'default', mirrors: [mirror] }, error: '', refresh: vi.fn(async () => {}) } as unknown as MirrorRegistry;
  const render = () => host!.render(createElement(MirrorConsole, { controller, mirror, registry, live: { liveStatus: null } as ExhibitionLiveController, selectMirror: vi.fn(), preview: null }));
  await render();
  return { state, send, stopExperience, render, open, popup, button: (label: string) => host!.find(node => node.nodeName === 'button' && node.textContent === label)!.getReactProps() };
}

describe('console material navigation commands', () => {
  it('opens wireless sharing securely and focuses the existing page on repeat clicks', async () => {
    const f = await fixture('idle');
    await act(async () => f.button('无线投屏').onClick());
    const url = new URL(String(f.open.mock.calls[0][0]));
    expect(url.origin).toBe('https://xuminghong.local:10202');
    expect(url.searchParams.get('presentation')).toBe('wireless');
    expect(url.searchParams.get('mirror')).toBe('default');
    expect(url.searchParams.get('output')).not.toBe('browser');
    await act(async () => f.button('无线投屏').onClick());
    expect(f.open).toHaveBeenCalledOnce(); expect(f.send).not.toHaveBeenCalled();
  });
  it('provides a direct wireless link after a popup block', async () => {
    const f = await fixture('idle'); f.open.mockReturnValueOnce(null);
    await act(async () => f.button('无线投屏').onClick());
    const link = host!.find(node => node.nodeName === 'a' && node.textContent === '打开无线投屏');
    expect(new URL(link!.getReactProps().href).searchParams.get('presentation')).toBe('wireless');
    expect(f.send).not.toHaveBeenCalled();
  });
  it('opens HDMI synchronously on the camera-capable origin and retains Android and ordinary browser links', async () => {
    const f = await fixture('idle');
    await act(async () => {
      f.button('HDMI 大屏').onClick();
      expect(f.open).toHaveBeenCalledOnce();
    });
    const target = new URL(String(f.open.mock.calls[0][0]));
    expect(target.origin).toBe('https://xuminghong.local:10202'); expect(target.searchParams.get('mirror')).toBe('default');
    expect(target.pathname).toMatch(/\/exhibition\/computer$/); expect(target.searchParams.get('output')).toBe('browser');
    expect(target.searchParams.get('presentation')).toBe('hdmi');
    const android = host!.find(node => node.nodeName === 'a' && node.textContent === '安卓联动');
    expect(new URL(android!.getReactProps().href).searchParams.get('output')).not.toBe('browser');
    const browser = host!.find(node => node.nodeName === 'a' && node.getReactProps().href?.includes('output=browser'));
    expect(new URL(browser!.getReactProps().href).searchParams.has('presentation')).toBe(false);
    expect(f.send).not.toHaveBeenCalled();
  });
  it('focuses the same HDMI window after the console remounts without navigating or starting', async () => {
    const f = await fixture('idle');
    await act(async () => f.button('HDMI 大屏').onClick());
    f.popup.focus.mockClear();
    await host!.render(null);
    await f.render();
    await act(async () => f.button('HDMI 大屏').onClick());
    expect(f.open).toHaveBeenCalledOnce();
    expect(f.popup.focus).toHaveBeenCalledOnce();
    expect(f.send).not.toHaveBeenCalled();
  });
  it('provides a native HTTPS link when the popup is blocked and clears the notice after retry', async () => {
    const f = await fixture('idle');
    f.open.mockReturnValueOnce(null);
    await act(async () => f.button('HDMI 大屏').onClick());
    expect(host!.find(node => node.getReactProps().role === 'alert')?.textContent).toContain('弹窗被拦截');
    const fallback = host!.find(node => node.nodeName === 'a' && node.textContent === '打开 HDMI 大屏')!.getReactProps();
    expect(new URL(fallback.href).origin).toBe('https://xuminghong.local:10202');
    expect(new URL(fallback.href).searchParams.get('presentation')).toBe('hdmi');
    expect(fallback.target).toBe('_blank');
    expect(fallback.onClick).toBeUndefined();
    await act(async () => f.button('HDMI 大屏').onClick());
    expect(host!.find(node => node.getReactProps().role === 'alert')).toBeUndefined();
    expect(f.send).not.toHaveBeenCalled();
  });
  it.each(['http://xuminghong.local:10200', 'http://xuminghong.local:10201', 'http://xuminghong.local:10601', 'http://192.168.1.2:10601'])('keeps the staff link on the current HTTP origin %s', async origin => {
    await fixture('idle', `${origin}/v1.1/exhibition/control?mirror=default`);
    const link = host!.find(node => node.nodeName === 'a' && node.textContent.startsWith(origin));
    const target = new URL(link!.getReactProps().href);
    expect(target.origin).toBe(origin); expect(target.pathname).toMatch(/\/exhibition\/control$/);
    expect(target.searchParams.get('mirror')).toBe('default');
  });
  it('retains the HTTP 10200 staff link from the secure camera origin', async () => {
    await fixture('idle', 'https://xuminghong.local:10202/v1.1/exhibition/control?mirror=default');
    const link = host!.find(node => node.nodeName === 'a' && node.textContent.startsWith('http://xuminghong.local:10200'));
    expect(new URL(link!.getReactProps().href).origin).toBe('http://xuminghong.local:10200');
  });
  it.each(['idle', 'select'] as const)('wraps current-mode selections in %s without starting an experience', async phase => {
    const f = await fixture(phase);
    await act(async () => f.button('上一份').onClick());
    expect(f.send).toHaveBeenLastCalledWith({ action: 'select', lookId: 'last' });
    f.state.selectedLookId = 'last'; await f.render();
    await act(async () => f.button('下一份').onClick());
    expect(f.send).toHaveBeenLastCalledWith({ action: 'select', lookId: 'first' });
    f.state.selectedLookId = 'first'; await f.render();
    await act(async () => f.button('下一份').onClick());
    expect(f.send.mock.calls).toEqual([[{ action: 'select', lookId: 'last' }], [{ action: 'select', lookId: 'first' }], [{ action: 'select', lookId: 'middle' }]]);
  });
  it('uses generation navigation while showcasing and keeps stop explicit', async () => {
    const f = await fixture('showcase');
    await act(async () => { f.button('上一份').onClick(); f.button('下一份').onClick(); f.button('停止生成').onClick(); });
    expect(f.send.mock.calls).toEqual([[{ action: 'previous' }], [{ action: 'next' }]]);
    expect(f.stopExperience).toHaveBeenCalledOnce();
  });
  it('guards both navigation handlers during generation while allowing stop', async () => {
    const f = await fixture('generating');
    expect(f.button('上一份').disabled).toBe(true); expect(f.button('下一份').disabled).toBe(true); expect(f.button('停止生成').disabled).toBe(false);
    await act(async () => { f.button('上一份').onClick(); f.button('下一份').onClick(); });
    expect(f.send).not.toHaveBeenCalled();
    await act(async () => f.button('停止生成').onClick());
    expect(f.stopExperience).toHaveBeenCalledOnce(); expect(f.send).not.toHaveBeenCalled();
  });
});
