import { act, createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useReferencePreparation } from '../src/exhibition/useReferencePreparation';
import { ReferencePreparationBadge } from '../src/exhibition/ReferencePreparationBadge';
import { createReactHost, flushReact } from './support/reactHost';

let host: Awaited<ReturnType<typeof createReactHost>> | undefined;
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(100000); });
afterEach(async () => { await host?.close(); host = undefined; vi.useRealTimers(); vi.unstubAllGlobals(); });
function deferred<T>() { let resolve!: (value: T) => void; return { promise: new Promise<T>(yes => { resolve = yes; }), resolve }; }
const ready = { state: 'ready', freshUntil: 200000 };
const failed = { state: 'failed', message: '图片检查失败', retryAt: 100000 };
const response = (references: Record<string, unknown>) => Response.json({ references });

async function fixture(fetcher: ReturnType<typeof vi.fn>) {
  host = await createReactHost();
  Object.defineProperty(document, 'hidden', { configurable: true, value: false, writable: true });
  vi.stubGlobal('fetch', fetcher);
  let current!: ReturnType<typeof useReferencePreparation>;
  function Harness({ mirrorId, catalog }: { mirrorId: string; catalog: string }) { current = useReferencePreparation(mirrorId, catalog); return null; }
  const render = async (mirrorId = 'east', catalog = 'a') => { await host!.render(createElement(Harness, { mirrorId, catalog })); await flushReact(); };
  await render();
  return { get current() { return current; }, render,
    async hidden(value: boolean) { await act(async () => { Reflect.set(document, 'hidden', value); document.dispatchEvent(new Event('visibilitychange')); }); await flushReact(); },
  };
}

describe('material reference status polling', () => {
  it('loads one batch for the mirror, then polls every three seconds', async () => {
    const fetcher = vi.fn(async () => response({ a: ready, b: { state: 'queued' } }));
    const f = await fixture(fetcher);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0][0]).toBe('/api/exhibition/mirrors/east/references');
    expect(f.current.references.a.state).toBe('ready');
    await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
    expect(fetcher).toHaveBeenCalledTimes(2);
    await f.render('east', 'a,b,c');
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it('aborts requests and ignores a late response after switching mirrors', async () => {
    const pending = deferred<Response>();
    const fetcher = vi.fn().mockReturnValueOnce(pending.promise).mockImplementation(async () => response({ b: { state: 'unconfigured' } }));
    const f = await fixture(fetcher);
    const signal = fetcher.mock.calls[0][1].signal as AbortSignal;
    await f.render('west', 'b');
    expect(signal.aborted).toBe(true);
    expect(f.current.references).toEqual({ b: { state: 'unconfigured' } });
    await act(async () => pending.resolve(response({ a: ready }))); await flushReact();
    expect(f.current.references).toEqual({ b: { state: 'unconfigured' } });
    expect(fetcher.mock.calls[1][0]).toBe('/api/exhibition/mirrors/west/references');
  });

  it('pauses polling while hidden and refreshes immediately on return', async () => {
    const pending = deferred<Response>();
    const fetcher = vi.fn().mockReturnValueOnce(pending.promise).mockImplementation(async () => response({ a: failed }));
    const f = await fixture(fetcher);
    await f.hidden(true);
    expect(fetcher.mock.calls[0][1].signal.aborted).toBe(true);
    await act(async () => { await vi.advanceTimersByTimeAsync(15000); pending.resolve(response({ a: ready })); });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(f.current.references).toEqual({});
    await f.hidden(false);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(f.current.references.a.state).toBe('failed');
  });

  it.each(['http', 'invalid'] as const)('retains previous ready statuses on %s errors and allows refresh recovery', async failure => {
    const fetcher = vi.fn().mockResolvedValueOnce(response({ a: ready })).mockResolvedValueOnce(failure === 'http' ? new Response('', { status: 503 }) : response({ a: { state: 'not-a-status' } }))
      .mockImplementation(async () => response({ a: failed }));
    const f = await fixture(fetcher);
    expect(f.current.references.a.state).toBe('ready');
    await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
    expect(f.current.references).toEqual({ a: ready });
    expect(f.current.error).toBe('素材准备状态获取失败');
    await act(async () => f.current.refresh()); await flushReact();
    expect(f.current.error).toBe(''); expect(f.current.references.a.state).toBe('failed');
  });

  it('aborts every in-flight request when unmounted', async () => {
    const fetcher = vi.fn(() => new Promise<Response>(() => {}));
    await fixture(fetcher);
    await host!.close(); host = undefined;
    expect(fetcher.mock.calls[0][1].signal.aborted).toBe(true);
    await act(async () => { await vi.advanceTimersByTimeAsync(15000); });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});

describe('material reference preparation retries', () => {
  it('waits for the cooldown before retry and suppresses duplicate clicks without blocking other materials', async () => {
    const retryA = deferred<Response>(); const retryB = deferred<Response>();
    const fetcher = vi.fn((url: string, init: RequestInit) => init.method === 'POST'
      ? url.includes('/a/') ? retryA.promise : retryB.promise
      : Promise.resolve(response({ a: { ...failed, retryAt: 106000 }, b: failed })));
    const f = await fixture(fetcher);
    await act(async () => { await f.current.retry('a'); });
    expect(fetcher).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(6000); });
    let first!: Promise<void>; let second!: Promise<void>;
    await act(async () => { first = f.current.retry('a'); void f.current.retry('a'); second = f.current.retry('b'); });
    expect(fetcher.mock.calls.filter(([, init]) => init.method === 'POST')).toHaveLength(2);
    expect(f.current.retrying).toEqual(new Set(['a', 'b']));
    await act(async () => { retryA.resolve(Response.json({ status: { state: 'preparing' } }, { status: 202 })); retryB.resolve(Response.json({ status: { state: 'preparing' } }, { status: 202 })); await Promise.all([first, second]); });
    expect(f.current.references.a.state).toBe('preparing'); expect(f.current.references.b.state).toBe('preparing');
    expect(f.current.retrying.size).toBe(0);
  });

  it('prevents a list request started before retry from restoring its old failed state', async () => {
    const list = deferred<Response>();
    const fetcher = vi.fn().mockResolvedValueOnce(response({ a: failed })).mockReturnValueOnce(list.promise)
      .mockResolvedValueOnce(Response.json({ status: { state: 'preparing' } }, { status: 202 }));
    const f = await fixture(fetcher);
    await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
    await act(async () => { await f.current.retry('a'); });
    expect(fetcher.mock.calls[1][1].signal.aborted).toBe(true);
    await act(async () => list.resolve(response({ a: failed }))); await flushReact();
    expect(f.current.references.a.state).toBe('preparing');
  });

  it('shows a brief retry transport error and keeps the original failure reason', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(response({ a: failed })).mockRejectedValueOnce(new Error('private provider response'));
    const f = await fixture(fetcher);
    await act(async () => { await f.current.retry('a'); });
    expect(f.current.references.a.message).toBe('图片检查失败');
    expect(f.current.retryErrors.a).toBe('重试请求失败，请再试一次');
    expect(f.current.retrying.size).toBe(0);
  });

  it('ignores a retry response and clears retry errors on a mirror change', async () => {
    const pending = deferred<Response>();
    const fetcher = vi.fn().mockResolvedValueOnce(response({ a: failed })).mockReturnValueOnce(pending.promise).mockResolvedValueOnce(response({ b: ready }));
    const f = await fixture(fetcher);
    let retry!: Promise<void>;
    await act(async () => { retry = f.current.retry('a'); });
    await f.render('west', 'b');
    expect(fetcher.mock.calls[1][1].signal.aborted).toBe(true);
    await act(async () => { pending.resolve(Response.json({ status: { state: 'preparing' } }, { status: 202 })); await retry; });
    expect(f.current.references).toEqual({ b: ready }); expect(f.current.retrying.size).toBe(0); expect(f.current.retryErrors).toEqual({});
  });
});

