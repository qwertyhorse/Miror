import { act, createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ExhibitionMirrorList, ExhibitionMirrorSummary, ExhibitionState } from '../shared/exhibition';
import { MirrorConsole } from '../src/exhibition/MirrorConsole';
import type { ExhibitionController } from '../src/exhibition/useExhibition';
import type { ExhibitionLiveController } from '../src/exhibition/useExhibitionLive';
import { useMirrors, type MirrorRegistry } from '../src/exhibition/useMirrors';
import { appUrl } from '../src/versionScope';
import { createReactHost, flushReact } from './support/reactHost';

vi.mock('../src/components/SelectionControls', () => ({ CustomSelect: () => null }));
vi.mock('../src/exhibition/UploadLimitsSettings', () => ({ UploadLimitsSettings: () => null }));
vi.mock('../src/exhibition/MirrorCredentialSettings', () => ({ MirrorCredentialSettings: () => null }));
vi.mock('../src/exhibition/SessionLimitSettings', () => ({ SessionLimitSettings: () => null }));
vi.mock('../src/exhibition/MirrorUiSkinSettings', () => ({ MirrorUiSkinSettings: () => null }));
vi.mock('../src/exhibition/GestureRecognitionSettings', () => ({ GestureRecognitionSettings: () => null }));
vi.mock('../src/exhibition/MirrorDeviceBinding', () => ({ MirrorDeviceBinding: () => null }));

let host: Awaited<ReturnType<typeof createReactHost>> | undefined;
const restores: (() => void)[] = [];
afterEach(async () => {
  await host?.close(); host = undefined;
  restores.splice(0).forEach(restore => restore());
  vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals();
});

function mirror(id: string): ExhibitionMirrorSummary {
  return { id, name: `智能镜 ${id}`, phase: 'select', revision: 7, updatedAt: 1, providerMode: 'demo', binding: null };
}
const list = (ids = ['default', 'east', 'west']): ExhibitionMirrorList => ({ defaultMirrorId: 'default', mirrors: ids.map(mirror) });
function deferred<T>() {
  let resolve!: (value: T) => void;
  return { promise: new Promise<T>(done => { resolve = done; }), resolve };
}
async function hookFixture(fetcher: ReturnType<typeof vi.fn>) {
  vi.useFakeTimers(); vi.stubGlobal('fetch', fetcher);
  host = await createReactHost(); Object.assign(window, { setTimeout, clearTimeout });
  let registry!: MirrorRegistry;
  function Harness() { registry = useMirrors(); return null; }
  await host.render(createElement(Harness)); await flushReact();
  return () => registry;
}

describe('smart mirror registry deletion', () => {
  it('sends the initiating revision to the encoded mirror and adopts the returned list', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(Response.json(list(['default', 'floor/2'])))
      .mockResolvedValueOnce(Response.json(list(['default'])));
    const registry = await hookFixture(fetcher);
    await act(async () => { await registry().remove('floor/2', 7); });
    const [url, init] = fetcher.mock.calls[1] as [string, RequestInit];
    expect(url).toBe(appUrl('/api/exhibition/mirrors/floor%2F2'));
    expect(init.method).toBe('DELETE'); expect(JSON.parse(init.body as string)).toEqual({ expectedRevision: 7 });
    expect(registry().data).toEqual(list(['default']));
  });

  it('ignores an earlier poll after deletion and pauses new polls while the mutation is pending', async () => {
    const poll = deferred<Response>(); const deleting = deferred<Response>();
    const fetcher = vi.fn().mockResolvedValueOnce(Response.json(list())).mockReturnValueOnce(poll.promise).mockReturnValueOnce(deleting.promise);
    const registry = await hookFixture(fetcher);
    let refreshing!: Promise<void>; let removing!: Promise<ExhibitionMirrorList>;
    await act(async () => { refreshing = registry().refresh(); removing = registry().remove('east', 7); });
    await act(async () => { await vi.advanceTimersByTimeAsync(4000); await registry().refresh(); });
    expect(fetcher).toHaveBeenCalledTimes(3);
    await act(async () => { deleting.resolve(Response.json(list(['default', 'west']))); await removing; });
    await act(async () => { poll.resolve(Response.json(list())); await refreshing; });
    expect(registry().data?.mirrors.map(item => item.id)).toEqual(['default', 'west']);
  });

  it('keeps the mirror after a server refusal and releases the mutation lock for retry', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(Response.json(list()))
      .mockResolvedValueOnce(Response.json({ message: '云端会话尚未结束。' }, { status: 409 }))
      .mockResolvedValueOnce(Response.json(list(['default', 'west'])));
    const registry = await hookFixture(fetcher);
    await act(async () => { await expect(registry().remove('east', 7)).rejects.toThrow('云端会话尚未结束。'); });
    expect(registry().data).toEqual(list());
    await act(async () => { await registry().remove('east', 8); });
    expect(registry().data?.mirrors.some(item => item.id === 'east')).toBe(false);
  });
});

