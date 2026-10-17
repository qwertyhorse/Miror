const preparedTracks = new WeakSet<MediaStreamTrack>();
const CAMERA_FRAME_RATE = 30;

/** Prepare only the session-owned clone; the camera preview keeps its native settings. */
export function prepareXmaxCameraStream(stream: MediaStream): MediaStream {
  for (const track of stream.getVideoTracks()) {
    if (preparedTracks.has(track)) continue;
    const nativeGetSettings = track.getSettings.bind(track);
    // Chromium generator tracks can report Infinity after applyConstraints(). ByteRTC
    // copies it over its finite encoder config into addTransceiver().maxFramerate.
    // Keep the native track and frame pipeline, and normalize only this SDK input.
    Object.defineProperty(track, 'getSettings', {
      configurable: true,
      writable: true,
      value: (): MediaTrackSettings => {
        const settings = nativeGetSettings();
        return Number.isFinite(settings.frameRate) && settings.frameRate! > 0
          ? settings
          : { ...settings, frameRate: CAMERA_FRAME_RATE };
      },
    });
    preparedTracks.add(track);
  }
  return stream;
}

function hasDimensionRange(range: ULongRange | undefined): boolean {
  return !!range && Number.isFinite(range.min) && Number.isFinite(range.max)
    && range.min! >= 0 && range.max! > 0 && range.max! >= range.min!;
}

export interface XmaxInputDimensions { width: number; height: number }

/** Borrow the source; own only the constraint-compatible canvas input used by XMAX. */
export async function prepareXmaxVideoInput(
  source: MediaStream,
  signal?: AbortSignal,
  resolveMaximumDimensions?: (decoded: XmaxInputDimensions) => XmaxInputDimensions,
): Promise<{ stream: MediaStream; dispose(): void }> {
  if (signal?.aborted) throw new DOMException('视频连接已取消。', 'AbortError');
  const sourceTrack = source.getVideoTracks().find(track => track.readyState === 'live');
  if (!sourceTrack) throw new Error('摄像头没有返回有效画面。');
  // Generator tracks lack width/height capabilities, so Agora cannot apply its
  // encoder constraints to them. Camera and canvas tracks already support these.
  const capabilities = sourceTrack.getCapabilities?.();
  if (!capabilities || (hasDimensionRange(capabilities.width) && hasDimensionRange(capabilities.height))) {
    return { stream: source, dispose() {} };
  }

  const video = document.createElement('video');
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d', { alpha: false, desynchronized: true });
  if (!context || typeof canvas.captureStream !== 'function') throw new Error('当前浏览器不支持视频连接。');
  video.muted = true;
  video.playsInline = true;
  video.autoplay = true;

  return new Promise((resolve, reject) => {
    let output: MediaStream | undefined;
    let disposed = false;
    let settled = false;
    let frameId: number | undefined;
    let frameTimer: ReturnType<typeof setTimeout> | undefined;
    let firstFrameTimeout: ReturnType<typeof setTimeout> | undefined;
    let maximumDimensions: XmaxInputDimensions | undefined;

    const dispose = (notifyEnded = false) => {
      if (disposed) return;
      disposed = true;
      if (frameId !== undefined) video.cancelVideoFrameCallback?.(frameId);
      clearTimeout(frameTimer); clearTimeout(firstFrameTimeout);
      signal?.removeEventListener('abort', aborted);
      sourceTrack.removeEventListener('ended', sourceEnded);
      video.removeEventListener('loadeddata', available);
      video.removeEventListener('canplay', available);
      video.removeEventListener('error', failed);
      canvas.removeEventListener('contextlost', failed);
      output?.getTracks().forEach(track => {
        track.stop();
        // stop() is silent; unexpected failures still need to reach SDK consumers.
        if (notifyEnded) track.dispatchEvent(new Event('ended'));
      });
      video.pause(); video.srcObject = null; video.removeAttribute('src'); video.load();
      canvas.width = 0; canvas.height = 0;
    };
    const fail = (error: Error, notifyEnded = true) => {
      if (disposed) return;
      if (!settled) { settled = true; reject(error); }
      dispose(notifyEnded);
    };
    const aborted = () => fail(new DOMException('视频连接已取消。', 'AbortError'), false);
    const sourceEnded = () => fail(new Error('摄像头已断开，请重新开启。'));
    const failed = () => fail(new Error('视频连接准备失败，请重试。'));
    const draw = () => {
      if (disposed) return;
      // stop() does not emit ended; never publish a decoder's cached frame after
      // the camera owner has retired the borrowed source.
      if (sourceTrack.readyState !== 'live') { sourceEnded(); return; }
      if (video.readyState < 2 || video.videoWidth <= 0 || video.videoHeight <= 0) return;
      try {
        const sourceWidth = video.videoWidth; const sourceHeight = video.videoHeight;
        // Resolve from actual decoded pixels: generator settings may omit dimensions.
        // Keep this connection's model bounds fixed, without resolving them per frame.
        if (!maximumDimensions && resolveMaximumDimensions) {
          const size = resolveMaximumDimensions({ width: sourceWidth, height: sourceHeight });
          if (![size.width, size.height].every(value => Number.isSafeInteger(value) && value >= 2)) {
            throw new Error('Invalid model input dimensions');
          }
          maximumDimensions = { ...size };
        }
        const scale = maximumDimensions ? Math.min(1, maximumDimensions.width / sourceWidth, maximumDimensions.height / sourceHeight) : 1;
        // Preserve the full frame and orientation; align bounded input to even pixels
        // just like the SDK uplink, and never enlarge low-resolution capture.
        const width = maximumDimensions ? Math.max(2, Math.floor(sourceWidth * scale / 2) * 2) : sourceWidth;
        const height = maximumDimensions ? Math.max(2, Math.floor(sourceHeight * scale / 2) * 2) : sourceHeight;
        if (canvas.width !== width || canvas.height !== height) {
          canvas.width = width; canvas.height = height;
        }
        context.drawImage(video, 0, 0, width, height);
        if (!output) {
          output = canvas.captureStream(CAMERA_FRAME_RATE);
          if (!output.getVideoTracks().some(track => track.readyState === 'live')) throw new Error('No canvas track');
        }
        if (!settled) {
          settled = true; clearTimeout(firstFrameTimeout);
          resolve({ stream: output, dispose: () => dispose() });
        }
      } catch { failed(); }
    };
    const schedule = () => {
      if (disposed) return;
      try {
        if (typeof video.requestVideoFrameCallback === 'function') {
          frameId = video.requestVideoFrameCallback(() => {
            frameId = undefined; draw(); schedule();
          });
        } else {
          frameTimer = setTimeout(() => {
            frameTimer = undefined; draw(); schedule();
          }, 1000 / CAMERA_FRAME_RATE);
        }
      } catch { failed(); }
    };
    const available = () => draw();
    signal?.addEventListener('abort', aborted, { once: true });
    sourceTrack.addEventListener('ended', sourceEnded, { once: true });
    video.addEventListener('loadeddata', available);
    video.addEventListener('canplay', available);
    video.addEventListener('error', failed);
    canvas.addEventListener('contextlost', failed);
    firstFrameTimeout = setTimeout(() => fail(new Error('等待摄像头画面超时，请重试。')), 8000);
    try {
      video.srcObject = source;
      Promise.resolve(video.play()).then(available, failed);
      schedule();
    } catch { failed(); }
  });
}
