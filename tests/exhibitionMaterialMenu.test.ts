import { act, createElement, useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MaterialActionsMenu } from '../src/exhibition/MaterialActionsMenu';
import { WardrobePanel } from '../src/exhibition/WardrobePanel';
import type { ExhibitionController } from '../src/exhibition/useExhibition';
import type { ExhibitionState } from '../shared/exhibition';
import { createReactHost } from './support/reactHost';

let host: Awaited<ReturnType<typeof createReactHost>> | undefined;
const originals: [object, string, PropertyDescriptor | undefined][] = [];
afterEach(async () => {
  await host?.close(); host = undefined;
  for (const [object, name, descriptor] of originals.splice(0)) {
    if (descriptor) Object.defineProperty(object, name, descriptor);
    else Reflect.deleteProperty(object, name);
  }
  vi.unstubAllGlobals();
});

type TestNode = ReturnType<typeof document.createElement> & { childNodes: TestNode[]; getReactProps: () => Record<string, any> };
function findPortal(predicate: (node: TestNode) => boolean, root = document.body as TestNode): TestNode | undefined {
  return predicate(root) ? root : Array.from(root.childNodes).map(child => findPortal(predicate, child)).find(Boolean);
}
async function fixture(initialDisabled = false, itemOptions: { editDisabled?: boolean; copyDisabled?: boolean; deleteDisabled?: boolean } = {}) {
  host = await createReactHost();
  const prototype = Object.getPrototypeOf(document.createElement('div'));
  function install(name: string, descriptor: PropertyDescriptor) {
    originals.push([prototype, name, Object.getOwnPropertyDescriptor(prototype, name)]);
    Object.defineProperty(prototype, name, { configurable: true, ...descriptor });
  }
  install('isConnected', { get(this: TestNode) { return (document.body as TestNode).contains(this); } });
  install('focus', { value(this: TestNode) {
    let ancestor = this as TestNode | null;
    while (ancestor) {
      if (ancestor.nodeName === 'dialog' && !(ancestor as HTMLDialogElement).open) return;
      ancestor = ancestor.parentNode as TestNode | null;
    }
    Object.assign(document, { activeElement: this });
  } });
  install('matches', { value(this: TestNode, selector: string) { return selector === ':disabled' && !!this.getReactProps().disabled; } });
  install('querySelector', { value() { return null; } });
  install('showModal', { value(this: TestNode) { (this as HTMLDialogElement).open = true; } });
  install('close', { value(this: TestNode) { (this as HTMLDialogElement).open = false; } });
  vi.stubGlobal('HTMLElement', window.HTMLElement);
  let anchorBounds = { top: 20, right: 790, bottom: 52, left: 758, width: 32, height: 32 };
  install('getBoundingClientRect', { value(this: TestNode) { return this.getReactProps().role === 'menu' ? { top: 0, right: 176, bottom: 90, left: 0, width: 176, height: 90 } : anchorBounds; } });
  Object.assign(window, { innerWidth: 800, innerHeight: 600 });
  const edit = vi.fn(() => document.activeElement);
  const remove = vi.fn(() => document.activeElement);
  const copy = vi.fn(() => document.activeElement);
  let disabled = initialDisabled;
  function MenuFixture() {
    const [open, setOpen] = useState(false);
    return createElement(MaterialActionsMenu, { name: '鎏金女神装', open, onOpenChange: setOpen, onEdit: edit, onCopy: copy, onDelete: remove, disabled, ...itemOptions });
  }
  const render = () => host!.render(createElement(MenuFixture));
  const trigger = () => host!.find(node => node.getReactProps()['aria-haspopup'] === 'menu')!;
  const menu = () => findPortal(node => node.getReactProps().role === 'menu');
  const items = () => menu()!.childNodes.filter(node => node.getReactProps().role === 'menuitem');
  const click = async (node: TestNode | ReturnType<typeof trigger>) => { await act(async () => node.getReactProps().onClick()); };
  const key = async (node: TestNode | ReturnType<typeof trigger>, key: string) => {
    const event = { key, preventDefault: vi.fn(), stopPropagation: vi.fn() };
    await act(async () => node.getReactProps().onKeyDown(event));
    return event;
  };
  const outside = async (type: 'pointerdown' | 'focusin', target: Node) => {
    const event = new Event(type); Object.defineProperty(event, 'target', { value: target });
    await act(async () => document.dispatchEvent(event));
  };
  await render();
  return { trigger, menu, items, edit, copy, remove, click, key, outside, render,
    async disable() { disabled = true; await render(); },
    bounds(value: typeof anchorBounds) { anchorBounds = value; },
  };
}

