import { act, createElement, type ComponentProps } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ExhibitionState } from '../shared/exhibition';
import { resolveExhibitionGestureSettings } from '../shared/exhibitionGestures';
import type { ExhibitionController } from '../src/exhibition/useExhibition';
import type { ExhibitionLiveController } from '../src/exhibition/useExhibitionLive';
import type { useExhibitionGestures } from '../src/exhibition/useExhibitionGestures';
import { createExhibitionDiagnostics } from '../src/exhibition/diagnostics';
import { commandDiagnosticContext, diagnosticsRequested } from '../src/exhibition/diagnosticContext';
import { Kiosk } from '../src/exhibition/ExhibitionApp';
import { exhibitionLooks } from '../src/exhibition/catalog';
import { createReactHost, flushReact } from './support/reactHost';

type GestureOptions = Parameters<typeof useExhibitionGestures>[0];
const capture = vi.hoisted(() => ({ options: null as GestureOptions | null, status: 'ready', error: '',
  confirmationState: undefined as ReturnType<typeof useExhibitionGestures>['confirmationState'] | undefined,
  palmHoldMs: 0,
  handDetected: true, handRaised: false, operatorStatus: 'locked', controlSource: 'body', ambiguityReason: null as null | 'people' | 'hands', armed: true, needsRelease: false, captureStatus: 'active', fps: 15, inferenceMs: 20, recognitionMs: 35, retry: vi.fn() }));
const materialDrawer = vi.hoisted(() => ({ onBusyChange: null as ((busy: boolean) => void) | null }));
vi.mock('../src/exhibition/useExhibitionGestures', () => ({ useExhibitionGestures: (options: GestureOptions) => {
  capture.options = options;
  return { status: capture.status, error: capture.error, handDetected: capture.handDetected, handRaised: capture.handRaised, captureStatus: capture.captureStatus,
    operatorStatus: capture.operatorStatus, controlSource: capture.controlSource, ambiguityReason: capture.ambiguityReason, armed: capture.armed, needsRelease: capture.needsRelease,
    confirmationState: capture.confirmationState, palmHoldMs: capture.palmHoldMs,
    fps: capture.fps, inferenceMs: capture.inferenceMs, recognitionMs: capture.recognitionMs, retry: capture.retry };
} }));
vi.mock('../src/exhibition/LiveCameraPanel', () => ({ StreamVideo: () => null }));
vi.mock('../src/exhibition/MoXDragSurface', () => ({ MoXDragSurface: () => null }));
vi.mock('../src/exhibition/MirrorMaterialDrawer', () => ({ MirrorMaterialDrawer: (props: { onBusyChange: (busy: boolean) => void }) => {
  materialDrawer.onBusyChange = props.onBusyChange; return null;
} }));

let host: Awaited<ReturnType<typeof createReactHost>> | undefined;
afterEach(async () => { await host?.close(); host = undefined; vi.useRealTimers(); capture.options = null; capture.status = 'ready'; capture.error = ''; capture.confirmationState = undefined; capture.palmHoldMs = 0;
  capture.handDetected = true; capture.handRaised = false; capture.operatorStatus = 'locked'; capture.controlSource = 'body'; capture.ambiguityReason = null; capture.armed = true; capture.needsRelease = false; capture.captureStatus = 'active'; capture.retry.mockClear(); materialDrawer.onBusyChange = null; });
