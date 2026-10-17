import { act, createElement, StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RealtimeVideoTrack, VideoContentMode } from '@xmaxai/web-sdk';
import { registerXmaxVideoStream, subscribeXmaxVideoBinding, xmaxVideoBinding } from '../src/exhibition/xmaxVideoBinding';
import { StreamVideo } from '../src/exhibition/LiveCameraPanel';
import { createReactHost, flushReact } from './support/reactHost';

const sdk = vi.hoisted(() => ({ construct: vi.fn() }));
vi.mock('@xmaxai/web-sdk', () => ({
  VideoContentMode: { fit: 'fit', fill: 'fill' },
  XmaxVideoView: class { constructor(options: unknown) { return sdk.construct(options); } },
}));

let host: Awaited<ReturnType<typeof createReactHost>>;
const registrations: (() => void)[] = [];
beforeEach(async () => {
  host = await createReactHost(); sdk.construct.mockReset();
  const createNode = document.createElement.bind(document);
  document.createElement = ((tag: string) => {
    const node = createNode(tag);
    if (tag === 'video') Object.assign(node, {
      play: vi.fn(async () => {}), pause: vi.fn(), srcObject: null,
      readyState: 2, videoWidth: 832, videoHeight: 1504,
    });
    return node;
  }) as typeof document.createElement;
});
afterEach(async () => {
  await act(async () => { registrations.splice(0).forEach(dispose => dispose()); });
  await host.close(); vi.unstubAllGlobals();
});
function source() {
  const native = { stop: vi.fn() };
  const stream = { getTracks: () => [native], getVideoTracks: () => [native] } as unknown as MediaStream;
  const track = { id: 'sdk-remote', mediaStreamTrack: native, stop: vi.fn() } as unknown as RealtimeVideoTrack;
  return { stream, track, native };
}
function view() {
  const element = document.createElement('div');
  const videoElement = document.createElement('video'); element.appendChild(videoElement);
  return {
    element, videoElement, track: undefined as RealtimeVideoTrack | undefined,
    videoContentMode: 'fill' as VideoContentMode, isInteractionEnabled: false, isMirrored: false,
    frameDisplayHandler: undefined as (() => void) | undefined,
    attach: vi.fn((container: HTMLElement) => { container.appendChild(element); }),
    detach: vi.fn(() => { element.parentNode?.removeChild(element); }),
  };
}
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (reason: Error) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function bind(f: ReturnType<typeof source>, factory = vi.fn(() => view())) {
  const unregister = registerXmaxVideoStream(f.stream, f.track, factory);
  registrations.push(unregister);
  return { unregister, factory, binding: xmaxVideoBinding(f.stream)! };
}
const options = () => ({ interactive: true, mirrored: false, onFirstFrame: vi.fn(), onPlayBlocked: vi.fn() });

