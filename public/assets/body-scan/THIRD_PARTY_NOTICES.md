# Local body-scan runtime assets

Downloaded 2026-10-03. These files are served from this application origin; body photos are processed in the user's browser and are never sent to MediaPipe or Google by the scan implementation.

- Runtime: `@mediapipe/tasks-vision` **0.10.32**, copied unchanged from its npm `wasm/` directory. Copyright Google LLC. Apache License 2.0; see `LICENSE`. Keep these runtime files synchronized with the exact pinned package version. Version 0.10.32 is intentionally retained because the 1.0.1 runtime emits external utilization telemetry. Do not upgrade without a network privacy regression check.
- Model: Google MediaPipe Pose Landmarker **Full, float16, version 1**. Official source: https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_full/float16/1/pose_landmarker_full.task
- Model SHA-256: `5134a3aad27a58b93da0088d431f366da362b44e3ccfbe3462b3827a839011b1`.
- Model card: https://storage.googleapis.com/mediapipe-assets/Model%20Card%20BlazePose%20GHUM%203D.pdf (preserved as `MODEL_CARD.pdf`). Its license section specifies Apache License 2.0.
- Documentation: https://developers.google.com/edge/mediapipe/solutions/vision/pose_landmarker/web_js
- License source: https://github.com/google-ai-edge/mediapipe/blob/master/LICENSE

MediaPipe returns learned pose landmarks and a foreground segmentation mask. The application adds its own approximate geometry: known-height scale calibration, silhouette cross-sections, limb lengths, and an ellipse perimeter. With only a front view, depth is a declared heuristic (chest 0.72× width, waist 0.70×, hips 0.80×). These are unvalidated sizing approximations, not a claim of measured anthropometry, exact metric depth, or a recovered photorealistic body surface. Loose clothing, shoes, hair, perspective and occlusion affect estimates. Inseam is omitted when a visible crotch gap cannot be found. The visual 3D mannequin is parameterized from these estimates; model output is not biometric identity recognition.

`imageLandmarks` retain normalized image coordinates. `worldLandmarks` retain the model's predicted meter-space coordinates with the hip midpoint as origin; these are learned estimates, not metrically observed body points. Only the silhouette/length measurement stage uses the supplied known height (centimeters). The 3D renderer may normalize pose extent separately for display. Landmark visibility is clamped to [0, 1]. Torso cross-sections trim the outer side of arm foreground near predicted arm bones; this is a geometric heuristic, not a trained circumference predictor.
