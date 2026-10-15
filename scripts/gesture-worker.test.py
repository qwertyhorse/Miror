import base64
import importlib.util
import io
import pathlib
import sys
import unittest
from PIL import Image

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location("gesture_worker", pathlib.Path(__file__).with_name("gesture-worker.py"))
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)


def encode(width=64, height=48, format="JPEG"):
    output = io.BytesIO()
    with Image.new("RGB", (width, height), "white") as image:
        image.save(output, format=format)
    return base64.b64encode(output.getvalue()).decode()


class JpegBoundaryTests(unittest.TestCase):
    def test_rgb_jpeg_and_orientation(self):
        pixels = worker.jpeg_pixels(encode(32, 64))
        self.assertEqual(pixels.shape, (64, 32, 3))

    def test_rejects_large_header_before_decompression(self):
        for size in [(641, 10), (10, 641), (2000, 2000)]:
            with self.assertRaises(Exception):
                worker.jpeg_pixels(encode(*size))

    def test_rejects_png_corrupt_truncated_and_oversized_payload(self):
        for value in [encode(format="PNG"), "?notbase64", base64.b64encode(b"\xff\xd8\xff\xd9").decode(), encode()[:-20], "A" * 400000]:
            with self.assertRaises(Exception):
                worker.jpeg_pixels(value)

    def test_confidences_reject_nonfinite_boolean_and_out_of_range(self):
        for value in [float("nan"), float("inf"), True, -1, 1.1, "0.5"]:
            with self.assertRaises(ValueError):
                worker.settings_from({"minTrackingConfidence": value})
        self.assertEqual(worker.settings_from({}), (0.5, 0.5, 0.5))


if __name__ == "__main__":
    unittest.main()