describe('SDK video registry and element ownership', () => {
  it('loads the SDK only when a registered stream attaches to its real container', async () => {
    const f = source(); const rendered = view(); sdk.construct.mockReturnValue(rendered);
    registrations.push(registerXmaxVideoStream(f.stream, f.track));
    expect(sdk.construct).not.toHaveBeenCalled();
    const container = document.createElement('div'); document.body.appendChild(container);
    const callbacks = options(); const attached = xmaxVideoBinding(f.stream)!.attach(container, callbacks);
    await flushReact();
    expect(sdk.construct).toHaveBeenCalledExactlyOnceWith({ videoContentMode: 'fill', isInteractionEnabled: false });
    expect(rendered.attach).toHaveBeenCalledExactlyOnceWith(container);
    expect(rendered.element.parentNode).toBe(container); expect(rendered.track).toBe(f.track);
    expect(rendered.videoContentMode).toBe('fill'); expect(rendered.isInteractionEnabled).toBe(true);
    expect(rendered.element.style).toMatchObject({ width: '100%', height: '100%' });
    expect(callbacks.onFirstFrame).not.toHaveBeenCalled();
    rendered.frameDisplayHandler!(); rendered.frameDisplayHandler!();
    expect(callbacks.onFirstFrame).toHaveBeenCalledExactlyOnceWith(f.stream);
    attached.dispose(); attached.dispose();
    expect(rendered.track).toBeUndefined(); expect(rendered.frameDisplayHandler).toBeUndefined();
    expect(rendered.detach).toHaveBeenCalledOnce(); expect(f.native.stop).not.toHaveBeenCalled();
  });

  it('makes the real SDK video cover the stage without stretching or letterboxing', async () => {
    const actual = await vi.importActual<typeof import('@xmaxai/web-sdk')>('@xmaxai/web-sdk');
    const rendered = new actual.XmaxVideoView({ videoContentMode: actual.VideoContentMode.fit, isInteractionEnabled: false });
    // Supply DOM methods missing from the effect-test host; no media or network is started.
    Object.assign(rendered.videoElement, { getAttribute: () => null });
    Object.assign(rendered.element, { remove: () => rendered.element.parentNode?.removeChild(rendered.element) });
    const f = source(); f.track.mediaStreamTrack = undefined;
    registrations.push(registerXmaxVideoStream(f.stream, f.track, () => rendered));
    const attached = xmaxVideoBinding(f.stream)!.attach(document.body, options()); await flushReact();
    expect(rendered.element.parentNode).toBe(document.body);
    expect(rendered.videoContentMode).toBe(actual.VideoContentMode.fill);
    expect(rendered.videoElement.style.objectFit).toBe('cover');
    attached.dispose(); expect(f.native.stop).not.toHaveBeenCalled();
  });

  it.each(['detach', 'unregister'] as const)('ignores a late SDK factory result after %s', async action => {
    const f = source(); const ready = deferred<ReturnType<typeof view>>();
    const unregister = registerXmaxVideoStream(f.stream, f.track, () => ready.promise); registrations.push(unregister);
    const callbacks = options(); const attached = xmaxVideoBinding(f.stream)!.attach(document.body, callbacks);
    if (action === 'detach') attached.dispose(); else unregister();
    const rendered = view(); ready.resolve(rendered); await flushReact();
    expect(rendered.attach).not.toHaveBeenCalled(); expect(rendered.track).toBeUndefined();
    expect(rendered.detach).toHaveBeenCalledOnce(); expect(callbacks.onFirstFrame).not.toHaveBeenCalled();
    expect(callbacks.onPlayBlocked).not.toHaveBeenCalled(); expect(f.native.stop).not.toHaveBeenCalled();
  });

  it('updates native interaction and mirroring without replacing the track or view', async () => {
    const f = source(); const rendered = view(); const b = bind(f, vi.fn(() => rendered));
    const attached = b.binding.attach(document.body, options()); await flushReact();
    attached.update({ interactive: false, mirrored: true });
    expect(rendered.isInteractionEnabled).toBe(false); expect(rendered.isMirrored).toBe(true);
    expect(rendered.attach).toHaveBeenCalledOnce(); expect(rendered.track).toBe(f.track);
    await attached.play(); expect(rendered.videoElement.play).toHaveBeenCalledOnce();
    expect(f.native.stop).not.toHaveBeenCalled();
  });

  it('preserves initial mirroring when the SDK remote-track binding resets it', async () => {
    const f = source(); const rendered = view();
    let attachedTrack: RealtimeVideoTrack | undefined;
    Object.defineProperty(rendered, 'track', {
      get: () => attachedTrack,
      set: (track: RealtimeVideoTrack | undefined) => {
        attachedTrack = track;
        if (track) rendered.isMirrored = false;
      },
    });
    const b = bind(f, vi.fn(() => rendered));
    const attached = b.binding.attach(document.body, { ...options(), mirrored: true }); await flushReact();
    expect(rendered.track).toBe(f.track); expect(rendered.isMirrored).toBe(true);
    attached.dispose(); expect(f.native.stop).not.toHaveBeenCalled();
  });

  it('notifies subscribers and retires replaced registrations without letting stale cleanup remove the replacement', async () => {
    const f = source(); const listener = vi.fn(); const unsubscribe = subscribeXmaxVideoBinding(f.stream, listener);
    const rendered = view(); const first = bind(f, vi.fn(() => rendered));
    first.binding.attach(document.body, options()); await flushReact();
    const replacement = bind(f); first.unregister();
    expect(rendered.detach).toHaveBeenCalledOnce(); expect(xmaxVideoBinding(f.stream)).toBe(replacement.binding);
    replacement.unregister(); expect(xmaxVideoBinding(f.stream)).toBeUndefined();
    expect(listener).toHaveBeenCalled(); unsubscribe();
    const calls = listener.mock.calls.length; bind(f); expect(listener).toHaveBeenCalledTimes(calls);
    expect(f.native.stop).not.toHaveBeenCalled();
  });

  it('allows retry after a failed lazy import and ignores errors from retired attachments', async () => {
    const f = source(); const rendered = view();
    const factory = vi.fn().mockRejectedValueOnce(new Error('chunk unavailable')).mockResolvedValue(rendered);
    registrations.push(registerXmaxVideoStream(f.stream, f.track, factory));
    const callbacks = options(); const attached = xmaxVideoBinding(f.stream)!.attach(document.body, callbacks);
    await flushReact(); expect(callbacks.onPlayBlocked).toHaveBeenCalledOnce();
    await attached.play(); expect(rendered.track).toBe(f.track); expect(rendered.videoElement.play).toHaveBeenCalledOnce();
    const late = deferred<ReturnType<typeof view>>(); const other = source();
    registrations.push(registerXmaxVideoStream(other.stream, other.track, () => late.promise));
    const retired = xmaxVideoBinding(other.stream)!.attach(document.body, callbacks); retired.dispose();
    late.reject(new Error('retired')); await flushReact();
    expect(callbacks.onPlayBlocked).toHaveBeenCalledOnce();
  });
});

