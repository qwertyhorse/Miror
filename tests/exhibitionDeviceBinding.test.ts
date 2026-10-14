import { act, createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MirrorDeviceBinding } from '../src/exhibition/MirrorDeviceBinding';
import type { ExhibitionDeviceBinding, ExhibitionMirrorSummary, ExhibitionState } from '../shared/exhibition';
import type { ExhibitionController } from '../src/exhibition/useExhibition';
import type { MirrorRegistry } from '../src/exhibition/useMirrors';
import { appUrl } from '../src/versionScope';
import { createReactHost, flushReact } from './support/reactHost';

const binding: ExhibitionDeviceBinding = { terminalId: 'terminal-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', label: '入口安卓镜端', platform: 'android', boundAt: 1_800_000_000_000, lastSeenAt: 1_800_000_000_000, online: true };
const mirror: ExhibitionMirrorSummary = { id: 'default', name: '智能镜 1', phase: 'idle', revision: 1, providerMode: 'demo', updatedAt: 1_800_000_000_000, binding: null };
function render(device: ExhibitionDeviceBinding | null, options: { phase?: ExhibitionState['phase']; live?: ExhibitionState['live']; connected?: boolean; pending?: boolean } = {}) {
  const controller = { state: { phase: options.phase ?? 'idle', live: options.live ?? null }, connected: options.connected ?? true, pending: options.pending ?? false } as ExhibitionController;
  const registry = { data: { defaultMirrorId: 'default', mirrors: [{ ...mirror, binding: device }] }, error: '', refresh: async () => {} } as unknown as MirrorRegistry;
  return renderToStaticMarkup(createElement(MirrorDeviceBinding, { mirror: { ...mirror, binding: device }, controller, registry }));
}

describe('staff terminal binding presentation', () => {
  it('explains where to obtain a four-digit code before pairing a device', () => {
    const html = render(null);
    expect(html).toContain('镜端设备'); expect(html).toContain('未绑定'); expect(html).toContain('绑定镜端设备');
    expect(html).toContain('镜端点击「绑定设备」获取绑定码，安卓客户端未绑定时自动显示。');
    expect(html).not.toContain('disabled=""');
  });

  it('shows only public online device details, even when unexpected secret fields are present', () => {
    const html = render({ ...binding, token: 'do-not-render-terminal-secret', tokenHash: 'do-not-render-hash', code: '6543' } as ExhibitionDeviceBinding);
    expect(html).toContain('入口安卓镜端'); expect(html).toContain('在线'); expect(html).toContain('安卓客户端'); expect(html).toContain('最近连接：');
    expect(html).toContain(`title="${binding.terminalId}">设备 aaaa</span>`);
    expect(html).not.toContain('do-not-render'); expect(html).not.toContain('6543');
  });

  it('shows offline state after restart without rendering an epoch date as a recent connection', () => {
    const html = render({ ...binding, online: false, lastSeenAt: 0 });
    expect(html).toContain('离线'); expect(html).toContain('等待镜端重新连接。');
    expect(html).not.toContain('最近连接：'); expect(html).not.toContain('1970');
  });

  it('keeps binding guarded while an experience or live session is active', () => {
    for (const options of [{ phase: 'generating' as const }, { phase: 'paused' as const }, { live: { sessionId: 'live-session' } as ExhibitionState['live'] }]) {
      expect(render(null, options)).toContain('disabled=""');
    }
  });

  it.each(['idle', 'select', 'positioning', 'generating', 'showcase', 'paused'] as const)('allows active unbinding while %s, even when the terminal is offline', phase => {
    for (const online of [true, false]) {
      const html = render({ ...binding, online }, { phase, live: { status: 'error', sessionId: 'live-session' } as ExhibitionState['live'] });
      expect(html.match(/<button[^>]*class="ex-button ex-binding-unbind"[^>]*>/)?.[0]).not.toContain('disabled');
      expect(html).not.toContain('结束体验并停止实时会话后');
    }
  });

  it('disables both bind and unbind only while backend synchronization is unavailable', () => {
    for (const device of [null, binding]) {
      for (const options of [{ connected: false }, { pending: true }]) {
        expect(render(device, options)).toContain('disabled=""');
      }
    }
  });
});

