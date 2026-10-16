import base64
import importlib.util
import io
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
