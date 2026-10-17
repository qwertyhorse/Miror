import { act, createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ComputerSource } from '../src/exhibition/ComputerSource';
import { exhibitionHdmiUrl } from '../src/exhibition/computerDisplay';
import type { HdmiScreen, HdmiScreenDetails } from '../src/exhibition/useHdmiPresentation';
import { createReactHost, flushReact } from './support/reactHost';

const mocks = vi.hoisted(() => ({ controller: null as any, live: null as any, liveInputs: [] as any[], kiosk: null as any,
  transports: [] as any[], openState: null as any }));
vi.mock('../src/exhibition/useExhibition', () => ({ useExhibition: () => mocks.controller }));
vi.mock('../src/exhibition/useExhibitionLive', () => ({ useExhibitionLive: (input: any) => { mocks.liveInputs.push(input); return mocks.live; } }));
vi.mock('../src/exhibition/ExhibitionApp', () => ({ Kiosk: (props: any) => { mocks.kiosk = props; return null; } }));
vi.mock('../src/exhibition/LiveCameraPanel', () => ({ LiveCameraPanel: () => null }));
vi.mock('../src/exhibition/computerDisplay', async importOriginal => ({
  ...await importOriginal<typeof import('../src/exhibition/computerDisplay')>(),
  ComputerDisplaySender: class {
    events: any; start: any; close = vi.fn(); setSource = vi.fn(async () => {}); setQuality = vi.fn(async () => {});
    constructor(public mirrorId: string, public deviceId: string, events: any, _dependencies: unknown, public output: 'android' | 'browser') {
      this.events = events;
      this.start = vi.fn(async () => events.change(mocks.openState ?? {
        session: { sessionId: 'host-east', token: 'ephemeral', terminalId: 'desktop-east' }, status: 'connected', receiverOnline: true, error: '',
      }));
      mocks.transports.push(this);
    }
  },
}));

class TestScreen extends EventTarget implements HdmiScreen {
  constructor(public label: string, public width: number, public height: number, public isInternal: boolean, public isPrimary = isInternal) { super(); }
}
class TestDetails extends EventTarget implements HdmiScreenDetails {
  constructor(public screens: TestScreen[], public currentScreen: TestScreen) { super(); }
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

let host: Awaited<ReturnType<typeof createReactHost>> | undefined;
let props: { mirrorId: string; output: 'android' | 'browser'; presentation?: 'hdmi' };
let details: TestDetails;
let internal: TestScreen;
let external: TestScreen;
let getScreenDetails: ReturnType<typeof vi.fn>;
let fullscreen: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: vi.fn() });
  mocks.transports = []; mocks.liveInputs = []; mocks.kiosk = null; mocks.openState = null;
  mocks.controller = {
    state: { mirrorId: 'east', revision: 1, phase: 'idle', providerMode: 'xmax', experienceMode: 'clothx', live: null },
    connected: true, refresh: vi.fn(async () => {}), send: vi.fn(async () => true), stopExperience: vi.fn(async () => true),
    pending: false, selectionPending: false, stopPending: false,
  };
  mocks.live = {
    deviceId: 'computer-east', cameraStream: { id: 'local-camera' }, outputStream: null, presentation: null, mirrored: true,
    error: '', opening: false, cameraError: '', cameras: [], selectedCameraId: '', stopGeneration: vi.fn(async () => true),
  };
});
afterEach(async () => { await host?.close(); host = undefined; vi.unstubAllGlobals(); });

async function mount(options: Partial<typeof props> = {}) {
  host = await createReactHost();
  internal = new TestScreen('Mac 内置屏', 1440, 900, true);
  external = new TestScreen('HDMI 智能镜', 1080, 1920, false);
  details = new TestDetails([internal, external], internal);
  getScreenDetails = vi.fn(async () => details);
  Object.assign(window, { getScreenDetails });
  Object.defineProperty(document, 'fullscreenElement', { writable: true, configurable: true, value: null });
  fullscreen = vi.fn(async (options?: FullscreenOptions & { screen?: TestScreen }) => {
    details.currentScreen = options?.screen ?? details.currentScreen;
    Object.assign(document, { fullscreenElement: document.documentElement });
    document.dispatchEvent(new Event('fullscreenchange'));
  });
  Object.assign(document.documentElement, { requestFullscreen: fullscreen });
  props = { mirrorId: 'east', output: 'browser', presentation: 'hdmi', ...options };
  await render();
  return mocks.transports.at(-1);
}
async function render() { await host!.render(createElement(ComputerSource, props)); await flushReact(); }
function button(label: string) {
  return host!.find(node => node.nodeName === 'button' && node.textContent === label)!.getReactProps();
}
function screenButton() {
  return host!.find(node => node.nodeName === 'button' && node.getReactProps().className === 'ex-hdmi-screen'
    && node.textContent.includes(external.label))!.getReactProps();
}
async function click(label: string) { await act(async () => button(label).onClick()); await flushReact(); }
async function discoverAndSelect() {
  await click('选择显示器');
  await act(async () => screenButton().onClick()); await flushReact();
}
async function unplug() {
  await act(async () => {
    details.screens = [internal]; details.currentScreen = internal;
    Object.assign(document, { fullscreenElement: null });
    details.dispatchEvent(new Event('screenschange'));
    document.dispatchEvent(new Event('fullscreenchange'));
  });
  await flushReact();
}
async function replug() {
  external = new TestScreen('HDMI 智能镜', 1080, 1920, false);
  await act(async () => { details.screens = [internal, external]; details.dispatchEvent(new Event('screenschange')); });
  await flushReact();
}

