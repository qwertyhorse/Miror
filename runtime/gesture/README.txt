Linux hand inference runtime

The server uses one separate MediaPipe 0.10.32 CPU VIDEO process per active
terminal. It reads the same hand_landmarker.task used by the Android app:
SHA256 fbc2a30080c3c557093b5ddfc334698132eb341044ccee322ccf8bcf3607cde1.
There are at most two hands and no pose model (poses=[]). Coordinates are not
mirrored in the worker; the shared gesture coordinator applies display mirroring.

Install

Use CPython 3.12 on Linux x86_64, including venv/ensurepip. The requirements lock
pins every direct and transitive wheel with SHA256. No packages are installed in
the operating system Python, and no keys or generation credentials are needed.

  python3 scripts/setup-gesture-runtime.py --python /path/to/python3.12

The default directory is ~/.local/share/miror/gesture-runtime. On this Codex
workstation the available bootstrap interpreter is:
  ~/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3.12

The setup command verifies dependencies and runs one blank-frame model warmup.
It does not start the web server or change its systemd service. A different
directory can be supplied with --directory; then set MIROR_GESTURE_PYTHON to its
bin/python in the server environment. MIROR_GESTURE_MODEL may override the model
path for a deliberate model migration; Android and server model versions should
remain aligned when comparing the two modes.

Runtime contract

createGestureInference() resolves only after model creation and warmup. infer()
accepts a complete JPEG of at most 256 KiB and dimensions no larger than 640 by
640. Pillow validates the JPEG header before pixel allocation and rejects corrupt,
truncated, non-JPEG and oversized frames. Timestamps must increase. Both native
and server inference use the same three hand-confidence settings; a changed
configuration replaces that process's model and tracking context.

There is one in-flight frame per worker. Another frame is rejected immediately
with INFERENCE_BUSY, never queued or replayed. Startup is bounded to 15 seconds;
inference to 5 seconds. A timeout, process exit or protocol error closes the
instance; the session coordinator must create a new context. close() is idempotent,
rejects outstanding work, sends SIGTERM and escalates to SIGKILL after 500 ms.

JPEG base64 exists only on private child-process stdin. Responses contain hand
landmarks and timings. Frames are never written to disk or logs, and native
diagnostic stderr is drained without being exposed to the client. The server's
gesture-session layer owns terminal authentication, busy/release state and the
maximum number of workers; this inference layer never issues outfit commands or
opens XMAX sessions.

Verification

  node node_modules/vitest/vitest.mjs run tests/gestureInference.test.ts
  ~/.local/share/miror/gesture-runtime/bin/python scripts/gesture-worker.test.py
  node --import tsx scripts/check-linux-gesture-runtime.mjs --frames 60 \
    --output artifacts/linux-gesture-benchmark.json
  node --import tsx scripts/check-remote-gesture-http.mjs \
    --output artifacts/linux-gesture-http-benchmark.json

The benchmark fetches Google's official Hand Landmarker example image into memory
and runs two independent VIDEO contexts simultaneously. --sample /path/to/image
can use an existing local test image. It checks actual hand detection, invalid
JPEG rejection and single-flight behavior. Reported CPU/pipe latency excludes
Android capture, JPEG encoding, LAN transport and XMAX video generation; it is not
an end-to-end mirror latency guarantee.

The HTTP smoke test uses the real API routes, terminal authentication, coordinator,
CPU models, gesture detector and select command. It creates two temporary mirror
registries/bindings with an in-memory session store and a supplier implementation
that rejects every cloud operation. The fixture explicitly publishes Free
prompt-only presets through the current publication API, with no reference
preparation. Only Google's public sample is fetched; a
fixed single-palm crop and blank JPEGs exercise independent terminals, held palms,
busy new/moving palms, release and fresh re-entry. Temporary data and both model
processes are removed on completion, including assertion failure. No production
configuration, keys, camera frames or generation sessions are used.

Its report includes binary-frame HTTP counts, actual gesture command counts,
per-terminal HTTP/model p50 and p95 timings, and a trace containing gesture state
only. HTTP timings are over loopback; the test uses controlled monotonic capture
timestamps to cover release/hold intervals quickly. They do not include Android
capture/encoding, Wi-Fi transport, display rendering or XMAX generation. This
test establishes the server path's correctness and local CPU capacity, not the
performance of a particular old Android device or exhibition network.

Primary references

https://developers.google.com/edge/mediapipe/solutions/vision/hand_landmarker/python
https://pypi.org/project/mediapipe/0.10.32/
https://github.com/google-ai-edge/mediapipe-samples/blob/main/examples/hand_landmarker/python/hand_landmarker.ipynb