let host: Awaited<ReturnType<typeof createReactHost>> | undefined;
const restores: (() => void)[] = [];
afterEach(async () => {
  await host?.close(); host = undefined;
  restores.splice(0).forEach(restore => restore());
  vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers();
});
function deferred<T>() { let resolve!: (value: T) => void; return { promise: new Promise<T>(yes => { resolve = yes; }), resolve }; }
async function bindingFixture(device: ExhibitionDeviceBinding | null = { ...binding, online: false }) {
  host = await createReactHost();
  const prototype = Object.getPrototypeOf(document.createElement('div'));
  const descriptors = new Map(['showModal', 'close', 'querySelector', 'focus', 'isConnected'].map(key => [key, Object.getOwnPropertyDescriptor(prototype, key)]));
  Object.defineProperties(prototype, {
    showModal: { configurable: true, value() { this.open = true; } },
    close: { configurable: true, value() { this.open = false; } },
    querySelector: { configurable: true, value() { return host!.find(node => node.nodeName === 'input'); } },
    focus: { configurable: true, value() {
      let ancestor = this;
      while (ancestor) {
        if (ancestor.nodeName === 'dialog' && !ancestor.open) return;
        ancestor = ancestor.parentNode;
      }
      Reflect.set(document, 'activeElement', this);
    } },
    isConnected: { configurable: true, get() { return document.body.contains(this); } },
  });
  restores.push(() => descriptors.forEach((value, key) => { if (value) Object.defineProperty(prototype, key, value); else Reflect.deleteProperty(prototype, key); }));
  vi.stubGlobal('HTMLElement', window.HTMLElement);
  Object.assign(window, { setTimeout });
  const refreshState = vi.fn(async () => {}); const refreshRegistry = vi.fn(async () => {});
  const state = { phase: 'paused', live: { status: 'error', sessionId: 'live-session' } } as ExhibitionState;
  const controller = { state, connected: true, pending: false, refresh: refreshState } as unknown as ExhibitionController;
  const registry = { refresh: refreshRegistry } as unknown as MirrorRegistry;
  const props = { mirror: { ...mirror, binding: device }, controller, registry };
  const fetcher = vi.fn(async () => Response.json({ binding: null })); vi.stubGlobal('fetch', fetcher);
  const render = () => host!.render(createElement(MirrorDeviceBinding, props));
  const button = (label: string) => host!.find(node => node.nodeName === 'button' && (node.textContent === label || node.getReactProps()['aria-label'] === label))!;
  const dialog = () => host!.find(node => node.nodeName === 'dialog');
  const open = async () => { await act(async () => { button(device ? '解绑' : '绑定镜端设备').getReactProps().onClick(); }); };
  const submit = async () => { await act(async () => { host!.find(node => node.nodeName === 'form')!.getReactProps().onSubmit({ preventDefault: vi.fn() }); }); await flushReact(); };
  await render();
  return { props, state, controller, fetcher, refreshState, refreshRegistry, render, button, dialog, open, submit };
}

