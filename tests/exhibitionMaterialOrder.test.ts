import { act, createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ExhibitionLook, ExhibitionState } from '../shared/exhibition';
import { WardrobePanel } from '../src/exhibition/WardrobePanel';
import { enableLookInOrder } from '../src/exhibition/useMaterialOrder';
import { insertMaterialAtSlot, materialDropTarget, type MaterialRect } from '../src/exhibition/materialOrderGeometry';
import type { ExhibitionController } from '../src/exhibition/useExhibition';
import { createReactHost } from './support/reactHost';

let host: Awaited<ReturnType<typeof createReactHost>> | undefined;
afterEach(async () => { await host?.close(); host = undefined; vi.unstubAllGlobals(); });

function material(id: string, mode: ExhibitionLook['mode'] = 'clothx'): ExhibitionLook {
  return { id, mode, name: `素材-${id}`, description: '', image: '/test.png', source: 'sample', palette: '', category: '', tags: [] };
}
async function fixture(overrides: Partial<ExhibitionState> = {}, options: Partial<ExhibitionController> = {}) {
  host = await createReactHost();
  const state: ExhibitionState = { mirrorId: 'default', revision: 4, phase: 'idle', experienceMode: 'clothx', selectedLookId: 'first', displayedLookId: null,
    looks: [material('first'), material('disabled'), material('third'), material('other-mode', 'free')], enabledLookIds: ['first', 'third', 'other-mode'], categories: [], tags: [],
    sessionNumber: 0, generationNumber: 0, updatedAt: 1, generationReadyAt: null, providerMode: 'xmax', live: null, logs: [],
    settings: { autoReturnSeconds: 60, uploadLimits: { maxFileSizeMB: 10, minWidth: 64, minHeight: 64, maxWidth: 4096, maxHeight: 4096 } }, ...overrides };
  const send = vi.fn(async () => true);
  const controller: ExhibitionController = { state, mirrorId: state.mirrorId!, send, pending: false, connected: true, error: '', clearError: vi.fn(),
    upload: vi.fn(async () => null), updateLook: vi.fn(async () => true), deleteLook: vi.fn(async () => true), saveTaxonomy: vi.fn(async () => true),
    copyData: vi.fn(async () => true), refresh: vi.fn(async () => {}), ...options };
  const render = () => host!.render(createElement(WardrobePanel, { controller }));
  const handle = (id: string) => host!.find(node => node.getReactProps()['aria-label'] === `调整素材-${id}顺序`)!;
  const region = () => host!.find(node => node.getReactProps().className === 'ex-library-results')!;
  const gridOrder = () => host!.find(node => node.getReactProps().className === 'ex-library-grid')!.childNodes.map(node => node.getReactProps()['data-material-id']);
  const key = async (id: string, value: string) => { await act(async () => { handle(id).getReactProps().onKeyDown({ key: value, currentTarget: handle(id), preventDefault: vi.fn() }); }); };
  await render();
  return { state, controller, send, render, handle, region, gridOrder, key };
}

function layout(f: Awaited<ReturnType<typeof fixture>>, columns = 3, height = 380) {
  const ids = f.gridOrder() as string[];
  const region = f.region();
  const box = (left: number, top: number, width: number, cardHeight: number) => ({ left, top, right: left + width, bottom: top + cardHeight, width, height: cardHeight });
  Object.assign(region, { focus: vi.fn(), setPointerCapture: vi.fn(), hasPointerCapture: () => true, releasePointerCapture: vi.fn(), scrollTop: 0,
    getBoundingClientRect: () => box(0, 0, columns * 120 + 20, height),
    querySelectorAll: (selector: string) => selector === '[data-material-id]' ? ids.map(id => host!.find(node => node.getReactProps()['data-material-id'] === id)!) : ids.map(id => f.handle(id)),
  });
  for (const [index, id] of ids.entries()) {
    const card = host!.find(node => node.getReactProps()['data-material-id'] === id)!;
    const image = card.childNodes[0];
    const rect = () => box(20 + index % columns * 120, 20 + Math.floor(index / columns) * 160 - region.scrollTop, 100, 140);
    Object.assign(card, { dataset: { materialId: id }, getBoundingClientRect: rect });
    Object.assign(image, { getBoundingClientRect: rect });
    Object.assign(f.handle(id), { focus: vi.fn(), dataset: { materialOrderId: id }, closest: () => image, getBoundingClientRect: rect });
  }
  const event = (id: string, x = 30, y = 30, extra = {}) => ({ pointerId: 1, pointerType: 'mouse', button: 0, isPrimary: true, currentTarget: f.handle(id), clientX: x, clientY: y, preventDefault: vi.fn(), ...extra });
  const down = async (id: string, x = 30, y = 30) => act(async () => f.handle(id).getReactProps().onPointerDown(event(id, x, y)));
  const move = async (x: number, y: number) => act(async () => region.getReactProps().onPointerMove(event(ids[0], x, y)));
  const up = async (x: number, y: number) => act(async () => region.getReactProps().onPointerUp(event(ids[0], x, y)));
  return { region, event, down, move, up };
}

