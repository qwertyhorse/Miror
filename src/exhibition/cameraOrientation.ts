export type ExhibitionCameraRotation = 0 | 90 | 180 | 270;
export interface ExhibitionCameraTransform { stream: MediaStream; dispose(): void }
type CameraDimensions = { width: number; height: number };

const FRAME_INTERVAL_MS = 1000 / 30;
const FIRST_FRAME_TIMEOUT_MS = 8000;

function frameBudget() {
  // Accumulate elapsed time instead of moving the deadline after each callback.
  // An 8 ms reserve absorbs ordinary scheduling jitter without saving extra frames.
  const capacity = FRAME_INTERVAL_MS + 8;
  let credit = capacity;
  let previous: number | undefined;
  return (now: number) => {
    if (previous !== undefined) credit = Math.min(capacity, credit + Math.max(0, now - previous));
    previous = Math.max(now, previous ?? now);
    if (credit + 0.001 < FRAME_INTERVAL_MS) return false;
    credit = Math.max(0, credit - FRAME_INTERVAL_MS);
    return true;
  };
}

function drawRotatedFrame(
  canvas: HTMLCanvasElement | OffscreenCanvas,
  context: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  input: CanvasImageSource,
  width: number,
  height: number,
  rotation: ExhibitionCameraRotation,
  maximumDimensions: CameraDimensions,
) {
  const swapped = rotation === 90 || rotation === 270;
  const rotatedWidth = swapped ? height : width;
  const rotatedHeight = swapped ? width : height;
  const scale = Math.min(1, maximumDimensions.width / Math.max(rotatedWidth, rotatedHeight), maximumDimensions.height / Math.min(rotatedWidth, rotatedHeight));
  const outWidth = Math.max(2, Math.floor(rotatedWidth * scale / 2) * 2);
  const outHeight = Math.max(2, Math.floor(rotatedHeight * scale / 2) * 2);
  if (canvas.width !== outWidth || canvas.height !== outHeight) {
    canvas.width = outWidth; canvas.height = outHeight;
  }
  const sx = outWidth / rotatedWidth; const sy = outHeight / rotatedHeight;
  if (rotation === 0) context.setTransform(sx, 0, 0, sy, 0, 0);
  else if (rotation === 90) context.setTransform(0, sy, -sx, 0, outWidth, 0);
  else if (rotation === 180) context.setTransform(-sx, 0, 0, -sy, outWidth, outHeight);
  else context.setTransform(0, -sy, sx, 0, 0, outHeight);
  context.drawImage(input, 0, 0, width, height);
}

interface TrackFrameAPIs {
  MediaStreamTrackProcessor?: new (options: { track: MediaStreamTrack; maxBufferSize: number }) => { readable: ReadableStream<VideoFrame> };
  MediaStreamTrackGenerator?: new (options: { kind: 'video' }) => MediaStreamTrack & { writable: WritableStream<VideoFrame> };
}

