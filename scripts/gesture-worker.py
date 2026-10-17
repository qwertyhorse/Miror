#!/usr/bin/env python3
"""Warm CPU pose and hand models per terminal. Framed input uses private pipes only."""
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
MAX_DIMENSION = 960
MAX_LINE_BYTES = 352 * 1024
MAX_RAW_DIMENSION = 4096
MAX_RAW_PIXELS = 3840 * 2160
MAX_RAW_BYTES = 16 * 1024 * 1024
RAW_READ_CHUNK = 64 * 1024
Image.MAX_IMAGE_PIXELS = MAX_DIMENSION * MAX_DIMENSION
ImageFile.LOAD_TRUNCATED_IMAGES = False
warnings.simplefilter("error", Image.DecompressionBombWarning)


def emit(value):
    sys.stdout.write(json.dumps(value, separators=(",", ":"), allow_nan=False) + "\n")
    sys.stdout.flush()


def settings_from(value):
    if not isinstance(value, dict):
        raise ValueError("Invalid settings")
    fields = ("minHandDetectionConfidence", "minHandPresenceConfidence", "minTrackingConfidence")
    result = tuple(value.get(field, 0.5) for field in fields)
    if any(isinstance(x, bool) or not isinstance(x, (int, float)) or not math.isfinite(x) or not 0 <= x <= 1 for x in result):
        raise ValueError("Invalid confidence")
    input_long_edge_from(value)
    return result


def input_long_edge_from(value):
    edge = value.get("inputLongEdge", 720)
    if type(edge) is not int or edge not in (480, 720, 960):
        raise ValueError("Invalid input size")
    return edge