function button(label: string) {
  return host!.find(node => node.nodeName === 'button' && (node.getReactProps()['aria-label'] === label || node.textContent === label));
}
const dialog = () => host!.find(node => node.nodeName === 'dialog');
async function click(label: string) { await act(async () => { button(label)!.getReactProps().onClick(); }); }
async function submit() { await act(async () => { dialog()!.childNodes[0].getReactProps().onSubmit({ preventDefault: vi.fn() }); }); await flushReact(); }
async function consoleFixture(currentId = 'east', stateOverrides: Partial<ExhibitionState> = {}) {
  host = await createReactHost();
  const prototype = Object.getPrototypeOf(document.createElement('div'));
  const descriptors = new Map(['showModal', 'close', 'querySelector', 'focus', 'isConnected'].map(key => [key, Object.getOwnPropertyDescriptor(prototype, key)]));
  Object.defineProperties(prototype, {
    showModal: { configurable: true, value() { this.open = true; } },
    close: { configurable: true, value() { this.open = false; } },
    querySelector: { configurable: true, value() { return null; } },
    focus: { configurable: true, value() { Reflect.set(document, 'activeElement', this); } },
    isConnected: { configurable: true, get() { return document.body.contains(this); } },
  });
  restores.push(() => descriptors.forEach((value, key) => { if (value) Object.defineProperty(prototype, key, value); else Reflect.deleteProperty(prototype, key); }));
  vi.stubGlobal('HTMLElement', window.HTMLElement);
  const state: ExhibitionState = { mirrorId: currentId, revision: 8, phase: 'select', experienceMode: 'clothx', providerMode: 'demo',
    selectedLookId: null, displayedLookId: null, looks: [], enabledLookIds: [], categories: [], tags: [], sessionNumber: 0,
    generationNumber: 0, updatedAt: 1, generationReadyAt: null, live: null, logs: [],
    settings: { autoReturnSeconds: 90, uploadLimits: { maxFileSizeMB: 10, minWidth: 64, minHeight: 64, maxWidth: 4096, maxHeight: 4096 } }, ...stateOverrides };
  const controller = { state, mirrorId: currentId, connected: true, pending: false, stopPending: false, error: '',
    send: vi.fn(async () => true), clearError: vi.fn() } as unknown as ExhibitionController;
  const remove = vi.fn<MirrorRegistry['remove']>(async id => list(['default', 'east', 'west'].filter(item => item !== id)));
  const registry = { data: list(), error: '', refresh: vi.fn(async () => {}), save: vi.fn(), remove } as MirrorRegistry;
  const selectMirror = vi.fn();
  const render = () => host!.render(createElement(MirrorConsole, { mirror: mirror(currentId), controller, registry, selectMirror,
    live: { liveStatus: null } as ExhibitionLiveController, preview: null }));
  await render();
  return { state, controller, registry, remove, selectMirror, render };
}

describe('smart mirror delete confirmation', () => {
  it('offers separate delete actions for added mirrors only and cancellation leaves data and selection intact', async () => {
    const f = await consoleFixture();
    expect(button('删除智能镜 default')).toBeUndefined();
    const removeButton = button('删除智能镜 west')!;
    expect(removeButton.parentNode?.nodeName).toBe('div');
    expect(removeButton.parentNode?.getReactProps().onClick).toBeUndefined();
    await click('删除智能镜 west');
    expect(dialog()?.textContent).toContain('删除「智能镜 west」？');
    expect(button('取消')?.getReactProps().autoFocus).toBe(true);
    expect(f.remove).not.toHaveBeenCalled(); expect(f.selectMirror).not.toHaveBeenCalled();
    await click('取消'); expect(dialog()).toBeUndefined();
    expect(f.remove).not.toHaveBeenCalled(); expect(f.selectMirror).not.toHaveBeenCalled();
  });

  it('deletes the selected mirror with its opened revision and selects the default only after success', async () => {
    const f = await consoleFixture(); const pending = deferred<ExhibitionMirrorList>(); f.remove.mockReturnValue(pending.promise);
    await click('删除智能镜 east'); f.state.revision = 9; await f.render();
    await submit(); await submit();
    expect(f.remove).toHaveBeenCalledExactlyOnceWith('east', 8);
    expect(f.selectMirror).not.toHaveBeenCalled(); expect(button('取消')?.getReactProps().disabled).toBe(true);
    await act(async () => { pending.resolve(list(['default', 'west'])); }); await flushReact();
    expect(f.selectMirror).toHaveBeenCalledExactlyOnceWith('default'); expect(dialog()).toBeUndefined();
  });

  it('deletes another mirror without navigating away from the current settings', async () => {
    const f = await consoleFixture(); await click('删除智能镜 west'); await submit();
    expect(f.remove).toHaveBeenCalledExactlyOnceWith('west', 7); expect(f.selectMirror).not.toHaveBeenCalled();
    expect(dialog()).toBeUndefined();
  });

  it.each([{ phase: 'generating' }, { live: { status: 'error', localEnded: true } }])('blocks deletion while generation remains active or unconfirmed: %j', async overrides => {
    const f = await consoleFixture('east', overrides as Partial<ExhibitionState>);
    await click('删除智能镜 east');
    expect(button('删除智能镜')?.getReactProps().disabled).toBe(true);
    expect(dialog()?.textContent).toContain('请先停止生成，待云端会话结束后再删除。');
    await submit(); expect(f.remove).not.toHaveBeenCalled();
  });

  it('shows a server refusal without removing the row or changing selection', async () => {
    const f = await consoleFixture(); f.remove.mockRejectedValue(new Error('设备状态已变化，请重新确认。'));
    await click('删除智能镜 west'); await submit();
    expect(dialog()?.textContent).toContain('设备状态已变化，请重新确认。');
    expect(button('删除智能镜 west')).toBeDefined(); expect(f.selectMirror).not.toHaveBeenCalled();
  });
});