function orientTrackFrames(
  sourceTrack: MediaStreamTrack,
  rotation: ExhibitionCameraRotation,
  signal: AbortSignal,
  maximumDimensions: CameraDimensions,
  Processor: NonNullable<TrackFrameAPIs['MediaStreamTrackProcessor']>,
  Generator: NonNullable<TrackFrameAPIs['MediaStreamTrackGenerator']>,
): Promise<ExhibitionCameraTransform> {
  return new Promise((resolve, reject) => {
    let disposed = false;
    let settled = false;
    let canvas: OffscreenCanvas | undefined;
    let outputTrack: MediaStreamTrack | undefined;
    let reader: ReadableStreamDefaultReader<VideoFrame> | undefined;
    let writer: WritableStreamDefaultWriter<VideoFrame> | undefined;
    let pendingFrame: VideoFrame | undefined;
    const mayDraw = frameBudget();

    const dispose = (notifyEnded = false) => {
      if (disposed) return;
      disposed = true; clearTimeout(timeout);
      signal.removeEventListener('abort', aborted);
      sourceTrack.removeEventListener('ended', sourceEnded);
      canvas?.removeEventListener('contextlost', failed);
      // Cancel detaches the processor sink; the borrowed source track stays live.
      const retiredReader = reader; const retiredWriter = writer;
      if (retiredReader) void retiredReader.cancel().catch(() => {}).then(() => { try { retiredReader.releaseLock(); } catch { /* Already released. */ } });
      pendingFrame?.close(); pendingFrame = undefined;
      outputTrack?.stop();
      if (notifyEnded) outputTrack?.dispatchEvent(new Event('ended'));
      if (retiredWriter) void retiredWriter.abort().catch(() => {}).then(() => { try { retiredWriter.releaseLock(); } catch { /* Write still settling. */ } });
      if (canvas) { canvas.width = 0; canvas.height = 0; }
    };
    const fail = (error: Error, notifyEnded = true) => {
      if (disposed) return;
      if (!settled) { settled = true; reject(error); }
      dispose(notifyEnded);
    };
    const aborted = () => fail(new DOMException('摄像头方向调整已取消。', 'AbortError'), false);
    const sourceEnded = () => fail(new Error('摄像头已断开，请重新开启。'));
    const failed = () => fail(new Error('摄像头方向调整失败，请重新开启。'));
    const timeout = setTimeout(() => fail(new Error('等待摄像头画面超时，请重新开启。')), FIRST_FRAME_TIMEOUT_MS);
    signal.addEventListener('abort', aborted, { once: true });
    sourceTrack.addEventListener('ended', sourceEnded, { once: true });
    try {
      canvas = new OffscreenCanvas(2, 2);
      const context = canvas.getContext('2d', { alpha: false, desynchronized: true });
      if (!context) throw new Error('Canvas unavailable');
      canvas.addEventListener('contextlost', failed);
      reader = new Processor({ track: sourceTrack, maxBufferSize: 1 }).readable.getReader();
      const generator = new Generator({ kind: 'video' });
      outputTrack = generator; writer = generator.writable.getWriter();
      const stream = new MediaStream([generator]);
      const activeReader = reader; const activeWriter = writer; const activeCanvas = canvas;
      const pump = async () => {
        while (!disposed) {
          const { value: frame, done } = await activeReader.read();
          if (done) { if (!disposed) sourceEnded(); return; }
          let transformed: VideoFrame;
          try {
            if (disposed) return;
            if (frame.displayWidth <= 0 || frame.displayHeight <= 0 || !mayDraw(frame.timestamp / 1000)) continue;
            drawRotatedFrame(activeCanvas, context, frame, frame.displayWidth, frame.displayHeight, rotation, maximumDimensions);
            transformed = new VideoFrame(activeCanvas, { timestamp: frame.timestamp });
          } finally { frame.close(); }
          if (disposed) { transformed.close(); return; }
          pendingFrame = transformed;
          try {
            // Release the camera frame before waiting on the single pending output write.
            await activeWriter.write(transformed);
          } finally {
            if (pendingFrame === transformed) { pendingFrame = undefined; transformed.close(); }
          }
          if (disposed) return;
          if (!settled) {
            settled = true; clearTimeout(timeout);
            resolve({ stream, dispose: () => dispose() });
          }
        }
      };
      void pump().catch(failed);
    } catch { failed(); }
  });
}

