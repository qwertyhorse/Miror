#!/usr/bin/env python3
"""One warm CPU hand model per terminal. JSON lines travel only through private pipes."""
import argparse
import base64
import io
import json
import math
import sys
import time
import warnings

import mediapipe as mp
import numpy as np
from PIL import Image, ImageFile

MAX_JPEG_BYTES = 256 * 1024
MAX_DIMENSION = 640
MAX_LINE_BYTES = 352 * 1024
Image.MAX_IMAGE_PIXELS = MAX_DIMENSION * MAX_DIMENSION
ImageFile.LOAD_TRUNCATED_IMAGES = False
warnings.simplefilter("error", Image.DecompressionBombWarning)


def emit(value):
    sys.stdout.write(json.dumps(value, separators=(",", ":"), allow_nan=False) + "\n")
    sys.stdout.flush()


def settings_from(value):
    fields = ("minHandDetectionConfidence", "minHandPresenceConfidence", "minTrackingConfidence")
    result = tuple(value.get(field, 0.5) for field in fields)
    if any(isinstance(x, bool) or not isinstance(x, (int, float)) or not math.isfinite(x) or not 0 <= x <= 1 for x in result):
        raise ValueError("Invalid confidence")
    return result


def jpeg_pixels(encoded):
    if not isinstance(encoded, str) or len(encoded) > (MAX_JPEG_BYTES + 2) // 3 * 4:
        raise ValueError("Invalid JPEG length")
    data = base64.b64decode(encoded, validate=True)
    if not 4 <= len(data) <= MAX_JPEG_BYTES or not data.startswith(b"\xff\xd8") or not data.endswith(b"\xff\xd9"):
        raise ValueError("Invalid JPEG")
    # Header dimensions are checked before load()/RGB allocation; no decompression of oversized images.
    with Image.open(io.BytesIO(data), formats=("JPEG",)) as source:
        if source.format != "JPEG" or not all(0 < dimension <= MAX_DIMENSION for dimension in source.size):
            raise ValueError("Invalid JPEG dimensions")
        source.load()
        with source.convert("RGB") as rgb:
            return np.array(rgb, dtype=np.uint8, copy=True)


class Detector:
    def __init__(self, model):
        self.model = model
        self.detector = None
        self.settings = None
        self.timestamp = 0
        self.configure((0.5, 0.5, 0.5))

    def configure(self, settings):
        if self.settings == settings:
            return
        self.close()
        options = mp.tasks.vision.HandLandmarkerOptions(
            base_options=mp.tasks.BaseOptions(model_asset_path=self.model, delegate=mp.tasks.BaseOptions.Delegate.CPU),
            running_mode=mp.tasks.vision.RunningMode.VIDEO,
            num_hands=2,
            min_hand_detection_confidence=settings[0],
            min_hand_presence_confidence=settings[1],
            min_tracking_confidence=settings[2],
        )
        self.detector = mp.tasks.vision.HandLandmarker.create_from_options(options)
        self.detector.detect_for_video(mp.Image(image_format=mp.ImageFormat.SRGB, data=np.zeros((32, 32, 3), np.uint8)), 0)
        self.settings = settings
        self.timestamp = 0

    def infer(self, pixels, timestamp, settings):
        started = time.perf_counter()
        self.configure(settings)
        # Warmup owns timestamp 0. Preserve client ordering without colliding with it.
        self.timestamp = max(self.timestamp + 1, timestamp)
        result = self.detector.detect_for_video(mp.Image(image_format=mp.ImageFormat.SRGB, data=pixels), self.timestamp)
        hands = [{"handedness": result.handedness[index][0].category_name,
                  "landmarks": [{"x": point.x, "y": point.y, "z": point.z} for point in points]}
                 for index, points in enumerate(result.hand_landmarks)]
        return {"hands": hands, "poses": [], "width": pixels.shape[1], "height": pixels.shape[0],
                "inferenceMs": (time.perf_counter() - started) * 1000}

    def close(self):
        if self.detector is not None:
            self.detector.close()
            self.detector = None
        self.settings = None


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", required=True)
    args = parser.parse_args()
    detector = None
    previous_timestamp = -1
    try:
        detector = Detector(args.model)
        emit({"type": "ready"})
        while True:
            raw = sys.stdin.buffer.readline(MAX_LINE_BYTES + 1)
            if not raw:
                break
            if len(raw) > MAX_LINE_BYTES or not raw.endswith(b"\n"):
                return 2
            request = json.loads(raw)
            timestamp = request.get("timestamp")
            if request.get("type") != "infer" or not isinstance(request.get("id"), int) or isinstance(timestamp, bool) or not isinstance(timestamp, int) or not previous_timestamp < timestamp <= 9007199254740991:
                return 2
            settings = settings_from(request.get("settings", {}))
            try:
                pixels = jpeg_pixels(request.get("jpeg"))
            except Exception:
                emit({"type": "error", "id": request["id"], "code": "INVALID_IMAGE"})
                continue
            previous_timestamp = timestamp
            try:
                result = detector.infer(pixels, timestamp, settings)
            finally:
                del pixels
            emit({"type": "result", "id": request["id"], "result": result})
    except Exception:
        # No exception text or input payload: client receives a sanitized process failure.
        return 1
    finally:
        if detector is not None:
            detector.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
