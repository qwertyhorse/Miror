/* Local MediaPipe 0.10.32 classic worker. Reuses the camera; no video upload here. */
'use strict';

let detector = null;
let handDetector = null;
let closing = false;
let initializing = false;
const controller = new AbortController();
const DEFAULT_HAND_OPTIONS = { minHandDetectionConfidence: 0.35, minHandPresenceConfidence: 0.35, minTrackingConfidence: 0.5 };

function handOptions(value) {
  const keys = Object.keys(DEFAULT_HAND_OPTIONS);
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || !keys.every(key => typeof value[key] === 'number' && Number.isFinite(value[key]) && value[key] >= 0.1 && value[key] <= 0.9)) {
    return { ...DEFAULT_HAND_OPTIONS };
  }
  return Object.fromEntries(keys.map(key => [key, value[key]]));
}

self.onmessage = async ({ data }) => {
  if (data.type === 'close') {
    closing = true;
    controller.abort();
    detector?.close();
    handDetector?.close();
    detector = null;
    handDetector = null;
    self.close();
    return;
  }
  if (closing) { data.bitmap?.close(); return; }
  if (data.type === 'init') {
    if (detector || initializing) return;
    initializing = true;
    try {
      // The bundled WASM loader uses importScripts; this must remain a classic worker.
      self.exports = {};
      importScripts(new URL('vision_bundle.js', self.location.href).href);
      const { FilesetResolver, PoseLandmarker, HandLandmarker } = self.exports;
      const response = await fetch(new URL('../body-scan/pose_landmarker_full.task', self.location.href), { signal: controller.signal });
      if (!response.ok) throw new Error('Local pose model unavailable');
      const modelAssetBuffer = new Uint8Array(await response.arrayBuffer());
      if (closing) return;
      const vision = await FilesetResolver.forVisionTasks(new URL('../body-scan/wasm', self.location.href).href);
      const task = await PoseLandmarker.createFromOptions(vision, {
        baseOptions: { modelAssetBuffer, delegate: 'CPU' },
        runningMode: 'VIDEO',
        numPoses: 2,
        outputSegmentationMasks: false,
        minPoseDetectionConfidence: 0.6,
        minPosePresenceConfidence: 0.6,
        minTrackingConfidence: 0.6,
      });
      if (closing) { task.close(); return; }
      detector = task;
      if (data.hands === true) {
        const handResponse = await fetch(new URL('hand_landmarker.task', self.location.href), { signal: controller.signal });
        if (!handResponse.ok) throw new Error('Local hand model unavailable');
        const handModel = new Uint8Array(await handResponse.arrayBuffer());
        if (closing) return;
        const handTask = await HandLandmarker.createFromOptions(vision, {
          baseOptions: { modelAssetBuffer: handModel, delegate: 'CPU' }, runningMode: 'VIDEO', numHands: 2,
          // Legacy Hands' min_tracking_confidence controls landmark presence;
          // Tasks' minTrackingConfidence is a separate box-IoU threshold.
          ...handOptions(data.options),
        });
        if (closing) { handTask.close(); return; }
        handDetector = handTask;
      }
      self.postMessage({ type: 'ready' });
    } catch {
      detector?.close(); detector = null;
      handDetector?.close(); handDetector = null;
      if (!closing) self.postMessage({ type: 'error' });
    } finally { initializing = false; }
    return;
  }
  if (data.type !== 'detect') return;
  const { bitmap, timestamp, frameId } = data;
  let result;
  try {
    if (!detector) throw new Error('Pose model not ready');
    const startedAt = performance.now();
    result = detector.detectForVideo(bitmap, timestamp);
    const handResult = handDetector?.detectForVideo(bitmap, timestamp);
    self.postMessage({ type: 'result', frameId, timestamp,
      poses: result.landmarks.map(landmarks => ({ landmarks })),
      ...(handResult ? { hands: handResult.landmarks.map((landmarks, index) => ({
        landmarks, handedness: handResult.handedness[index]?.[0]?.categoryName,
      })) } : {}),
      inferenceMs: performance.now() - startedAt });
  } catch {
    self.postMessage({ type: 'error', frameId });
  } finally {
    try { result?.close(); } finally { bitmap?.close(); }
  }
};
