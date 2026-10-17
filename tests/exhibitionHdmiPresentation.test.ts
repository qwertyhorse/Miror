import { act, createElement, StrictMode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HdmiDisplayPanel } from '../src/exhibition/HdmiDisplayPanel';
import { hdmiScreenName, useHdmiPresentation, type HdmiPresentation, type HdmiScreen, type HdmiScreenDetails } from '../src/exhibition/useHdmiPresentation';
import { createReactHost } from './support/reactHost';

let host: Awaited<ReturnType<typeof createReactHost>> | undefined;
let view: HdmiPresentation;
afterEach(async () => { await host?.close(); host = undefined; vi.unstubAllGlobals(); });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
async function fixture(options: { supported?: boolean; strict?: boolean; enabled?: boolean } = {}) {
  host = await createReactHost();
  const internal: HdmiScreen = Object.assign(new EventTarget(), { label: 'MacBook', width: 1728, height: 1117, isInternal: true, isPrimary: true });
  const external: HdmiScreen = Object.assign(new EventTarget(), { label: 'HDMI Mirror', width: 1080, height: 1920, isInternal: false, isPrimary: false });
  const details: HdmiScreenDetails = Object.assign(new EventTarget(), { screens: [internal, external], currentScreen: internal });
  const getScreenDetails = vi.fn(async () => details);
  if (options.supported !== false) Object.assign(window, { getScreenDetails });
  let fullscreenElement: Element | null = null;
  Object.defineProperty(document, 'fullscreenElement', { configurable: true, get: () => fullscreenElement });
  const fullscreen = vi.fn(async (input?: { screen?: HdmiScreen }) => {
    if (input?.screen) details.currentScreen = input.screen;
    fullscreenElement = document.documentElement;
    document.dispatchEvent(new Event('fullscreenchange'));
  });
  Object.assign(document.documentElement, { requestFullscreen: fullscreen });
  const disconnect = vi.fn(async () => true);
  function Harness() { view = useHdmiPresentation(options.enabled !== false, disconnect); return createElement(HdmiDisplayPanel, { presentation: view }); }
  await host.render(options.strict ? createElement(StrictMode, null, createElement(Harness)) : createElement(Harness));
  return { internal, external, details, getScreenDetails, fullscreen, disconnect,
    async discover() { await act(async () => view.discover()); },
    async present(screen: HdmiScreen = external) { await act(async () => view.present(screen)); },
    async unplug() { details.screens = [internal]; details.currentScreen = internal; await act(async () => details.dispatchEvent(new Event('screenschange'))); },
    async escape() { fullscreenElement = null; await act(async () => document.dispatchEvent(new Event('fullscreenchange'))); },
  };
}