def i420_layout(frame):
    if not isinstance(frame, dict) or frame.get("format") != "i420-v1":
        raise ValueError("Invalid frame format")
    width, height = frame.get("width"), frame.get("height")
    if any(type(size) is not int or not 1 <= size <= MAX_RAW_DIMENSION for size in (width, height)) or width * height > MAX_RAW_PIXELS:
        raise ValueError("Invalid frame dimensions")
    rotation, mirrored = frame.get("rotation"), frame.get("mirrored")
    if type(rotation) is not int or rotation not in (0, 90, 180, 270) or type(mirrored) is not bool:
        raise ValueError("Invalid frame orientation")
    byte_length = frame.get("byteLength")
    expected = width * height + 2 * ((width + 1) // 2) * ((height + 1) // 2)
    if type(byte_length) is not int or not 1 <= byte_length <= MAX_RAW_BYTES or byte_length != expected:
        raise ValueError("Invalid frame length")
    return width, height, rotation, mirrored, byte_length


def read_i420(stream, frame):
    # Reject dimensions and framing before allocating or consuming binary data.
    byte_length = i420_layout(frame)[4]
    data = bytearray(byte_length)
    view = memoryview(data)
    offset = 0
    while offset < byte_length:
        count = stream.readinto(view[offset:min(byte_length, offset + RAW_READ_CHUNK)])
        if not count:
            raise ValueError("Truncated frame")
        offset += count
    return data


def i420_pixels(data, frame, input_long_edge=720):
    width, height, rotation, mirrored, byte_length = i420_layout(frame)
    if not isinstance(data, (bytes, bytearray, memoryview)) or len(data) != byte_length:
        raise ValueError("Invalid frame data")
    edge = input_long_edge_from({"inputLongEdge": input_long_edge})
    turned = rotation in (90, 270)
    rotated_width, rotated_height = (height, width) if turned else (width, height)
    scale = min(1.0, edge / max(rotated_width, rotated_height))
    # Kotlin roundToInt rounds positive halves up, unlike Python round().
    out_width = max(1, math.floor(rotated_width * scale + 0.5))
    out_height = max(1, math.floor(rotated_height * scale + 0.5))
    columns = np.arange(out_width, dtype=np.int32)
    if mirrored:
        columns = out_width - 1 - columns
    rx = (columns * rotated_width // out_width)[None, :]
    ry = (np.arange(out_height, dtype=np.int32) * rotated_height // out_height)[:, None]
    # Sample directly in the reduced display grid. No full-size RGB image exists.
    if rotation == 90:
        sx, sy = ry, height - 1 - rx
    elif rotation == 180:
        sx, sy = width - 1 - rx, height - 1 - ry
    elif rotation == 270:
        sx, sy = width - 1 - ry, rx
    else:
        sx, sy = rx, ry
    source = np.frombuffer(data, dtype=np.uint8)
    y_size = width * height
    chroma_width = (width + 1) // 2
    chroma_size = chroma_width * ((height + 1) // 2)
    chroma_indices = sy // 2 * chroma_width + sx // 2
    yy = np.maximum(0, source[sy * width + sx].astype(np.int32) - 16)
    uu = source[y_size + chroma_indices].astype(np.int32) - 128
    vv = source[y_size + chroma_size + chroma_indices].astype(np.int32) - 128
    pixels = np.empty((out_height, out_width, 3), dtype=np.uint8)
    pixels[:, :, 0] = np.clip((298 * yy + 409 * vv + 128) >> 8, 0, 255)
    pixels[:, :, 1] = np.clip((298 * yy - 100 * uu - 208 * vv + 128) >> 8, 0, 255)
    pixels[:, :, 2] = np.clip((298 * yy + 516 * uu + 128) >> 8, 0, 255)
    return pixels


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
    def __init__(self, model, pose_model):
        self.model = model
        self.detector = None
        self.pose_detector = None
        self.settings = None
        self.timestamp = 0
        try:
            # Match the web worker: two full-body poses, CPU VIDEO, no segmentation.
            options = mp.tasks.vision.PoseLandmarkerOptions(
                base_options=mp.tasks.BaseOptions(model_asset_path=pose_model, delegate=mp.tasks.BaseOptions.Delegate.CPU),
                running_mode=mp.tasks.vision.RunningMode.VIDEO,
                num_poses=2,
                output_segmentation_masks=False,
                min_pose_detection_confidence=0.6,
                min_pose_presence_confidence=0.6,
                min_tracking_confidence=0.6,
            )
            self.pose_detector = mp.tasks.vision.PoseLandmarker.create_from_options(options)
            self.pose_detector.detect_for_video(mp.Image(image_format=mp.ImageFormat.SRGB, data=np.zeros((32, 32, 3), np.uint8)), 0)
            self.configure((0.5, 0.5, 0.5))
        except Exception:
            self.close()
            raise

    def configure(self, settings):
        if self.settings == settings:
            return
        # Hand tuning must not replace the pose model or reset its VIDEO clock.
        self.close_hand()
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

    def infer(self, pixels, timestamp, settings):
        started = time.perf_counter()
        self.configure(settings)
        # Warmup owns timestamp 0. Preserve client ordering without colliding with it.
        self.timestamp = max(self.timestamp + 1, timestamp)
        image = mp.Image(image_format=mp.ImageFormat.SRGB, data=pixels)
        pose_result = self.pose_detector.detect_for_video(image, self.timestamp)
        result = self.detector.detect_for_video(image, self.timestamp)
        hands = [{"handedness": result.handedness[index][0].category_name,
                  "landmarks": [{"x": point.x, "y": point.y, "z": point.z} for point in points]}
                 for index, points in enumerate(result.hand_landmarks)]
        poses = [{"landmarks": [{"x": point.x, "y": point.y, "z": point.z, "visibility": point.visibility}
                                for point in points]} for points in pose_result.pose_landmarks]
        return {"hands": hands, "poses": poses, "width": pixels.shape[1], "height": pixels.shape[0],
                "inferenceMs": (time.perf_counter() - started) * 1000}

    def close_hand(self):
        if self.detector is not None:
            detector = self.detector
            self.detector = None
            detector.close()
        self.settings = None

    def close(self):
        try:
            self.close_hand()
        finally:
            if self.pose_detector is not None:
                detector = self.pose_detector
                self.pose_detector = None
                detector.close()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", required=True)
    parser.add_argument("--pose-model", required=True)
    args = parser.parse_args()
    detector = None
    previous_timestamp = -1
    try:
        detector = Detector(args.model, args.pose_model)
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
            raw_settings = request.get("settings", {})
            settings = settings_from(raw_settings)
            try:
                if "frame" in request:
                    data = read_i420(sys.stdin.buffer, request["frame"])
                    try:
                        pixels = i420_pixels(data, request["frame"], input_long_edge_from(raw_settings))
                    finally:
                        del data
                else:
                    pixels = jpeg_pixels(request.get("jpeg"))
            except Exception:
                emit({"type": "error", "id": request["id"], "code": "INVALID_IMAGE"})
                if "frame" in request:
                    # An invalid/truncated raw frame cannot be safely resynchronized.
                    return 2
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
