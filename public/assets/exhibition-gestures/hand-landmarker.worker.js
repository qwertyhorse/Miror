/* Local MediaPipe 0.10.32 classic worker. Camera pixels remain on this device. */
'use strict';

let detector = null;
let closing = false;
let initializing = false;
const controller = new AbortController();

self.onmessage = async ({ data }) => {
  if (data.type === 'close') {
    closing = true;
    controller.abort();
    detector?.close();
    detector = null;
    self.close();
    return;
  }
  if (closing) { data.bitmap?.close(); return; }
  if (data.type === 'init') {
    if (detector || initializing) return;
    initializing = true;
    try {
      // This package release uses importScripts for its WASM loader, so use a classic worker.
      // Its original CommonJS bundle needs only an exports object; it has no require() calls.
      self.exports = {};
      importScripts(new URL('vision_bundle.js', self.location.href).href);
      const { FilesetResolver, HandLandmarker } = self.exports;
      const response = await fetch(new URL('hand_landmarker.task', self.location.href), { signal: controller.signal });
      if (!response.ok) throw new Error('Local hand model unavailable');
      const modelAssetBuffer = new Uint8Array(await response.arrayBuffer());
      if (closing) return;
      const vision = await FilesetResolver.forVisionTasks(new URL('../body-scan/wasm', self.location.href).href);
      const task = await HandLandmarker.createFromOptions(vision, {
        baseOptions: { modelAssetBuffer, delegate: 'CPU' },
        runningMode: 'VIDEO',
        numHands: 1,
        minHandDetectionConfidence: 0.5,
        minHandPresenceConfidence: 0.5,
        minTrackingConfidence: 0.5,
      });
      if (closing) { task.close(); return; }
      detector = task;
      self.postMessage({ type: 'ready' });
    } catch {
      if (!closing) self.postMessage({ type: 'error' });
    } finally {
      initializing = false;
    }
    return;
  }
  if (data.type !== 'detect') return;
  const { bitmap, timestamp, frameId } = data;
  try {
    if (!detector) throw new Error('Hand model not ready');
    const startedAt = performance.now();
    const result = detector.detectForVideo(bitmap, timestamp);
    self.postMessage({
      type: 'result', frameId, timestamp,
      landmarks: result.landmarks[0] || [],
      handedness: result.handedness[0]?.[0]?.categoryName,
      inferenceMs: performance.now() - startedAt,
    });
  } catch {
    self.postMessage({ type: 'error', frameId });
  } finally {
    bitmap?.close();
  }
};