/** Borrow the camera stream. Only the canvas output and auxiliary elements belong to this result. */
export async function orientExhibitionCamera(
  source: MediaStream,
  rotation: ExhibitionCameraRotation,
  signal: AbortSignal,
  maximumDimensions?: CameraDimensions,
): Promise<ExhibitionCameraTransform> {
  if (signal.aborted) throw new DOMException('摄像头方向调整已取消。', 'AbortError');
  if (![0, 90, 180, 270].includes(rotation)) throw new Error('摄像头画面方向无效。');
  const maximum = maximumDimensions ?? { width: 1920, height: 1080 };
  if (![maximum.width, maximum.height].every(size => Number.isSafeInteger(size) && size >= 2)) {
    throw new Error('摄像头画面尺寸无效。');
  }
  if (rotation === 0 && maximumDimensions === undefined) return { stream: source, dispose() {} };
  // Snapshot the chosen quality and apply it by long/short edge for either orientation.
  const dimensions = { width: Math.max(maximum.width, maximum.height), height: Math.min(maximum.width, maximum.height) };
  const sourceTrack = source.getVideoTracks().find(track => track.readyState === 'live');
  if (!sourceTrack) throw new Error('摄像头没有返回有效画面。');
  if (rotation === 0) {
    const { width, height } = sourceTrack.getSettings();
    if (typeof width === 'number' && typeof height === 'number' && width > 0 && height > 0
      && Math.max(width, height) <= dimensions.width && Math.min(width, height) <= dimensions.height) {
      return { stream: source, dispose() {} };
    }
  }
  const { MediaStreamTrackProcessor: Processor, MediaStreamTrackGenerator: Generator } = globalThis as typeof globalThis & TrackFrameAPIs;
  if (typeof Processor === 'function' && typeof Generator === 'function'
    && typeof OffscreenCanvas === 'function' && typeof VideoFrame === 'function') {
    return orientTrackFrames(sourceTrack, rotation, signal, dimensions, Processor, Generator);
  }
  const video = document.createElement('video');
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d', { alpha: false, desynchronized: true });
  if (!context || typeof canvas.captureStream !== 'function') throw new Error('当前浏览器不支持摄像头方向调整。');
  video.muted = true;
  video.playsInline = true;
  video.autoplay = true;

  return new Promise<ExhibitionCameraTransform>((resolve, reject) => {
    let output: MediaStream | undefined;
    let disposed = false;
    let settled = false;
    let frameId: number | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let firstFrameTimeout: ReturnType<typeof setTimeout> | undefined;
    const mayDraw = frameBudget();

    const dispose = (notifyEnded = false) => {
      if (disposed) return;
      disposed = true;
      if (frameId !== undefined) video.cancelVideoFrameCallback?.(frameId);
      clearTimeout(timer); clearTimeout(firstFrameTimeout);
      signal.removeEventListener('abort', aborted);
      sourceTrack.removeEventListener('ended', sourceEnded);
      video.removeEventListener('loadeddata', available);
      video.removeEventListener('canplay', available);
      video.removeEventListener('error', failed);
      canvas.removeEventListener('contextlost', failed);
      // Never stop source tracks: the camera owner may still be using or replacing them.
      output?.getTracks().forEach(track => {
        track.stop();
        // stop() itself emits no ended event. An unexpected input/render failure must still
        // notify consumers of the transformed track; explicit dispose/abort stays silent.
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
    const aborted = () => fail(new DOMException('摄像头方向调整已取消。', 'AbortError'), false);
    const sourceEnded = () => fail(new Error('摄像头已断开，请重新开启。'));
    const failed = () => fail(new Error('摄像头方向调整失败，请重新开启。'));

    const draw = (now: number) => {
      if (disposed || video.readyState < 2 || video.videoWidth <= 0 || video.videoHeight <= 0) return;
      if (!mayDraw(now)) return;
      try {
        const width = video.videoWidth; const height = video.videoHeight;
        drawRotatedFrame(canvas, context, video, width, height, rotation, dimensions);
        if (!output) {
          output = canvas.captureStream(30);
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
      if (typeof video.requestVideoFrameCallback === 'function') {
        frameId = video.requestVideoFrameCallback(now => {
          frameId = undefined; draw(now); schedule();
        });
      } else {
        timer = setTimeout(() => { timer = undefined; draw(performance.now()); schedule(); }, FRAME_INTERVAL_MS);
      }
    };
    const available = () => draw(performance.now());
    signal.addEventListener('abort', aborted, { once: true });
    sourceTrack.addEventListener('ended', sourceEnded, { once: true });
    video.addEventListener('loadeddata', available);
    video.addEventListener('canplay', available);
    video.addEventListener('error', failed);
    canvas.addEventListener('contextlost', failed);
    firstFrameTimeout = setTimeout(() => fail(new Error('等待摄像头画面超时，请重新开启。')), FIRST_FRAME_TIMEOUT_MS);
    try {
      video.srcObject = source;
      // Install cancellation before play(): a late play promise must never revive a retired stream.
      Promise.resolve(video.play()).then(available, failed);
      schedule();
    } catch { failed(); }
  });
}