function snapshot(overrides: Partial<ExhibitionState> = {}): ExhibitionState {
  return { mirrorId: 'default', revision: 1, phase: 'idle', experienceMode: 'clothx', looks: structuredClone(exhibitionLooks),
    enabledLookIds: ['commute', 'city', 'evening'], selectedLookId: 'commute', displayedLookId: null,
    categories: [], tags: [], sessionNumber: 1, generationNumber: 1, updatedAt: 1, generationReadyAt: null,
    providerMode: 'xmax', live: null, logs: [], settings: { autoReturnSeconds: 90, uploadLimits: { maxFileSizeMB: 10, minWidth: 64, minHeight: 64, maxWidth: 4096, maxHeight: 4096 }, gestureRecognition: { ...resolveExhibitionGestureSettings(), gestures: ['open_palm', 'wave'] } }, ...overrides };
}
async function fixture(overrides: Partial<ExhibitionState> = {}, props: Partial<ComponentProps<typeof Kiosk>> = {}) {
  host = await createReactHost();
  let state = snapshot(overrides);
  const live = { cameraStream: { getVideoTracks: () => [{ readyState: 'live' }] }, outputStream: null, opening: false,
    error: '', status: 'preview', deviceId: 'wave-screen', mirrored: true, secure: true } as unknown as ExhibitionLiveController;
  const send = vi.fn(async (_command: unknown) => true);
  const render = () => host!.render(createElement(Kiosk, { state, live, send, ...props }));
  await render();
  return { live, send, render, update: async (next: Partial<ExhibitionState>) => { state = { ...state, ...next }; await render(); },
    palm: async () => { await act(async () => capture.options!.onGesture('open_palm')); await flushReact(); } };
}

