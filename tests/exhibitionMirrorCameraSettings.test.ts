import { act, createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MirrorCameraSettings } from '../src/exhibition/MirrorCameraSettings';
import type { ExhibitionDeviceBinding } from '../shared/exhibition';
import type { ExhibitionCameraRequest, ExhibitionCameraStatus } from '../shared/exhibitionCamera';
import { appUrl } from '../src/versionScope';
import { createReactHost, flushReact } from './support/reactHost';

const terminalId = 'terminal-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const requested: ExhibitionCameraRequest = { id: 'request-one', action: 'open', mirrorId: 'default', terminalId, bindingId: 'binding-one', createdAt: 10, expiresAt: 120010 };
function camera(overrides: Partial<ExhibitionCameraStatus> = {}): ExhibitionCameraStatus {
  return { supported: true, terminalId, online: true, state: 'idle', devices: [], selectedDeviceId: null, activeDeviceId: null, updatedAt: 10, request: null, ...overrides };
}
function binding(overrides: Partial<ExhibitionDeviceBinding> = {}): ExhibitionDeviceBinding {
  return { terminalId, label: '入口镜端', platform: 'android', boundAt: 1, lastSeenAt: 10, online: true, camera: camera(), ...overrides };
}
let host: Awaited<ReturnType<typeof createReactHost>> | undefined;
afterEach(async () => { await host?.close(); host = undefined; vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });
function deferred<T>() { let resolve!: (value: T) => void; return { promise: new Promise<T>(yes => { resolve = yes; }), resolve }; }
async function fixture() {
  host = await createReactHost();
  const props = { mirrorId: 'default', binding: binding(), connected: true, editable: true, disabled: false, refresh: vi.fn(async () => {}) };
  const fetcher = vi.fn(async () => Response.json(camera({ state: 'requested', request: { ...requested, createdAt: Date.now(), expiresAt: Date.now() + 120000 } })));
  vi.stubGlobal('fetch', fetcher);
  const capture = vi.fn(); const enumerate = vi.fn(); vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: capture, enumerateDevices: enumerate } });
  const render = () => host!.render(createElement(MirrorCameraSettings, props));
  const button = () => host!.find(node => node.nodeName === 'button' && node.textContent === '切换摄像头')!;
  const click = async () => { await act(async () => button().getReactProps().onClick()); await flushReact(); };
  await render(); return { props, fetcher, capture, enumerate, render, button, click };
}

