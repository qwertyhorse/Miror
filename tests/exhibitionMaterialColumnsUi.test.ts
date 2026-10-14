import { act, createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ExhibitionCommand, ExhibitionMirrorSummary, ExhibitionState } from '../shared/exhibition';
import { Kiosk } from '../src/exhibition/ExhibitionApp';
import { MirrorConsole } from '../src/exhibition/MirrorConsole';
import { MirrorMaterialDrawer } from '../src/exhibition/MirrorMaterialDrawer';
import type { ExhibitionController } from '../src/exhibition/useExhibition';
import type { ExhibitionLiveController } from '../src/exhibition/useExhibitionLive';
import type { MirrorRegistry } from '../src/exhibition/useMirrors';
import { exhibitionLooks } from '../src/exhibition/catalog';
import { createReactHost, flushReact } from './support/reactHost';

type SelectProps = { label: string; value: string; disabled?: boolean; options: { value: string; label: string }[]; onChange: (value: string) => void };
const selects = vi.hoisted(() => new Map<string, SelectProps>());
// The select's keyboard and popup behavior has its own tests; retain the real
// console handler while exposing this component boundary to the small DOM host.
vi.mock('../src/components/SelectionControls', () => ({ CustomSelect: (props: SelectProps) => {
  selects.set(props.label, props);
  return createElement('button', { type: 'button', role: 'combobox', 'aria-label': props.label, disabled: props.disabled },
    props.options.find(option => option.value === props.value)?.label);
} }));
vi.mock('../src/exhibition/UploadLimitsSettings', () => ({ UploadLimitsSettings: () => null }));
vi.mock('../src/exhibition/MirrorCredentialSettings', () => ({ MirrorCredentialSettings: () => null }));
vi.mock('../src/exhibition/SessionLimitSettings', () => ({ SessionLimitSettings: () => null }));
vi.mock('../src/exhibition/MirrorUiSkinSettings', () => ({ MirrorUiSkinSettings: () => null }));
vi.mock('../src/exhibition/GestureRecognitionSettings', () => ({ GestureRecognitionSettings: () => null }));
vi.mock('../src/exhibition/useExhibitionGestures', () => ({ useExhibitionGestures: () => ({
  status: 'disabled', error: '', handDetected: false, handRaised: false, captureStatus: 'disabled',
  operatorStatus: 'searching', armed: false, needsRelease: false, retry: vi.fn(),
}) }));
vi.mock('../src/exhibition/LiveCameraPanel', () => ({ StreamVideo: () => null }));
vi.mock('../src/exhibition/MoXDragSurface', () => ({ MoXDragSurface: () => null }));

