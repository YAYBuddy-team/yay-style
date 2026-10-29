"""Thin wrappers over the open-source detectors used for garment preparation.

None of these generate images: they only locate body keypoints and pixel masks.
The models are not thread-safe, so every call goes through a single lock.
"""

from __future__ import annotations

import threading
from dataclasses import dataclass
from functools import cache

import cv2
import mediapipe as mp
import numpy as np
from mediapipe.tasks.python import BaseOptions, vision
from PIL import Image

from ..settings import settings
from .models import model_path

_lock = threading.Lock()

# MediaPipe pose indices we care about (names follow the *person's* side).
POSE_POINTS = {
    "nose": 0,
    "left_shoulder": 11,
    "right_shoulder": 12,
    "left_elbow": 13,
    "right_elbow": 14,
    "left_wrist": 15,
    "right_wrist": 16,
    "left_hip": 23,
    "right_hip": 24,
    "left_knee": 25,
    "right_knee": 26,
    "left_ankle": 27,
    "right_ankle": 28,
}

# selfie_multiclass_256x256 classes
SEG_BACKGROUND, SEG_HAIR, SEG_BODY_SKIN, SEG_FACE_SKIN, SEG_CLOTHES, SEG_OTHERS = range(6)


@dataclass
class Keypoint:
    x: float  # pixels
    y: float
    visibility: float


Pose = dict[str, Keypoint]


@cache
def _pose_landmarker() -> vision.PoseLandmarker:
    opts = vision.PoseLandmarkerOptions(
        base_options=BaseOptions(model_asset_path=str(model_path("pose_landmarker_heavy.task"))),
        num_poses=2,
        min_pose_detection_confidence=0.5,
    )
    return vision.PoseLandmarker.create_from_options(opts)


@cache
def _segmenter() -> vision.ImageSegmenter:
    opts = vision.ImageSegmenterOptions(
        base_options=BaseOptions(
            model_asset_path=str(model_path("selfie_multiclass_256x256.tflite"))
        ),
        output_category_mask=False,
        output_confidence_masks=True,
    )
    return vision.ImageSegmenter.create_from_options(opts)


@cache
def _rembg_session():
    from rembg import new_session

    return new_session(settings.rembg_model)


def _mp_image(rgb: np.ndarray) -> mp.Image:
    return mp.Image(image_format=mp.ImageFormat.SRGB, data=np.ascontiguousarray(rgb))


def detect_poses(rgb: np.ndarray) -> list[Pose]:
    """All people found in the image (up to 2), largest first."""
    h, w = rgb.shape[:2]
    with _lock:
        result = _pose_landmarker().detect(_mp_image(rgb))
    poses: list[Pose] = []
    for landmarks in result.pose_landmarks:
        poses.append(
            {name: _keypoint(landmarks[i], w, h) for name, i in POSE_POINTS.items()}
        )
    poses.sort(key=pose_extent, reverse=True)
    return poses


def _keypoint(lm, w: int, h: int) -> Keypoint:
    """`visibility` here means "located in the frame": MediaPipe's own visibility drops for
    joints merely covered by clothing (knees under a dress), which are still fine anchors,
    so we use landmark presence and zero it for points outside the image."""
    inside = -0.02 <= lm.x <= 1.02 and -0.02 <= lm.y <= 1.02
    conf = float(lm.presence or 0) if inside else 0.0
    return Keypoint(lm.x * w, lm.y * h, conf)


def pose_extent(pose: Pose) -> float:
    ys = [k.y for k in pose.values() if k.visibility > 0.5]
    return max(ys) - min(ys) if ys else 0.0


def segment_person(rgb: np.ndarray) -> np.ndarray:
    """Per-pixel class map (uint8, same size as input) from the multiclass segmenter.

    The model works at 256×256; upscaling its hard category mask gives blocky edges that
    leak into the background, so we upscale the per-class confidences smoothly and take
    the argmax at full resolution instead.
    """
    with _lock:
        result = _segmenter().segment(_mp_image(rgb))
    h, w = rgb.shape[:2]
    conf = np.stack(
        [
            cv2.resize(np.squeeze(m.numpy_view()), (w, h), interpolation=cv2.INTER_LINEAR)
            for m in result.confidence_masks
        ],
        axis=-1,
    )
    return conf.argmax(axis=-1).astype(np.uint8)


def foreground_alpha(rgb: np.ndarray) -> np.ndarray:
    """High-resolution foreground alpha (uint8 0..255) from rembg."""
    from rembg import remove

    with _lock:
        out = remove(Image.fromarray(rgb), session=_rembg_session(), only_mask=True)
    return np.asarray(out.convert("L"))
