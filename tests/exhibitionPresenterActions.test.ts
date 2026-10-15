import { act, createElement, type ComponentProps } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { usePresenterKeys, type PresenterAction } from '../src/exhibition/usePresenterKeys';
import { createReactHost, flushReact } from './support/reactHost';

function Presenter(props: Parameters<typeof usePresenterKeys>[0]) { usePresenterKeys(props); return null; }

let host: Awaited<ReturnType<typeof createReactHost>> | undefined;
afterEach(async () => {
  await host?.close(); host = undefined;
  vi.restoreAllMocks(); vi.unstubAllGlobals();
});

async function fixture(overrides: Partial<ComponentProps<typeof Presenter>> = {}) {
  host = await createReactHost();
  // The host uses Node EventTarget; normalize capture removal to browser semantics.
  const add = window.addEventListener.bind(window);
  const remove = window.removeEventListener.bind(window);
  vi.spyOn(window, 'addEventListener').mockImplementation((type, listener, options) => {
    add(type, listener, typeof options === 'boolean' ? { capture: options } : options);
  });
  vi.spyOn(window, 'removeEventListener').mockImplementation((type, listener, options) => {
    remove(type, listener, typeof options === 'boolean' ? { capture: options } : options);
  });
  let now = 0;
  vi.spyOn(performance, 'now').mockImplementation(() => now);
  const experience = vi.fn();
  const menu = vi.fn();
  const onStep = vi.fn();
  const onActionPress = vi.fn((action: PresenterAction) => action === 'experience' ? experience : menu);
  // These are synthetic test bindings, not defaults for any physical presenter.
  const props: ComponentProps<typeof Presenter> = { enabled: true, scope: 'mirror:session:mode', onStep, onActionPress,
    actionKeys: { experience: { code: 'KeyQ', key: 'q', minHoldMs: 800 }, menu: { code: 'KeyW', key: 'w' } }, ...overrides };
  const render = () => host!.render(createElement(Presenter, props));
  await render();
  return { props, render, experience, menu, onStep, onActionPress, advance: (ms: number) => { now += ms; } };
}

async function key(type: 'keydown' | 'keyup', code: string, options: Record<string, unknown> = {}) {
  const event = new Event(type, { cancelable: true });
  const values = { key: code, code, repeat: false, isComposing: false,
    shiftKey: false, altKey: false, ctrlKey: false, metaKey: false, ...options };
  for (const [name, value] of Object.entries(values)) Object.defineProperty(event, name, { value, configurable: true });
  await act(async () => { window.dispatchEvent(event); });
  await flushReact();
  return event;
}

async function tap(code: string, options: Record<string, unknown> = {}) {
  const down = await key('keydown', code, options);
  await key('keyup', code, options);
  return down;
}

function editable(selector: string) {
  return { closest: vi.fn((selectors: string) => selectors.split(', ').includes(selector) ? {} : null) };
}