describe('a revealed palm or wave advances material without beginning an experience', () => {
  it('defaults old mirrors to palm only and ignores an unselected wave callback', async () => {
    const settings = snapshot().settings;
    delete settings.gestureRecognition;
    const f = await fixture({ settings });
    expect(capture.options!.recognitionSettings).toEqual(resolveExhibitionGestureSettings());
    await act(async () => capture.options!.onGesture('wave')); await flushReact();
    expect(f.send).not.toHaveBeenCalled();
    await f.palm(); expect(f.send).toHaveBeenCalledExactlyOnceWith({ action: 'select', lookId: 'city' });
  });
  it('reads per-mirror parameters and respects wave-only configuration', async () => {
    const settings = snapshot().settings;
    settings.gestureRecognition = { ...resolveExhibitionGestureSettings(), gestures: ['wave'], palmConfirmMs: 450, maxFps: 10, inputLongEdge: 480 };
    const f = await fixture({ settings });
    expect(capture.options!.recognitionSettings).toEqual(settings.gestureRecognition);
    await f.palm(); expect(f.send).not.toHaveBeenCalled();
    await act(async () => capture.options!.onGesture('wave')); await flushReact();
    expect(f.send).toHaveBeenCalledExactlyOnceWith({ action: 'select', lookId: 'city' });
  });
  it('disables all recognition when staff clears the selected gestures', async () => {
    const settings = snapshot().settings;
    settings.gestureRecognition = { ...resolveExhibitionGestureSettings(), gestures: [] };
    const f = await fixture({ phase: 'showcase', settings });
    expect(capture.options!.enabled).toBe(false);
    await f.palm(); await act(async () => capture.options!.onGesture('wave')); await flushReact();
    expect(f.send).not.toHaveBeenCalled();
    expect(host!.find(node => node.getReactProps()['aria-label'] === '手势识别已由后台关闭')!.getReactProps().disabled).toBe(true);
  });
  it.each(['idle', 'showcase'] as const)('accepts a wave through the existing selection path in %s', async phase => {
    const f = await fixture({ phase });
    await act(async () => capture.options!.onGesture('wave')); await flushReact();
    expect(f.send).toHaveBeenCalledExactlyOnceWith({ action: phase === 'idle' ? 'select' : 'switch', lookId: 'city' });
  });
  it('advances each completed raise and wraps in the enabled material order', async () => {
    const f = await fixture();
    expect(capture.options).toMatchObject({ enabled: true, mode: 'palm_wave', mirrored: true, stream: f.live.cameraStream });
    await f.palm();
    expect(f.send).toHaveBeenLastCalledWith({ action: 'select', lookId: 'city' });
    await f.update({ selectedLookId: 'city', phase: 'select' }); await f.palm();
    expect(f.send).toHaveBeenLastCalledWith({ action: 'select', lookId: 'evening' });
    await f.update({ selectedLookId: 'evening' }); await f.palm();
    expect(f.send).toHaveBeenLastCalledWith({ action: 'select', lookId: 'commute' });
    expect(f.send.mock.calls).toHaveLength(3);
    expect(f.send.mock.calls.some(([command]) => (command as { action: string }).action === 'begin')).toBe(false);
  });

  it('uses the existing switch path in showcase', async () => {
    const f = await fixture({ phase: 'showcase' }); await f.palm();
    expect(f.send).toHaveBeenCalledExactlyOnceWith({ action: 'switch', lookId: 'city' });
  });

  it('follows the configured order and skips disabled materials and other modes', async () => {
    const other = { ...exhibitionLooks[1], id: 'other-mode', mode: 'charx' as const };
    const f = await fixture({ selectedLookId: 'evening', looks: [...exhibitionLooks, other], enabledLookIds: ['evening', 'other-mode', 'commute'] });
    await f.palm(); expect(f.send).toHaveBeenCalledExactlyOnceWith({ action: 'select', lookId: 'commute' });
  });

  it('deduplicates gestures until the current command finishes', async () => {
    const f = await fixture(); let finish!: (accepted: boolean) => void;
    f.send.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    await f.palm(); await f.palm(); expect(f.send).toHaveBeenCalledTimes(1);
    await f.update({ phase: 'select', selectedLookId: 'city' });
    await act(async () => finish(true)); await f.palm();
    expect(f.send).toHaveBeenCalledTimes(2);
    expect(f.send).toHaveBeenLastCalledWith({ action: 'select', lookId: 'evening' });
  });

  it('blocks motion during processing and resets ownership across stop boundaries', async () => {
    const f = await fixture({ phase: 'showcase' });
    const initialKey = capture.options!.resetKey;
    await f.palm(); await f.update({ selectedLookId: 'city', phase: 'generating', generationNumber: 2 });
    expect(capture.options!.blocked).toBe(true);
    expect(capture.options!.resetKey).toBe(initialKey);
    const processingKey = capture.options!.resetKey;
    await f.update({ phase: 'showcase' });
    expect(capture.options!.blocked).toBe(false);
    expect(capture.options!.resetKey).toBe(processingKey);
    const restoredKey = capture.options!.resetKey;
    await act(async () => host!.find(node => node.nodeName === 'button' && node.getReactProps()['aria-label'] === '停止生成')!.getReactProps().onClick());
    expect(capture.options!.resetKey).not.toBe(restoredKey);
    const afterStop = capture.options!.resetKey;
    await f.update({ phase: 'idle' });
    expect(capture.options!.resetKey).not.toBe(afterStop);
  });

  it.each(['disabled', 'carousel', 'command', 'generation', 'preparing'] as const)('passes both edges of %s blocking without restarting recognition', async blocking => {
    const props: Partial<ComponentProps<typeof Kiosk>> = {};
    const f = await fixture({ phase: 'showcase' }, props);
    const initialKey = capture.options!.resetKey;
    if (blocking === 'disabled') props.disabled = true;
    else if (blocking === 'carousel') await act(async () => materialDrawer.onBusyChange!(true));
    else if (blocking === 'command') props.commandPending = true;
    else if (blocking === 'generation') await f.update({ phase: 'generating' });
    else f.live.status = 'preparing';
    await f.render();
    const blockedKey = capture.options!.resetKey;
    expect(capture.options!.blocked).toBe(true);
    expect(blockedKey).toBe(initialKey);
    await f.palm(); expect(f.send).not.toHaveBeenCalled();
    props.disabled = false; props.commandPending = false; f.live.status = 'running';
    if (blocking === 'carousel') await act(async () => materialDrawer.onBusyChange!(false));
    await f.update({ phase: 'showcase' });
    expect(capture.options!.blocked).toBe(false);
    expect(capture.options!.resetKey).toBe(blockedKey);
    expect(f.send).not.toHaveBeenCalled();
  });

  it.each([
    { state: { phase: 'paused' as const }, props: {} },
    { state: {}, props: { disabled: true } },
    { state: {}, props: { stopPending: true } },
    { state: {}, props: { commandPending: true, selectionPending: true } },
    { state: {}, props: { canControl: false } },
    { state: {}, props: { passive: true } },
    { state: {}, props: { presentation: 'remote' as const } },
  ])('does not issue a gesture command when this screen cannot control selection: %j', async ({ state, props }) => {
    const f = await fixture(state, props); await f.palm(); expect(f.send).not.toHaveBeenCalled();
  });

  it('does nothing when only one material is enabled', async () => {
    const f = await fixture({ enabledLookIds: ['commute'] }); await f.palm(); expect(f.send).not.toHaveBeenCalled();
  });

  it.each(['raise_hand', 'swipe_right', 'swipe_left'] as const)('ignores the previous %s gesture', async gesture => {
    const f = await fixture(); await act(async () => capture.options!.onGesture(gesture)); expect(f.send).not.toHaveBeenCalled();
  });

  it('distinguishes a ready model from a locked operator and a stalled camera', async () => {
    capture.operatorStatus = 'searching';
    const f = await fixture({ phase: 'showcase' });
    const control = () => host!.find(node => node.nodeName === 'button' && node.getReactProps()['aria-label'] === '关闭手势换装')!;
    expect(control().textContent).toBe('请露出手掌');
    expect(control().getReactProps()['data-operator']).toBe('searching');
    expect(control().getReactProps()['data-detection']).toBe('waiting');
    capture.handDetected = true; await f.render();
    expect(control().textContent).toBe('请露出手掌');
    capture.operatorStatus = 'locked'; await f.render();
    expect(control().textContent).toBe('挥手或展掌换装');
    expect(control().getReactProps()['data-detection']).toBe('hand');
    expect(control().getReactProps()['data-capture-to-result-ms']).toBe(35);
    expect(control().getReactProps()['data-inference-ms']).toBe(20);
    capture.captureStatus = 'stalled'; await f.render();
    expect(control().textContent).toBe('取景未更新');
    expect(control().getReactProps()['data-detection']).toBe('waiting');
    capture.captureStatus = 'active';
    await f.update({ phase: 'paused' });
    expect(control().textContent).toBe('手势已暂停');
    expect(control().getReactProps()['data-detection']).toBe('paused');
    expect(f.send).not.toHaveBeenCalled();
  });

  it('shows release after a consumed gesture without treating readiness as another action', async () => {
    const f = await fixture({ phase: 'showcase' });
    vi.useFakeTimers();
    const control = () => host!.find(node => node.nodeName === 'button' && node.getReactProps()['aria-label'] === '关闭手势换装')!;
    expect(control().getReactProps()['data-hand-raised']).toBe(false);
    expect(control().textContent).toBe('挥手或展掌换装');
    capture.handDetected = true; capture.handRaised = true; capture.armed = false; capture.needsRelease = true; await f.render();
    expect(control().textContent).toBe('请放下手');
    expect(control().getReactProps()['data-hand-raised']).toBe(true);
    expect(control().getReactProps()['data-armed']).toBe(false);
    expect(f.send).not.toHaveBeenCalled();
    await f.palm();
    expect(f.send).toHaveBeenCalledExactlyOnceWith({ action: 'switch', lookId: 'city' });
    expect(control().textContent).toBe('换装已提交');
    await f.update({ selectedLookId: 'city', generationNumber: 2 });
    expect(control().textContent).toBe('换装已提交');
    await act(async () => vi.advanceTimersByTime(1200));
    expect(control().textContent).toBe('请放下手');
    capture.handRaised = false; capture.armed = true; capture.needsRelease = false; await f.render();
    expect(control().textContent).toBe('可以再次抬手');
    expect(control().getReactProps()['data-hand-raised']).toBe(false);
  });

  it('shows natural lowering and rearming even without an accepted command', async () => {
    const f = await fixture({ phase: 'showcase' });
    const label = () => host!.find(node => node.getReactProps().className === 'ex-mirror-gesture')!.textContent;
    capture.confirmationState = 'lowering'; capture.needsRelease = true; capture.armed = false;
    await f.render(); expect(label()).toBe('请放下手');
    capture.confirmationState = 'raise_required'; capture.needsRelease = false;
    await f.render(); expect(label()).toBe('可以再次抬手');
    expect(f.send).not.toHaveBeenCalled();
  });

  it('acknowledges a running switch only after acceptance without claiming a generated result', async () => {
    const f = await fixture({ phase: 'showcase' });
    let complete!: (accepted: boolean) => void;
    f.send.mockImplementationOnce(() => new Promise(resolve => { complete = resolve; }));
    const label = () => host!.find(node => node.getReactProps().className === 'ex-mirror-gesture')!.textContent;
    await f.palm(); expect(label()).toBe('切换中');
    await f.update({ selectedLookId: 'city', generationNumber: 2, phase: 'generating', revision: 2 });
    await act(async () => complete(true));
    expect(label()).toBe('换装已提交');
    expect(label()).not.toMatch(/已换装|已生成|已切换/);
  });

  it.each(['rejected', 'failed', 'ignored'] as const)('does not show success for %s gestures', async result => {
    const f = await fixture({ phase: 'showcase', ...(result === 'ignored' ? { enabledLookIds: ['commute'] } : {}) });
    if (result === 'rejected') f.send.mockResolvedValueOnce(false);
    else if (result === 'failed') f.send.mockRejectedValueOnce(new Error('request failed'));
    await f.palm();
    const label = host!.find(node => node.getReactProps().className === 'ex-mirror-gesture')!.textContent;
    expect(label).not.toMatch(/已选中|已提交/);
  });

  it.each(['session', 'mirror', 'superseded', 'stopped', 'disabled'] as const)('ignores late acceptance after %s', async boundary => {
    const props: Partial<ComponentProps<typeof Kiosk>> = {};
    const f = await fixture({ phase: 'showcase' }, props);
    let complete!: (accepted: boolean) => void;
    f.send.mockImplementationOnce(() => new Promise(resolve => { complete = resolve; }));
    await f.palm();
    if (boundary === 'session') await f.update({ sessionNumber: 2 });
    else if (boundary === 'mirror') await f.update({ mirrorId: 'second-mirror' });
    else if (boundary === 'superseded') await f.update({ selectedLookId: 'evening', generationNumber: 3, revision: 3 });
    else if (boundary === 'disabled') { props.disabled = true; await f.render(); props.disabled = false; await f.render(); }
    else await act(async () => host!.find(node => node.nodeName === 'button' && node.getReactProps()['aria-label'] === '停止生成')!.getReactProps().onClick());
    await act(async () => complete(true));
    const label = host!.find(node => node.getReactProps().className === 'ex-mirror-gesture')!.textContent;
    expect(label).not.toMatch(/已选中|已提交/);
  });

  it.each([false, true])('asks a locked operator to reveal their hands when neither is visible (armed %s)', async armed => {
    capture.handDetected = false; capture.armed = armed;
    const f = await fixture({ phase: 'showcase' });
    const control = () => host!.find(node => node.nodeName === 'button' && node.getReactProps()['aria-label'] === '关闭手势换装')!;
    expect(control().textContent).toBe('请露出手');
    capture.handDetected = true; capture.armed = false; await f.render();
    expect(control().textContent).toBe('请露出手掌');
    expect(f.send).not.toHaveBeenCalled();
  });

  it('accepts a hand-only control target and separately explains competing hands', async () => {
    capture.controlSource = 'hand';
    const f = await fixture({ phase: 'showcase' });
    const control = () => host!.find(node => node.nodeName === 'button' && node.getReactProps()['aria-label'] === '关闭手势换装')!;
    expect(control().getReactProps()['data-control-source']).toBe('hand');
    await f.palm(); expect(f.send).toHaveBeenCalledOnce();
    await f.update({ selectedLookId: 'city', generationNumber: 2 });
    f.send.mockClear();
    capture.operatorStatus = 'ambiguous'; capture.ambiguityReason = 'hands';
    await f.render();
    expect(control().textContent).toBe('请只露一只手');
    expect(f.send).not.toHaveBeenCalled();
  });

  it('updates ambiguity feedback without queuing an action from a rendered status', async () => {
    capture.operatorStatus = 'ambiguous'; capture.handDetected = true;
    const f = await fixture({ phase: 'showcase' });
    const control = () => host!.find(node => node.nodeName === 'button' && node.getReactProps()['aria-label'] === '关闭手势换装')!;
    expect(control().textContent).toBe('请单人体验');
    expect(control().getReactProps()['data-operator']).toBe('ambiguous');
    expect(f.send).not.toHaveBeenCalled();
    capture.operatorStatus = 'locked'; await f.render();
    expect(f.send).not.toHaveBeenCalled();
    await f.palm(); expect(f.send).toHaveBeenCalledOnce();
  });

  it.each(['searching', 'ambiguous', 'loading', 'waiting', 'stalled'] as const)('accepts a current-frame confirmation despite the prior rendered %s status', async previous => {
    if (previous === 'searching' || previous === 'ambiguous') capture.operatorStatus = previous;
    else if (previous === 'loading') capture.status = previous;
    else capture.captureStatus = previous;
    const f = await fixture({ phase: 'showcase' });
    await f.palm();
    expect(f.send).toHaveBeenCalledExactlyOnceWith({ action: 'switch', lookId: 'city' });
  });

  it.each(['generating', 'preparing', 'connecting', 'opening'] as const)('discards raises during %s and requires a new raise after processing', async pending => {
    const f = await fixture({ phase: 'showcase' });
    f.live.outputStream = {} as MediaStream;
    if (pending === 'generating') await f.update({ phase: 'generating' });
    else if (pending === 'opening') f.live.opening = true;
    else { f.live.status = pending; await f.update({ phase: 'showcase' }); }
    await f.render(); await f.palm(); expect(f.send).not.toHaveBeenCalled();
    const control = host!.find(node => node.nodeName === 'button' && node.getReactProps()['aria-label'] === '关闭手势换装')!;
    expect(control.textContent).toBe('切换中');
    expect(control.getReactProps()['data-processing']).toBe(true);
    f.live.opening = false; f.live.status = 'running'; await f.update({ phase: 'showcase' });
    expect(f.send).not.toHaveBeenCalled();
    await f.palm(); expect(f.send).toHaveBeenCalledExactlyOnceWith({ action: 'switch', lookId: 'city' });
  });

  it('keeps the gesture lock until an accepted command is observed in the selected material state', async () => {
    const f = await fixture();
    await f.palm(); await f.palm(); expect(f.send).toHaveBeenCalledOnce();
    await f.render(); await f.palm(); expect(f.send).toHaveBeenCalledOnce();
    await f.update({ phase: 'select', selectedLookId: 'city' });
    expect(f.send).toHaveBeenCalledOnce();
    await f.palm(); expect(f.send).toHaveBeenCalledTimes(2);
    expect(f.send).toHaveBeenLastCalledWith({ action: 'select', lookId: 'evening' });
  });

  it('releases an accepted gesture target superseded by a newer staff selection', async () => {
    const f = await fixture();
    await f.palm(); expect(f.send).toHaveBeenCalledOnce();
    await f.update({ selectedLookId: 'evening', phase: 'select', revision: 3 });
    await f.palm();
    expect(f.send).toHaveBeenLastCalledWith({ action: 'select', lookId: 'commute' });
    expect(f.send).toHaveBeenCalledTimes(2);
  });

  it.each(['rejected', 'failed'] as const)('releases a %s command without queuing the blocked gesture', async failure => {
    const f = await fixture();
    if (failure === 'rejected') f.send.mockResolvedValueOnce(false);
    else f.send.mockRejectedValueOnce(new Error('网络中断'));
    await f.palm(); expect(f.send).toHaveBeenCalledOnce();
    await f.render(); expect(f.send).toHaveBeenCalledOnce();
    await f.palm(); expect(f.send).toHaveBeenCalledTimes(2);
    expect(f.send).toHaveBeenLastCalledWith({ action: 'select', lookId: 'city' });
  });

  it.each(['preparing', 'connecting'] as const)('keeps idle selection available despite a leftover %s status', async status => {
    const f = await fixture(); f.live.status = status; await f.render();
    await f.palm(); expect(f.send).toHaveBeenCalledExactlyOnceWith({ action: 'select', lookId: 'city' });
  });

  it('starts XMAX only after the explicit start button is clicked', async () => {
    const f = await fixture();
    await f.palm(); await f.update({ phase: 'select', selectedLookId: 'city' });
    expect(f.send.mock.calls.some(([command]) => (command as { action: string }).action === 'begin')).toBe(false);
    await act(async () => host!.find(node => node.nodeName === 'button' && node.textContent === '开始体验')!.getReactProps().onClick());
    await flushReact();
    expect(f.send).toHaveBeenLastCalledWith({ action: 'begin' });
    expect(f.send).toHaveBeenCalledTimes(2);
  });

  it('lets the local screen turn recognition off and retry a failed model load', async () => {
    const f = await fixture({ phase: 'showcase' });
    await act(async () => host!.find(node => node.nodeName === 'button' && node.getReactProps()['aria-label'] === '关闭手势换装')!.getReactProps().onClick());
    expect(capture.options?.enabled).toBe(false);
    await act(async () => host!.find(node => node.nodeName === 'button' && node.getReactProps()['aria-label'] === '开启手势换装')!.getReactProps().onClick());
    capture.status = 'error'; capture.error = '抬手识别加载失败，请重试。'; await f.render();
    await act(async () => host!.find(node => node.nodeName === 'button' && node.getReactProps()['aria-label'] === '重新开启手势换装')!.getReactProps().onClick());
    expect(capture.retry).toHaveBeenCalledOnce(); expect(f.send).not.toHaveBeenCalled();
  });
});