describe('material reference status labels', () => {
  it('renders failure details and a disabled cooldown retry, then enables it', async () => {
    host = await createReactHost(); const retry = vi.fn();
    const render = (now: number) => host!.render(createElement(ReferencePreparationBadge, { name: '盔甲', status: { ...failed, state: 'failed', retryAt: 103000 }, unavailable: false, retrying: false, now, onRetry: retry }));
    await render(100000);
    const button = () => host!.find(node => node.getReactProps()['aria-label'] === '重试盔甲')!;
    expect(button().getReactProps().disabled).toBe(true); expect(button().textContent).toBe('3秒后重试');
    expect(host.find(node => node.textContent === '图片检查失败')).toBeDefined();
    await render(104000); expect(button().getReactProps().disabled).toBe(false);
    await act(async () => button().getReactProps().onClick()); expect(retry).toHaveBeenCalledOnce();
  });

  it('keeps permanent ready references available when their old freshness time passes or polling fails', async () => {
    host = await createReactHost();
    const props = { name: '盔甲', status: { state: 'ready' as const, freshUntil: 99999 }, unavailable: false, retrying: false, now: 100000, onRetry: vi.fn() };
    await host.render(createElement(ReferencePreparationBadge, props));
    expect(host.find(node => node.getReactProps()['aria-label'] === '盔甲：可用')).toBeDefined();
    await host.render(createElement(ReferencePreparationBadge, { ...props, unavailable: true }));
    expect(host.find(node => node.getReactProps()['aria-label'] === '盔甲：可用')).toBeDefined();
  });
});

it('keeps permanent references ready and offers explicit replacement without allowing duplicate repairs', async () => {
  const fetcher = vi.fn((url: string, init: RequestInit) => Promise.resolve(init.method === 'POST'
    ? Response.json({ status: { ...ready, freshUntil: Number.MAX_SAFE_INTEGER, refreshState: 'preparing' } })
    : response({ a: { ...ready, freshUntil: Number.MAX_SAFE_INTEGER } })));
  const f = await fixture(fetcher);
  await act(async () => { await f.current.retry('a'); });
  expect(JSON.parse(fetcher.mock.calls[1][1].body as string)).toEqual({ replace: true });
  await act(async () => { await f.current.retry('a'); }); expect(fetcher).toHaveBeenCalledTimes(2);
  expect(f.current.references.a.state).toBe('ready');
});
