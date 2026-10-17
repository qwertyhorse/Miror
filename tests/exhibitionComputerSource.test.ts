import { act, createElement, StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ComputerSource } from '../src/exhibition/ComputerSource';
import { createReactHost, flushReact } from './support/reactHost';
import { cameraCaptureConstraints, readCameraPreference } from '../src/exhibition/cameraPreference';
import { scopedStorageKey } from '../src/versionScope';

const mocks = vi.hoisted(() => ({ controller: null as any, live: null as any, liveInputs: [] as any[], kiosk: null as any, transports: [] as any[], openState: null as any, orient: vi.fn() }));
vi.mock('../src/exhibition/useExhibition', () => ({ useExhibition: () => mocks.controller }));
vi.mock('../src/exhibition/useExhibitionLive', () => ({ useExhibitionLive: (input: any) => { mocks.liveInputs.push(input); return mocks.live; } }));
vi.mock('../src/exhibition/ExhibitionApp', () => ({ Kiosk: (props: any) => { mocks.kiosk = props; return null; } }));
vi.mock('../src/exhibition/LiveCameraPanel', () => ({ LiveCameraPanel: () => null }));
vi.mock('../src/exhibition/cameraOrientation', () => ({ orientExhibitionCamera: mocks.orient }));
vi.mock('../src/exhibition/computerDisplay', () => ({ ComputerDisplaySender: class {
  events: any; start: any; close = vi.fn(); setSource = vi.fn(async () => {}); setQuality = vi.fn(async () => {});
  constructor(public mirrorId: string, public deviceId: string, events: any, _dependencies: unknown, public output: 'android' | 'browser') {
    this.events = events;
    this.start = vi.fn(async () => events.change(mocks.openState ?? { session: { sessionId: 'host', token: 'ephemeral', terminalId: 'desktop-host' }, status: 'connected', receiverOnline: true, error: '' }));
    mocks.transports.push(this);
  }
} }));

let host: Awaited<ReturnType<typeof createReactHost>> | undefined;
let storage: Map<string, string>;
let setItem: ReturnType<typeof vi.fn>;
let sourceProps: { mirrorId: string; output?: 'android' | 'browser' };
beforeEach(() => {
  sourceProps = { mirrorId: 'east' };
  storage = new Map();
  setItem = vi.fn((key: string, value: string) => { storage.set(key, value); });
  vi.stubGlobal('localStorage', { getItem: (key: string) => storage.get(key) ?? null, setItem });
  mocks.transports = []; mocks.liveInputs = []; mocks.kiosk = null; mocks.openState = null;
  mocks.orient.mockReset().mockResolvedValue({ stream: { id: 'rotated' }, dispose: vi.fn() });
  mocks.controller = {
    state: { mirrorId: 'east', revision: 1, phase: 'idle', providerMode: 'xmax', experienceMode: 'clothx', live: null },
    connected: true, refresh: vi.fn(async () => {}), send: vi.fn(async () => true), stopExperience: vi.fn(async () => true),
    pending: false, selectionPending: false, stopPending: false,
  };
  mocks.live = {
    deviceId: 'screen-unique', cameraStream: { id: 'camera' }, outputStream: null, presentation: null, mirrored: true, error: '',
    opening: false, cameraError: '', cameras: [], selectedCameraId: '',
    stopGeneration: vi.fn(async () => true),
  };
});
afterEach(async () => { await host?.close(); host = undefined; vi.unstubAllGlobals(); });
async function mount(strict = false, options: Partial<typeof sourceProps> = {}) {
  host = await createReactHost();
  const createNode = document.createElement.bind(document);
  document.createElement = ((tag: string) => {
    const node = createNode(tag);
    if (tag === 'select') Object.defineProperty(node, 'options', { get: () => node.childNodes });
    return node;
  }) as typeof document.createElement;
  sourceProps = { mirrorId: 'east', ...options };
  const element = createElement(ComputerSource, sourceProps);
  await host.render(strict ? createElement(StrictMode, null, element) : element); await flushReact();
  return mocks.transports.at(-1);
}
async function render() { await host!.render(createElement(ComputerSource, sourceProps)); await flushReact(); }
function capture(deviceId: string, label = 'Insta360 Link') {
  const track = { readyState: 'live', label, getSettings: () => ({ deviceId }) };
  mocks.live.cameraStream = { getVideoTracks: () => [track] };
  mocks.live.selectedCameraId = deviceId;
  mocks.live.cameras = [{ deviceId, label }];
  return track;
}
async function rotationSelect() {
  await act(async () => mocks.kiosk.cameraControl.props.children.props.onClick()); await flushReact();
  return () => host!.find(node => node.nodeName === 'select' && node.getReactProps()['aria-label'] === '摄像头方向')!.getReactProps();
}
async function qualitySelect() {
  await act(async () => mocks.kiosk.cameraControl.props.children.props.onClick()); await flushReact();
  return () => host!.find(node => node.nodeName === 'select' && node.getReactProps()['aria-label'] === '摄像头画质')!.getReactProps();
}
async function outputControls() {
  await act(async () => mocks.kiosk.cameraControl.props.children.props.onClick()); await flushReact();
  const select = (label: string) => host!.find(node => node.nodeName === 'select' && node.getReactProps()['aria-label'] === label)!.getReactProps();
  return { quality: () => select('输出分辨率'), frameRate: () => select('帧率上限') };
}

