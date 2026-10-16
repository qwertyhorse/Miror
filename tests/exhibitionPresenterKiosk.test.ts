import { materialCatalogFixture } from './support/materialCatalogFixture';
import { act, createElement, type ComponentProps } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ExhibitionCommand, ExhibitionState } from '../shared/exhibition';
import type { ExhibitionLiveController } from '../src/exhibition/useExhibitionLive';
import { Kiosk } from '../src/exhibition/ExhibitionApp';
import { exhibitionLooks } from '../src/exhibition/catalog';
import { createReactHost, flushReact } from './support/reactHost';

vi.mock('../src/exhibition/useExhibitionGestures', () => ({ useExhibitionGestures: () => ({
  status: 'disabled', error: '', handDetected: false, handRaised: false, captureStatus: 'disabled',
  operatorStatus: 'searching', armed: false, needsRelease: false, retry: vi.fn(),
}) }));
vi.mock('../src/exhibition/LiveCameraPanel', () => ({ StreamVideo: () => null }));
vi.mock('../src/exhibition/MoXDragSurface', () => ({ MoXDragSurface: () => null }));
vi.mock('../src/exhibition/MirrorMaterialDrawer', () => ({ MirrorMaterialDrawer: ({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) =>
  createElement('button', { 'data-presenter-drawer': true, 'aria-expanded': open, onClick: () => onOpenChange(!open) }) }));

let host: Awaited<ReturnType<typeof createReactHost>> | undefined;
afterEach(async () => {
  await host?.close(); host = undefined;
  vi.restoreAllMocks(); vi.unstubAllGlobals();
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

function snapshot(overrides: Partial<ExhibitionState> = {}): ExhibitionState {
  return materialCatalogFixture({
    mirrorId: 'default', revision: 1, phase: 'idle', experienceMode: 'clothx', providerMode: 'xmax',
    selectedLookId: 'commute', displayedLookId: null, looks: structuredClone(exhibitionLooks),
    enabledLookIds: ['commute', 'city', 'evening'], categories: [], tags: [],
    sessionNumber: 1, generationNumber: 1, updatedAt: 0, generationReadyAt: null, live: null, logs: [],
    settings: { autoReturnSeconds: 90, uploadLimits: { maxFileSizeMB: 10, minWidth: 64, minHeight: 64, maxWidth: 4096, maxHeight: 4096 } },
    ...overrides,
  });
}

async function fixture(stateOverrides: Partial<ExhibitionState> = {}, overrides: Partial<ComponentProps<typeof Kiosk>> = {}) {
  host = await createReactHost();
  // Node's EventTarget does not match removal with a boolean capture argument.
  // Preserve browser capture semantics for lifecycle tests in this fake DOM.
  const add = window.addEventListener.bind(window);
  const remove = window.removeEventListener.bind(window);
  vi.spyOn(window, 'addEventListener').mockImplementation((type, listener, options) => {
    add(type, listener, typeof options === 'boolean' ? { capture: options } : options);
  });
  vi.spyOn(window, 'removeEventListener').mockImplementation((type, listener, options) => {
    remove(type, listener, typeof options === 'boolean' ? { capture: options } : options);
  });
  const send = vi.fn(async (_command: ExhibitionCommand) => true);
  const live = { cameraStream: null, outputStream: null, status: 'preview', opening: false, error: '',
    deviceId: 'presenter-screen', secure: true, mirrored: true, startCamera: vi.fn(async () => true), stopGeneration: vi.fn(async () => true) } as unknown as ExhibitionLiveController;
  const props: ComponentProps<typeof Kiosk> = { state: snapshot(stateOverrides), send, live, ...overrides };
  const render = () => host!.render(createElement(Kiosk, props));
  const update = async (changes: Partial<ExhibitionState>) => { props.state = materialCatalogFixture({ ...props.state, catalog: undefined, ...changes }); await render(); };
  await render();
  return { send, live, props, render, update };
}

async function key(type: 'keydown' | 'keyup', value: string, options: Record<string, unknown> = {}) {
  const event = new Event(type, { cancelable: true });
  const values = { key: value, code: value, repeat: false, isComposing: false,
    shiftKey: false, altKey: false, ctrlKey: false, metaKey: false, ...options };
  for (const [name, property] of Object.entries(values)) Object.defineProperty(event, name, { value: property, configurable: true });
  await act(async () => { window.dispatchEvent(event); });
  await flushReact();
  return event;
}

async function tap(value: string, options: Record<string, unknown> = {}) {
  const down = await key('keydown', value, options);
  await key('keyup', value, options);
  return down;
}

describe('presenter keys select and switch materials on the mirror screen', () => {
  it.each([
    ['PageDown', 'city'], ['ArrowRight', 'city'], ['ArrowDown', 'city'],
    ['PageUp', 'evening'], ['ArrowLeft', 'evening'], ['ArrowUp', 'evening'],
  ])('maps %s to the adjacent enabled material', async (value, lookId) => {
    const f = await fixture();
    const event = await tap(value);
    expect(f.send).toHaveBeenCalledExactlyOnceWith({ action: 'select', lookId });
    expect(event.defaultPrevented).toBe(true);
  });

  it.each(['idle', 'select', 'generating', 'showcase'] as const)('uses the existing selection command in %s without starting or stopping generation', async phase => {
    const f = await fixture({ phase });
    await tap('PageDown');
    expect(f.send).toHaveBeenCalledExactlyOnceWith({ action: ['idle', 'select'].includes(phase) ? 'select' : 'switch', lookId: 'city' });
  });

  it('wraps through the configured order and omits disabled materials and other modes', async () => {
    const other = { ...exhibitionLooks[0], id: 'other-mode', mode: 'charx' as const };
    const f = await fixture({ looks: [...exhibitionLooks, other], enabledLookIds: ['evening', 'other-mode', 'commute'], selectedLookId: 'commute' });
    await tap('PageDown');
    expect(f.send).toHaveBeenLastCalledWith({ action: 'select', lookId: 'evening' });
    await f.update({ selectedLookId: 'evening', revision: 2 });
    await tap('PageUp');
    expect(f.send).toHaveBeenLastCalledWith({ action: 'select', lookId: 'commute' });
    expect(f.send).toHaveBeenCalledTimes(2);
  });

  it.each([{ enabledLookIds: [] }, { enabledLookIds: ['commute'] }])('does nothing with fewer than two enabled materials: %j', async ({ enabledLookIds }) => {
    const f = await fixture({ enabledLookIds, selectedLookId: enabledLookIds[0] ?? null });
    await tap('PageDown'); await tap('PageUp');
    expect(f.send).not.toHaveBeenCalled();
  });

  it.each(['paused', 'positioning'] as const)('does not select while %s', async phase => {
    const f = await fixture({ phase });
    const event = await tap('PageDown');
    expect(f.send).not.toHaveBeenCalled(); expect(event.defaultPrevented).toBe(true);
  });

  it.each([
    { disabled: true }, { stopPending: true }, { commandPending: true },
    { canControl: false }, { send: undefined },
  ])('blocks commands when control is unavailable: %j', async props => {
    const f = await fixture({}, props);
    await tap('PageDown');
    expect(f.send).not.toHaveBeenCalled();
  });

  it.each([{ passive: true }, { presentation: 'remote' as const }])('keeps presenter control on the active terminal only: %j', async props => {
    const f = await fixture({}, props);
    const event = await tap('PageDown');
    expect(f.send).not.toHaveBeenCalled(); expect(event.defaultPrevented).toBe(false);
  });

  it.each(['opening', 'error'] as const)('blocks while the local connection has %s', async condition => {
    const f = await fixture({ phase: 'showcase' });
    if (condition === 'opening') f.live.opening = true;
    else f.live.error = '连接中断';
    await f.render(); await tap('PageDown');
    expect(f.send).not.toHaveBeenCalled();
  });

  it.each(['foreign', 'error', 'renewal'] as const)('blocks a %s live session', async condition => {
    const f = await fixture({ phase: 'showcase' });
    const live = { deviceId: condition === 'foreign' ? 'another-screen' : f.live.deviceId,
      status: condition === 'error' ? 'error' : 'running', sessionId: 'presenter-session',
      generationNumber: 1, lookId: 'commute', heartbeatAt: 0, updatedAt: 0,
      ...(condition === 'renewal' ? { renewal: { status: 'stopping' } } : {}) } as ExhibitionState['live'];
    await f.update({ live }); await tap('PageDown');
    expect(f.send).not.toHaveBeenCalled();
  });
});

describe('presenter key event handling', () => {
  it.each(['shiftKey', 'altKey', 'ctrlKey', 'metaKey', 'isComposing'])('leaves %s shortcuts untouched', async modifier => {
    const f = await fixture();
    const event = await tap('PageDown', { [modifier]: true });
    expect(f.send).not.toHaveBeenCalled(); expect(event.defaultPrevented).toBe(false);
  });

  it.each([
    ['input', 'input'], ['textarea', 'textarea'], ['select', 'select'],
    ['contenteditable', '[contenteditable]:not([contenteditable="false"])'],
    ['textbox', '[role="textbox"]'], ['combobox', '[role="combobox"]'],
    ['slider', '[role="slider"]'], ['dialog', '[role="dialog"]'], ['alertdialog', '[role="alertdialog"]'],
  ])('leaves events within %s untouched', async (element, selector) => {
    const f = await fixture();
    const target = { closest: vi.fn((selectors: string) => selectors.includes(selector) ? { element } : null) };
    const event = await tap('PageDown', { target });
    expect(f.send).not.toHaveBeenCalled(); expect(event.defaultPrevented).toBe(false);
    expect(target.closest).toHaveBeenCalled();
  });

  it('checks the composed path for editable controls in a shadow root', async () => {
    const f = await fixture();
    const editable = { closest: vi.fn(() => ({ role: 'textbox' })) };
    const event = await tap('PageDown', { target: { closest: () => null }, composedPath: () => [editable, window] });
    expect(f.send).not.toHaveBeenCalled(); expect(event.defaultPrevented).toBe(false);
  });

  it('ignores hidden documents and unrelated keys', async () => {
    const f = await fixture();
    Object.defineProperty(document, 'hidden', { value: true, configurable: true });
    const hidden = await tap('PageDown');
    Object.defineProperty(document, 'hidden', { value: false, configurable: true });
    const unrelated = await tap('Enter');
    expect(f.send).not.toHaveBeenCalled();
    expect(hidden.defaultPrevented).toBe(false); expect(unrelated.defaultPrevented).toBe(false);
  });

  it('executes once per physical press despite repeated keydown events', async () => {
    const f = await fixture();
    await key('keydown', 'PageDown');
    await f.update({ selectedLookId: 'city', revision: 2 });
    await key('keydown', 'PageDown', { repeat: true });
    await key('keydown', 'PageDown');
    expect(f.send).toHaveBeenCalledTimes(1);
    await key('keyup', 'PageDown');
    expect(f.send).toHaveBeenCalledTimes(1);
    await tap('PageDown');
    expect(f.send).toHaveBeenCalledTimes(2);
    expect(f.send).toHaveBeenLastCalledWith({ action: 'select', lookId: 'evening' });
  });

  it('clears held keys when the window loses focus', async () => {
    const f = await fixture();
    await key('keydown', 'PageDown');
    await f.update({ selectedLookId: 'city', revision: 2 });
    await act(async () => { window.dispatchEvent(new Event('blur')); });
    await tap('PageDown');
    expect(f.send).toHaveBeenCalledTimes(2);
    expect(f.send).toHaveBeenLastCalledWith({ action: 'select', lookId: 'evening' });
  });

  it('requires a fresh press after a blocked key is held through recovery', async () => {
    const f = await fixture({}, { disabled: true });
    await key('keydown', 'PageDown');
    f.props.disabled = false; await f.render();
    await key('keydown', 'PageDown');
    expect(f.send).not.toHaveBeenCalled();
    await key('keyup', 'PageDown'); await tap('PageDown');
    expect(f.send).toHaveBeenCalledExactlyOnceWith({ action: 'select', lookId: 'city' });
  });

  it('removes the window listener on unmount', async () => {
    const f = await fixture();
    await host!.close(); host = undefined;
    const event = await tap('PageDown');
    expect(f.send).not.toHaveBeenCalled(); expect(event.defaultPrevented).toBe(false);
  });
});

describe('presenter request and acknowledgement boundaries', () => {
  it('serializes requests and waits for state acknowledgement before another step', async () => {
    const f = await fixture();
    const request = deferred<boolean>(); f.send.mockReturnValueOnce(request.promise);
    await tap('PageDown'); await tap('PageDown');
    expect(f.send).toHaveBeenCalledTimes(1);
    await act(async () => { request.resolve(true); }); await flushReact();
    await tap('PageDown'); expect(f.send).toHaveBeenCalledTimes(1);
    await f.update({ selectedLookId: 'city', revision: 2, phase: 'select' });
    await tap('PageDown');
    expect(f.send).toHaveBeenCalledTimes(2);
    expect(f.send).toHaveBeenLastCalledWith({ action: 'select', lookId: 'evening' });
  });

  it.each(['false', 'throw'] as const)('allows a fresh press after a %s response', async result => {
    const f = await fixture();
    if (result === 'false') f.send.mockResolvedValueOnce(false);
    else f.send.mockRejectedValueOnce(new Error('fixture failure'));
    await tap('PageDown'); await tap('PageDown');
    expect(f.send).toHaveBeenCalledTimes(2);
    expect(f.send).toHaveBeenLastCalledWith({ action: 'select', lookId: 'city' });
  });

  it('does not let a stale request completion unlock a newer mirror request', async () => {
    const f = await fixture();
    const old = deferred<boolean>(); const current = deferred<boolean>();
    f.send.mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise);
    await tap('PageDown');
    await f.update({ mirrorId: 'second-mirror', sessionNumber: 2, selectedLookId: 'evening', revision: 1 });
    await tap('PageDown'); expect(f.send).toHaveBeenCalledTimes(2);
    await act(async () => { old.resolve(false); }); await flushReact();
    await tap('PageUp'); expect(f.send).toHaveBeenCalledTimes(2);
    await act(async () => { current.resolve(false); }); await flushReact();
    await tap('PageUp');
    expect(f.send).toHaveBeenCalledTimes(3);
    expect(f.send).toHaveBeenLastCalledWith({ action: 'select', lookId: 'city' });
  });
});

// Synthetic learned bindings: no physical device mapping is assumed by Kiosk.
const actionKeys = { experience: { code: 'KeyQ' }, menu: { code: 'KeyW' } };
const drawer = () => host!.find(node => node.getReactProps()['data-presenter-drawer'])?.getReactProps();

describe('configured presenter experience and menu controls', () => {
  it('starts on release through the existing camera and begin path', async () => {
    const f = await fixture({}, { presenterActionKeys: actionKeys });
    await key('keydown', 'KeyQ');
    expect(f.send).not.toHaveBeenCalled(); expect(f.live.startCamera).not.toHaveBeenCalled();
    await key('keyup', 'KeyQ');
    expect(f.live.startCamera).toHaveBeenCalledTimes(1);
    expect(f.send).toHaveBeenCalledExactlyOnceWith({ action: 'begin' });
    expect(drawer()['aria-expanded']).toBe(false);
  });

  it('honors a configured minimum hold and suppresses repeated starts', async () => {
    const f = await fixture({}, { presenterActionKeys: { ...actionKeys, experience: { code: 'KeyQ', minHoldMs: 800 } } });
    let now = 0; vi.spyOn(performance, 'now').mockImplementation(() => now);
    await tap('KeyQ'); expect(f.send).not.toHaveBeenCalled();
    await key('keydown', 'KeyQ'); now = 900;
    await key('keydown', 'KeyQ', { repeat: true }); await key('keydown', 'KeyQ');
    expect(f.send).not.toHaveBeenCalled();
    await key('keyup', 'KeyQ'); await key('keyup', 'KeyQ');
    expect(f.send).toHaveBeenCalledExactlyOnceWith({ action: 'begin' });
  });

  it('stops through both existing stop paths while selection is busy', async () => {
    const stopExperience = vi.fn(async () => true);
    const f = await fixture({ phase: 'showcase' }, { presenterActionKeys: actionKeys, stopExperience,
      disabled: true, commandPending: true, selectionPending: true });
    await key('keydown', 'KeyQ');
    // A material update within this experience must not consume a stop intent.
    await f.update({ phase: 'generating', selectedLookId: 'city', generationNumber: 2, revision: 2 });
    await key('keyup', 'KeyQ');
    expect(stopExperience).toHaveBeenCalledTimes(1); expect(f.live.stopGeneration).toHaveBeenCalledTimes(1);
    expect(f.send).not.toHaveBeenCalled();
  });

  it('toggles the controlled drawer and retains the mode-change reset', async () => {
    const f = await fixture({}, { presenterActionKeys: actionKeys });
    expect(drawer()['aria-expanded']).toBe(false);
    await tap('KeyW'); expect(drawer()['aria-expanded']).toBe(true);
    await act(async () => { drawer().onClick(); }); expect(drawer()['aria-expanded']).toBe(false);
    f.props.disabled = true; await f.render();
    await tap('KeyW'); expect(drawer()['aria-expanded']).toBe(true);
    await f.update({ experienceMode: 'charx', looks: f.props.state.looks.map(look => ({ ...look, mode: 'charx' })) });
    expect(drawer()['aria-expanded']).toBe(false); expect(f.send).not.toHaveBeenCalled();
  });

  it.each([{ canControl: false }, { passive: true }, { presentation: 'remote' as const }, { send: undefined }])('disables both new actions without terminal control: %j', async overrides => {
    const f = await fixture({}, { presenterActionKeys: actionKeys, ...overrides });
    await tap('KeyQ'); await tap('KeyW');
    expect(f.send).not.toHaveBeenCalled(); expect(f.live.startCamera).not.toHaveBeenCalled();
    expect(drawer()['aria-expanded']).toBe(false);
  });

  it('does not convert a held start into stopping an experience started elsewhere', async () => {
    const f = await fixture({}, { presenterActionKeys: actionKeys });
    await key('keydown', 'KeyQ');
    await f.update({ phase: 'generating', sessionNumber: 2, generationNumber: 2 });
    await key('keyup', 'KeyQ');
    expect(f.send).not.toHaveBeenCalled(); expect(f.live.stopGeneration).not.toHaveBeenCalled();
  });

  it('does not convert a held stop into a new start after the experience ends', async () => {
    const f = await fixture({ phase: 'showcase' }, { presenterActionKeys: actionKeys });
    await key('keydown', 'KeyQ'); await f.update({ phase: 'select' }); await key('keyup', 'KeyQ');
    expect(f.send).not.toHaveBeenCalled(); expect(f.live.startCamera).not.toHaveBeenCalled();
  });

  it('does not stop a replacement experience when the key was held across sessions', async () => {
    const f = await fixture({ phase: 'showcase' }, { presenterActionKeys: actionKeys });
    await key('keydown', 'KeyQ'); await f.update({ sessionNumber: 2, generationNumber: 2 }); await key('keyup', 'KeyQ');
    expect(f.send).not.toHaveBeenCalled(); expect(f.live.stopGeneration).not.toHaveBeenCalled();
  });

  it('requires a fresh press after permission is revoked and restored', async () => {
    const f = await fixture({}, { presenterActionKeys: actionKeys });
    await key('keydown', 'KeyQ'); f.props.canControl = false; await f.render();
    f.props.canControl = true; await f.render(); await key('keyup', 'KeyQ');
    expect(f.send).not.toHaveBeenCalled();
    await tap('KeyQ'); expect(f.send).toHaveBeenCalledExactlyOnceWith({ action: 'begin' });
  });

  it.each([{ selectedLookId: 'city' }, { generationNumber: 2 }, { providerMode: 'demo' as const }])('cancels a held start after a material or provider change: %j', async change => {
    const f = await fixture({}, { presenterActionKeys: actionKeys });
    await key('keydown', 'KeyQ'); await f.update(change); await key('keyup', 'KeyQ');
    expect(f.send).not.toHaveBeenCalled();
  });

  it('can cancel a pending camera start without restarting when the camera resolves', async () => {
    const stopExperience = vi.fn(async () => true);
    const f = await fixture({}, { presenterActionKeys: actionKeys, stopExperience });
    const camera = deferred<boolean>(); vi.mocked(f.live.startCamera).mockReturnValueOnce(camera.promise);
    await tap('KeyQ'); expect(f.live.startCamera).toHaveBeenCalledTimes(1); expect(f.send).not.toHaveBeenCalled();
    await tap('KeyQ'); expect(stopExperience).toHaveBeenCalledTimes(1);
    expect(f.live.stopGeneration).toHaveBeenCalledTimes(1);
    await act(async () => { camera.resolve(true); }); await flushReact();
    expect(f.send).not.toHaveBeenCalled();
  });

  it('rechecks control permission after waiting for camera access', async () => {
    const f = await fixture({}, { presenterActionKeys: actionKeys });
    const camera = deferred<boolean>(); vi.mocked(f.live.startCamera).mockReturnValueOnce(camera.promise);
    await tap('KeyQ'); f.props.canControl = false; await f.render();
    await act(async () => { camera.resolve(true); }); await flushReact();
    expect(f.send).not.toHaveBeenCalled();
  });
});