describe('StreamVideo SDK rendering', () => {
  it('keeps the ordinary video path and borrowed ownership for unregistered streams', async () => {
    const f = source(); const first = vi.fn();
    await host.render(createElement(StreamVideo, { stream: f.stream, mirrored: true, onFirstFrame: first }));
    const video = host.find(node => node.nodeName === 'video')! as unknown as HTMLVideoElement;
    expect(video.srcObject).toBe(f.stream); expect(video.style.transform).toBe('scaleX(-1)');
    video.dispatchEvent(new Event('loadeddata')); expect(first).toHaveBeenCalledExactlyOnceWith(f.stream);
    await host.render(null); expect(video.pause).toHaveBeenCalledOnce(); expect(video.srcObject).toBeNull();
    expect(sdk.construct).not.toHaveBeenCalled(); expect(f.native.stop).not.toHaveBeenCalled();
  });

  it('renders the registered SDK view visibly, toggles interaction in place and reports the newest first-frame callback', async () => {
    const f = source(); const rendered = view(); bind(f, vi.fn(() => rendered));
    const oldFrame = vi.fn(); const frame = vi.fn();
    await host.render(createElement(StreamVideo, { stream: f.stream, interactive: true, label: '生成画面', onFirstFrame: oldFrame }));
    await flushReact();
    const container = host.find(node => node.getReactProps().role === 'img')!;
    expect(container.getReactProps()['aria-label']).toBe('生成画面');
    expect(rendered.attach).toHaveBeenCalledExactlyOnceWith(container);
    await host.render(createElement(StreamVideo, { stream: f.stream, interactive: false, mirrored: true, onFirstFrame: frame }));
    expect(rendered.isInteractionEnabled).toBe(false); expect(rendered.isMirrored).toBe(true);
    expect(rendered.attach).toHaveBeenCalledOnce(); expect(rendered.detach).not.toHaveBeenCalled();
    rendered.frameDisplayHandler!(); expect(frame).toHaveBeenCalledExactlyOnceWith(f.stream); expect(oldFrame).not.toHaveBeenCalled();
    const stale = rendered.frameDisplayHandler;
    await host.render(null); stale!();
    expect(frame).toHaveBeenCalledOnce(); expect(rendered.detach).toHaveBeenCalledOnce(); expect(f.native.stop).not.toHaveBeenCalled();
  });

  it('adopts registration after mount and rejects the old stream callback after replacement', async () => {
    const first = source(); const next = source(); const report = vi.fn(); const firstView = view(); const nextView = view();
    await host.render(createElement(StreamVideo, { stream: first.stream, onFirstFrame: report }));
    await act(async () => { bind(first, vi.fn(() => firstView)); }); await flushReact();
    const stale = firstView.frameDisplayHandler;
    await act(async () => { bind(next, vi.fn(() => nextView)); });
    await host.render(createElement(StreamVideo, { stream: next.stream, onFirstFrame: report })); await flushReact();
    stale!(); expect(report).not.toHaveBeenCalled(); nextView.frameDisplayHandler!();
    expect(report).toHaveBeenCalledExactlyOnceWith(next.stream);
    expect(firstView.detach).toHaveBeenCalledOnce(); expect(first.native.stop).not.toHaveBeenCalled(); expect(next.native.stop).not.toHaveBeenCalled();
  });

  it('survives the StrictMode probe without attaching a retired asynchronous view', async () => {
    const f = source(); const views: ReturnType<typeof view>[] = [];
    bind(f, vi.fn(() => { const created = view(); views.push(created); return created; }));
    await host.render(createElement(StrictMode, null, createElement(StreamVideo, { stream: f.stream })));
    await flushReact();
    expect(views.filter(item => item.attach.mock.calls.length)).toHaveLength(1);
    await host.render(null);
    expect(views.every(item => item.track === undefined)).toBe(true); expect(f.native.stop).not.toHaveBeenCalled();
  });
});
