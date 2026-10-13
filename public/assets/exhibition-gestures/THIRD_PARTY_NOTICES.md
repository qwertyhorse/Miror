# Local exhibition hand recognition assets

Downloaded 2026-10-13. Camera frames are processed on this device in a dedicated Web Worker; the implementation sends no camera frames or model requests to Google or another external origin.

- Model: Google MediaPipe Hand Landmarker, full float16, version 1. Official source: https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task
- Model SHA-256: `fbc2a30080c3c557093b5ddfc334698132eb341044ccee322ccf8bcf3607cde1` (7,819,105 bytes).
- Runtime: the unchanged `vision_bundle.cjs` from the pinned `@mediapipe/tasks-vision` **0.10.32**, renamed `vision_bundle.js` so static servers provide JavaScript MIME type. SHA-256: `43c65a77825c5d5af7456d4781a64cd15cb3e53f479ff1f923c12b5adecf2b44`. The runtime has no `require()` dependencies; the classic worker supplies its CommonJS `exports` object.
- WASM: shared, unchanged 0.10.32 runtime assets in `../body-scan/wasm/`. Keep these and the bundled JS synchronized with the exact pinned package. See `../body-scan/THIRD_PARTY_NOTICES.md` for the existing runtime version/privacy policy.
- Copyright Google LLC / The MediaPipe Authors. Apache License 2.0 is preserved in `LICENSE`.
- Model card: https://storage.googleapis.com/mediapipe-assets/Model%20Card%20Hand%20Tracking%20%28Lite_Full%29%20with%20Fairness%20Oct%202021.pdf
- Official integration guide: https://developers.google.com/edge/mediapipe/solutions/vision/hand_landmarker/web_js

The application adds a motion detector over the returned hand landmarks. It recognizes one wave after multiple horizontal direction changes and requires the hand to pause or leave before another wave can trigger. Recognition is sampled at no more than 15 FPS with a 720-pixel maximum input edge; only one frame can be in flight. Detection/presence/tracking confidence use the documented default of 0.5. The worker uses the CPU delegate. Local hand-presence, decoded-frame progress and inference timing are returned to the interface, without uploading pixels or landmarks. Detector confidence and motion thresholds need to be validated against the exhibition's actual camera, lighting, distance and participants. A gesture is an input action, not biometric identification.