describe('staff active unbinding', () => {
  it('opens a concise confirmation during a paused, offline session and cancels without a request', async () => {
    const f = await bindingFixture(); const opener = f.button('解绑');
    await act(async () => opener.focus()); await f.open();
    expect(f.dialog()?.textContent).toContain('这将结束当前体验，下次使用需重新绑定。');
    expect(f.button('确认解绑').getReactProps().disabled).toBe(false); expect(f.fetcher).not.toHaveBeenCalled();
    await act(async () => f.button('取消').getReactProps().onClick());
    expect(f.dialog()).toBeUndefined(); expect(f.fetcher).not.toHaveBeenCalled(); expect(document.activeElement === opener).toBe(true);
  });

  it('unbinds the confirmed terminal and refreshes both binding and experience state', async () => {
    const f = await bindingFixture(); await f.open(); await f.submit();
    expect(f.fetcher).toHaveBeenCalledExactlyOnceWith(appUrl('/api/exhibition/mirrors/default/binding'), expect.objectContaining({
      method: 'DELETE', body: JSON.stringify({ terminalId: binding.terminalId }), cache: 'no-store',
    }));
    expect(f.refreshRegistry).toHaveBeenCalledOnce(); expect(f.refreshState).toHaveBeenCalledOnce();
    expect(f.dialog()).toBeUndefined(); expect(host!.find(node => node.getReactProps().role === 'status')?.textContent).toBe('镜端设备已解绑。');
  });

  it('sends one request and locks dismissal while unbinding is in flight', async () => {
    const f = await bindingFixture(); const pending = deferred<Response>(); f.fetcher.mockReturnValueOnce(pending.promise);
    await f.open(); const submit = host!.find(node => node.nodeName === 'form')!.getReactProps().onSubmit;
    await act(async () => { submit({ preventDefault: vi.fn() }); submit({ preventDefault: vi.fn() }); });
    expect(f.fetcher).toHaveBeenCalledOnce(); expect(f.button('正在处理…').getReactProps().disabled).toBe(true);
    expect(f.button('解绑').getReactProps().disabled).toBe(true); expect(f.button('取消').getReactProps().disabled).toBe(true);
    await act(async () => f.dialog()!.getReactProps().onCancel({ preventDefault: vi.fn() })); expect(f.dialog()).toBeDefined();
    await act(async () => pending.resolve(Response.json({ binding: null }))); await flushReact(); expect(f.dialog()).toBeUndefined();
  });

  it('keeps the confirmation and supports retry after a server error', async () => {
    const f = await bindingFixture(); f.fetcher.mockResolvedValueOnce(Response.json({ message: '绑定状态已变化，请重试。' }, { status: 409 }));
    await f.open(); await f.submit();
    expect(f.dialog()).toBeDefined(); expect(f.button('确认解绑').getReactProps().disabled).toBe(false);
    expect(host!.find(node => node.getReactProps().role === 'alert')?.textContent).toBe('绑定状态已变化，请重试。');
    expect(f.refreshRegistry).toHaveBeenCalledOnce(); expect(f.refreshState).toHaveBeenCalledOnce();
    await f.submit(); expect(f.fetcher).toHaveBeenCalledTimes(2); expect(f.dialog()).toBeUndefined();
  });

  it('reports a timed-out unbind and allows a fresh attempt', async () => {
    vi.useFakeTimers();
    const f = await bindingFixture();
    f.fetcher.mockImplementationOnce((_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init.signal!.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
    }));
    await f.open(); await f.submit();
    await act(async () => { await vi.advanceTimersByTimeAsync(10000); }); await flushReact();
    expect(host!.find(node => node.getReactProps().role === 'alert')?.textContent).toBe('请求超时，请核对绑定状态后重试。');
    expect(f.button('确认解绑').getReactProps().disabled).toBe(false);
    await f.submit(); expect(f.fetcher).toHaveBeenCalledTimes(2); expect(f.dialog()).toBeUndefined();
  });

  it('keeps the confirmed terminal stable when polling reports a different binding', async () => {
    const f = await bindingFixture(); await f.open();
    f.props.mirror = { ...mirror, binding: { ...binding, terminalId: 'terminal-replacement', label: '新镜端' } };
    await f.render(); await f.submit();
    expect(f.fetcher).toHaveBeenCalledExactlyOnceWith(appUrl('/api/exhibition/mirrors/default/binding'), expect.objectContaining({
      body: JSON.stringify({ terminalId: binding.terminalId }),
    }));
  });

  it.each(['disconnected', 'pending'] as const)('blocks opening and submitting when the backend becomes %s', async reason => {
    const f = await bindingFixture();
    if (reason === 'disconnected') f.controller.connected = false; else f.controller.pending = true;
    await f.render(); await f.open(); expect(f.dialog()).toBeUndefined();
    f.controller.connected = true; f.controller.pending = false; await f.render(); await f.open();
    if (reason === 'disconnected') f.controller.connected = false; else f.controller.pending = true;
    await f.render(); await f.submit();
    expect(f.fetcher).not.toHaveBeenCalled(); expect(f.button('确认解绑').getReactProps().disabled).toBe(true);
  });

  it.each(['switch', 'unmount'] as const)('aborts and ignores a late unbind response after %s', async action => {
    const f = await bindingFixture(); const pending = deferred<Response>(); f.fetcher.mockReturnValueOnce(pending.promise);
    await f.open(); await f.submit();
    const signal = (f.fetcher.mock.calls[0] as unknown as [string, RequestInit])[1].signal!;
    if (action === 'switch') { f.props.mirror = { ...mirror, id: 'west', name: '西侧智能镜', binding: { ...binding, terminalId: 'terminal-west' } }; await f.render(); expect(f.dialog()).toBeUndefined(); }
    else { await host!.close(); host = undefined; }
    expect(signal.aborted).toBe(true);
    await act(async () => pending.resolve(Response.json({ binding: null }))); await flushReact();
    expect(f.refreshRegistry).not.toHaveBeenCalled(); expect(f.refreshState).not.toHaveBeenCalled();
    if (host) expect(host.find(node => node.getReactProps().role === 'status')).toBeUndefined();
  });

  it('does not carry a success notice into another mirror while the post-save refresh is pending', async () => {
    const f = await bindingFixture(); const refresh = deferred<void>(); f.refreshState.mockReturnValueOnce(refresh.promise);
    await f.open(); await f.submit(); expect(f.refreshRegistry).toHaveBeenCalledOnce(); expect(f.refreshState).toHaveBeenCalledOnce();
    f.props.mirror = { ...mirror, id: 'west', name: '西侧智能镜', binding: null }; await f.render();
    await act(async () => refresh.resolve()); await flushReact();
    expect(f.dialog()).toBeUndefined(); expect(host!.find(node => node.getReactProps().role === 'status')).toBeUndefined();
  });

  it('still requires an idle experience before binding, including when state changes after opening the dialog', async () => {
    const f = await bindingFixture(null); await f.open(); expect(f.dialog()).toBeUndefined();
    f.state.phase = 'idle'; f.state.live = null; await f.render(); await f.open();
    await act(async () => host!.find(node => node.nodeName === 'input')!.getReactProps().onChange({ target: { value: '1234' } }));
    f.state.phase = 'generating'; await f.render(); await f.submit(); expect(f.fetcher).not.toHaveBeenCalled();
    f.state.phase = 'idle'; await f.render(); await f.submit();
    expect(f.fetcher).toHaveBeenCalledExactlyOnceWith(appUrl('/api/exhibition/mirrors/default/binding'), expect.objectContaining({ method: 'POST', body: JSON.stringify({ code: '1234' }) }));
    expect(f.refreshRegistry).toHaveBeenCalledOnce(); expect(f.refreshState).toHaveBeenCalledOnce();
  });

  it('accepts exactly four numeric digits while preserving leading zeros', async () => {
    const f = await bindingFixture(null); f.state.phase = 'idle'; f.state.live = null; await f.render(); await f.open();
    const input = () => host!.find(node => node.nodeName === 'input')!;
    expect(input().getReactProps()).toMatchObject({ pattern: '[0-9]{4}', minLength: 4, maxLength: 4, placeholder: '0000' });
    await act(async () => input().getReactProps().onChange({ target: { value: '004' } }));
    expect(f.button('确认绑定').getReactProps().disabled).toBe(true); await f.submit(); expect(f.fetcher).not.toHaveBeenCalled();
    await act(async () => input().getReactProps().onChange({ target: { value: '0a04299' } }));
    expect(input().getReactProps().value).toBe('0042'); expect(f.button('确认绑定').getReactProps().disabled).toBe(false);
    await f.submit();
    expect(f.fetcher).toHaveBeenCalledExactlyOnceWith(appUrl('/api/exhibition/mirrors/default/binding'), expect.objectContaining({ method: 'POST', body: JSON.stringify({ code: '0042' }) }));
  });
});
