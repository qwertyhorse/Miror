import { act, createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ComputerSource } from '../src/exhibition/ComputerSource';
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
        session: { sessionId: 'host-east', token: 'ephemeral', terminalId: 'desktop-east' }, status: 'connected', receiverOnline: true, receiverSupportsPage: true, receiverSupportsPageAck: true, receiverRenderedPage: true, error: '',
      }));
      mocks.transports.push(this);
    }
  },
}));


class Track extends EventTarget {
  readyState = 'live';
  stop = vi.fn(() => { this.readyState = 'ended'; });
  cropTo = vi.fn(async (_target: unknown) => {});
  contentHint = '';
  applyConstraints = vi.fn(async (_constraints: unknown) => {});
  getSettings = vi.fn(() => ({ displaySurface: 'browser' }));
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
let host: Awaited<ReturnType<typeof createReactHost>> | undefined;
let track: Track;
let captured: MediaStream;
let picker: ReturnType<typeof vi.fn>;
let crop: ReturnType<typeof vi.fn>;
const props = { mirrorId: 'east', output: 'android' as const, presentation: 'wireless' as const };
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


async function mount() {
  host = await createReactHost();
  track = new Track();
  captured = { getTracks: () => [track], getVideoTracks: () => [track] } as unknown as MediaStream;
  picker = vi.fn(async () => captured);
  crop = vi.fn(async () => 'kiosk-crop');
  vi.stubGlobal('navigator', { mediaDevices: { getDisplayMedia: picker } });
  Object.assign(window, { CropTarget: { fromElement: crop } });
  await render();
  return mocks.transports.at(-1);
}
async function render() { await host!.render(createElement(ComputerSource, props)); await flushReact(); }
function button(label: string) { return host!.find(node => node.nodeName === 'button' && (node.getReactProps()['aria-label'] ?? node.textContent) === label)?.getReactProps(); }
async function click(label: string) { await act(async () => button(label)!.onClick()); await flushReact(); }
async function state(transport: any, patch: any) { await act(async () => transport.events.change({ session: { sessionId: 'host-east', token: 'ephemeral', terminalId: 'desktop-east' }, status: 'connected', receiverOnline: true, receiverSupportsPage: true, receiverSupportsPageAck: true, receiverRenderedPage: true, error: '', ...patch })); await flushReact(); }

describe('wireless complete-page source', () => {
  it('waits for the Android rendered acknowledgement before reporting success or enabling start', async () => {
    const transport = await mount();
    await state(transport, { receiverRenderedPage: false });
    await click('共享试衣界面');
    expect(mocks.kiosk.canControl).toBe(false);
    expect(host!.find(node => node.textContent === '等待安卓显示画面…')).toBeDefined();
    expect(host!.find(node => node.textContent === '正在投屏')).toBeUndefined();
    await state(transport, { receiverRenderedPage: true });
    expect(mocks.kiosk.canControl).toBe(true);
    expect(host!.find(node => node.textContent === '正在投屏')).toBeDefined();
    await state(transport, { receiverRenderedPage: false });
    expect(mocks.kiosk.canControl).toBe(false);
    expect(mocks.controller.send).not.toHaveBeenCalled();
  });
  it('reports a backend outage even when the Android page has been received', async () => {
    await mount(); await click('共享试衣界面');
    mocks.controller.connected = false; await render();
    expect(host!.find(node => node.textContent === '后台连接中断，正在重连…')).toBeDefined();
    expect(mocks.kiosk.disabled).toBe(true);
    expect(track.stop).not.toHaveBeenCalled();
  });
  it('prepares camera but never transmits camera/output or starts generation on entry', async () => {
    const transport = await mount();
    expect(document.title).toBe('OpenBuy.AI · 无线投屏');
    expect(transport.output).toBe('android');
    expect(mocks.liveInputs.at(-1)).toMatchObject({ active: true, cameraSettingsOpen: false });
    expect(mocks.kiosk.canControl).toBe(false);
    expect(transport.setSource).toHaveBeenLastCalledWith(null, { source: 'page', mirrored: false });
    expect(transport.setQuality).toHaveBeenLastCalledWith('1080p', 30);
    expect(picker).not.toHaveBeenCalled();
    expect(mocks.controller.send).not.toHaveBeenCalled();
  });
  it('captures synchronously on click, crops before transport and preserves one session across selection and generation', async () => {
    const transport = await mount();
    const pending = deferred<void>(); track.cropTo.mockReturnValueOnce(pending.promise);
    await act(async () => { button('共享试衣界面')!.onClick(); expect(picker).toHaveBeenCalledOnce(); });
    expect(transport.setSource).toHaveBeenLastCalledWith(null, { source: 'page', mirrored: false });
    await act(async () => pending.resolve()); await flushReact();
    expect(crop).toHaveBeenCalledWith(expect.objectContaining({ nodeName: 'div' }));
    expect(track.cropTo).toHaveBeenCalledWith('kiosk-crop');
    expect(track.applyConstraints).toHaveBeenCalledWith({ frameRate: { min: 15, ideal: 30, max: 30 } });
    expect(track.contentHint).toBe('motion');
    expect(transport.setSource).toHaveBeenLastCalledWith(captured, { source: 'page', mirrored: false });
    expect(mocks.kiosk.canControl).toBe(true);
    mocks.controller.state = { ...mocks.controller.state, phase: 'showcase', live: { deviceId: 'computer-east' } };
    mocks.live.outputStream = { id: 'generation' }; await render();
    expect(transport.setSource).toHaveBeenLastCalledWith(captured, { source: 'page', mirrored: false });
    expect(mocks.transports).toHaveLength(1); expect(transport.start).toHaveBeenCalledOnce();
    expect(mocks.controller.send).not.toHaveBeenCalled();
  });
  it('keeps stale generating state blocked when page opens and sharing alone never starts it', async () => {
    mocks.controller.state.phase = 'generating'; await mount(); await click('共享试衣界面');
    expect(mocks.kiosk.canControl).toBe(false);
    expect(mocks.liveInputs.every(input => input.cameraSettingsOpen)).toBe(true);
    expect(mocks.controller.send).not.toHaveBeenCalled();
  });
  it('handles permission denial and lets user explicitly retry', async () => {
    await mount(); picker.mockRejectedValueOnce(new DOMException('Denied', 'NotAllowedError'));
    await click('共享试衣界面');
    expect(mocks.kiosk.canControl).toBe(false);
    expect(host!.find(node => node.textContent.includes('未开始共享'))).toBeDefined();
    await click('共享试衣界面'); expect(mocks.kiosk.canControl).toBe(true);
  });
  it('rejects a different tab without sending even its first frame', async () => {
    const transport = await mount(); track.cropTo.mockRejectedValueOnce(new Error('Not self capture'));
    await click('共享试衣界面'); expect(track.stop).toHaveBeenCalledOnce();
    expect(transport.setSource.mock.calls.every(([stream]: any[]) => stream === null)).toBe(true);
    expect(mocks.kiosk.canControl).toBe(false);
  });
  it('rejects an entire-screen capture and releases it', async () => {
    await mount(); track.getSettings.mockReturnValue({ displaySurface: 'monitor' });
    await click('共享试衣界面'); expect(track.stop).toHaveBeenCalledOnce(); expect(track.cropTo).not.toHaveBeenCalled();
  });
  it('stops both generation paths on browser stop even with an idle pending begin', async () => {
    const transport = await mount(); await click('共享试衣界面');
    mocks.controller.pending = true; await render();
    await act(async () => track.dispatchEvent(new Event('ended'))); await flushReact();
    expect(transport.setSource).toHaveBeenLastCalledWith(null, { source: 'page', mirrored: false });
    expect(mocks.live.stopGeneration).toHaveBeenCalledOnce(); expect(mocks.controller.stopExperience).toHaveBeenCalledOnce();
    expect(mocks.kiosk.canControl).toBe(false); expect(track.stop).toHaveBeenCalledOnce();
  });
  it('blocks another share until local AND backend stopping are confirmed', async () => {
    await mount(); await click('共享试衣界面'); mocks.live.stopGeneration.mockResolvedValueOnce(false);
    await click('停止投屏'); expect(button('共享试衣界面')).toBeUndefined(); expect(button('重试停止')).toBeDefined();
    expect(mocks.kiosk.canControl).toBe(false); await click('重试停止'); expect(button('共享试衣界面')).toBeDefined();
    expect(picker).toHaveBeenCalledOnce();
  });
  it('disconnects without resuming on reconnect; requires fresh share and start', async () => {
    const transport = await mount(); await click('共享试衣界面');
    await state(transport, { receiverOnline: false, receiverSupportsPage: false, status: 'waiting' });
    expect(track.stop).toHaveBeenCalledOnce(); expect(mocks.controller.stopExperience).toHaveBeenCalledOnce();
    await state(transport, {}); expect(mocks.kiosk.canControl).toBe(false); expect(picker).toHaveBeenCalledOnce();
    expect(mocks.transports).toHaveLength(1);
  });
  it('stops pending capture and ignores a late grant after disconnect', async () => {
    const transport = await mount(); const pending = deferred<MediaStream>(); picker.mockReturnValueOnce(pending.promise);
    await click('共享试衣界面'); await state(transport, { receiverOnline: false });
    await act(async () => pending.resolve(captured)); await flushReact();
    expect(track.stop).toHaveBeenCalledOnce(); expect(crop).not.toHaveBeenCalled();
    expect(transport.setSource.mock.calls.every(([stream]: any[]) => stream === null)).toBe(true);
  });
  it('releases a capture grant that arrives after unmount', async () => {
    await mount(); const pending = deferred<MediaStream>(); picker.mockReturnValueOnce(pending.promise);
    await click('共享试衣界面'); await host!.close(); host = undefined;
    await act(async () => pending.resolve(captured)); expect(track.stop).toHaveBeenCalledOnce();
  });
  it('allows capture while ICE connects but blocks generation until connected', async () => {
    const transport = await mount(); await state(transport, { status: 'connecting' });
    expect(button('共享试衣界面')!.disabled).toBe(false); await click('共享试衣界面');
    expect(track.stop).not.toHaveBeenCalled(); expect(mocks.kiosk.canControl).toBe(false);
    await state(transport, {}); expect(mocks.kiosk.canControl).toBe(true);
    await state(transport, { status: 'connecting' });
    expect(track.stop).not.toHaveBeenCalled(); // Encoder renegotiation is not a loss.
    await act(async () => transport.events.connectionLost()); await flushReact();
    expect(track.stop).toHaveBeenCalledOnce(); expect(mocks.controller.stopExperience).toHaveBeenCalledOnce();
  });
  it('still stops pending work when host lease disappears', async () => {
    const transport = await mount(); await click('共享试衣界面');
    await state(transport, { session: null, status: 'error' });
    expect(mocks.controller.stopExperience).toHaveBeenCalled(); expect(mocks.live.stopGeneration).toHaveBeenCalled();
    expect(mocks.kiosk.canControl).toBe(false);
  });
  it('reports unsupported browser without opening capture or starting', async () => {
    await mount(); Object.assign(window, { CropTarget: undefined }); await render();
    await click('共享试衣界面'); expect(picker).not.toHaveBeenCalled(); expect(mocks.kiosk.canControl).toBe(false);
    expect(host!.find(node => node.textContent.includes('请使用新版 Chrome'))).toBeDefined();
  });
  it('blocks old Android versions and offline receivers', async () => {
    const transport = await mount(); await state(transport, { receiverSupportsPage: false });
    expect(button('共享试衣界面')!.disabled).toBe(true); expect(mocks.kiosk.canControl).toBe(false);
    expect(host!.find(node => node.textContent.includes('请更新安卓 App'))).toBeDefined();
    await state(transport, { receiverSupportsPage: true, receiverSupportsPageAck: false });
    expect(button('共享试衣界面')!.disabled).toBe(true);
    expect(host!.find(node => node.textContent.includes('请更新安卓 App'))).toBeDefined();
    await state(transport, { receiverOnline: false }); expect(button('共享试衣界面')!.disabled).toBe(true);
  });
});
