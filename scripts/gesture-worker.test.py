import base64
import importlib.util
import io
import json
import pathlib
import sys
import unittest
from types import SimpleNamespace
from unittest.mock import Mock, patch
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


def frame(width=4, height=2, rotation=0, mirrored=False, **changes):
    value = {"format": "i420-v1", "width": width, "height": height,
             "rotation": rotation, "mirrored": mirrored,
             "byteLength": width * height + 2 * ((width + 1) // 2) * ((height + 1) // 2)}
    return dict(value, **changes)


def colored_i420(width, height):
    y_size = width * height
    chroma_size = ((width + 1) // 2) * ((height + 1) // 2)
    return bytes((index * 29) % 256 for index in range(y_size)) + \
        bytes((index * 51 + 23) % 256 for index in range(chroma_size)) + \
        bytes((index * 83 + 192) % 256 for index in range(chroma_size))


def reference_rgb(data, width, height):
    """Independent scalar color conversion before display transforms, for small fixtures."""
    chroma_width = (width + 1) // 2
    chroma_size = chroma_width * ((height + 1) // 2)
    result = worker.np.zeros((height, width, 3), dtype=worker.np.uint8)
    for row in range(height):
        for column in range(width):
            yy = max(0, data[row * width + column] - 16)
            offset = row // 2 * chroma_width + column // 2
            uu = data[width * height + offset] - 128
            vv = data[width * height + chroma_size + offset] - 128
            result[row, column] = [min(255, max(0, channel >> 8)) for channel in
                                   (298 * yy + 409 * vv + 128,
                                    298 * yy - 100 * uu - 208 * vv + 128,
                                    298 * yy + 516 * uu + 128)]
    return result


class I420BoundaryTests(unittest.TestCase):
    def test_color_rotation_and_unmirror_match_display_coordinates(self):
        for width, height in [(4, 2), (5, 3), (1, 1), (1, 5)]:
            data = colored_i420(width, height)
            original = reference_rgb(data, width, height)
            for rotation in (0, 90, 180, 270):
                for mirrored in (False, True):
                    with self.subTest(width=width, height=height, rotation=rotation, mirrored=mirrored):
                        expected = worker.np.rot90(original, -(rotation // 90))
                        if mirrored:
                            expected = worker.np.fliplr(expected)
                        actual = worker.i420_pixels(data, frame(width, height, rotation, mirrored))
                        worker.np.testing.assert_array_equal(actual, expected)
                        self.assertTrue(actual.flags.c_contiguous)
                        self.assertEqual(actual.dtype, worker.np.uint8)

    def test_resize_samples_rotated_grid_before_horizontal_unmirror(self):
        width, height = 1440, 9
        data = colored_i420(width, height)
        original = reference_rgb(data, width, height)
        for edge in (480, 720, 960):
            for rotation in (0, 90, 180, 270):
                for mirrored in (False, True):
                    with self.subTest(edge=edge, rotation=rotation, mirrored=mirrored):
                        displayed = worker.np.rot90(original, -(rotation // 90))
                        # At 720 this short edge is 4.5, which must round to 5.
                        short_edge = {480: 3, 720: 5, 960: 6}[edge]
                        out_width, out_height = (short_edge, edge) if rotation in (90, 270) else (edge, short_edge)
                        rows = worker.np.arange(out_height) * displayed.shape[0] // out_height
                        columns = worker.np.arange(out_width) * displayed.shape[1] // out_width
                        expected = displayed[rows[:, None], columns[None, :]]
                        if mirrored:
                            expected = worker.np.fliplr(expected)
                        worker.np.testing.assert_array_equal(
                            worker.i420_pixels(data, frame(width, height, rotation, mirrored), edge), expected)

    def test_default_is_720_and_no_rgb_allocation_at_camera_resolution(self):
        descriptor = frame(3840, 2160)
        data = bytes(descriptor["byteLength"])
        with patch.object(worker.np, "empty", wraps=worker.np.empty) as allocate:
            pixels = worker.i420_pixels(data, descriptor)
        self.assertEqual(pixels.shape, (405, 720, 3))
        allocate.assert_called_once_with((405, 720, 3), dtype=worker.np.uint8)

    def test_dimension_and_pixel_boundaries(self):
        for width, height in [(1, 1), (4096, 1), (1, 4096), (3840, 2160), (2160, 3840)]:
            self.assertEqual(worker.i420_layout(frame(width, height))[:2], (width, height))
        for changes in [{"width": value} for value in (0, -1, True, 1.5, "4", None, 4097)] + \
                [{"height": value} for value in (0, -1, True, 1.5, "2", None, 4097)] + \
                [{"width": 4096, "height": 2160}, {"width": 3840, "height": 2161}]:
            with self.subTest(changes=changes), self.assertRaises(ValueError):
                worker.i420_layout(dict(frame(), **changes))

    def test_rejects_format_length_and_orientation_without_reading_payload(self):
        changes = [{"format": value} for value in (None, "i420", "jpeg")] + \
            [{"byteLength": value} for value in (0, -1, True, 12.0, "12", 11, 13, worker.MAX_RAW_BYTES + 1)] + \
            [{"rotation": value} for value in (None, True, 90.0, "90", -90, 360, 45)] + \
            [{"mirrored": value} for value in (None, 0, 1, "false")]
        for change in changes:
            with self.subTest(change=change):
                source = Mock()
                with self.assertRaises(ValueError):
                    worker.read_i420(source, dict(frame(), **change))
                source.readinto.assert_not_called()
        for missing in ("format", "width", "height", "rotation", "mirrored", "byteLength"):
            value = frame()
            del value[missing]
            with self.subTest(missing=missing), self.assertRaises(ValueError):
                worker.i420_layout(value)

    def test_data_must_match_exact_length(self):
        data = colored_i420(4, 2)
        for value in (data[:-1], data + b"\n", None, [0] * len(data)):
            with self.assertRaises(ValueError):
                worker.i420_pixels(value, frame())

    def test_bounded_reads_handle_partial_chunks_and_preserve_next_header(self):
        descriptor = frame(720, 480)
        data = bytes(descriptor["byteLength"])
        following = b'{"id":2}\n'

        class PartialStream(io.BytesIO):
            def readinto(self, target):
                self.max_read = max(getattr(self, "max_read", 0), len(target))
                return super().readinto(target[:1027])

        source = PartialStream(data + following)
        self.assertEqual(worker.read_i420(source, descriptor), data)
        self.assertLessEqual(source.max_read, worker.RAW_READ_CHUNK)
        self.assertEqual(source.read(), following)
        with self.assertRaises(ValueError):
            worker.read_i420(io.BytesIO(data[:-1]), descriptor)

    def test_input_size_is_independent_of_model_settings(self):
        self.assertEqual(worker.input_long_edge_from({}), 720)
        for edge in (480, 720, 960):
            self.assertEqual(worker.input_long_edge_from({"inputLongEdge": edge}), edge)
            self.assertEqual(worker.settings_from({"inputLongEdge": edge}), (0.5, 0.5, 0.5))
        for edge in (None, True, 720.0, "720", 0, 640, 961):
            with self.assertRaises(ValueError):
                worker.settings_from({"inputLongEdge": edge})


class WorkerFramingTests(unittest.TestCase):
    def run_worker(self, payload):
        detector = Mock()
        detector.infer.return_value = {"hands": [], "poses": []}
        output = io.StringIO()
        with patch.object(worker, "Detector", return_value=detector), \
                patch.object(worker.sys, "argv", ["gesture-worker.py", "--model", "hand.task", "--pose-model", "pose.task"]), \
                patch.object(worker.sys, "stdin", SimpleNamespace(buffer=io.BytesIO(payload))), \
                patch.object(worker.sys, "stdout", output):
            status = worker.main()
        detector.close.assert_called_once()
        return status, [json.loads(line) for line in output.getvalue().splitlines()], detector

    def line(self, number, **fields):
        return (json.dumps(dict({"id": number, "type": "infer", "timestamp": number}, **fields)) + "\n").encode()

    def test_multiple_raw_frames_without_separator_and_legacy_jpegs(self):
        first = bytes([10, 20, 30, 40, 50, 60, 70, 80, 128, 128, 128, 128])
        second = colored_i420(3, 5)
        payload = self.line(1, jpeg=encode(32, 48)) + self.line(2, frame=frame()) + first + \
            self.line(3, frame=frame(3, 5, 90, True), settings={"inputLongEdge": 480}) + second + \
            self.line(4, jpeg=encode(48, 32))
        status, output, detector = self.run_worker(payload)
        self.assertEqual(status, 0)
        self.assertEqual([item["type"] for item in output], ["ready"] + ["result"] * 4)
        self.assertEqual([item["id"] for item in output[1:]], [1, 2, 3, 4])
        calls = detector.infer.call_args_list
        self.assertEqual([call.args[0].shape for call in calls], [(48, 32, 3), (2, 4, 3), (3, 5, 3), (32, 48, 3)])
        worker.np.testing.assert_array_equal(calls[1].args[0], worker.i420_pixels(first, frame()))
        worker.np.testing.assert_array_equal(calls[2].args[0], worker.i420_pixels(second, frame(3, 5, 90, True), 480))

    def test_bad_raw_framing_stops_with_sanitized_error(self):
        secret = b"PRIVATE_FRAME_CONTENT"
        for descriptor, data in [(frame(byteLength=worker.MAX_RAW_BYTES + 1), secret), (frame(), b"short")]:
            with self.subTest(descriptor=descriptor):
                status, output, detector = self.run_worker(self.line(1, frame=descriptor) + data)
                self.assertEqual(status, 2)
                self.assertEqual(output, [{"type": "ready"}, {"type": "error", "id": 1, "code": "INVALID_IMAGE"}])
                detector.infer.assert_not_called()

    def test_bad_jpeg_can_recover_before_raw_frame(self):
        data = colored_i420(4, 2)
        status, output, detector = self.run_worker(
            self.line(1, jpeg="invalid") + self.line(2, frame=frame()) + data)
        self.assertEqual(status, 0)
        self.assertEqual([item["type"] for item in output], ["ready", "error", "result"])
        detector.infer.assert_called_once()


class JpegBoundaryTests(unittest.TestCase):
    def test_rgb_jpeg_and_orientation(self):
        pixels = worker.jpeg_pixels(encode(32, 64))
        self.assertEqual(pixels.shape, (64, 32, 3))

    def test_accepts_the_960_dimension_boundary_and_legacy_frames(self):
        for width, height in [(960, 960), (540, 960), (720, 540), (480, 360)]:
            self.assertEqual(worker.jpeg_pixels(encode(width, height)).shape, (height, width, 3))

    def test_rejects_large_header_before_decompression(self):
        for size in [(961, 10), (10, 961), (2000, 2000)]:
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


class DetectorTests(unittest.TestCase):
    def setUp(self):
        point = SimpleNamespace(x=0.2, y=0.3, z=-0.4, visibility=0.85)
        self.pose = Mock()
        self.pose.detect_for_video.return_value = SimpleNamespace(pose_landmarks=[[point] * 33, [point] * 33])
        self.hand = Mock()
        self.hand.detect_for_video.return_value = SimpleNamespace(
            hand_landmarks=[[point] * 21], handedness=[[SimpleNamespace(category_name="Left")]])
        self.pose_factory = self.enterContext(patch.object(worker.mp.tasks.vision.PoseLandmarker, "create_from_options", return_value=self.pose))
        self.hand_factory = self.enterContext(patch.object(worker.mp.tasks.vision.HandLandmarker, "create_from_options", return_value=self.hand))
        self.pixels = worker.np.zeros((48, 64, 3), worker.np.uint8)

    def test_matches_web_pose_options_and_returns_visible_landmarks_for_same_frame(self):
        detector = worker.Detector("hands.task", "full-pose.task")
        self.addCleanup(detector.close)
        options = self.pose_factory.call_args.args[0]
        self.assertEqual(options.base_options.model_asset_path, "full-pose.task")
        self.assertEqual(options.base_options.delegate, worker.mp.tasks.BaseOptions.Delegate.CPU)
        self.assertEqual(options.running_mode, worker.mp.tasks.vision.RunningMode.VIDEO)
        self.assertEqual(options.num_poses, 2)
        self.assertFalse(options.output_segmentation_masks)
        self.assertEqual((options.min_pose_detection_confidence, options.min_pose_presence_confidence, options.min_tracking_confidence), (0.6, 0.6, 0.6))
        result = detector.infer(self.pixels, 0, (0.5, 0.5, 0.5))
        self.assertEqual(len(result["poses"]), 2)
        self.assertEqual(len(result["poses"][0]["landmarks"]), 33)
        self.assertEqual(result["poses"][0]["landmarks"][0], {"x": 0.2, "y": 0.3, "z": -0.4, "visibility": 0.85})
        self.assertEqual(result["hands"][0]["handedness"], "Left")
        self.assertEqual(len(result["hands"][0]["landmarks"]), 21)
        self.assertEqual((result["width"], result["height"]), (64, 48))
        self.assertGreaterEqual(result["inferenceMs"], 0)
        self.assertIs(self.pose.detect_for_video.call_args.args[0], self.hand.detect_for_video.call_args.args[0])
        self.assertEqual(self.pose.detect_for_video.call_args.args[1], 1)
        self.assertEqual(self.hand.detect_for_video.call_args.args[1], 1)

    def test_hand_tuning_preserves_pose_tracking_and_increasing_video_timestamps(self):
        detector = worker.Detector("hands.task", "full-pose.task")
        self.addCleanup(detector.close)
        detector.infer(self.pixels, 0, (0.5, 0.5, 0.5))
        replacement = Mock()
        replacement.detect_for_video.return_value = self.hand.detect_for_video.return_value
        self.hand_factory.return_value = replacement
        detector.infer(self.pixels, 1, (0.35, 0.4, 0.6))
        detector.infer(self.pixels, 2, (0.35, 0.4, 0.6))
        self.pose_factory.assert_called_once()
        self.pose.close.assert_not_called()
        self.hand.close.assert_called_once()
        self.assertEqual(self.hand_factory.call_count, 2)
        self.assertEqual([call.args[1] for call in self.pose.detect_for_video.call_args_list], [0, 1, 2, 3])
        self.assertEqual([call.args[1] for call in replacement.detect_for_video.call_args_list], [0, 2, 3])
        options = self.hand_factory.call_args.args[0]
        self.assertEqual((options.min_hand_detection_confidence, options.min_hand_presence_confidence, options.min_tracking_confidence), (0.35, 0.4, 0.6))
        detector.close()
        detector.close()
        self.pose.close.assert_called_once()
        replacement.close.assert_called_once()

    def test_partial_startup_failure_closes_both_created_models(self):
        self.hand.detect_for_video.side_effect = RuntimeError("warmup failed")
        with self.assertRaises(RuntimeError):
            worker.Detector("hands.task", "full-pose.task")
        self.hand.close.assert_called_once()
        self.pose.close.assert_called_once()

    def test_pose_is_released_even_if_hand_close_fails(self):
        detector = worker.Detector("hands.task", "full-pose.task")
        self.hand.close.side_effect = RuntimeError("close failed")
        with self.assertRaises(RuntimeError):
            detector.close()
        detector.close()
        self.hand.close.assert_called_once()
        self.pose.close.assert_called_once()


if __name__ == "__main__":
    unittest.main()