describe('per-mirror staff camera management', () => {
  it('opens the bound terminal camera settings without touching staff hardware or navigating away', async () => {
    const f = await fixture(); await f.click();
    expect(f.fetcher).toHaveBeenCalledExactlyOnceWith(appUrl('/api/exhibition/mirrors/default/camera'), expect.objectContaining({
      method: 'POST', body: JSON.stringify({ terminalId, action: 'open' }),
    }));
    expect(f.props.refresh).toHaveBeenCalledOnce();
    expect(f.capture).not.toHaveBeenCalled(); expect(f.enumerate).not.toHaveBeenCalled();
    expect(host!.find(node => node.nodeName === 'a')).toBeUndefined();
    expect(host!.find(node => node.getReactProps().role === 'status')?.textContent).toBe('请在镜端选择并预览摄像头');
  });

  it.each(['offline', 'unsupported', 'unavailable', 'active', 'disabled'] as const)('blocks a camera request while %s', async reason => {
    const f = await fixture();
    if (reason === 'offline') f.props.binding.online = false;
    if (reason === 'unsupported') f.props.binding.camera = undefined;
    if (reason === 'unavailable') f.props.connected = false;
    if (reason === 'active') f.props.editable = false;
    if (reason === 'disabled') f.props.disabled = true;
    await f.render(); expect(f.button().getReactProps().disabled).toBe(true);
    await f.click(); expect(f.fetcher).not.toHaveBeenCalled();
  });

  it('shows only this mirror camera list and prevents duplicate pending requests', async () => {
    const f = await fixture(); const pending = deferred<Response>(); f.fetcher.mockReturnValueOnce(pending.promise);
    await f.click(); await f.click(); expect(f.fetcher).toHaveBeenCalledOnce();
    await act(async () => pending.resolve(Response.json(camera({ state: 'requested', request: requested })))); await flushReact();
    f.props.binding = binding({ camera: camera({ state: 'preview', request: requested, selectedDeviceId: 'usb-1', activeDeviceId: 'usb-1', devices: [
      { id: 'usb-1', label: '绿联 USB 摄像头', kind: 'external' }, { id: 'front', label: '内置摄像头', kind: 'front' },
    ] }) });
    await f.render(); expect(f.button().getReactProps().disabled).toBe(true);
    expect(host!.find(node => node.nodeName === 'strong')?.textContent).toBe('绿联 USB 摄像头');
    expect(host!.find(node => node.nodeName === 'summary')?.textContent).toContain('2 个摄像头');
    expect(host!.find(node => node.nodeName === 'li' && node.textContent.includes('绿联'))?.textContent).toContain('已选择');
    f.props.binding = binding({ camera: camera({ state: 'closed' }) }); await f.render();
    expect(f.button().getReactProps().disabled).toBe(false);
    expect(host!.find(node => node.getReactProps().role === 'status')).toBeUndefined();
  });

  it('shows the server rejection and leaves retry available without pretending a terminal opened', async () => {
    const f = await fixture(); f.fetcher.mockResolvedValueOnce(Response.json({ message: '镜端绑定已变化，请刷新后重试。' }, { status: 409 }));
    await f.click(); expect(host!.find(node => node.getReactProps().role === 'alert')?.textContent).toContain('镜端绑定已变化');
    expect(host!.find(node => node.getReactProps().role === 'status')).toBeUndefined();
    expect(f.button().getReactProps().disabled).toBe(false); expect(f.props.refresh).not.toHaveBeenCalled();
  });

  it.each(['mirror', 'binding', 'unmount'] as const)('aborts and ignores a late response after changing %s', async change => {
    const f = await fixture(); const pending = deferred<Response>(); f.fetcher.mockReturnValueOnce(pending.promise); await f.click();
    const signal = (f.fetcher.mock.calls[0] as unknown as [string, RequestInit])[1].signal!;
    if (change === 'mirror') { f.props.mirrorId = 'west'; await f.render(); }
    else if (change === 'binding') { f.props.binding = binding({ terminalId: 'terminal-bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', boundAt: 2 }); await f.render(); }
    else { await host!.close(); host = undefined; }
    expect(signal.aborted).toBe(true);
    await act(async () => pending.resolve(Response.json(camera({ state: 'requested', request: requested })))); await flushReact();
    expect(f.props.refresh).not.toHaveBeenCalled();
    if (host) expect(host.find(node => node.getReactProps().role === 'status')).toBeUndefined();
  });

  it('times out a lost staff request and permits a fresh retry', async () => {
    vi.useFakeTimers(); const f = await fixture();
    f.fetcher.mockImplementationOnce((_url: string, init: RequestInit) => new Promise<Response>((_, reject) => {
      init.signal!.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
    }));
    await f.click(); await act(async () => { await vi.advanceTimersByTimeAsync(10000); }); await flushReact();
    expect(host!.find(node => node.getReactProps().role === 'alert')?.textContent).toContain('请求超时');
    expect(f.button().getReactProps().disabled).toBe(false);
  });

  it('expires an unsynchronized request notice even when the registry never observed its id', async () => {
    vi.useFakeTimers(); const f = await fixture();
    // useMirrors.refresh handles its own failures, leaving the previous snapshot.
    await f.click();
    expect(host!.find(node => node.getReactProps().role === 'status')?.textContent).toBe('请在镜端选择并预览摄像头');
    await act(async () => { await vi.advanceTimersByTimeAsync(119999); }); await flushReact();
    expect(host!.find(node => node.getReactProps().role === 'status')).toBeDefined();
    await act(async () => { await vi.advanceTimersByTimeAsync(1); }); await flushReact();
    expect(host!.find(node => node.getReactProps().role === 'status')).toBeUndefined();
    f.props.binding = binding({ camera: camera({ state: 'expired', request: null }) }); await f.render();
    expect(host!.find(node => node.getReactProps().role === 'status')).toBeUndefined();
    expect(f.button().getReactProps().disabled).toBe(false);
  });

  it.each(['observed', 'mirror', 'binding', 'unmount'] as const)('clears the unsynchronized request timer after %s', async change => {
    vi.useFakeTimers(); const f = await fixture(); await f.click(); expect(vi.getTimerCount()).toBe(1);
    if (change === 'observed') f.props.binding = binding({ camera: camera({ state: 'closed', request: requested }) });
    else if (change === 'mirror') f.props.mirrorId = 'west';
    else if (change === 'binding') f.props.binding = binding({ terminalId: 'terminal-bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', boundAt: 2 });
    else { await host!.close(); host = undefined; }
    if (host) await f.render();
    expect(vi.getTimerCount()).toBe(0);
  });
});