describe('computer source page', () => {
  it('changes output limits during generation without changing the capture or restarting the connection', async () => {
    storage.set(scopedStorageKey('exhibition-camera-quality:computer-east'), '4k');
    storage.set(scopedStorageKey('exhibition-camera-rotation:computer-east'), '270');
    mocks.live.rawCameraStream = { id: 'landscape-4k' };
    const transport = await mount();
    mocks.controller.state = { ...mocks.controller.state, phase: 'showcase', live: { deviceId: 'screen-unique' } };
    mocks.live.outputStream = { id: 'xmax-native' }; await render();
    const input = mocks.liveInputs.at(-1); const calls = transport.setSource.mock.calls.length;
    const controls = await outputControls();
    expect(controls.quality().value).toBe('4k'); expect(controls.frameRate().value).toBe(30);
    expect(controls.quality().disabled).toBe(false);
    expect(controls.quality().children.map((option: any) => option.props.value)).toEqual(['1080p', '2k', '4k', 'l1', 'l2', 'l3', 'l4']);
    expect(controls.frameRate().children.map((option: any) => option.props.value)).toEqual([15, 24, 30]);
    await act(async () => controls.quality().onChange({ target: { value: '2k' } })); await flushReact();
    await act(async () => controls.frameRate().onChange({ target: { value: '15' } })); await flushReact();
    expect(transport.setQuality).toHaveBeenLastCalledWith('2k', 15);
    expect(mocks.liveInputs.at(-1).cameraTransform).toBe(input.cameraTransform);
    expect(mocks.liveInputs.at(-1).cameraCaptureDimensions).toBe(input.cameraCaptureDimensions);
    expect(transport.setSource).toHaveBeenCalledTimes(calls);
    expect(transport.close).not.toHaveBeenCalled(); expect(mocks.transports).toHaveLength(1);
    expect(mocks.controller.send).not.toHaveBeenCalled(); expect(mocks.controller.stopExperience).not.toHaveBeenCalled();
    expect(mocks.live.stopGeneration).not.toHaveBeenCalled();
    expect(JSON.parse(storage.get(scopedStorageKey('exhibition-display-settings:computer-east'))!)).toEqual({ quality: '2k', frameRate: 15 });
    expect(storage.get(scopedStorageKey('exhibition-camera-quality:computer-east'))).toBe('4k');
    expect(storage.has(scopedStorageKey('exhibition-display-settings:computer-west'))).toBe(false);
  });

  it.each(['l1', 'l2', 'l3', 'l4'])('applies output %s during generation without recapturing or restarting AI', async quality => {
    storage.set(scopedStorageKey('exhibition-camera-quality:computer-east'), '4k');
    storage.set(scopedStorageKey('exhibition-camera-rotation:computer-east'), '270');
    const transport = await mount();
    mocks.controller.state = { ...mocks.controller.state, phase: 'showcase', live: { deviceId: 'screen-unique' } };
    mocks.live.outputStream = { id: 'xmax-native' }; await render();
    const input = mocks.liveInputs.at(-1); const calls = transport.setSource.mock.calls.length;
    const controls = await outputControls();
    await act(async () => controls.quality().onChange({ target: { value: quality } })); await flushReact();
    expect(transport.setQuality).toHaveBeenLastCalledWith(quality, 30);
    expect(mocks.liveInputs.at(-1).cameraTransform).toBe(input.cameraTransform);
    expect(mocks.liveInputs.at(-1).cameraCaptureDimensions).toBe(input.cameraCaptureDimensions);
    expect(transport.setSource).toHaveBeenCalledTimes(calls);
    expect(transport.close).not.toHaveBeenCalled(); expect(mocks.transports).toHaveLength(1);
    expect(mocks.controller.send).not.toHaveBeenCalled(); expect(mocks.controller.stopExperience).not.toHaveBeenCalled();
    expect(mocks.live.stopGeneration).not.toHaveBeenCalled();
    expect(JSON.parse(storage.get(scopedStorageKey('exhibition-display-settings:computer-east'))!)).toEqual({ quality, frameRate: 30 });
    expect(storage.get(scopedStorageKey('exhibition-camera-quality:computer-east'))).toBe('4k');
  });

  it.each(['1080p', '4k'])('preserves the implicit %s output on reload after changing capture to L4', async previous => {
    storage.set(scopedStorageKey('exhibition-camera-quality:computer-east'), previous);
    const transport = await mount(); const select = await qualitySelect();
    expect(select().children.map((option: any) => option.props.value)).toEqual(['1080p', '4k', 'l1', 'l2', 'l3', 'l4']);
    await act(async () => select().onChange({ target: { value: 'l4' } })); await flushReact();
    expect(transport.setQuality).toHaveBeenLastCalledWith(previous, 30);
    expect(storage.get(scopedStorageKey('exhibition-camera-quality:computer-east'))).toBe('l4');
    await host!.close(); host = undefined;
    const next = await mount(); const restored = await qualitySelect();
    expect(restored().value).toBe('l4'); expect(next.setQuality).toHaveBeenLastCalledWith(previous, 30);
  });

  it.each([
    ['l1', 1920, 1024], ['l2', 1536, 818], ['l3', 1248, 664], ['l4', 960, 512],
  ].flatMap(([quality, width, height]) => [0, 90, 180, 270].map(rotation => ({ quality, width, height, rotation }))))(
    'bounds $quality capture at $rotation degrees while retaining a separate 4K output limit', async ({ quality, width, height, rotation }) => {
      storage.set(scopedStorageKey('exhibition-camera-quality:computer-east'), String(quality));
      storage.set(scopedStorageKey('exhibition-camera-rotation:computer-east'), String(rotation));
      storage.set(scopedStorageKey('exhibition-display-settings:computer-east'), JSON.stringify({ quality: '4k', frameRate: 24 }));
      mocks.live.rawCameraStream = { id: 'oversized-native-camera' };
      const transport = await mount(); const input = mocks.liveInputs.at(-1);
      expect(input.cameraCaptureDimensions).toEqual(rotation === 90 || rotation === 270 ? { width, height } : { width: height, height: width });
      const signal = new AbortController().signal;
      await input.cameraTransform(mocks.live.rawCameraStream, signal);
      expect(mocks.orient).toHaveBeenCalledExactlyOnceWith(mocks.live.rawCameraStream, rotation, signal, { width, height });
      expect(transport.setSource).toHaveBeenLastCalledWith(mocks.live.cameraStream, { source: 'camera', mirrored: true });
      expect(transport.setQuality).toHaveBeenLastCalledWith('4k', 24);
      await render(); expect(mocks.liveInputs.at(-1).cameraTransform).toBe(input.cameraTransform);
      expect(setItem).not.toHaveBeenCalled(); expect(mocks.controller.send).not.toHaveBeenCalled();
    });

  it('keeps the raw landscape track and rotation metadata when lowering preview output', async () => {
    storage.set(scopedStorageKey('exhibition-camera-quality:computer-east'), '4k');
    storage.set(scopedStorageKey('exhibition-camera-rotation:computer-east'), '270');
    mocks.live.rawCameraStream = { id: 'landscape-4k' };
    const transport = await mount(); const controls = await outputControls();
    const calls = transport.setSource.mock.calls.length;
    await act(async () => controls.quality().onChange({ target: { value: '1080p' } })); await flushReact();
    expect(transport.setQuality).toHaveBeenLastCalledWith('1080p', 30);
    expect(transport.setSource).toHaveBeenCalledTimes(calls);
    expect(transport.setSource).toHaveBeenLastCalledWith(mocks.live.rawCameraStream, { source: 'camera', mirrored: true, rotation: 270 });
  });

  it('restores per-mirror output preferences without writing them or altering capture quality', async () => {
    storage.set(scopedStorageKey('exhibition-display-settings:computer-east'), JSON.stringify({ quality: '2k', frameRate: 24 }));
    const transport = await mount(); const controls = await outputControls();
    expect(controls.quality().value).toBe('2k'); expect(controls.frameRate().value).toBe(24);
    expect(transport.setQuality).toHaveBeenLastCalledWith('2k', 24);
    expect(host!.find(node => node.getReactProps()['data-camera-quality'])!.getReactProps()['data-camera-quality']).toBe('1080p');
    expect(setItem).not.toHaveBeenCalled();
    await host!.close(); host = undefined;
    const west = await mount(false, { mirrorId: 'west' });
    expect(west.setQuality).toHaveBeenLastCalledWith('4k', 30);
  });

  it('reports failed output changes, preserves saved limits and applies them on explicit retry', async () => {
    const key = scopedStorageKey('exhibition-display-settings:computer-east');
    storage.set(key, JSON.stringify({ quality: '4k', frameRate: 30 }));
    const transport = await mount(); const controls = await outputControls();
    transport.setQuality.mockRejectedValueOnce(new Error('encoder failure'));
    await act(async () => controls.frameRate().onChange({ target: { value: '24' } })); await flushReact();
    expect(JSON.parse(storage.get(key)!)).toEqual({ quality: '4k', frameRate: 30 });
    expect(host!.find(node => node.getReactProps().role === 'alert')?.getReactProps().children[0]).toBe('输出设置未生效，请重试。');
    const retry = host!.find(node => node.nodeName === 'button' && node.getReactProps().children === '重试应用')!;
    await act(async () => retry.getReactProps().onClick()); await flushReact();
    expect(transport.setQuality).toHaveBeenLastCalledWith('4k', 24);
    expect(JSON.parse(storage.get(key)!)).toEqual({ quality: '4k', frameRate: 24 });
    expect(host!.find(node => node.getReactProps().role === 'alert')).toBeUndefined();
  });

  it('surfaces an output failure during later negotiation instead of losing it on normal display polls', async () => {
    const transport = await mount(); await outputControls();
    const session = { sessionId: 'host', token: 'ephemeral', terminalId: 'desktop-host' };
    await act(async () => transport.events.change({ session, status: 'connected', receiverOnline: true, error: '' })); await flushReact();
    await act(async () => {
      transport.events.qualityError('输出设置未生效，请重试。');
      transport.events.change({ session, status: 'connected', receiverOnline: true, error: '' });
    }); await flushReact();
    expect(host!.find(node => node.getReactProps().role === 'alert')).toBeDefined();
  });

  it('locks pending output controls and ignores a late result after leaving the page', async () => {
    const transport = await mount(); const controls = await outputControls();
    let resolve!: () => void;
    transport.setQuality.mockImplementationOnce(() => new Promise<void>(done => { resolve = done; }));
    await act(async () => controls.frameRate().onChange({ target: { value: '15' } })); await flushReact();
    expect(controls.frameRate().disabled).toBe(true);
    window.dispatchEvent(new Event('pagehide'));
    await act(async () => resolve()); await flushReact();
    expect(storage.has(scopedStorageKey('exhibition-display-settings:computer-east'))).toBe(false);
  });

  it('does not save or dismiss a failed setting when the display session disconnects', async () => {
    const key = scopedStorageKey('exhibition-display-settings:computer-east');
    storage.set(key, JSON.stringify({ quality: '4k', frameRate: 30 }));
    const transport = await mount(); const controls = await outputControls();
    transport.setQuality.mockRejectedValueOnce(new Error('encoder failure'));
    await act(async () => controls.quality().onChange({ target: { value: '2k' } })); await flushReact();
    await act(async () => transport.events.change({ session: null, status: 'error', receiverOnline: false, error: '连接中断' })); await flushReact();
    expect(JSON.parse(storage.get(key)!)).toEqual({ quality: '4k', frameRate: 30 });
    expect(host!.find(node => node.nodeName === 'button' && node.getReactProps().children === '重试应用')).toBeDefined();
  });

  const busy = { session: null, status: 'error', receiverOnline: false, error: '请先结束当前体验，再连接电脑。', errorCode: 'DISPLAY_MIRROR_BUSY' };
  const button = (label: string) => host!.find(node => node.nodeName === 'button' && node.getReactProps().children?.at?.(-1) === label)!;

  it.each(['android', 'browser'] as const)('stops only on request and waits for release before connecting the %s output', async output => {
    mocks.openState = busy;
    mocks.controller.state = { ...mocks.controller.state, phase: 'showcase', live: { deviceId: 'android-device' } };
    let finishStop!: (value: boolean) => void;
    mocks.controller.stopExperience.mockImplementation(() => new Promise<boolean>(resolve => { finishStop = resolve; }));
    const first = await mount(false, { output });
    expect(mocks.controller.stopExperience).not.toHaveBeenCalled();
    expect(mocks.liveInputs.at(-1).active).toBe(false);
    const click = button('停止并连接').getReactProps().onClick;
    await act(async () => { click(); click(); });
    expect(mocks.controller.stopExperience).toHaveBeenCalledOnce();
    expect(button('正在停止…').getReactProps().disabled).toBe(true);
    expect(mocks.transports).toHaveLength(1);
    mocks.openState = { session: null, status: 'releasing', receiverOnline: false, error: '' };
    await act(async () => finishStop(true)); await flushReact();
    const next = mocks.transports.at(-1);
    expect(first.close).toHaveBeenCalledOnce();
    expect(next.start).toHaveBeenCalledWith({ waitForRelease: true, replaceHost: true });
    expect(button('正在连接…').getReactProps().disabled).toBe(true);
    expect(mocks.kiosk.canControl).toBe(false);
    expect(mocks.liveInputs.at(-1).active).toBe(false);
    mocks.controller.state = { ...mocks.controller.state, phase: 'select', live: null };
    await act(async () => next.events.change({ session: { sessionId: 'new-host', token: 'token', terminalId: 'desktop-new' }, status: 'connected', receiverOnline: true, error: '' }));
    await render();
    expect(mocks.kiosk.canControl).toBe(true);
    expect(mocks.controller.send).not.toHaveBeenCalled();
  });

  it.each(['rejected', 'unconfirmed'] as const)('keeps a %s stop retryable without opening another connection', async failure => {
    mocks.openState = busy;
    if (failure === 'rejected') mocks.controller.stopExperience.mockRejectedValue(new Error('network'));
    else mocks.controller.stopExperience.mockResolvedValue(false);
    await mount();
    await act(async () => button('停止并连接').getReactProps().onClick()); await flushReact();
    expect(mocks.transports).toHaveLength(1);
    expect(button('停止并连接').getReactProps().disabled).toBe(false);
    expect(host!.find(node => node.getReactProps().role === 'alert')?.getReactProps().children[0].props.children).toBe('停止未完成，请重试。');
  });

  it.each(['pagehide', 'unmount', 'mirror-change'] as const)('ignores a late stop result after %s', async exit => {
    mocks.openState = busy;
    let finishStop!: (value: boolean) => void;
    mocks.controller.stopExperience.mockImplementation(() => new Promise<boolean>(resolve => { finishStop = resolve; }));
    await mount();
    await act(async () => button('停止并连接').getReactProps().onClick());
    if (exit === 'pagehide') window.dispatchEvent(new Event('pagehide'));
    else if (exit === 'unmount') { await host!.close(); host = undefined; }
    else { sourceProps = { mirrorId: 'west' }; await render(); }
    const before = mocks.transports.length;
    await act(async () => finishStop(true)); await flushReact();
    expect(mocks.transports).toHaveLength(before);
    expect(mocks.transports.every(transport => transport.start.mock.calls.every(([options]: any[]) => !options.waitForRelease))).toBe(true);
  });

  it('retries an ordinary connection error without stopping any experience', async () => {
    mocks.openState = { ...busy, errorCode: 'NETWORK_UNAVAILABLE', error: '网络已断开。' };
    await mount();
    await act(async () => button('重新连接').getReactProps().onClick()); await flushReact();
    expect(mocks.transports).toHaveLength(2);
    expect(mocks.transports.at(-1).start).toHaveBeenCalledWith({ waitForRelease: false, replaceHost: false });
    expect(mocks.controller.stopExperience).not.toHaveBeenCalled();
  });

  it.each(['android', 'browser'] as const)('replaces a busy %s host only after the user clicks takeover', async output => {
    mocks.openState = { ...busy, errorCode: 'DISPLAY_HOST_BUSY', error: '此智能镜已有电脑连接。' };
    const old = await mount(false, { output });
    expect(old.start).toHaveBeenCalledWith({ waitForRelease: false, replaceHost: false });
    expect(mocks.liveInputs.at(-1).waitForCameraRelease).toBe(false);
    expect(mocks.controller.stopExperience).not.toHaveBeenCalled();
    await act(async () => button('接管连接').getReactProps().onClick()); await flushReact();
    expect(old.close).toHaveBeenCalledOnce();
    expect(mocks.transports.at(-1).start).toHaveBeenCalledWith({ waitForRelease: false, replaceHost: true });
    expect(mocks.liveInputs.at(-1).waitForCameraRelease).toBe(true);
    expect(mocks.controller.stopExperience).not.toHaveBeenCalled();
  });

  it('uses a local browser display without receiver readiness or Android disconnect handling', async () => {
    const transport = await mount(false, { output: 'browser' });
    expect(transport.output).toBe('browser'); expect(document.title).toBe('OpenBuy.AI · 网页大屏');
    expect(mocks.kiosk.canControl).toBe(true);
    await act(async () => {
      transport.events.change({ session: { sessionId: 'host', token: 'ephemeral', terminalId: 'desktop-host' }, status: 'connected', receiverOnline: false, error: '' });
      transport.events.receiverExpired();
    }); await flushReact();
    expect(mocks.kiosk.canControl).toBe(true); expect(mocks.liveInputs.at(-1).active).toBe(true);
    expect(mocks.live.stopGeneration).not.toHaveBeenCalled(); expect(mocks.controller.stopExperience).not.toHaveBeenCalled();
    expect(host!.find(node => node.getReactProps().role === 'status')?.getReactProps().children.at(-1)).toBe('网页大屏');
    expect(host!.find(node => node.getReactProps()['aria-label'] === '进入全屏')).toBeDefined();
    await qualitySelect();
    expect(host!.find(node => node.getReactProps()['aria-label'] === '发送到大屏')).toBeUndefined();
  });

  it('keeps camera preferences independent for two mirrors with browser and Android outputs', async () => {
    capture('camera-east'); await mount(false, { output: 'browser' });
    expect(readCameraPreference('computer-east')?.deviceId).toBe('camera-east');
    await host!.close(); host = undefined;
    capture('camera-west'); mocks.live.deviceId = 'screen-west';
    await mount(false, { mirrorId: 'west', output: 'android' });
    expect(mocks.liveInputs.at(-1).cameraPreferenceScope).toBe('computer-west');
    expect(readCameraPreference('computer-east')?.deviceId).toBe('camera-east');
    expect(readCameraPreference('computer-west')?.deviceId).toBe('camera-west');
    expect(mocks.controller.send).not.toHaveBeenCalled();
  });

  it('opens with the live page device ID and delegates only the returned ephemeral identity; never sends begin', async () => {
    const transport = await mount();
    expect(transport.mirrorId).toBe('east'); expect(transport.deviceId).toBe('screen-unique'); expect(transport.start).toHaveBeenCalledOnce();
    expect(mocks.liveInputs[0].active).toBe(false);
    expect(mocks.liveInputs.at(-1)).toMatchObject({ active: true, terminal: { terminalId: 'desktop-host', token: 'ephemeral' }, cameraSettingsOpen: false });
    expect(mocks.controller.send).not.toHaveBeenCalled(); expect(mocks.live.stopGeneration).not.toHaveBeenCalled();
    expect(transport.setSource).toHaveBeenLastCalledWith(mocks.live.cameraStream, { source: 'camera', mirrored: true });
    expect(mocks.kiosk.canControl).toBe(true);
  });

  it('does not open twice during the React StrictMode setup probe', async () => {
    await mount(true);
    expect(mocks.transports).toHaveLength(2);
    expect(mocks.transports[0].start).not.toHaveBeenCalled(); expect(mocks.transports[0].close).toHaveBeenCalledOnce();
    expect(mocks.transports[1].start).toHaveBeenCalledOnce();
    expect(mocks.controller.send).not.toHaveBeenCalled();
  });

  it('blocks a stale generating round on page entry and arms only after observing idle', async () => {
    mocks.controller.state.phase = 'generating';
    await mount();
    expect(mocks.liveInputs.every(input => input.cameraSettingsOpen)).toBe(true);
    expect(mocks.kiosk.canControl).toBe(false); expect(mocks.controller.send).not.toHaveBeenCalled();
    mocks.controller.state = { ...mocks.controller.state, phase: 'select' }; await render();
    expect(mocks.liveInputs.at(-1).cameraSettingsOpen).toBe(false); expect(mocks.kiosk.canControl).toBe(true);
    mocks.controller.state = { ...mocks.controller.state, phase: 'generating', revision: 3 }; await render();
    expect(mocks.liveInputs.at(-1).cameraSettingsOpen).toBe(false);
    expect(mocks.controller.send).not.toHaveBeenCalled();
  });

  it.each(['android', 'browser'] as const)('opens a released paused %s screen for explicit start with local video', async output => {
    mocks.controller.state.phase = 'paused'; mocks.live.outputStream = { id: 'stale-output' };
    const transport = await mount(false, { output });
    expect(mocks.kiosk.canControl).toBe(true);
    expect(mocks.liveInputs.at(-1).cameraSettingsOpen).toBe(false);
    expect(transport.setSource).toHaveBeenLastCalledWith(mocks.live.cameraStream, { source: 'camera', mirrored: true });
    expect(mocks.controller.send).not.toHaveBeenCalled();
  });

  it('waits for the previous paused session to release before arming a newly opened page', async () => {
    mocks.controller.state.phase = 'paused'; mocks.controller.state.live = { status: 'stopping' };
    await mount(false, { output: 'browser' });
    expect(mocks.kiosk.canControl).toBe(false);
    mocks.controller.state = { ...mocks.controller.state, live: null }; await render();
    expect(mocks.kiosk.canControl).toBe(true); expect(mocks.controller.send).not.toHaveBeenCalled();
  });

  it.each(['clothx', 'free'] as const)('keeps %s generated output aligned with the local mirror setting across camera/output switches', async mode => {
    mocks.controller.state.experienceMode = mode;
    const transport = await mount();
    expect(transport.setSource).toHaveBeenLastCalledWith(mocks.live.cameraStream, { source: 'camera', mirrored: true });
    mocks.controller.state = { ...mocks.controller.state, phase: 'generating' };
    mocks.live.outputStream = { id: 'output' }; await render();
    expect(transport.setSource).toHaveBeenLastCalledWith(mocks.live.outputStream, { source: 'output', mirrored: true });
    const generated = mocks.live.outputStream;
    mocks.live.mirrored = false; await render();
    expect(transport.setSource).toHaveBeenLastCalledWith(generated, { source: 'output', mirrored: false });
    mocks.controller.state = { ...mocks.controller.state, phase: 'idle' }; await render();
    expect(transport.setSource).toHaveBeenLastCalledWith(mocks.live.cameraStream, { source: 'camera', mirrored: false });
    mocks.live.mirrored = true; await render();
    expect(transport.setSource).toHaveBeenLastCalledWith(mocks.live.cameraStream, { source: 'camera', mirrored: true });
    mocks.controller.state = { ...mocks.controller.state, phase: 'showcase' }; await render();
    expect(transport.setSource).toHaveBeenLastCalledWith(generated, { source: 'output', mirrored: true });
    expect(transport.start).toHaveBeenCalledOnce(); expect(transport.close).not.toHaveBeenCalled();
    expect(mocks.live.stopGeneration).not.toHaveBeenCalled(); expect(mocks.controller.send).not.toHaveBeenCalled();
  });

  it.each([true, false])('keeps MoX input and generated output unmirrored despite camera mirror preference %s', async mirrored => {
    mocks.controller.state.experienceMode = 'mox';
    mocks.live.mirrored = mirrored;
    const transport = await mount();
    expect(transport.setSource).toHaveBeenLastCalledWith(null, { source: 'image', mirrored: false });
    mocks.controller.state = { ...mocks.controller.state, phase: 'generating' };
    mocks.live.outputStream = { id: 'output' }; mocks.live.presentation = { showInputImage: true }; await render();
    expect(transport.setSource).toHaveBeenLastCalledWith(null, { source: 'image', mirrored: false });
    mocks.live.presentation = { showInputImage: false }; await render();
    expect(transport.setSource).toHaveBeenLastCalledWith(mocks.live.outputStream, { source: 'output', mirrored: false });
    mocks.live.mirrored = !mirrored; await render();
    expect(transport.setSource).toHaveBeenLastCalledWith(mocks.live.outputStream, { source: 'output', mirrored: false });
    mocks.live.outputStream = null;
    mocks.controller.state = { ...mocks.controller.state, phase: 'idle' }; await render();
    expect(transport.setSource).toHaveBeenLastCalledWith(null, { source: 'image', mirrored: false });
  });

  it('stops both cloud and backend on receiver expiry and cannot resume a stale generating round', async () => {
    const transport = await mount(); mocks.controller.state = { ...mocks.controller.state, phase: 'generating', live: { deviceId: 'screen-unique' } }; await render();
    await act(async () => {
      transport.events.change({ session: { sessionId: 'host', token: 'ephemeral', terminalId: 'desktop-host' }, status: 'waiting', receiverOnline: false, error: '' });
      transport.events.receiverExpired();
    }); await flushReact();
    expect(mocks.live.stopGeneration).toHaveBeenCalledOnce(); expect(mocks.controller.stopExperience).toHaveBeenCalledOnce();
    expect(mocks.liveInputs.at(-1).cameraSettingsOpen).toBe(true); expect(mocks.kiosk.canControl).toBe(false);
    await act(async () => transport.events.change({ session: { sessionId: 'host', token: 'ephemeral', terminalId: 'desktop-host' }, status: 'connected', receiverOnline: true, error: '' })); await flushReact();
    expect(mocks.liveInputs.at(-1).cameraSettingsOpen).toBe(true);
    mocks.controller.state = { ...mocks.controller.state, phase: 'select', live: null }; await render();
    expect(mocks.liveInputs.at(-1).cameraSettingsOpen).toBe(false); expect(mocks.kiosk.canControl).toBe(true);
    expect(mocks.controller.send).not.toHaveBeenCalled();
  });

  it('deactivates the live owner and cleans up its generation when host authorization expires', async () => {
    const transport = await mount(); mocks.controller.state = { ...mocks.controller.state, phase: 'showcase', live: { deviceId: 'screen-unique' } }; await render();
    await act(async () => transport.events.change({ session: null, status: 'error', receiverOnline: false, error: 'expired' })); await flushReact();
    expect(mocks.liveInputs.at(-1).active).toBe(false); expect(mocks.liveInputs.at(-1).terminal).toBeUndefined();
    expect(mocks.live.stopGeneration).toHaveBeenCalledOnce(); expect(mocks.controller.stopExperience).toHaveBeenCalledOnce();
    expect(mocks.kiosk.canControl).toBe(false);
  });

  it('closes the transport on pagehide and unmount without issuing any generation command', async () => {
    const transport = await mount();
    window.dispatchEvent(new Event('pagehide')); expect(transport.close).toHaveBeenCalledOnce();
    await host!.close(); host = undefined;
    expect(transport.close).toHaveBeenCalledTimes(2); expect(mocks.controller.send).not.toHaveBeenCalled();
  });

  it('persists a successful exact device in the computer mirror scope and restores its constraints on reload', async () => {
    capture('insta360-device'); await mount();
    expect(readCameraPreference('computer-east')).toEqual({ deviceId: 'insta360-device', label: 'Insta360 Link', profile: 'screen' });
    expect(readCameraPreference('east')).toBeNull(); expect(readCameraPreference()).toBeNull(); expect(readCameraPreference('computer-west')).toBeNull();
    expect(setItem).toHaveBeenCalledOnce();
    await host!.close(); host = undefined;
    await mount();
    const scope = mocks.liveInputs.at(-1).cameraPreferenceScope;
    expect(scope).toBe('computer-east');
    expect(cameraCaptureConstraints(undefined, readCameraPreference(scope))).toEqual({ audio: false, video: {
      deviceId: { exact: 'insta360-device' }, width: { ideal: 1080 }, height: { ideal: 1920 }, frameRate: { ideal: 30, max: 30 },
    } });
  });

  it.each(['opening', 'error', 'ended', 'mismatch', 'missing-id'] as const)('does not replace the saved choice with a %s capture', async failure => {
    capture('insta360-device'); await mount();
    const next = capture('failed-device', 'Wrong camera');
    if (failure === 'opening') mocks.live.opening = true;
    if (failure === 'error') mocks.live.cameraError = 'permission denied';
    if (failure === 'ended') next.readyState = 'ended';
    if (failure === 'mismatch') mocks.live.selectedCameraId = 'requested-but-not-returned';
    if (failure === 'missing-id') next.getSettings = () => ({ deviceId: '' });
    await render();
    expect(readCameraPreference('computer-east')?.deviceId).toBe('insta360-device'); expect(setItem).toHaveBeenCalledOnce();
  });

  it('saves a completed switch only after the new camera finishes opening', async () => {
    capture('built-in', 'Mac camera'); await mount();
    capture('insta360-device'); mocks.live.opening = true; await render();
    expect(readCameraPreference('computer-east')?.deviceId).toBe('built-in');
    mocks.live.opening = false; await render();
    expect(readCameraPreference('computer-east')).toEqual({ deviceId: 'insta360-device', label: 'Insta360 Link', profile: 'screen' });
    expect(setItem).toHaveBeenCalledTimes(2);
  });

  it('ignores a late capture after pagehide and remains harmless when storage is unavailable', async () => {
    capture('insta360-device'); await mount();
    window.dispatchEvent(new Event('pagehide'));
    capture('late-device'); await render();
    expect(readCameraPreference('computer-east')?.deviceId).toBe('insta360-device'); expect(setItem).toHaveBeenCalledOnce();
    await host!.close(); host = undefined;
    setItem.mockImplementation(() => { throw new Error('storage unavailable'); });
    await mount();
    expect(mocks.kiosk.canControl).toBe(true); expect(mocks.controller.send).not.toHaveBeenCalled();
  });

  it('keeps default orientation direct and applies one stable shared transform after an explicit rotation', async () => {
    await mount(); expect(mocks.liveInputs.at(-1).cameraTransform).toBeUndefined(); expect(mocks.orient).not.toHaveBeenCalled();
    const select = await rotationSelect();
    expect(select().value).toBe(0); expect(select().disabled).toBe(false);
    await act(async () => select().onChange({ target: { value: '90' } })); await flushReact();
    const transform = mocks.liveInputs.at(-1).cameraTransform;
    expect(select().value).toBe(90); expect(typeof transform).toBe('function');
    expect(mocks.liveInputs.at(-1).cameraCaptureDimensions).toEqual({ width: 1920, height: 1080 });
    const raw = {} as MediaStream; const signal = new AbortController().signal;
    await transform(raw, signal); expect(mocks.orient).toHaveBeenCalledExactlyOnceWith(raw, 90, signal, { width: 1920, height: 1080 });
    await render(); expect(mocks.liveInputs.at(-1).cameraTransform).toBe(transform);
    expect(storage.get(scopedStorageKey('exhibition-camera-rotation:computer-east'))).toBe('90');
    expect(storage.has(scopedStorageKey('exhibition-camera-rotation:computer-west'))).toBe(false);
    expect(mocks.controller.send).not.toHaveBeenCalled();
    await act(async () => select().onChange({ target: { value: '0' } })); await flushReact();
    expect(mocks.liveInputs.at(-1).cameraTransform).toBeUndefined(); expect(mocks.liveInputs.at(-1).cameraCaptureDimensions).toBeUndefined();
  });

  it.each([90, 180, 270] as const)('restores the saved %d degree input transform in a new page instance', async rotation => {
    storage.set(scopedStorageKey('exhibition-camera-rotation:computer-east'), String(rotation));
    await mount();
    const select = await rotationSelect(); expect(select().value).toBe(rotation);
    const raw = {} as MediaStream; const signal = new AbortController().signal;
    await mocks.liveInputs.at(-1).cameraTransform(raw, signal);
    expect(mocks.orient).toHaveBeenCalledExactlyOnceWith(raw, rotation, signal, { width: 1920, height: 1080 });
    expect(mocks.liveInputs.at(-1).cameraCaptureDimensions).toEqual(rotation === 180 ? undefined : { width: 1920, height: 1080 });
    expect(mocks.controller.send).not.toHaveBeenCalled();
  });

  it.each(['generating', 'showcase', 'paused', 'positioning', 'live', 'opening', 'command'] as const)('locks direction while %s without writing a preference or starting anything', async busy => {
    await mount();
    if (['generating', 'showcase', 'paused', 'positioning'].includes(busy)) mocks.controller.state.phase = busy;
    if (busy === 'live') mocks.controller.state.live = { deviceId: 'screen-unique' };
    if (busy === 'opening') mocks.live.opening = true;
    if (busy === 'command') mocks.controller.pending = true;
    await render(); const select = await rotationSelect();
    expect(select().disabled).toBe(true);
    await act(async () => select().onChange({ target: { value: '270' } })); await flushReact();
    expect(select().value).toBe(0); expect(mocks.liveInputs.at(-1).cameraTransform).toBeUndefined();
    expect(storage.has(scopedStorageKey('exhibition-camera-rotation:computer-east'))).toBe(false);
    expect(mocks.controller.send).not.toHaveBeenCalled();
  });

  it('uses the rotated camera for Kiosk and LAN while saving the original camera identity', async () => {
    capture('insta360-device'); mocks.live.rawCameraStream = mocks.live.cameraStream;
    const rotated = { getVideoTracks: () => [{ readyState: 'live', getSettings: () => ({ width: 1080, height: 1920 }) }] };
    mocks.live.cameraStream = rotated;
    const transport = await mount();
    expect(mocks.kiosk.live.cameraStream).toBe(rotated);
    expect(transport.setSource).toHaveBeenLastCalledWith(rotated, { source: 'camera', mirrored: true });
    expect(readCameraPreference('computer-east')?.deviceId).toBe('insta360-device');
  });

  it('keeps capture quality independent of the output limit without changing camera or direction', async () => {
    storage.set(scopedStorageKey('exhibition-camera-rotation:computer-east'), '270');
    capture('insta360-device'); const transport = await mount(); const select = await qualitySelect();
    const priorTransform = mocks.liveInputs.at(-1).cameraTransform;
    expect(select().value).toBe('1080p'); expect(select().disabled).toBe(false);
    expect(transport.setQuality).toHaveBeenLastCalledWith('4k', 30);
    await act(async () => select().onChange({ target: { value: '4k' } })); await flushReact();
    const input = mocks.liveInputs.at(-1);
    expect(input.cameraCaptureDimensions).toEqual({ width: 3840, height: 2160 });
    expect(input.cameraTransform).not.toBe(priorTransform);
    const raw = {} as MediaStream; const signal = new AbortController().signal;
    await input.cameraTransform(raw, signal);
    expect(mocks.orient).toHaveBeenCalledExactlyOnceWith(raw, 270, signal, { width: 3840, height: 2160 });
    expect(transport.setQuality).toHaveBeenLastCalledWith('4k', 30);
    expect(storage.get(scopedStorageKey('exhibition-camera-quality:computer-east'))).toBe('4k');
    expect(storage.has(scopedStorageKey('exhibition-camera-quality:computer-west'))).toBe(false);
    expect(storage.get(scopedStorageKey('exhibition-camera-rotation:computer-east'))).toBe('270');
    expect(readCameraPreference('computer-east')?.deviceId).toBe('insta360-device');
    await render(); expect(mocks.liveInputs.at(-1).cameraTransform).toBe(input.cameraTransform);
    expect(mocks.transports).toHaveLength(1); expect(mocks.controller.send).not.toHaveBeenCalled();
    await act(async () => select().onChange({ target: { value: '1080p' } })); await flushReact();
    expect(mocks.liveInputs.at(-1).cameraCaptureDimensions).toEqual({ width: 1920, height: 1080 });
    expect(transport.setQuality).toHaveBeenLastCalledWith('4k', 30);
  });

  it.each([0, 90, 180, 270] as const)('restores scoped 4K at %d degrees and requests the native landscape capture', async rotation => {
    storage.set(scopedStorageKey('exhibition-camera-quality:computer-east'), '4k');
    storage.set(scopedStorageKey('exhibition-camera-rotation:computer-east'), String(rotation));
    const transport = await mount(); const select = await qualitySelect();
    expect(select().value).toBe('4k'); expect(transport.setQuality).toHaveBeenLastCalledWith('4k', 30);
    const input = mocks.liveInputs.at(-1);
    expect(input.cameraCaptureDimensions).toEqual({ width: 3840, height: 2160 });
    if (rotation === 0) expect(input.cameraTransform).toBeUndefined();
    else {
      const raw = {} as MediaStream; const signal = new AbortController().signal;
      await input.cameraTransform(raw, signal);
      expect(mocks.orient).toHaveBeenCalledWith(raw, rotation, signal, { width: 3840, height: 2160 });
    }
    expect(mocks.controller.send).not.toHaveBeenCalled();
  });

  it.each(['generating', 'showcase', 'paused', 'positioning', 'live', 'opening', 'command', 'stopping'] as const)('locks quality while %s without persisting or starting generation', async busy => {
    await mount();
    if (['generating', 'showcase', 'paused', 'positioning'].includes(busy)) mocks.controller.state.phase = busy;
    if (busy === 'live') mocks.controller.state.live = { deviceId: 'screen-unique' };
    if (busy === 'opening') mocks.live.opening = true;
    if (busy === 'command') mocks.controller.pending = true;
    if (busy === 'stopping') mocks.controller.stopPending = true;
    await render(); const select = await qualitySelect(); expect(select().disabled).toBe(true);
    await act(async () => select().onChange({ target: { value: '4k' } })); await flushReact();
    expect(select().value).toBe('1080p');
    expect(storage.has(scopedStorageKey('exhibition-camera-quality:computer-east'))).toBe(false);
    expect(mocks.controller.send).not.toHaveBeenCalled();
  });

  it('shows actual outbound dimensions even when the selected 4K camera supplies a smaller stream', async () => {
    storage.set(scopedStorageKey('exhibition-camera-quality:computer-east'), '4k');
    const transport = await mount(); await qualitySelect();
    await act(async () => transport.events.stats({ width: 1280, height: 720, framesPerSecond: 29.76, bitrate: 4_000_000, codec: 'video/H264' })); await flushReact();
    const status = host!.find(node => node.getReactProps()['aria-label'] === '发送到大屏')!;
    expect(status.getReactProps().children.join('')).toBe('发送到大屏 · 摄像头画面 1280 × 720 · 29.8 fps');
    expect(host!.find(node => node.getReactProps()['data-camera-quality'])!.getReactProps()).toMatchObject({ 'data-camera-quality': '4k', 'data-display-width': 1280, 'data-display-height': 720 });
  });

  it('identifies generated video sent to the display and hides video statistics for a still image', async () => {
    const transport = await mount(); await qualitySelect();
    mocks.controller.state = { ...mocks.controller.state, phase: 'generating' }; mocks.live.outputStream = { id: 'output' }; await render();
    await act(async () => transport.events.stats({ width: 832, height: 1504, framesPerSecond: 24, bitrate: 2_000_000, codec: 'video/H264' })); await flushReact();
    const text = () => host!.find(node => node.getReactProps()['aria-label'] === '发送到大屏')!.getReactProps().children.join('');
    expect(text()).toBe('发送到大屏 · 生成画面 832 × 1504 · 24.0 fps');
    mocks.controller.state = { ...mocks.controller.state, experienceMode: 'mox' }; mocks.live.presentation = { showInputImage: true }; await render();
    expect(text()).toBe('发送到大屏 · 素材画面 —');
  });

  it.each([90, 270] as const)('sends the borrowed landscape raw camera with %d-degree display metadata only for 4K camera preview', async rotation => {
    storage.set(scopedStorageKey('exhibition-camera-quality:computer-east'), '4k');
    storage.set(scopedStorageKey('exhibition-camera-rotation:computer-east'), String(rotation));
    capture('insta360-device'); const raw = mocks.live.cameraStream; mocks.live.rawCameraStream = raw;
    const rotated = { id: 'rotated-portrait-4k' }; mocks.live.cameraStream = rotated;
    const transport = await mount();
    expect(transport.setSource).toHaveBeenLastCalledWith(raw, { source: 'camera', mirrored: true, rotation });
    expect(mocks.kiosk.live.cameraStream).toBe(rotated);
    expect(readCameraPreference('computer-east')?.deviceId).toBe('insta360-device');
    mocks.controller.state = { ...mocks.controller.state, phase: 'generating' };
    mocks.live.outputStream = { id: 'output' }; await render();
    expect(transport.setSource).toHaveBeenLastCalledWith(mocks.live.outputStream, { source: 'output', mirrored: true });
    mocks.controller.state = { ...mocks.controller.state, phase: 'idle' }; await render();
    expect(transport.setSource).toHaveBeenLastCalledWith(raw, { source: 'camera', mirrored: true, rotation });
    const select = await qualitySelect();
    await act(async () => select().onChange({ target: { value: '1080p' } })); await flushReact();
    expect(transport.setSource).toHaveBeenLastCalledWith(rotated, { source: 'camera', mirrored: true });
  });

  it('waits for a raw 4K camera instead of sending an undecodable rotated portrait stream', async () => {
    storage.set(scopedStorageKey('exhibition-camera-quality:computer-east'), '4k');
    storage.set(scopedStorageKey('exhibition-camera-rotation:computer-east'), '270');
    const transport = await mount();
    expect(transport.setSource).toHaveBeenLastCalledWith(null, { source: 'camera', mirrored: true, rotation: 270 });
  });

  it('ignores unsupported saved and requested quality values', async () => {
    storage.set(scopedStorageKey('exhibition-camera-quality:computer-east'), '8k');
    const transport = await mount(); const select = await qualitySelect();
    expect(select().value).toBe('1080p');
    await act(async () => select().onChange({ target: { value: '8k' } })); await flushReact();
    expect(select().value).toBe('1080p'); expect(transport.setQuality).toHaveBeenLastCalledWith('1080p', 30);
    expect(setItem).not.toHaveBeenCalled();
  });
});
