import { act, createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MirrorConsole } from '../src/exhibition/MirrorConsole';
import type { ExhibitionState, ExhibitionMirrorSummary } from '../shared/exhibition';
import type { ExhibitionController } from '../src/exhibition/useExhibition';
import type { ExhibitionLiveController } from '../src/exhibition/useExhibitionLive';
import type { MirrorRegistry } from '../src/exhibition/useMirrors';
import { createReactHost } from './support/reactHost';

let host: Awaited<ReturnType<typeof createReactHost>> | undefined;
afterEach(async () => { await host?.close(); host = undefined; vi.restoreAllMocks(); vi.unstubAllGlobals(); });

async function fixture(phase: ExhibitionState['phase']) {
  host = await createReactHost();
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
  return { state, send, stopExperience, render, button: (label: string) => host!.find(node => node.nodeName === 'button' && node.textContent === label)!.getReactProps() };
}

describe('console material navigation commands', () => {
  it('opens the selected mirror directly on the camera-capable origin', async () => {
    await fixture('idle');
    const link = host!.find(node => node.nodeName === 'a' && node.textContent === '打开大屏');
    const target = new URL(link!.getReactProps().href);
    expect(target.origin).toBe('https://xuminghong.local:10202'); expect(target.searchParams.get('mirror')).toBe('default');
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
