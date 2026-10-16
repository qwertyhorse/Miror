import { act, createElement } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { ProviderSettingsForm } from '../src/exhibition/ProviderSettingsForm';
import { createReactHost, flushReact } from './support/reactHost';
let host: Awaited<ReturnType<typeof createReactHost>> | undefined;
afterEach(async () => { await host?.close(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
it('ignores a poll started before save instead of restoring an obsolete provider revision', async () => {
  host = await createReactHost();
  let poll!: () => void;
  vi.spyOn(globalThis, 'setInterval').mockImplementation(((callback: () => void) => { poll = callback; return 1; }) as typeof setInterval);
  let stale!: (response: Response) => void;
  const pending = new Promise<Response>(resolve => { stale = resolve; });
  const value = { revision: 1, active: 'xmax', desired: 'xmax', pending: false, accounts: { xmax: { configured: true }, decart: { configured: true } } };
  let reads = 0;
  const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => init?.method === 'PUT'
    ? Response.json({ ...value, revision: 2, active: 'decart', desired: 'decart' })
    : ++reads === 1 ? Response.json(value) : pending);
  vi.stubGlobal('fetch', fetcher);
  await host.render(createElement(ProviderSettingsForm, { mirrorId: 'east', onSaved: vi.fn() })); await flushReact();
  await act(async () => poll());
  await act(async () => host!.find(node => node.nodeName === 'form')!.getReactProps().onSubmit({ preventDefault: vi.fn() })); await flushReact();
  await act(async () => stale(Response.json(value))); await flushReact();
  expect(host.find(node => node.textContent === '当前：Decart · Lucy VTON 3.6')).toBeDefined();
  await act(async () => host!.find(node => node.nodeName === 'form')!.getReactProps().onSubmit({ preventDefault: vi.fn() })); await flushReact();
  const writes = fetcher.mock.calls.filter(([, init]) => init?.method === 'PUT');
  expect(JSON.parse(writes[1][1]!.body as string).expectedRevision).toBe(2);
});
it('waits for automatically prepared target materials before allowing an explicit switch', async () => {
  host = await createReactHost();
  let poll!: () => void;
  vi.spyOn(globalThis, 'setInterval').mockImplementation(((callback: () => void) => { poll = callback; return 1; }) as typeof setInterval);
  let ready = false;
  const value = { revision: 3, active: 'xmax', desired: 'decart', pending: true, accounts: { xmax: { configured: true }, decart: { configured: true } } };
  const fetcher = vi.fn(async (url: unknown, init?: RequestInit) => {
    const path = String(url);
    if (path.endsWith('/publication/prepare')) return Response.json({ accepted: true });
    if (path.endsWith('/materials/readiness')) return Response.json({ stateRevision: 7, targetReadyLookIds: ready ? ['coat'] : [], targetUnavailableLookIds: ready ? [] : ['coat'] });
    if (path.endsWith('/apply')) return Response.json({ ...value, revision: 4, active: 'decart', pending: false });
    return Response.json(value);
  });
  vi.stubGlobal('fetch', fetcher);
  await host.render(createElement(ProviderSettingsForm, { mirrorId: 'east', onSaved: vi.fn() })); await flushReact();
  const button = (text: string) => host!.find(node => node.nodeName === 'button' && node.textContent === text)!;
  expect(button('切换服务').getReactProps().disabled).toBe(true);
  expect(host.find(node => node.nodeName === 'button' && node.textContent === '准备目标服务素材')).toBeUndefined();
  expect(fetcher.mock.calls.some(([url]) => String(url).endsWith('/publication/prepare'))).toBe(false);
  ready = true; await act(async () => poll()); await flushReact();
  expect(button('切换服务').getReactProps().disabled).toBe(false);
  await act(async () => button('切换服务').getReactProps().onClick()); await flushReact();
  expect(fetcher.mock.calls.some(([url]) => String(url).endsWith('/apply'))).toBe(true);
});

it('allows switching once a target material is ready while other materials keep processing', async () => {
  host = await createReactHost();
  const value = { revision: 3, active: 'xmax', desired: 'decart', pending: true, accounts: { xmax: { configured: true }, decart: { configured: true } } };
  vi.stubGlobal('fetch', vi.fn(async (url: unknown) => String(url).endsWith('/materials/readiness')
    ? Response.json({ targetReadyLookIds: ['coat'], targetUnavailableLookIds: ['shirt'] }) : Response.json(value)));
  await host.render(createElement(ProviderSettingsForm, { mirrorId: 'east', onSaved: vi.fn() })); await flushReact();
  const button = host.find(node => node.nodeName === 'button' && node.textContent === '切换服务')!;
  expect(button.getReactProps().disabled).toBe(false);
});