describe('HDMI display selection', () => {
  it('waits for explicit permission and target selection, with names and resolution', async () => {
    const f = await fixture();
    expect(f.getScreenDetails).not.toHaveBeenCalled(); expect(view.ready).toBe(false);
    await f.discover(); expect(view.screens).toEqual([f.internal, f.external]);
    expect(host!.find(n => n.textContent === '1080 × 1920 · 外接')).toBeDefined();
    await f.present();
    expect(f.fullscreen).toHaveBeenCalledWith({ screen: f.external });
    expect(view.ready).toBe(true); expect(view.open).toBe(false);
    expect(f.disconnect).not.toHaveBeenCalled();
  });
  it('calls fullscreen in the click turn and does not wait for another permission request', async () => {
    const f = await fixture(); await f.discover();
    await act(async () => {
      const operation = view.present(f.external);
      expect(f.fullscreen).toHaveBeenCalledOnce();
      await operation;
    });
    expect(f.getScreenDetails).toHaveBeenCalledOnce();
  });
  it('retains the current experience when Escape only exits fullscreen', async () => {
    const f = await fixture(); await f.discover(); await f.present(); await f.escape();
    expect(view.open).toBe(true); expect(view.ready).toBe(true); expect(f.disconnect).not.toHaveBeenCalled();
  });
  it('does not mistake a resolution or display arrangement change for unplug', async () => {
    const f = await fixture(); await f.discover(); await f.present();
    f.external.width = 2160;
    await act(async () => { f.details.dispatchEvent(new Event('screenschange')); (f.external as HdmiScreen & EventTarget).dispatchEvent(new Event('change')); });
    expect(view.screens[1].width).toBe(2160); expect(view.ready).toBe(true); expect(f.disconnect).not.toHaveBeenCalled();
  });
  it('stops once on unplug and does not resume on reconnect or refresh', async () => {
    const f = await fixture({ strict: true }); await f.discover(); await f.present();
    await f.unplug(); await f.unplug();
    expect(f.disconnect).toHaveBeenCalledOnce(); expect(view.ready).toBe(false); expect(view.open).toBe(true);
    f.details.screens = [f.internal, f.external];
    await act(async () => f.details.dispatchEvent(new Event('screenschange')));
    await f.discover(); expect(view.ready).toBe(false);
    await f.present(); expect(view.ready).toBe(true);
  });
  it('blocks selection while stopping, and exposes a retry on unconfirmed stop', async () => {
    const f = await fixture(); await f.discover(); await f.present();
    const stopped = deferred<boolean>(); f.disconnect.mockImplementationOnce(() => stopped.promise);
    await f.unplug(); expect(view.stopping).toBe(true); expect(view.needsStop).toBe(true);
    await act(async () => { void view.present(); view.useWindow(); });
    expect(f.fullscreen).toHaveBeenCalledOnce(); expect(view.ready).toBe(false);
    await act(async () => stopped.resolve(false));
    expect(view.stopError).toContain('重试'); expect(view.needsStop).toBe(true);
    await act(async () => view.retryStop());
    expect(f.disconnect).toHaveBeenCalledTimes(2); expect(view.needsStop).toBe(false); expect(view.ready).toBe(false);
  });
  it('invalidates a pending fullscreen request when its target disappears', async () => {
    const f = await fixture(); await f.discover();
    const pending = deferred<void>(); f.fullscreen.mockImplementationOnce(() => pending.promise);
    let request!: Promise<void>;
    await act(async () => { request = view.present(f.external); });
    await f.unplug();
    await act(async () => { pending.resolve(); await request; });
    expect(view.ready).toBe(false); expect(view.open).toBe(true); expect(f.disconnect).toHaveBeenCalledOnce();
  });
  it('stops if the old screen is unplugged during an unfinished switch to another screen', async () => {
    const f = await fixture(); await f.discover(); await f.present();
    const pending = deferred<void>(); f.fullscreen.mockImplementationOnce(() => pending.promise);
    let request!: Promise<void>;
    await act(async () => { request = view.present(f.internal); });
    await f.unplug();
    await act(async () => { pending.resolve(); await request; });
    expect(view.ready).toBe(false); expect(f.disconnect).toHaveBeenCalledOnce();
  });
  it('observes changes of a newly attached screen and removes the listeners on cleanup', async () => {
    const f = await fixture(); f.details.screens = [f.internal]; await f.discover();
    const add = vi.spyOn(f.external as HdmiScreen & EventTarget, 'addEventListener');
    const remove = vi.spyOn(f.external as HdmiScreen & EventTarget, 'removeEventListener');
    f.details.screens = [f.internal, f.external];
    await act(async () => f.details.dispatchEvent(new Event('screenschange')));
    expect(add).toHaveBeenCalledWith('change', expect.any(Function));
    f.external.width = 2160;
    await act(async () => (f.external as HdmiScreen & EventTarget).dispatchEvent(new Event('change')));
    expect(host!.find(n => n.nodeName === 'small' && n.getReactProps().children?.[0] === 2160)).toBeDefined();
    await host!.close(); host = undefined;
    expect(remove).toHaveBeenCalledWith('change', expect.any(Function));
  });
  it('does not claim a target was reached when a browser ignores fullscreen screen options', async () => {
    const f = await fixture(); await f.discover();
    f.fullscreen.mockImplementationOnce(async () => { /* Browser ignores target or fullscreen. */ });
    await f.present(); expect(view.ready).toBe(false); expect(view.open).toBe(true); expect(view.manual).toBe(true);
    expect(view.message).toContain('未能');
  });
  it('keeps manual fullscreen after permission rejection', async () => {
    const f = await fixture(); f.getScreenDetails.mockRejectedValueOnce(new DOMException('Denied', 'NotAllowedError'));
    await f.discover(); expect(view.message).toContain('权限'); expect(view.ready).toBe(false);
    await act(async () => view.present());
    expect(f.fullscreen).toHaveBeenCalledWith(undefined); expect(view.ready).toBe(true);
  });
  it('offers a manual window when automatic display/fullscreen APIs are unavailable', async () => {
    const f = await fixture({ supported: false });
    await f.discover(); expect(f.getScreenDetails).not.toHaveBeenCalled();
    Object.assign(document.documentElement, { requestFullscreen: undefined });
    await act(async () => view.present()); expect(view.ready).toBe(false);
    expect(view.message).toContain('重试');
    await act(async () => view.useWindow()); expect(view.ready).toBe(true);
  });
  it('shows a concise single-screen fallback without claiming HDMI is disconnected', async () => {
    const f = await fixture(); f.details.screens = [f.internal];
    await f.discover(); expect(view.message).toContain('未发现可选外接屏'); expect(view.ready).toBe(false);
    await act(async () => view.present()); expect(view.ready).toBe(true);
  });
  it('tracks a manually moved window after display permission is granted', async () => {
    const f = await fixture(); await f.discover();
    await act(async () => view.useWindow());
    f.details.currentScreen = f.external;
    await act(async () => f.details.dispatchEvent(new Event('currentscreenchange')));
    f.details.screens = [f.internal]; f.details.currentScreen = f.internal;
    await act(async () => f.details.dispatchEvent(new Event('currentscreenchange')));
    expect(view.ready).toBe(false); expect(f.disconnect).toHaveBeenCalledOnce();
  });
  it('does not change the URL or lose selected-screen monitoring when the panel closes', async () => {
    const f = await fixture(); const href = window.location.href;
    await f.discover(); await f.present();
    await act(async () => { view.setOpen(true); }); await act(async () => { view.setOpen(false); });
    await f.unplug(); expect(f.disconnect).toHaveBeenCalledOnce(); expect(window.location.href).toBe(href);
  });
  it('removes observers and ignores a late permissions response after unmount', async () => {
    const f = await fixture(); await f.discover(); await f.present();
    const pending = deferred<HdmiScreenDetails>(); f.getScreenDetails.mockImplementationOnce(() => pending.promise);
    let request!: Promise<void>;
    await act(async () => { request = view.discover(); });
    await host!.close(); host = undefined;
    pending.resolve(f.details); await request; await f.unplug();
    expect(f.disconnect).not.toHaveBeenCalled();
  });
  it('is inert for ordinary browser and Android output', async () => {
    const f = await fixture({ enabled: false });
    expect(view.ready).toBe(true); expect(view.open).toBe(false); expect(f.getScreenDetails).not.toHaveBeenCalled();
    await f.unplug(); expect(f.disconnect).not.toHaveBeenCalled();
  });
  it('uses readable fallbacks for missing screen labels', () => {
    expect(hdmiScreenName({ label: '  ', isInternal: false } as HdmiScreen, 1)).toBe('显示器 2');
    expect(hdmiScreenName({ label: '', isInternal: true } as HdmiScreen, 0)).toBe('内置屏幕 1');
  });
});