let host: Awaited<ReturnType<typeof createReactHost>> | undefined;
afterEach(async () => { await host?.close(); host = undefined; selects.clear(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function snapshot(overrides: Partial<ExhibitionState> = {}): ExhibitionState {
  return { mirrorId: 'east', revision: 7, phase: 'idle', experienceMode: 'clothx', providerMode: 'demo',
    selectedLookId: 'commute', displayedLookId: null, looks: structuredClone(exhibitionLooks), enabledLookIds: ['commute', 'city'],
    categories: [], tags: [], sessionNumber: 0, generationNumber: 0, updatedAt: 1000, generationReadyAt: null, live: null, logs: [],
    settings: { autoReturnSeconds: 90, uploadLimits: { maxFileSizeMB: 10, minWidth: 64, minHeight: 64, maxWidth: 4096, maxHeight: 4096 } }, ...overrides };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  return { promise: new Promise<T>(done => { resolve = done; }), resolve };
}
const columnsSelect = () => {
  const props = selects.get('素材栏列数');
  expect(props).toBeDefined();
  return props!;
};
async function changeColumns(value: string) { await act(async () => { columnsSelect().onChange(value); }); await flushReact(); }
function button(label: string) {
  return host!.find(node => node.nodeName === 'button' && (node.getReactProps()['aria-label'] === label || node.textContent === label))!.getReactProps();
}
function drawer() { return host!.find(node => String(node.getReactProps().className ?? '').split(' ').includes('ex-mirror-drawer'))!; }

async function consoleFixture(stateOverrides: Partial<ExhibitionState> = {}) {
  host = await createReactHost();
  const state = snapshot(stateOverrides);
  const send = vi.fn(async (_command: ExhibitionCommand) => true);
  const controller = { state, mirrorId: 'east', connected: true, pending: false, stopPending: false, error: '', send,
    clearError: vi.fn(), stopExperience: vi.fn(async () => true) } as unknown as ExhibitionController;
  const mirror: ExhibitionMirrorSummary = { id: 'east', name: '东侧智能镜', phase: state.phase, revision: state.revision,
    providerMode: state.providerMode, updatedAt: 1000, binding: null };
  const registry = { data: { defaultMirrorId: 'east', mirrors: [mirror] }, error: '', refresh: vi.fn(async () => {}) } as unknown as MirrorRegistry;
  const props = { controller, mirror, registry, live: { liveStatus: null } as ExhibitionLiveController, selectMirror: vi.fn(), preview: null };
  const render = () => host!.render(createElement(MirrorConsole, props));
  await render();
  return { state, send, controller, props, render };
}

async function kioskFixture(columns?: 1 | 2) {
  host = await createReactHost();
  const state = snapshot();
  if (columns !== undefined) state.settings.materialDrawerColumns = columns;
  const send = vi.fn(async (_command: ExhibitionCommand) => true);
  const render = () => host!.render(createElement(Kiosk, { state, send }));
  await render();
  return { state, send, render };
}

describe('per-mirror material drawer column setting', () => {
  it('defaults older mirrors to two columns and presents exactly one/two column choices', async () => {
    const f = await consoleFixture();
    expect(columnsSelect().value).toBe('2');
    expect(columnsSelect().options).toEqual([{ value: '1', label: '一列' }, { value: '2', label: '两列' }]);
    expect(button('素材栏列数').disabled).toBe(false);
    const row = host!.find(node => node.getReactProps()['aria-label'] === '素材栏列数')!.parentNode!;
    expect(row.childNodes.filter(node => node.nodeName === 'button')).toHaveLength(1);
    expect(f.send).not.toHaveBeenCalled();
  });

  it.each(['idle', 'select'] as const)('saves the column choice directly with the latest revision in %s', async phase => {
    const f = await consoleFixture({ phase });
    f.state.revision = 9; await f.render();
    await changeColumns('1');
    expect(f.send).toHaveBeenCalledExactlyOnceWith({ action: 'configure', materialDrawerColumns: 1, expectedRevision: 9 });
    expect(f.state.selectedLookId).toBe('commute');
    expect(f.state.phase).toBe(phase);
  });

  it('reads the acknowledged choice without optimistically changing the shared state', async () => {
    const f = await consoleFixture();
    await changeColumns('1');
    expect(columnsSelect().value).toBe('2');
    expect(f.state.settings.materialDrawerColumns).toBeUndefined();
    f.state.settings.materialDrawerColumns = 1; f.state.revision = 8; await f.render();
    expect(columnsSelect().value).toBe('1');
    await changeColumns('2');
    expect(f.send).toHaveBeenLastCalledWith({ action: 'configure', materialDrawerColumns: 2, expectedRevision: 8 });
  });

  it.each(['2', '0', '3', '', 'invalid'])('does not send unchanged or invalid value %j', async value => {
    const f = await consoleFixture(); await changeColumns(value);
    expect(f.send).not.toHaveBeenCalled();
  });

  it.each(['generating', 'showcase', 'paused', 'positioning'] as const)('guards the direct choice handler during %s', async phase => {
    const f = await consoleFixture({ phase });
    expect(button('素材栏列数').disabled).toBe(true);
    await changeColumns('1'); expect(f.send).not.toHaveBeenCalled();
  });

  it.each(['live', 'pending', 'stopPending', 'disconnected'] as const)('guards the direct choice handler when %s', async reason => {
    const f = await consoleFixture();
    if (reason === 'live') f.state.live = { status: 'stopping' } as ExhibitionState['live'];
    else if (reason === 'disconnected') f.controller.connected = false;
    else f.controller[reason] = true;
    await f.render();
    expect(button('素材栏列数').disabled).toBe(true);
    await changeColumns('1'); expect(f.send).not.toHaveBeenCalled();
  });

  it('keeps the confirmed choice after a failed save and permits retry', async () => {
    const f = await consoleFixture(); f.send.mockResolvedValueOnce(false);
    await changeColumns('1');
    expect(columnsSelect().value).toBe('2'); expect(button('素材栏列数').disabled).toBe(false);
    await changeColumns('1');
    expect(f.send).toHaveBeenCalledTimes(2);
    expect(f.send).toHaveBeenLastCalledWith({ action: 'configure', materialDrawerColumns: 1, expectedRevision: 7 });
  });

  it('reads a different mirror’s own choice and revision after switching devices', async () => {
    const f = await consoleFixture(); f.state.settings.materialDrawerColumns = 1; await f.render();
    expect(columnsSelect().value).toBe('1');
    const second = snapshot({ mirrorId: 'west', revision: 21 });
    f.controller.state = second; f.controller.mirrorId = 'west';
    f.props.mirror = { ...f.props.mirror, id: 'west', name: '西侧智能镜', revision: 21 };
    await f.render();
    expect(columnsSelect().value).toBe('2');
    await changeColumns('1');
    expect(f.send).toHaveBeenCalledExactlyOnceWith({ action: 'configure', materialDrawerColumns: 1, expectedRevision: 21 });
  });
});

describe('material drawer applies columns without resetting browsing', () => {
  it.each([undefined, 1, 2] as const)('passes the saved %s column value from Kiosk to the real drawer', async columns => {
    const f = await kioskFixture(columns);
    expect(drawer().getReactProps()['data-columns']).toBe(columns ?? 2);
    expect(button('选择服装')['aria-expanded']).toBe(false);
    expect(f.send).not.toHaveBeenCalled();
  });

  it('changes layout while retaining the open drawer and selected material', async () => {
    const f = await kioskFixture();
    await act(async () => { button('选择服装').onClick(); });
    expect(button('选择轻盈通勤')['aria-pressed']).toBe(true);
    f.state.settings.materialDrawerColumns = 1; f.state.revision = 8; await f.render();
    expect(drawer().getReactProps()['data-columns']).toBe(1);
    expect(button('收起素材选择')['aria-expanded']).toBe(true);
    expect(button('选择轻盈通勤')['aria-pressed']).toBe(true);
    expect(f.state.selectedLookId).toBe('commute'); expect(f.send).not.toHaveBeenCalled();
    f.state.settings.materialDrawerColumns = 2; await f.render();
    expect(drawer().getReactProps()['data-columns']).toBe(2);
    expect(button('收起素材选择')['aria-expanded']).toBe(true);
  });

  it('preserves an optimistic selection and its acknowledgement across a column update', async () => {
    const f = await kioskFixture(2); const selection = deferred<boolean>(); f.send.mockReturnValueOnce(selection.promise);
    await act(async () => { button('选择服装').onClick(); });
    await act(async () => { button('选择都市休闲').onClick(); });
    expect(button('选择都市休闲')['aria-pressed']).toBe(true);
    f.state.settings.materialDrawerColumns = 1; await f.render();
    expect(drawer().getReactProps()['data-columns']).toBe(1);
    expect(button('选择都市休闲')['aria-pressed']).toBe(true);
    expect(button('收起素材选择')['aria-expanded']).toBe(true);
    await act(async () => { selection.resolve(true); });
    f.state.selectedLookId = 'city'; f.state.revision = 8; await f.render();
    expect(button('选择都市休闲')['aria-pressed']).toBe(true);
    expect(f.send).toHaveBeenCalledExactlyOnceWith({ action: 'select', lookId: 'city' });
  });

  it('defaults direct drawer usage to two columns', async () => {
    host = await createReactHost();
    await host.render(createElement(MirrorMaterialDrawer, { looks: exhibitionLooks, selectedId: 'commute', disabled: false,
      passive: false, title: '选择服装', onSelect: vi.fn(async () => true), onBusyChange: vi.fn() }));
    expect(drawer().getReactProps()['data-columns']).toBe(2);
  });
});