describe('HDMI computer source integration', () => {
  it('prepares local camera preview while keeping start and gestures disabled until a screen is selected', async () => {
    const transport = await mount();
    expect(transport.output).toBe('browser');
    expect(document.title).toBe('OpenBuy.AI · HDMI 大屏');
    expect(mocks.liveInputs.at(-1)).toMatchObject({ active: true, cameraSettingsOpen: false, cameraPreferenceScope: 'computer-east',
      terminal: { terminalId: 'desktop-east', token: 'ephemeral' } });
    expect(mocks.kiosk.live.cameraStream).toBe(mocks.live.cameraStream);
    expect(mocks.kiosk.canControl).toBe(false); expect(mocks.kiosk.disabled).toBe(true);
    expect(mocks.controller.send).not.toHaveBeenCalled(); expect(mocks.live.stopGeneration).not.toHaveBeenCalled();
    expect(getScreenDetails).not.toHaveBeenCalled(); expect(fullscreen).not.toHaveBeenCalled();
  });

  it('blocks a stale generating round before selection and never starts it just by selecting a screen', async () => {
    mocks.controller.state.phase = 'generating';
    await mount();
    expect(mocks.liveInputs.every(input => input.cameraSettingsOpen)).toBe(true);
    await discoverAndSelect();
    expect(mocks.kiosk.canControl).toBe(false);
    expect(mocks.liveInputs.at(-1).cameraSettingsOpen).toBe(true);
    expect(mocks.controller.send).not.toHaveBeenCalled();
    expect(mocks.transports).toHaveLength(1);
  });

  it('selects synchronously and keeps transport, camera and active generation intact through selection and Escape', async () => {
    const transport = await mount();
    await click('选择显示器');
    await act(async () => {
      screenButton().onClick();
      expect(fullscreen).toHaveBeenCalledWith({ screen: external });
    }); await flushReact();
    expect(mocks.kiosk.canControl).toBe(true);
    expect(mocks.controller.send).not.toHaveBeenCalled();
    mocks.controller.state = { ...mocks.controller.state, phase: 'showcase', live: { deviceId: 'computer-east' } };
    mocks.live.outputStream = { id: 'cloud-output' }; await render();
    const camera = mocks.liveInputs.at(-1);
    await act(async () => {
      Object.assign(document, { fullscreenElement: null }); document.dispatchEvent(new Event('fullscreenchange'));
    }); await flushReact();
    expect(host!.find(node => node.nodeName === 'section' && node.getReactProps()['aria-label'] === 'HDMI 大屏')).toBeDefined();
    expect(mocks.kiosk.canControl).toBe(true);
    await act(async () => screenButton().onClick()); await flushReact();
    expect(mocks.transports).toEqual([transport]); expect(transport.start).toHaveBeenCalledOnce(); expect(transport.close).not.toHaveBeenCalled();
    expect(mocks.liveInputs.at(-1).terminal).toEqual(camera.terminal);
    expect(mocks.liveInputs.at(-1).cameraTransform).toBe(camera.cameraTransform);
    expect(mocks.liveInputs.at(-1).cameraSettingsOpen).toBe(false);
    expect(mocks.kiosk.live.outputStream).toBe(mocks.live.outputStream);
    expect(mocks.live.stopGeneration).not.toHaveBeenCalled(); expect(mocks.controller.stopExperience).not.toHaveBeenCalled();
  });

  it('stops both local and backend work on unplug even while idle with a pending start command', async () => {
    const transport = await mount(); await discoverAndSelect();
    mocks.controller.pending = true; await render();
    expect(mocks.controller.state.phase).toBe('idle'); expect(mocks.controller.state.live).toBeNull();
    await unplug();
    expect(mocks.live.stopGeneration).toHaveBeenCalledOnce(); expect(mocks.controller.stopExperience).toHaveBeenCalledOnce();
    expect(mocks.kiosk.canControl).toBe(false);
    mocks.controller.pending = false; await render(); await replug();
    expect(mocks.kiosk.canControl).toBe(false);
    await act(async () => screenButton().onClick()); await flushReact();
    expect(mocks.kiosk.canControl).toBe(true);
    expect(mocks.controller.send).not.toHaveBeenCalled();
    expect(mocks.transports).toEqual([transport]); expect(transport.close).not.toHaveBeenCalled();
  });

  it('waits for both stop confirmations, allows retry, and still requires explicit reselection after reconnect', async () => {
    const transport = await mount(); await discoverAndSelect();
    mocks.controller.state = { ...mocks.controller.state, phase: 'showcase', live: { deviceId: 'computer-east' } }; await render();
    const localStop = deferred<boolean>(); const backendStop = deferred<boolean>();
    mocks.live.stopGeneration.mockReturnValueOnce(localStop.promise);
    mocks.controller.stopExperience.mockReturnValueOnce(backendStop.promise);
    await unplug(); await replug();
    expect(screenButton().disabled).toBe(true); expect(mocks.kiosk.canControl).toBe(false);
    expect(mocks.liveInputs.at(-1).cameraSettingsOpen).toBe(true);
    await act(async () => {
      mocks.controller.state = { ...mocks.controller.state, phase: 'idle', live: null };
      backendStop.resolve(true);
    }); await flushReact();
    expect(screenButton().disabled).toBe(true);
    await act(async () => localStop.resolve(false)); await flushReact();
    expect(host!.find(node => node.getReactProps().role === 'alert')?.textContent).toContain('停止未完成');
    expect(screenButton().disabled).toBe(true);
    await click('重试停止');
    expect(mocks.live.stopGeneration).toHaveBeenCalledTimes(2); expect(mocks.controller.stopExperience).toHaveBeenCalledTimes(2);
    expect(screenButton().disabled).toBe(false); expect(mocks.kiosk.canControl).toBe(false);
    await act(async () => screenButton().onClick()); await flushReact();
    expect(mocks.kiosk.canControl).toBe(true);
    expect(mocks.controller.send).not.toHaveBeenCalled(); expect(mocks.transports).toEqual([transport]);
  });

  it('never stops another device when no computer host was granted', async () => {
    mocks.openState = { session: null, status: 'error', receiverOnline: false, error: '此智能镜正在体验。', errorCode: 'DISPLAY_MIRROR_BUSY' };
    mocks.controller.state = { ...mocks.controller.state, phase: 'showcase', live: { deviceId: 'another-device' } };
    const transport = await mount(); await discoverAndSelect(); await unplug();
    expect(mocks.liveInputs.at(-1).active).toBe(false); expect(mocks.kiosk.canControl).toBe(false);
    expect(mocks.live.stopGeneration).not.toHaveBeenCalled(); expect(mocks.controller.stopExperience).not.toHaveBeenCalled();
    expect(mocks.controller.send).not.toHaveBeenCalled(); expect(mocks.transports).toEqual([transport]);
  });

  it('ignores the HDMI presentation parameter for Android output', async () => {
    const transport = await mount({ output: 'android' });
    expect(transport.output).toBe('android'); expect(mocks.kiosk.canControl).toBe(true);
    expect(document.title).toBe('OpenBuy.AI · 电脑视频源');
    expect(host!.find(node => node.getReactProps()['aria-label'] === 'HDMI 大屏')).toBeUndefined();
    expect(host!.find(node => node.getReactProps()['aria-label'] === '选择显示器')).toBeUndefined();
    await unplug();
    expect(mocks.kiosk.canControl).toBe(true); expect(getScreenDetails).not.toHaveBeenCalled();
    expect(mocks.live.stopGeneration).not.toHaveBeenCalled(); expect(mocks.controller.stopExperience).not.toHaveBeenCalled();
  });
});

describe('HDMI entry URL', () => {
  it.each(['http://xuminghong.local:10601/', 'http://xuxin.local:10101/', 'http://192.168.1.8:10200/'])(
    'keeps the current server host and selects the HTTPS browser presentation from %s', href => {
      const target = new URL(exhibitionHdmiUrl('mirror/a', href));
      expect(target.hostname).toBe(new URL(href).hostname);
      expect(target.protocol).toBe('https:'); expect(target.port).toBe('10202');
      expect(target.pathname).toMatch(/\/exhibition\/computer$/);
      expect([...target.searchParams]).toEqual([['mirror', 'mirror/a'], ['output', 'browser'], ['presentation', 'hdmi']]);
    },
  );
});