describe('material ordering controls', () => {
  it('persists a complete mode order including disabled items without switching the selected material', async () => {
    const f = await fixture();
    await f.key('first', 'ArrowRight');
    expect(f.send).toHaveBeenCalledExactlyOnceWith({ action: 'reorder', experienceMode: 'clothx', lookIds: ['disabled', 'first', 'third'], expectedRevision: 4 });
    expect(f.state.selectedLookId).toBe('first'); expect(f.state.enabledLookIds).toEqual(['first', 'third', 'other-mode']);
    expect(f.handle('other-mode')).toBeUndefined();
  });

  it('shows the pending order and rolls it back when saving fails', async () => {
    let resolve!: (value: boolean) => void;
    const send = vi.fn(() => new Promise<boolean>(done => { resolve = done; }));
    const f = await fixture({}, { send });
    await f.key('third', 'Home');
    expect(f.gridOrder()).toEqual(['third', 'first', 'disabled']);
    expect(f.handle('first').getReactProps().disabled).toBe(true);
    await act(async () => { resolve(false); });
    expect(f.gridOrder()).toEqual(['first', 'disabled', 'third']);
    expect(host!.find(node => node.getReactProps().role === 'status')!.textContent).toContain('顺序未保存');
  });

  it('keeps the grid stable while dragging and inserts at a gap on release, ignoring tiny movement', async () => {
    const f = await fixture();
    const { region, down, move, up } = layout(f);
    const handle = f.handle('first');
    await down('first');
    expect(region.setPointerCapture).toHaveBeenCalledWith(1);
    expect(handle.getReactProps().onLostPointerCapture).toBeUndefined();
    await move(32, 30);
    expect(f.gridOrder()).toEqual(['first', 'disabled', 'third']); expect(f.send).not.toHaveBeenCalled();
    await move(250, 90);
    expect(f.gridOrder()).toEqual(['first', 'disabled', 'third']); expect(f.send).not.toHaveBeenCalled();
    await act(async () => {
      region.getReactProps().onLostPointerCapture({ pointerId: 1, target: handle, currentTarget: region });
      region.getReactProps().onLostPointerCapture({ pointerId: 2, target: region, currentTarget: region });
    });
    expect(f.gridOrder()).toEqual(['first', 'disabled', 'third']);
    await up(250, 90);
    expect(f.send).toHaveBeenCalledExactlyOnceWith({ action: 'reorder', experienceMode: 'clothx', lookIds: ['disabled', 'first', 'third'], expectedRevision: 4 });
    expect(region.releasePointerCapture).toHaveBeenCalledWith(1);
  });

  it.each([false, true])('restores keyboard focus after saving unless another operation gained focus: %s', async focusMoved => {
    let resolve!: (value: boolean) => void;
    const send = vi.fn(() => new Promise<boolean>(done => { resolve = done; }));
    const f = await fixture({}, { send }); const handle = f.handle('first'); const focus = vi.fn();
    Object.assign(handle, { focus, dataset: { materialOrderId: 'first' } });
    Object.assign(f.region(), { querySelectorAll: () => [handle] });
    await f.key('first', 'ArrowRight');
    // Native browsers may send focus to body when the active button is disabled.
    Object.assign(document, { activeElement: focusMoved ? host!.find(node => node.getReactProps()['aria-label'] === '搜索素材') : document.body });
    expect(focus).not.toHaveBeenCalled();
    await act(async () => { resolve(true); });
    if (focusMoved) expect(focus).not.toHaveBeenCalled();
    else expect(focus).toHaveBeenCalledExactlyOnceWith({ preventScroll: true });
  });

  it('cancels a drag when the server revision changes before release', async () => {
    const f = await fixture();
    const { down, move, up } = layout(f);
    await down('first'); await move(250, 90);
    f.state.revision = 5; await f.render();
    await up(250, 90);
    expect(f.send).not.toHaveBeenCalled(); expect(f.gridOrder()).toEqual(['first', 'disabled', 'third']);
  });

  it('inserts across rows at the requested boundary rather than requiring adjacent steps', async () => {
    const f = await fixture({ looks: [...'ABCDEFGH'].map(id => material(id)), enabledLookIds: [...'ABCDEFGH'], selectedLookId: 'A' });
    const { down, move, up } = layout(f, 4);
    await down('A'); await move(250, 250);
    expect(f.gridOrder()).toEqual([...'ABCDEFGH']);
    await move(250, 250); // Holding the pointer over a gap cannot shift the grid or target.
    expect(f.gridOrder()).toEqual([...'ABCDEFGH']);
    await up(250, 250);
    expect(f.send).toHaveBeenCalledExactlyOnceWith({ action: 'reorder', experienceMode: 'clothx', lookIds: [...'BCDEFAGH'], expectedRevision: 4 });
  });

  it('starts mouse dragging from the image while touch input on the image keeps normal scrolling', async () => {
    const f = await fixture(); const { region, event, move, up } = layout(f);
    const image = host!.find(node => node.getReactProps()['data-material-id'] === 'first')!.childNodes[0];
    const touch = event('first', 30, 30, { currentTarget: image, target: image, pointerType: 'touch' });
    await act(async () => image.getReactProps().onPointerDown(touch));
    expect(region.setPointerCapture).not.toHaveBeenCalled(); expect(touch.preventDefault).not.toHaveBeenCalled();
    await move(250, 90); await up(250, 90); expect(f.send).not.toHaveBeenCalled();
    const mouse = event('first', 30, 30, { currentTarget: image, target: image });
    await act(async () => image.getReactProps().onPointerDown(mouse));
    expect(region.setPointerCapture).toHaveBeenCalledWith(1);
    await move(250, 90); expect(f.gridOrder()).toEqual(['first', 'disabled', 'third']);
    await up(250, 90);
    expect(f.send).toHaveBeenCalledExactlyOnceWith({ action: 'reorder', experienceMode: 'clothx', lookIds: ['disabled', 'first', 'third'], expectedRevision: 4 });
  });

  it('allows touch dragging only through the handle and ignores a different pointer', async () => {
    const f = await fixture(); const { region, event, move, up } = layout(f);
    await act(async () => f.handle('first').getReactProps().onPointerDown(event('first', 30, 30, { pointerType: 'touch' })));
    expect(region.setPointerCapture).toHaveBeenCalledWith(1);
    await act(async () => region.getReactProps().onPointerMove(event('first', 250, 90, { pointerId: 2 })));
    await up(30, 30); expect(f.send).not.toHaveBeenCalled();
    await act(async () => f.handle('first').getReactProps().onPointerDown(event('first', 30, 30, { pointerType: 'touch' })));
    await move(250, 90); await up(250, 90);
    expect(f.send).toHaveBeenCalledOnce();
  });

  it('rolls back a failed pointer save after showing only the final pending order', async () => {
    let resolve!: (value: boolean) => void;
    const send = vi.fn(() => new Promise<boolean>(done => { resolve = done; }));
    const f = await fixture({}, { send }); const { down, move, up } = layout(f);
    await down('first'); await move(350, 90);
    expect(f.gridOrder()).toEqual(['first', 'disabled', 'third']);
    await up(350, 90); expect(f.gridOrder()).toEqual(['disabled', 'third', 'first']);
    await act(async () => resolve(false));
    expect(f.gridOrder()).toEqual(['first', 'disabled', 'third']);
    expect(host!.find(node => node.getReactProps().role === 'status')!.textContent).toContain('顺序未保存');
  });

  it.each(['outside', 'escape', 'pointercancel', 'capturelost'])('cancels without saving after %s', async reason => {
    const f = await fixture(); const { region, down, move, up } = layout(f);
    await down('first'); await move(250, 90);
    if (reason === 'outside') await up(-10, 90);
    else {
      await act(async () => {
        if (reason === 'escape') region.getReactProps().onKeyDown({ key: 'Escape', preventDefault: vi.fn() });
        if (reason === 'pointercancel') region.getReactProps().onPointerCancel({ pointerId: 1 });
        if (reason === 'capturelost') region.getReactProps().onLostPointerCapture({ pointerId: 1, target: region, currentTarget: region });
      });
      await up(250, 90);
    }
    expect(f.send).not.toHaveBeenCalled(); expect(f.gridOrder()).toEqual(['first', 'disabled', 'third']);
  });

  it.each(['catalog', 'phase', 'connection'])('cancels a drag after its %s changes', async reason => {
    const f = await fixture(); const { down, move, up } = layout(f);
    await down('first'); await move(250, 90);
    if (reason === 'catalog') f.state.looks.push(material('new'));
    if (reason === 'phase') f.state.phase = 'generating';
    if (reason === 'connection') f.controller.connected = false;
    await f.render(); await up(250, 90);
    expect(f.send).not.toHaveBeenCalled();
  });

  it('recomputes the insertion position while edge scrolling without moving the pointer', async () => {
    const f = await fixture({ looks: [...'ABCDEFGH'].map(id => material(id)), enabledLookIds: [...'ABCDEFGH'], selectedLookId: 'A' });
    const { region, down, move, up } = layout(f, 2, 200);
    let frame: (() => void) | undefined;
    Object.assign(window, { requestAnimationFrame: vi.fn(callback => { frame = callback; return 1; }), cancelAnimationFrame: vi.fn() });
    await down('A'); await move(250, 190);
    for (let index = 0; index < 25; index++) await act(async () => frame?.());
    expect(region.scrollTop).toBeGreaterThan(200); expect(f.gridOrder()).toEqual([...'ABCDEFGH']);
    await up(250, 190);
    expect(f.send).toHaveBeenCalledExactlyOnceWith({ action: 'reorder', experienceMode: 'clothx', lookIds: [...'BCDEFGHA'], expectedRevision: 4 });
    expect(window.cancelAnimationFrame).toHaveBeenCalledWith(1);
  });

  it('disables ordering while searching and preserves the complete catalog', async () => {
    const f = await fixture();
    await act(async () => host!.find(node => node.getReactProps()['aria-label'] === '搜索素材')!.getReactProps().onChange({ target: { value: 'first' } }));
    expect(f.gridOrder()).toEqual(['first']); expect(f.handle('first').getReactProps().disabled).toBe(true);
    await f.key('first', 'End'); expect(f.send).not.toHaveBeenCalled();
  });

  it.each([
    { state: { phase: 'showcase' }, options: {} }, { state: { live: { status: 'stopping' } }, options: {} },
    { state: {}, options: { pending: true } }, { state: {}, options: { connected: false } },
  ])('guards ordering during an active experience or unavailable connection: %j', async ({ state, options }) => {
    const f = await fixture(state as Partial<ExhibitionState>, options);
    expect(f.handle('first').getReactProps().disabled).toBe(true);
    await f.key('first', 'ArrowRight'); expect(f.send).not.toHaveBeenCalled();
  });

  it('keeps mode order when an item is re-enabled and leaves other mode order intact', () => {
    const looks = [material('first'), material('middle'), material('last'), material('free-a', 'free'), material('free-b', 'free')];
    expect(enableLookInOrder(looks, ['free-b', 'first', 'free-a', 'last'], looks[1])).toEqual(['free-b', 'first', 'free-a', 'middle', 'last']);
    expect(enableLookInOrder(looks, ['free-b', 'free-a'], looks[1])).toEqual(['middle', 'free-b', 'free-a']);
  });
});