describe('configured presenter actions', () => {
  it('commits a long press once on release without opening the menu', async () => {
    const f = await fixture();
    await key('keydown', 'KeyQ');
    f.advance(1000);
    await key('keydown', 'KeyQ', { repeat: true });
    await key('keydown', 'KeyQ');
    expect(f.onActionPress).toHaveBeenCalledExactlyOnceWith('experience');
    expect(f.experience).not.toHaveBeenCalled(); expect(f.menu).not.toHaveBeenCalled();
    const release = await key('keyup', 'KeyQ');
    await key('keyup', 'KeyQ');
    expect(release.defaultPrevented).toBe(true);
    expect(f.experience).toHaveBeenCalledTimes(1); expect(f.menu).not.toHaveBeenCalled();
  });

  it('does nothing below the configured hold duration and accepts the boundary', async () => {
    const f = await fixture();
    await key('keydown', 'KeyQ'); f.advance(799); await key('keyup', 'KeyQ');
    expect(f.experience).not.toHaveBeenCalled(); expect(f.menu).not.toHaveBeenCalled();
    await key('keydown', 'KeyQ'); f.advance(800); await key('keyup', 'KeyQ');
    expect(f.experience).toHaveBeenCalledTimes(1);
  });

  it('toggles only the separately configured menu action', async () => {
    const f = await fixture();
    await tap('KeyW'); await tap('KeyW');
    expect(f.menu).toHaveBeenCalledTimes(2); expect(f.experience).not.toHaveBeenCalled();
  });

  it('keeps the intent returned at keydown even if React renders another callback', async () => {
    const f = await fixture();
    await key('keydown', 'KeyQ');
    const changedIntent = vi.fn(); f.props.onActionPress = () => changedIntent;
    // Equivalent freshly created mappings must not reset a physical press.
    f.props.actionKeys = structuredClone(f.props.actionKeys); await f.render();
    f.advance(800); await key('keyup', 'KeyQ');
    expect(f.experience).toHaveBeenCalledTimes(1); expect(changedIntent).not.toHaveBeenCalled();
  });

  it('requires another physical press after an unavailable action', async () => {
    const f = await fixture({ onActionPress: () => null });
    await key('keydown', 'KeyQ'); f.props.onActionPress = f.onActionPress; await f.render();
    f.advance(1000); await key('keydown', 'KeyQ'); await key('keyup', 'KeyQ');
    expect(f.experience).not.toHaveBeenCalled();
    await key('keydown', 'KeyQ'); f.advance(800); await key('keyup', 'KeyQ');
    expect(f.experience).toHaveBeenCalledTimes(1);
  });

  it('never guesses an action binding and preserves direction steps', async () => {
    const f = await fixture({ actionKeys: undefined });
    const unrelated = await tap('KeyQ'); await tap('Enter'); await tap('Space'); await tap('F5');
    await tap('PageDown'); await tap('PageUp');
    expect(unrelated.defaultPrevented).toBe(false); expect(f.onActionPress).not.toHaveBeenCalled();
    expect(f.onStep.mock.calls).toEqual([[1], [-1]]);
  });

  it.each(['PageDown', 'PageUp', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'])('does not reassign %s to an action', async code => {
    const f = await fixture({ actionKeys: { experience: { code } } });
    await tap(code);
    expect(f.onStep).toHaveBeenCalledTimes(1); expect(f.onActionPress).not.toHaveBeenCalled();
  });

  it('matches physical code independently of keyboard layout', async () => {
    const f = await fixture();
    await key('keydown', 'KeyQ', { key: 'a' }); f.advance(800); await key('keyup', 'KeyQ', { key: 'a' });
    expect(f.experience).toHaveBeenCalledTimes(1);
    await tap('KeyA', { key: 'q' }); expect(f.experience).toHaveBeenCalledTimes(1);
  });

  it.each(['', 'Unidentified'])('can match a learned key when the device supplies code %j', async code => {
    const f = await fixture({ actionKeys: { menu: { code: 'Unidentified', key: 'SyntheticPresenterKey' } } });
    await tap(code, { key: 'SyntheticPresenterKey' }); expect(f.menu).toHaveBeenCalledTimes(1);
  });

  it('does not release a held action when a different unidentified key is released', async () => {
    const f = await fixture({ actionKeys: {
      experience: { code: 'Unidentified', key: 'SyntheticExperience', minHoldMs: 800 },
      menu: { code: 'Unidentified', key: 'SyntheticMenu' },
    } });
    await key('keydown', 'Unidentified', { key: 'SyntheticExperience' }); f.advance(800);
    await key('keyup', 'Unidentified', { key: 'SyntheticMenu' });
    expect(f.experience).not.toHaveBeenCalled(); expect(f.menu).not.toHaveBeenCalled();
    await key('keyup', 'Unidentified', { key: 'SyntheticExperience' });
    expect(f.experience).toHaveBeenCalledOnce();
  });

  it('tracks distinct unidentified keys without suppressing or cross-committing their actions', async () => {
    const f = await fixture({ actionKeys: {
      experience: { code: 'Unidentified', key: 'SyntheticExperience', minHoldMs: 800 },
      menu: { code: 'Unidentified', key: 'SyntheticMenu' },
    } });
    await key('keydown', 'Unidentified', { key: 'SyntheticExperience' });
    await key('keydown', 'Unidentified', { key: 'SyntheticMenu' });
    expect(f.onActionPress.mock.calls).toEqual([['experience'], ['menu']]);
    f.advance(800); await key('keyup', 'Unidentified', { key: 'SyntheticMenu' });
    expect(f.menu).toHaveBeenCalledOnce(); expect(f.experience).not.toHaveBeenCalled();
    await key('keyup', 'Unidentified', { key: 'SyntheticExperience' });
    expect(f.experience).toHaveBeenCalledOnce(); expect(f.menu).toHaveBeenCalledOnce();
  });

  it('ignores ambiguous mappings and invalid duration configuration', async () => {
    const f = await fixture({ actionKeys: { experience: { code: 'KeyQ' }, menu: { code: 'KeyQ' } } });
    await tap('KeyQ'); expect(f.onActionPress).not.toHaveBeenCalled();
    f.props.actionKeys = { experience: { code: 'KeyQ', minHoldMs: -1 }, menu: { code: 'KeyW', minHoldMs: NaN } };
    await f.render(); await tap('KeyQ'); await tap('KeyW'); expect(f.onActionPress).not.toHaveBeenCalled();
  });
});

