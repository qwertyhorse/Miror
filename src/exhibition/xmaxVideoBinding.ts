import type { RealtimeVideoTrack, VideoContentMode } from '@xmaxai/web-sdk';

interface XmaxVideoViewHandle {
  element: HTMLElement;
  videoElement: HTMLVideoElement;
  track: RealtimeVideoTrack | undefined;
  videoContentMode: VideoContentMode;
  isInteractionEnabled: boolean;
  isMirrored: boolean;
  frameDisplayHandler?: () => void;
  attach(container: HTMLElement): void;
  detach(): void;
}
type XmaxVideoViewFactory = () => XmaxVideoViewHandle | Promise<XmaxVideoViewHandle>;
interface Presentation { interactive: boolean; mirrored: boolean }
interface AttachmentOptions extends Presentation {
  onFirstFrame(stream: MediaStream): void;
  onPlayBlocked(): void;
}
export interface XmaxVideoAttachment {
  update(presentation: Presentation): void;
  play(): Promise<void>;
  dispose(): void;
}
export interface XmaxVideoBinding {
  attach(container: HTMLElement, options: AttachmentOptions): XmaxVideoAttachment;
}
const registry = new WeakMap<MediaStream, XmaxVideoBinding>();
const retirements = new WeakMap<MediaStream, () => void>();
const listeners = new WeakMap<MediaStream, Set<() => void>>();
const createVideoView: XmaxVideoViewFactory = async () => {
  const sdk = await import('@xmaxai/web-sdk');
  return new sdk.XmaxVideoView({ videoContentMode: sdk.VideoContentMode.fill, isInteractionEnabled: false });
};

export function xmaxVideoBinding(stream: MediaStream | null): XmaxVideoBinding | undefined {
  return stream ? registry.get(stream) : undefined;
}

export function subscribeXmaxVideoBinding(stream: MediaStream | null, listener: () => void): () => void {
  if (!stream) return () => {};
  let subscriptions = listeners.get(stream);
  if (!subscriptions) { subscriptions = new Set(); listeners.set(stream, subscriptions); }
  subscriptions.add(listener);
  return () => { subscriptions.delete(listener); if (!subscriptions.size) listeners.delete(stream); };
}

/** Register SDK rendering without transferring ownership of either SDK or native tracks. */
export function registerXmaxVideoStream(stream: MediaStream, track: RealtimeVideoTrack,
  createView: XmaxVideoViewFactory = createVideoView): () => void {
  retirements.get(stream)?.();
  let registered = true;
  const attachments = new Set<() => void>();
  const binding: XmaxVideoBinding = {
    attach(container, options) {
      let disposed = false;
      let reported = false;
      let presentation: Presentation = options;
      let view: XmaxVideoViewHandle | undefined;
      let mounting: Promise<void> | undefined;
      const releaseView = (target: XmaxVideoViewHandle) => {
        target.frameDisplayHandler = undefined;
        target.isInteractionEnabled = false;
        try { target.track = undefined; } finally { target.detach(); }
      };
      const active = () => !disposed && registered && registry.get(stream) === binding;
      const applyPresentation = () => {
        if (!view) return;
        view.isInteractionEnabled = presentation.interactive;
        view.isMirrored = presentation.mirrored;
      };
      const mount = (): Promise<void> => {
        if (!active() || view) return Promise.resolve();
        if (mounting) return mounting;
        const pending = Promise.resolve().then(createView).then(created => {
          if (!active()) { releaseView(created); return; }
          view = created;
          try {
            // SDK fill uses aspect-preserving cover for video, interpolation and trajectory coordinates.
            view.videoContentMode = 'fill' as VideoContentMode;
            view.element.style.width = '100%'; view.element.style.height = '100%';
            applyPresentation();
            view.frameDisplayHandler = () => {
              if (!active() || reported) return;
              reported = true; options.onFirstFrame(stream);
            };
            // The real visible container participates in SDK warmup and frame presentation.
            view.attach(container);
            view.track = track;
            // Remote track attachment resets SDK mirroring to its default.
            applyPresentation();
          } catch (error) { view = undefined; releaseView(created); throw error; }
        });
        mounting = pending;
        void pending.catch(() => { if (active()) options.onPlayBlocked(); })
          .finally(() => { if (mounting === pending) mounting = undefined; });
        return pending;
      };
      const dispose = () => {
        if (disposed) return;
        disposed = true; attachments.delete(dispose);
        const previous = view; view = undefined;
        if (previous) releaseView(previous);
      };
      attachments.add(dispose);
      void mount().catch(() => {});
      return {
        update(next) { presentation = next; if (active()) applyPresentation(); },
        async play() { await mount(); if (active() && view) await view.videoElement.play(); },
        dispose,
      };
    },
  };
  const unregister = () => {
    if (!registered) return;
    registered = false;
    for (const dispose of [...attachments]) dispose();
    if (registry.get(stream) === binding) {
      registry.delete(stream);
      retirements.delete(stream);
      listeners.get(stream)?.forEach(listener => listener());
    }
  };
  registry.set(stream, binding);
  retirements.set(stream, unregister);
  listeners.get(stream)?.forEach(listener => listener());
  return unregister;
}
