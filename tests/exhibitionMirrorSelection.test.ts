import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ExhibitionApp from '../src/exhibition/ExhibitionApp';
import type { ExhibitionMirrorList, ExhibitionMirrorSummary } from '../shared/exhibition';
import { createReactHost, flushReact } from './support/reactHost';

const mocks = vi.hoisted(() => ({ registry: vi.fn(), controller: vi.fn(), terminal: vi.fn() }));
vi.mock('../src/exhibition/useMirrors', () => ({ useMirrors: mocks.registry }));
vi.mock('../src/exhibition/useExhibition', () => ({ useExhibition: mocks.controller }));
vi.mock('../src/exhibition/useTerminalBinding', () => ({ useTerminalBinding: mocks.terminal }));
vi.mock('../src/exhibition/useExhibitionLive', () => ({ useExhibitionLive: () => ({}) }));

let host: Awaited<ReturnType<typeof createReactHost>> | undefined;
afterEach(async () => { await host?.close(); host = undefined; vi.unstubAllGlobals(); vi.clearAllMocks(); });

function mirror(id: string): ExhibitionMirrorSummary {
  return { id, name: id, phase: 'idle', revision: 1, updatedAt: 1, providerMode: 'demo', binding: null };
}

async function fixture(path: 'control' | 'screen', selected = 'east') {
  host = await createReactHost();
  let url = new URL(`${path === 'screen' ? 'https://xuminghong.local:10202' : 'http://xuminghong.local:10200'}/v1.1/exhibition/${path}?mirror=${selected}&mode=touch#settings`);
  const location = { href: url.href, pathname: url.pathname, search: url.search, replace: vi.fn() };
  const replaceState = vi.fn((_state: unknown, _title: string, next: string | URL) => {
    url = new URL(next); Object.assign(location, { href: url.href, pathname: url.pathname, search: url.search });
  });
  Object.assign(window, { location, history: { replaceState } });
  let data: ExhibitionMirrorList = { defaultMirrorId: 'default', mirrors: [mirror('default'), mirror('east')] };
  mocks.registry.mockImplementation(() => ({ data, error: '', refresh: vi.fn() }));
  mocks.controller.mockReturnValue({ state: null, connected: true, error: '', refresh: vi.fn() });
  mocks.terminal.mockReturnValue({ ready: true, connected: true, identity: null, connection: null });
  await host.render(createElement(ExhibitionApp)); await flushReact();
  return { replaceState, location, async remove() {
    data = { ...data, mirrors: data.mirrors.filter(item => item.id !== 'east') };
    await host!.render(createElement(ExhibitionApp)); await flushReact();
  } };
}

describe('deleted mirror navigation', () => {
  it('moves an open staff page to the default mirror when another page removes its selection', async () => {
    const f = await fixture('control');
    expect(mocks.controller).toHaveBeenLastCalledWith('east');
    await f.remove();
    expect(mocks.controller).toHaveBeenLastCalledWith('default');
    expect(f.replaceState).toHaveBeenCalledOnce();
    const target = new URL(f.location.href);
    expect(target.origin).toBe('http://xuminghong.local:10200');
    expect(target.searchParams.get('mirror')).toBe('default');
    expect(target.searchParams.get('mode')).toBe('touch');
    expect(target.hash).toBe('#settings');
  });

  it('does not silently redirect an initially unknown mirror link', async () => {
    const f = await fixture('control', 'missing');
    expect(mocks.controller).not.toHaveBeenCalled();
    expect(f.replaceState).not.toHaveBeenCalled();
    expect(host!.find(node => node.nodeName === 'h1')?.textContent).toBe('设备不存在');
  });

  it('never reassigns an open camera screen to another mirror after removal', async () => {
    const f = await fixture('screen');
    expect(mocks.controller).toHaveBeenLastCalledWith('east');
    mocks.controller.mockClear();
    await f.remove();
    expect(mocks.controller).not.toHaveBeenCalled();
    expect(f.replaceState).not.toHaveBeenCalled();
    expect(host!.find(node => node.nodeName === 'h1')?.textContent).toBe('设备不存在');
  });
});