describe('material insertion geometry', () => {
  const rects = (count = 8, columns = 4): MaterialRect[] => Array.from({ length: count }, (_, index) => ({ id: String.fromCharCode(65 + index),
    left: 20 + index % columns * 120, right: 120 + index % columns * 120, top: 20 + Math.floor(index / columns) * 160, bottom: 160 + Math.floor(index / columns) * 160 }));

  it('recognizes the exact inter-card gap across rows and uses source-removal adjusted insertion', () => {
    const target = materialDropTarget(rects(), 250, 250)!;
    expect(target).toEqual({ slot: 6, left: 250, top: 180, height: 140 });
    expect(insertMaterialAtSlot([...'ABCDEFGH'], 'A', target.slot)).toEqual([...'BCDEFAGH']);
  });

  it('moves in reverse and finds first, last and incomplete-row boundaries', () => {
    expect(insertMaterialAtSlot([...'ABCDEFGH'], 'H', materialDropTarget(rects(), 130, 90)!.slot)).toEqual([...'AHBCDEFG']);
    expect(materialDropTarget(rects(), 470, 10)?.slot).toBe(0);
    expect(materialDropTarget(rects(), 20, 330)?.slot).toBe(8);
    expect(materialDropTarget(rects(6), 470, 250)?.slot).toBe(6);
    expect(materialDropTarget(rects(6), 20, 250)?.slot).toBe(4);
  });

  it('maps both visual sides of a row wrap to the same logical insertion boundary', () => {
    expect(materialDropTarget(rects(), 480, 90)?.slot).toBe(4);
    expect(materialDropTarget(rects(), 20, 250)?.slot).toBe(4);
    expect(materialDropTarget(rects(), 250, 170)?.slot).toBe(2);
  });

  it('handles empty geometry and no-op slots without creating an invalid order', () => {
    expect(materialDropTarget([], 0, 0)).toBeNull();
    const ids = [...'ABCD'];
    expect(insertMaterialAtSlot(ids, 'A', 0)).toBe(ids);
    expect(insertMaterialAtSlot(ids, 'A', 1)).toBe(ids);
    expect(insertMaterialAtSlot(ids, 'A', 9)).toBe(ids);
    expect(insertMaterialAtSlot(ids, 'missing', 2)).toBe(ids);
  });
});
