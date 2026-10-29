"""Download-on-first-use for the open (Apache-2.0) MediaPipe model files."""

from __future__ import annotations

import urllib.request
from pathlib import Path

from ..settings import settings

_BASE = "https://storage.googleapis.com/mediapipe-models"
MODEL_URLS = {
    "pose_landmarker_heavy.task": (
        f"{_BASE}/pose_landmarker/pose_landmarker_heavy/float16/latest/pose_landmarker_heavy.task"
    ),
    "selfie_multiclass_256x256.tflite": (
        f"{_BASE}/image_segmenter/selfie_multiclass_256x256/float32/latest/"
        "selfie_multiclass_256x256.tflite"
    ),
}


def model_path(name: str) -> Path:
    path = settings.models_dir / name
    if not path.exists():
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(path.suffix + ".part")
        urllib.request.urlretrieve(MODEL_URLS[name], tmp)
        tmp.rename(path)
    return path