describe('material actions menu', () => {
  it('opens a body portal with edit, copy and delete actions, and initially focuses edit', async () => {
    const f = await fixture();
    expect(f.menu()).toBeUndefined(); expect(f.trigger().getReactProps()['aria-expanded']).toBe(false);
    await f.click(f.trigger());
    expect(f.menu()!.parentNode).toBe(document.body);
    expect(f.menu()!.getReactProps()['aria-label']).toBe('鎏金女神装的素材操作');
    expect(f.items().map(item => item.textContent)).toEqual(['编辑素材', '复制到…', '删除素材']);
    expect(document.activeElement).toBe(f.items()[0]);
    expect(f.trigger().getReactProps()['aria-controls']).toBe(f.menu()!.getReactProps().id);
  });

  it('supports arrow, Home and End navigation, then Escape returns focus to the trigger', async () => {
    const f = await fixture();
    await f.key(f.trigger(), 'ArrowUp'); expect(document.activeElement).toBe(f.items()[2]);
    await f.key(f.menu()!, 'ArrowDown'); expect(document.activeElement).toBe(f.items()[0]);
    await f.key(f.menu()!, 'ArrowUp'); expect(document.activeElement).toBe(f.items()[2]);
    await f.key(f.menu()!, 'Home'); expect(document.activeElement).toBe(f.items()[0]);
    await f.key(f.menu()!, 'End'); expect(document.activeElement).toBe(f.items()[2]);
    const event = await f.key(f.menu()!, 'Escape');
    expect(event.preventDefault).toHaveBeenCalled(); expect(event.stopPropagation).toHaveBeenCalled();
    expect(f.menu()).toBeUndefined(); expect(document.activeElement).toBe(f.trigger());
  });

  it.each(['edit', 'copy', 'remove'] as const)('restores the trigger before opening the %s dialog', async action => {
    const f = await fixture(); await f.click(f.trigger());
    await f.click(f.items()[action === 'edit' ? 0 : action === 'copy' ? 1 : 2]);
    expect(f[action]).toHaveBeenCalledOnce(); expect(f[action].mock.results[0].value).toBe(f.trigger());
    expect(f.menu()).toBeUndefined();
    expect(f[action === 'edit' ? 'remove' : 'edit']).not.toHaveBeenCalled();
  });

  it('skips disabled actions while keeping copy available during an experience', async () => {
    const f = await fixture(false, { editDisabled: true, deleteDisabled: true });
    await f.click(f.trigger());
    expect(f.trigger().getReactProps().disabled).toBe(false);
    expect(f.items().map(item => !!item.getReactProps().disabled)).toEqual([true, false, true]);
    expect(document.activeElement).toBe(f.items()[1]);
    for (const direction of ['ArrowDown', 'ArrowUp', 'Home', 'End']) {
      await f.key(f.menu()!, direction); expect(document.activeElement).toBe(f.items()[1]);
    }
    await f.click(f.items()[0]); expect(f.edit).not.toHaveBeenCalled();
    await f.click(f.items()[1]); expect(f.copy).toHaveBeenCalledOnce();
  });

  it('dismisses on outside pointer or focus without taking focus from the other operation', async () => {
    const f = await fixture(); const outside = document.createElement('button'); document.body.appendChild(outside);
    for (const type of ['pointerdown', 'focusin'] as const) {
      await f.click(f.trigger()); outside.focus(); await f.outside(type, outside);
      expect(f.menu()).toBeUndefined(); expect(document.activeElement).toBe(outside);
    }
  });

  it('leaves pointer and focus events inside either menu or trigger alone', async () => {
    const f = await fixture(); await f.click(f.trigger());
    await f.outside('pointerdown', f.items()[0]); await f.outside('focusin', f.trigger() as unknown as Node);
    expect(f.menu()).toBeDefined();
  });

  it('dismisses on Tab without preventing normal browser tab order', async () => {
    const f = await fixture(); await f.click(f.trigger());
    const event = await f.key(f.menu()!, 'Tab');
    expect(event.preventDefault).not.toHaveBeenCalled(); expect(f.menu()).toBeUndefined();
    expect(document.activeElement).toBe(f.trigger());
  });

  it('clamps to the viewport and repositions above the trigger near the bottom', async () => {
    const f = await fixture(); await f.click(f.trigger());
    expect(f.menu()!.style.left).toBe('612px'); expect(f.menu()!.style.top).toBe('58px');
    f.bounds({ top: 555, right: 20, bottom: 587, left: -12, width: 32, height: 32 });
    window.dispatchEvent(new Event('resize'));
    expect(f.menu()!.style.left).toBe('12px'); expect(f.menu()!.style.top).toBe('459px');
  });

  it('disables opening and closes an already open menu when the operation becomes unavailable', async () => {
    const f = await fixture(); await f.click(f.trigger()); await f.disable();
    expect(f.menu()).toBeUndefined(); expect(f.trigger().getReactProps().disabled).toBe(true);
    await f.click(f.trigger()); await f.key(f.trigger(), 'ArrowDown');
    expect(f.menu()).toBeUndefined(); expect(f.edit).not.toHaveBeenCalled(); expect(f.remove).not.toHaveBeenCalled();
  });

  it('unmounts the portal and removes outside listeners cleanly', async () => {
    const f = await fixture(); await f.click(f.trigger());
    await host!.close(); host = undefined;
    expect(findPortal(node => node.getReactProps().role === 'menu')).toBeUndefined();
    document.dispatchEvent(new Event('pointerdown')); window.dispatchEvent(new Event('scroll'));
    expect(f.edit).not.toHaveBeenCalled(); expect(f.remove).not.toHaveBeenCalled();
  });
});

