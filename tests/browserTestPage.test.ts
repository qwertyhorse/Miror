import { act, createElement, StrictMode, useEffect, type ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { appUrl } from '../src/versionScope';
import { BrowserTestPage } from '../src/exhibition/BrowserTestPage';
import ExhibitionApp from '../src/exhibition/ExhibitionApp';
import { exhibitionBrowserTestUrl, defaultMirrorCameraEntry } from '../src/exhibition/cameraEntry';
import type { ExhibitionMirrorSummary } from '../shared/exhibition';
import { createReactHost, flushReact } from './support/reactHost';

const mocks = vi.hoisted(() => ({ registry: vi.fn(), terminal: vi.fn(), controller: vi.fn(), live: vi.fn() }));
vi.mock('../src/exhibition/useMirrors', () => ({ useMirrors: mocks.registry }));
vi.mock('../src/exhibition/useTerminalBinding', () => ({ useTerminalBinding: mocks.terminal }));
vi.mock('../src/exhibition/useExhibition', () => ({ useExhibition: mocks.controller }));
vi.mock('../src/exhibition/useExhibitionLive', () => ({ useExhibitionLive: mocks.live }));

const testId = 'test-2b960f65-a639-4f96-925c-ea2f4a673cb1';
const anotherTestId = 'test-bfccd285-b13d-48f6-bf00-75fec9f4e011';
const mirror: ExhibitionMirrorSummary = { id: testId, name: '一号镜 · 浏览器测试', phase: 'select', revision: 1, updatedAt: 1, providerMode: 'xmax', binding: null };
const session = (expiresAt = Date.now() + 3600000) => ({ mirror, expiresAt });
let host: Awaited<ReturnType<typeof createReactHost>> | undefined;
afterEach(async () => {
  await host?.close(); host = undefined;
  await vi.advanceTimersByTimeAsync(0);
  vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.clearAllMocks();
});

function deferred<T>() { let resolve!: (value: T) => void; return { promise: new Promise<T>(done => { resolve = done; }), resolve }; }
async function fixture(query = 'mirror=source&browserTest=1') {
  vi.useFakeTimers(); host = await createReactHost();
  const url = new URL(`https://xuminghong.local:10202/v1.1/exhibition/screen?${query}`);
  const location = { href: url.href, pathname: url.pathname, search: url.search, replace: vi.fn() };
  const replaceState = vi.fn((_state: unknown, _title: string, next: string | URL) => {
    const target = new URL(next); Object.assign(location, { href: target.href, search: target.search });
  });
  Object.assign(window, { location, history: { replaceState } });
  const storage = { getItem: vi.fn(), setItem: vi.fn(), removeItem: vi.fn() };
  vi.stubGlobal('localStorage', storage); vi.stubGlobal('sessionStorage', storage);
  const fetcher = vi.fn().mockImplementation(async (path: string) => path.endsWith('/close') ? Response.json({ closed: true }) : Response.json(session()));
  vi.stubGlobal('fetch', fetcher);
  const renderMirror = vi.fn((value: ExhibitionMirrorSummary, controls: ReactNode) => createElement('section', { 'data-mirror': value.id }, controls));
  return { fetcher, storage, replaceState, location, renderMirror,
    async render(strict = false) {
      const page = createElement(BrowserTestPage, { renderMirror });
      await host!.render(strict ? createElement(StrictMode, null, page) : page); await flushReact();
    },
  };
}
function button(text: string) { return host!.find(node => node.nodeName === 'button' && node.textContent.includes(text))!; }
async function click(text: string) { await act(async () => { await button(text).getReactProps().onClick(); }); await flushReact(); }

describe('isolated browser test page', () => {
  it('creates one test under StrictMode and preserves the source URL without terminal storage', async () => {
    const f = await fixture('mirror=floor%2F2&browserTest=1');
    await f.render(true); await vi.advanceTimersByTimeAsync(0);
    expect(f.fetcher).toHaveBeenCalledOnce();
    expect(f.fetcher).toHaveBeenCalledWith(appUrl('/api/exhibition/mirrors/floor%2F2/browser-tests'), expect.objectContaining({
      method: 'POST', body: '{}', credentials: 'same-origin', cache: 'no-store',
    }));
    expect(new URL(f.location.href).searchParams.get('mirror')).toBe('floor/2');
    expect(new URL(f.location.href).searchParams.get('browserTest')).toBe(testId);
    expect(f.renderMirror).toHaveBeenCalledWith(mirror, expect.anything());
    expect(f.storage.getItem).not.toHaveBeenCalled(); expect(f.storage.setItem).not.toHaveBeenCalled();
    await f.render(true);
    expect(f.fetcher).toHaveBeenCalledOnce(); expect(button('结束测试')).toBeTruthy();
  });

  it('restores a refresh with its cookie-bound test id and never creates another mirror', async () => {
    const f = await fixture(`mirror=source&browserTest=${testId}`); await f.render();
    expect(f.fetcher).toHaveBeenCalledExactlyOnceWith(appUrl(`/api/exhibition/mirrors/${testId}/browser-test`), expect.objectContaining({ credentials: 'same-origin' }));
    expect(f.fetcher.mock.calls[0][1].method).toBeUndefined();
    window.dispatchEvent(new Event('pagehide')); await vi.advanceTimersByTimeAsync(0);
    expect(f.fetcher).toHaveBeenCalledOnce();
  });

  it('cleans up a late create after leaving without replacing the next page URL', async () => {
    const f = await fixture(); const pending = deferred<Response>(); f.fetcher.mockReturnValueOnce(pending.promise);
    await f.render(); await host!.close(); host = undefined; await vi.advanceTimersByTimeAsync(0);
    await act(async () => { pending.resolve(Response.json(session())); }); await flushReact();
    expect(f.fetcher).toHaveBeenLastCalledWith(appUrl(`/api/exhibition/mirrors/${testId}/browser-test/close`), expect.objectContaining({ method: 'POST', keepalive: true }));
    expect(f.replaceState).not.toHaveBeenCalled(); expect(f.renderMirror).not.toHaveBeenCalled();
  });

  it('closes a ready test only on actual unmount, not a parent render or StrictMode probe', async () => {
    const f = await fixture(); await f.render(true); await f.render(true);
    expect(f.fetcher).toHaveBeenCalledOnce();
    await host!.close(); host = undefined; await vi.advanceTimersByTimeAsync(0);
    expect(f.fetcher).toHaveBeenCalledTimes(2);
    expect(f.fetcher).toHaveBeenLastCalledWith(appUrl(`/api/exhibition/mirrors/${testId}/browser-test/close`), expect.objectContaining({ keepalive: true }));
  });

  it('bounds an unresolved StrictMode create and reclaims a late result without adopting it', async () => {
    const f = await fixture(); const pending = deferred<Response>(); f.fetcher.mockReturnValueOnce(pending.promise);
    await f.render(true);
    await act(async () => { await vi.advanceTimersByTimeAsync(10000); }); await flushReact();
    expect(f.fetcher).toHaveBeenCalledOnce(); expect(f.renderMirror).not.toHaveBeenCalled();
    expect(host!.find(node => node.attributes.role === 'alert')?.textContent).toContain('超时');
    expect(host!.find(node => node.nodeName === 'a' && node.textContent === '重新测试')).toBeDefined();
    await act(async () => { pending.resolve(Response.json(session())); }); await flushReact();
    expect(f.fetcher).toHaveBeenLastCalledWith(appUrl(`/api/exhibition/mirrors/${testId}/browser-test/close`), expect.objectContaining({ keepalive: true }));
    expect(f.replaceState).not.toHaveBeenCalled(); expect(f.renderMirror).not.toHaveBeenCalled();
    expect(host!.find(node => node.attributes.role === 'alert')?.textContent).toContain('超时');
  });

  it('includes response body time in the create deadline and cleans it after timeout plus unmount', async () => {
    const f = await fixture(); const body = deferred<ReturnType<typeof session>>();
    f.fetcher.mockResolvedValueOnce({ ok: true, json: () => body.promise });
    await f.render(); await act(async () => { await vi.advanceTimersByTimeAsync(10000); });
    await host!.close(); host = undefined; await vi.advanceTimersByTimeAsync(0);
    await act(async () => { body.resolve(session()); }); await flushReact();
    expect(f.fetcher).toHaveBeenCalledTimes(2);
    expect(f.fetcher).toHaveBeenLastCalledWith(appUrl(`/api/exhibition/mirrors/${testId}/browser-test/close`), expect.objectContaining({ keepalive: true }));
    expect(f.replaceState).not.toHaveBeenCalled(); expect(f.renderMirror).not.toHaveBeenCalled();
  });

  it('does not adopt or destroy a restored mirror after its GET has timed out', async () => {
    const f = await fixture(`mirror=source&browserTest=${testId}`); const pending = deferred<Response>();
    f.fetcher.mockReturnValueOnce(pending.promise); await f.render();
    await act(async () => { await vi.advanceTimersByTimeAsync(10000); }); await flushReact();
    expect(host!.find(node => node.attributes.role === 'alert')?.textContent).toContain('超时');
    await act(async () => { pending.resolve(Response.json(session())); }); await flushReact();
    expect(f.fetcher).toHaveBeenCalledOnce(); expect(f.renderMirror).not.toHaveBeenCalled(); expect(f.replaceState).not.toHaveBeenCalled();
  });

  it('allows close retry after the deadline and ignores an older late response', async () => {
    const f = await fixture(); await f.render();
    const old = deferred<Response>(); f.fetcher.mockReturnValueOnce(old.promise); await click('结束测试');
    await act(async () => { await vi.advanceTimersByTimeAsync(15000); }); await flushReact();
    expect(host!.find(node => node.attributes.role === 'alert')?.textContent).toContain('结束测试超时');
    expect(button('重试结束')).toBeDefined();
    const retry = deferred<Response>(); f.fetcher.mockReturnValueOnce(retry.promise); await click('重试结束');
    await act(async () => { old.resolve(Response.json({ closed: true })); }); await flushReact();
    expect(host!.find(node => node.nodeName === 'h1')?.textContent).toBe('正在结束测试…');
    await act(async () => { retry.resolve(Response.json({ closed: true })); }); await flushReact();
    expect(host!.find(node => node.nodeName === 'h1')?.textContent).toBe('测试已结束');
    expect(f.renderMirror).toHaveBeenCalledTimes(1); expect(f.fetcher).toHaveBeenCalledTimes(3);
  });

  it('unmounts camera/RTC immediately on close failure, permits cleanup retry, and never resumes generation', async () => {
    const f = await fixture(); const disconnected = vi.fn();
    function CaptureOwner({ controls }: { controls: ReactNode }) { useEffect(() => disconnected, []); return controls; }
    f.renderMirror.mockImplementation((_value, controls) => createElement(CaptureOwner, { controls }));
    await f.render();
    f.fetcher.mockResolvedValueOnce(Response.json({ message: '结束测试未确认，请重试。' }, { status: 409 }));
    await click('结束测试');
    expect(disconnected).toHaveBeenCalledOnce();
    expect(host!.find(node => node.attributes.role === 'alert')?.textContent).toContain('未确认');
    expect(button('重试结束')).toBeTruthy();
    expect(host!.find(node => node.nodeName === 'a' && node.textContent === '重新测试')).toBeUndefined();
    await click('重试结束');
    expect(host!.find(node => node.nodeName === 'h1')?.textContent).toBe('测试已结束');
    expect(f.fetcher.mock.calls.filter(([path]) => String(path).endsWith('/browser-tests'))).toHaveLength(1);
    await host!.close(); host = undefined; await vi.advanceTimersByTimeAsync(0);
    expect(f.fetcher).toHaveBeenCalledTimes(3);
  });

  it('coalesces repeated explicit close while cleanup is pending', async () => {
    const f = await fixture(); await f.render(); const close = button('结束测试').getReactProps().onClick;
    const pending = deferred<Response>(); f.fetcher.mockReturnValueOnce(pending.promise);
    await act(async () => { close(); close(); });
    expect(f.fetcher).toHaveBeenCalledTimes(2); expect(f.renderMirror).toHaveBeenCalledTimes(1);
    await act(async () => { pending.resolve(Response.json({ closed: true })); }); await flushReact();
    expect(host!.find(node => node.nodeName === 'h1')?.textContent).toBe('测试已结束');
  });

  it.each([
    [404, 'BROWSER_TEST_NOT_FOUND', true],
    [410, 'BROWSER_TEST_EXPIRED', true],
    [401, 'BROWSER_TEST_UNAUTHORIZED', false],
    [409, 'BROWSER_TEST_STOP_PENDING', false],
    [404, 'NOT_FOUND', false],
  ] as const)('handles close %s/%s without trapping a restarted test or masking cleanup refusal', async (status, code, alreadyClosed) => {
    const f = await fixture(); await f.render();
    f.fetcher.mockResolvedValueOnce(Response.json({ error: { code }, message: '测试状态已变化。' }, { status }));
    await click('结束测试');
    expect(host!.find(node => node.nodeName === 'h1')?.textContent).toBe(alreadyClosed ? '测试已结束' : '浏览器测试');
    expect(!!host!.find(node => node.nodeName === 'a' && node.textContent === '重新测试')).toBe(alreadyClosed);
    expect(!!button('重试结束')).toBe(!alreadyClosed);
  });

  it('expires a test and releases its local capture without touching the source mirror', async () => {
    const f = await fixture(); f.fetcher.mockResolvedValueOnce(Response.json(session(Date.now() + 1000))); await f.render();
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); }); await flushReact();
    expect(host!.find(node => node.nodeName === 'h1')?.textContent).toBe('测试已结束');
    expect(f.fetcher.mock.calls.map(([path]) => path)).toEqual([appUrl('/api/exhibition/mirrors/source/browser-tests'), appUrl(`/api/exhibition/mirrors/${testId}/browser-test/close`)]);
  });

  it.each(['invalid', 'default', 'source'])('rejects an invalid test marker %s without falling back to a real mirror', async value => {
    const f = await fixture(`mirror=source&browserTest=${value}`); await f.render();
    expect(f.fetcher).not.toHaveBeenCalled(); expect(f.renderMirror).not.toHaveBeenCalled();
    expect(host!.find(node => node.attributes.role === 'alert')?.textContent).toContain('失效');
  });

  it('offers a fresh test after server restart instead of adopting a real mirror', async () => {
    const f = await fixture(`mirror=source&browserTest=${testId}`);
    f.fetcher.mockResolvedValueOnce(Response.json({ message: '测试已失效，请重新测试。' }, { status: 404 })); await f.render();
    expect(f.renderMirror).not.toHaveBeenCalled();
    const link = host!.find(node => node.nodeName === 'a')!;
    expect(new URL(link.attributes.href).searchParams.get('mirror')).toBe('source');
    expect(new URL(link.attributes.href).searchParams.get('browserTest')).toBe('1');
  });

  it('rejects a restored response belonging to a different test without closing that other test', async () => {
    const f = await fixture(`mirror=source&browserTest=${testId}`);
    f.fetcher.mockResolvedValueOnce(Response.json({ ...session(), mirror: { ...mirror, id: anotherTestId } })); await f.render();
    expect(f.renderMirror).not.toHaveBeenCalled(); expect(f.fetcher).toHaveBeenCalledOnce();
  });

  it('routes test pages before terminal/registry hooks even when a browser already has a real mirror identity', async () => {
    const f = await fixture();
    f.storage.getItem.mockReturnValue(JSON.stringify({ terminalId: 'real-terminal', token: 'saved-token' }));
    mocks.controller.mockReturnValue({ state: null, connected: true, pending: false, error: '', refresh: vi.fn() });
    mocks.live.mockReturnValue({});
    await host!.render(createElement(ExhibitionApp)); await flushReact();
    expect(mocks.registry).not.toHaveBeenCalled(); expect(mocks.terminal).not.toHaveBeenCalled();
    expect(mocks.controller).toHaveBeenCalledExactlyOnceWith(testId);
    expect(mocks.live).toHaveBeenCalledWith(expect.objectContaining({ mirrorId: testId, active: true, terminal: undefined, cameraPreferenceScope: testId }));
    expect(f.storage.getItem).not.toHaveBeenCalled(); expect(f.storage.setItem).not.toHaveBeenCalled();
    expect(button('结束测试')).toBeTruthy();
    expect(host!.find(node => node.nodeName === 'button' && node.textContent.includes('绑定设备'))).toBeUndefined();
  });

  it('builds a separate HTTPS test entry for the selected mirror and preserves the flag during HTTP upgrade', async () => {
    await fixture();
    const url = new URL(exhibitionBrowserTestUrl('floor/2', 'http://192.168.63.54:10601/v1.1/exhibition/control?mirror=other'));
    expect(url.origin).toBe('https://192.168.63.54:10202'); expect(url.pathname).toBe(appUrl('/exhibition/screen'));
    expect(url.searchParams.get('mirror')).toBe('floor/2'); expect(url.searchParams.get('browserTest')).toBe('1');
    expect(defaultMirrorCameraEntry('http://xuminghong.local:10200/v1.1/exhibition/screen?mirror=source&browserTest=1'))
      .toBe('https://xuminghong.local:10202/v1.1/exhibition/screen?mirror=source&browserTest=1');
  });
});