describe('presenter action cancellation', () => {
  it.each(['blur', 'visibilitychange', 'scope', 'mapping', 'disabled', 'unmount'])('discards a held action on %s', async boundary => {
    const f = await fixture(); await key('keydown', 'KeyQ'); f.advance(1000);
    if (boundary === 'blur') await act(async () => { window.dispatchEvent(new Event('blur')); });
    if (boundary === 'visibilitychange') await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
    if (boundary === 'scope') { f.props.scope = 'second-mirror'; await f.render(); }
    if (boundary === 'mapping') { f.props.actionKeys = { experience: { code: 'KeyQ', minHoldMs: 1000 } }; await f.render(); }
    if (boundary === 'disabled') { f.props.enabled = false; await f.render(); }
    if (boundary === 'unmount') { await host!.close(); host = undefined; }
    await key('keyup', 'KeyQ'); expect(f.experience).not.toHaveBeenCalled();
  });

  it.each(['input', 'textarea', 'select', 'dialog', '[role="dialog"]', '[role="alertdialog"]'])('does not start actions inside %s', async selector => {
    const f = await fixture(); const target = editable(selector);
    const down = await key('keydown', 'KeyQ', { target }); f.advance(1000); await key('keyup', 'KeyQ', { target });
    expect(down.defaultPrevented).toBe(false); expect(f.onActionPress).not.toHaveBeenCalled();
  });

  it('rechecks editing focus at release, including a native dialog', async () => {
    const f = await fixture(); await key('keydown', 'KeyQ'); f.advance(1000);
    Object.defineProperty(document, 'activeElement', { value: editable('dialog'), configurable: true });
    const release = await key('keyup', 'KeyQ');
    expect(release.defaultPrevented).toBe(false); expect(f.experience).not.toHaveBeenCalled();
  });

  it('cancels when focus moves into an input even if it moves back before release', async () => {
    const f = await fixture(); await key('keydown', 'KeyQ'); f.advance(1000);
    const focus = new Event('focusin'); Object.defineProperty(focus, 'target', { value: editable('input') });
    await act(async () => { window.dispatchEvent(focus); });
    await key('keyup', 'KeyQ'); expect(f.experience).not.toHaveBeenCalled();
  });

  it('checks editing controls within the composed path', async () => {
    const f = await fixture();
    await key('keydown', 'KeyQ', { composedPath: () => [editable('input'), window] });
    f.advance(1000); await key('keyup', 'KeyQ'); expect(f.onActionPress).not.toHaveBeenCalled();
  });

  it.each(['shiftKey', 'altKey', 'ctrlKey', 'metaKey', 'isComposing'])('rechecks %s at release', async modifier => {
    const f = await fixture(); await key('keydown', 'KeyQ'); f.advance(1000);
    await key('keyup', 'KeyQ', { [modifier]: true }); expect(f.experience).not.toHaveBeenCalled();
  });

  it('does not commit an intercepted release or a release in a hidden document', async () => {
    const f = await fixture(); await key('keydown', 'KeyQ'); f.advance(1000);
    await key('keyup', 'KeyQ', { defaultPrevented: true }); expect(f.experience).not.toHaveBeenCalled();
    await key('keydown', 'KeyQ'); f.advance(1000);
    Object.defineProperty(document, 'hidden', { value: true, configurable: true });
    await key('keyup', 'KeyQ'); expect(f.experience).not.toHaveBeenCalled();
  });

  it('does not turn a stray repeat or keyup into an action', async () => {
    const f = await fixture(); await key('keydown', 'KeyQ', { repeat: true }); f.advance(1000);
    await key('keyup', 'KeyQ'); await key('keyup', 'KeyQ');
    expect(f.onActionPress).not.toHaveBeenCalled(); expect(f.experience).not.toHaveBeenCalled();
  });
});