async function libraryFixture() {
  const f = await fixture();
  const state: ExhibitionState = { mirrorId: 'isolated-test-mirror', revision: 4, phase: 'idle', experienceMode: 'clothx', selectedLookId: 'test-material', displayedLookId: null,
    looks: [{ id: 'test-material', mode: 'clothx', name: '隔离测试素材', description: '', image: '/test.webp', source: 'sample', palette: '', category: '', tags: [] }],
    enabledLookIds: ['test-material'], categories: [], tags: [], sessionNumber: 0, generationNumber: 0, updatedAt: 1, generationReadyAt: null, providerMode: 'demo', live: null, logs: [],
    settings: { autoReturnSeconds: 60, uploadLimits: { maxFileSizeMB: 10, minWidth: 64, minHeight: 64, maxWidth: 4096, maxHeight: 4096 } } };
  const controller: ExhibitionController = { state, mirrorId: state.mirrorId!, send: vi.fn(async () => true), pending: false, connected: true, error: '', clearError: vi.fn(),
    upload: vi.fn(async () => null), updateLook: vi.fn(async () => true), deleteLook: vi.fn(async () => true), saveTaxonomy: vi.fn(async () => true), copyData: vi.fn(async () => true), refresh: vi.fn(async () => {}) };
  await host!.render(createElement(WardrobePanel, { controller }));
  const dialog = () => host!.find(node => node.nodeName === 'dialog');
  const button = (name: string) => host!.find(node => node.nodeName === 'button' && node.textContent === name)!;
  return { ...f, controller, dialog, button };
}

describe('material menu and existing confirmation integration', () => {
  it('keeps deletion in the confirmation dialog and returns focus to more actions when cancelled', async () => {
    const f = await libraryFixture(); const trigger = f.trigger();
    await f.click(trigger); await f.click(f.items()[2]);
    expect(f.menu()).toBeUndefined(); expect(f.dialog()!.getReactProps()['aria-label']).toBe('删除素材');
    expect(f.dialog()!.textContent).toContain('确认删除「隔离测试素材」？');
    expect(f.controller.deleteLook).not.toHaveBeenCalled();
    await f.click(f.button('保留素材'));
    expect(f.dialog()).toBeUndefined(); expect(document.activeElement).toBe(trigger);
    expect(f.controller.deleteLook).not.toHaveBeenCalled();
  });

  it('edits through the existing dialog and restores focus on cancel', async () => {
    const f = await libraryFixture(); const trigger = f.trigger();
    await f.click(trigger); await f.click(f.items()[0]);
    expect(f.dialog()!.getReactProps()['aria-label']).toBe('编辑素材');
    await f.click(f.button('取消'));
    expect(f.dialog()).toBeUndefined(); expect(document.activeElement).toBe(trigger);
  });

  it('only deletes the isolated fixture after explicit confirmation', async () => {
    const f = await libraryFixture();
    await f.click(f.trigger()); await f.click(f.items()[2]);
    expect(f.controller.deleteLook).not.toHaveBeenCalled();
    await f.click(f.button('确认删除'));
    expect(f.controller.deleteLook).toHaveBeenCalledExactlyOnceWith('test-material', { expectedRevision: 4 });
    expect(f.dialog()).toBeUndefined();
  });
});