describe('optional mirror diagnostics integration', () => {
  it('uses the exact screen flag and preserves a quiet default', async () => {
    expect(diagnosticsRequested('https://xuminghong.local:10202/v1.1/exhibition/screen?diagnostics=1')).toBe(true);
    for (const suffix of ['/exhibition/screen', '/exhibition/screen?diagnostics=true', '/exhibition/control?diagnostics=1']) {
      expect(diagnosticsRequested(`https://xuminghong.local:10202/v1.1${suffix}`)).toBe(false);
    }
    await fixture(); expect(capture.options!.diagnostics).toBe(false);
  });
  it('associates palm, command and target round without inventing a raise latency', async () => {
    const store = createExhibitionDiagnostics();
    const f = await fixture({ phase: 'showcase', sessionNumber: 3, generationNumber: 8 }, { diagnostics: store });
    const at = performance.now();
    await act(async () => capture.options!.onGesture('open_palm', { eventId: 'gesture-test-1', frameId: 7, sampledAt: at - 20, detectedAt: at }));
    await flushReact();
    const events = store.getSnapshot().events.filter(event => event.type !== 'sample');
    expect(events.map(event => event.type)).toEqual(['gesture_confirmed', 'command_sent', 'command_accepted']);
    expect(events.every(event => event.interactionId === 'gesture-test-1' && event.actionId === 'gesture-test-1-attempt-1' && event.context.sessionNumber === 3)).toBe(true);
    expect(events[0].context).toMatchObject({ generationNumber: 8, lookId: 'commute' });
    expect(events[1].context).toMatchObject({ generationNumber: 9, lookId: 'city' });
    expect(events[0].metrics).toMatchObject({ gesture: 'open_palm', recognitionMs: 20 });
    expect(events[0].metrics).not.toHaveProperty('raiseLatencyMs');
    expect(f.send).toHaveBeenCalledExactlyOnceWith({ action: 'switch', lookId: 'city' });
  });
  it('records rejected commands without counting visual success', async () => {
    const store = createExhibitionDiagnostics(); const f = await fixture({}, { diagnostics: store });
    f.send.mockResolvedValueOnce(false); await f.palm();
    expect(store.getSnapshot().events.some(event => event.type === 'command_rejected')).toBe(true);
    expect(store.getSnapshot().stats.confirmed).toBe(0); expect(store.markVisible()).toBeNull();
  });
  it('does not append an accepted command after the local stop boundary', async () => {
    const store = createExhibitionDiagnostics(); const f = await fixture({ phase: 'showcase' }, { diagnostics: store });
    let complete!: (accepted: boolean) => void;
    f.send.mockImplementationOnce(() => new Promise(resolve => { complete = resolve; }));
    await f.palm();
    await act(async () => host!.find(node => node.nodeName === 'button' && node.getReactProps()['aria-label'] === '停止生成')!.getReactProps().onClick());
    await act(async () => complete(true));
    expect(store.getSnapshot().events.filter(event => event.type === 'command_accepted')).toHaveLength(0);
    expect(store.getSnapshot().canMarkVisible).toBe(false);
  });
  it('closing diagnostics leaves gesture configuration and command behavior intact', async () => {
    const store = createExhibitionDiagnostics();
    const props: Partial<ComponentProps<typeof Kiosk>> = { diagnostics: store };
    const f = await fixture({}, props); const stream = capture.options!.stream; const reset = capture.options!.resetKey;
    store.close(); props.diagnostics = null; await f.render();
    expect(capture.options!.diagnostics).toBe(false); expect(capture.options!.stream).toBe(stream); expect(capture.options!.resetKey).toBe(reset);
    await f.palm(); expect(f.send).toHaveBeenCalledTimes(1); expect(store.getSnapshot().events).toHaveLength(0);
  });
  it('uses actual command observations even when a superseded accepted command resolves false', async () => {
    const store = createExhibitionDiagnostics();
    const acceptedState = snapshot({ phase: 'showcase', selectedLookId: 'city', sessionNumber: 1, generationNumber: 6 });
    const sendDiagnosed: ExhibitionController['sendDiagnosed'] = vi.fn(async (command, observer) => {
      observer({ type: 'sent', command, state: snapshot({ phase: 'showcase', generationNumber: 5 }), attempt: 1, at: performance.now() });
      observer({ type: 'accepted', command, state: acceptedState, attempt: 1, at: performance.now() });
      return false;
    });
    const f = await fixture({ phase: 'showcase', generationNumber: 1 }, { diagnostics: store, sendDiagnosed });
    const at = performance.now();
    await act(async () => capture.options!.onGesture('wave', { eventId: 'gesture-actual', frameId: 1, sampledAt: at, detectedAt: at }));
    await flushReact();
    expect(f.send).not.toHaveBeenCalled();
    expect(store.getSnapshot().events.filter(event => event.type === 'command_rejected')).toHaveLength(0);
    expect(store.getSnapshot().events.find(event => event.type === 'command_accepted')?.context).toMatchObject({ generationNumber: 6, lookId: 'city' });
    await f.update(acceptedState);
    const context = { mirrorId: 'default', sessionNumber: 1, generationNumber: 6, lookId: 'city' };
    store.record({ type: 'sdk_set_started', context, operationId: 'live-actual' });
    store.record({ type: 'sdk_set_resolved', context, operationId: 'live-actual' });
    store.record({ type: 'condition_committed', context, operationId: 'live-actual' });
    expect(store.markVisible()?.interactionId).toBe('gesture-actual');
  });
  it('predicts the existing command tuple for selection, begin and no-op switch', () => {
    const state = snapshot({ sessionNumber: 2, generationNumber: 7 });
    expect(commandDiagnosticContext(state, { action: 'begin' })).toMatchObject({ sessionNumber: 3, generationNumber: 8, lookId: 'commute' });
    expect(commandDiagnosticContext(state, { action: 'select', lookId: 'city' })).toMatchObject({ sessionNumber: 2, generationNumber: 7, lookId: 'city' });
    expect(commandDiagnosticContext(state, { action: 'switch', lookId: 'commute' }).generationNumber).toBe(7);
  });
});
