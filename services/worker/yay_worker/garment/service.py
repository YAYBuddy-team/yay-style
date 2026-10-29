"""Prepare every photo of a product, pick the best one, and cache results on disk.

Layout: data/garments/<marketplace>/<id>/
    card.json        product card snapshot
    garment.json     prepared photos (scores, keypoints, file names)
    <n>.png          RGBA cutout of photo n
    <n>_debug.jpg    mask + keypoints visualisation for review
"""

from __future__ import annotations

import asyncio
import hashlib
import io
import json
import logging
import time
from dataclasses import asdict, dataclass, field
from pathlib import Path

import httpx
import numpy as np
from PIL import Image

from ..marketplaces import GarmentCategory, ProductCard
from ..settings import settings
from .prepare import PreparedGarment, prepare_image

PIPELINE_VERSION = 10  # bump to invalidate cached garments after pipeline changes
# Below this a photo is never picked automatically (side view, back view, cut by the
# frame...). Raised after benchmark r1: an honest "can't try this on" beats a bad fit.
MIN_USABLE_SCORE = 0.5
NO_MODEL_PHOTO = "Нет подходящего фото вещи на модели — примерка этой вещи пока недоступна"

log = logging.getLogger(__name__)


@dataclass
class PreparedPhoto:
    index: int
    source_url: str | None
    kind: str
    score: float
    reasons: list[str]
    cutout: str | None  # file name inside the garment dir
    debug: str | None
    width: int | None = None
    height: int | None = None
    keypoints: dict[str, dict] = field(default_factory=dict)
    body_profile: dict[str, float] | None = None


@dataclass
class GarmentResult:
    key: str  # "<marketplace>/<id>"
    category: str
    best_index: int | None
    photos: list[PreparedPhoto]
    unusable_reason: str | None = None
    pipeline_version: int = PIPELINE_VERSION
    prepared_at: float = field(default_factory=time.time)

    @property
    def usable(self) -> bool:
        return self.best_index is not None


def garment_dir(key: str) -> Path:
    return settings.garments_dir / key


def load_cached(key: str) -> GarmentResult | None:
    path = garment_dir(key) / "garment.json"
    if not path.exists():
        return None
    raw = json.loads(path.read_text())
    if raw.get("pipeline_version") != PIPELINE_VERSION:
        return None
    raw["photos"] = [PreparedPhoto(**p) for p in raw["photos"]]
    return GarmentResult(**raw)


async def prepare_product(
    client: httpx.AsyncClient, card: ProductCard, *, force: bool = False
) -> GarmentResult:
    key = f"{card.ref.marketplace}/{card.ref.product_id}"
    if not force and (cached := load_cached(key)):
        return cached

    out_dir = garment_dir(key)
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / "card.json").write_text(
        json.dumps(asdict(card), ensure_ascii=False, indent=2, default=str)
    )

    urls = card.image_urls[: settings.max_photos]
    images = await asyncio.gather(*(_download(client, u) for u in urls))
    photos = []
    for i, (url, rgb) in enumerate(zip(urls, images, strict=True), start=1):
        if rgb is None:
            photos.append(
                PreparedPhoto(i, url, "rejected", 0.0, ["Не удалось скачать фото"], None, None)
            )
            continue
        prepared = await asyncio.to_thread(_prepare_safely, rgb, card.category)
        photos.append(_save(out_dir, i, url, prepared))

    # Marketplace items are tried on from model photos only: in benchmark r1 flat-lay shots
    # (estimated anchors, busy backdrops) were acceptable far less often. They stay listed,
    # so the user can still pick one by hand.
    return _finish(key, card.category, photos, auto_kinds=("model",))


async def prepare_upload(data: bytes, category: GarmentCategory) -> GarmentResult:
    """Fallback path: a screenshot or photo uploaded by the user."""
    digest = hashlib.sha256(data).hexdigest()[:16]
    key = f"upload/{digest}-{category}"
    if cached := load_cached(key):
        return cached
    out_dir = garment_dir(key)
    out_dir.mkdir(parents=True, exist_ok=True)
    rgb = _decode(data)
    prepared = await asyncio.to_thread(_prepare_safely, rgb, category)
    return _finish(key, category, [_save(out_dir, 1, None, prepared)])


def _prepare_safely(rgb: np.ndarray, category: GarmentCategory) -> PreparedGarment:
    """One odd photo (unexpected pose, crop) must not fail the whole product."""
    try:
        return prepare_image(rgb, category)
    except Exception:
        log.exception("garment preparation failed for one photo")
        return PreparedGarment("rejected", 0.0, ["Не удалось обработать фото"])


def _finish(
    key: str,
    category: GarmentCategory,
    photos: list[PreparedPhoto],
    auto_kinds: tuple[str, ...] = ("model", "flatlay"),
) -> GarmentResult:
    usable = [p for p in photos if p.kind in auto_kinds and p.score >= MIN_USABLE_SCORE]
    best = max(usable, key=lambda p: p.score).index if usable else None
    reason = None
    if best is None:
        reason = NO_MODEL_PHOTO if auto_kinds == ("model",) else "Вещь не удалось разобрать на фото"
    result = GarmentResult(
        key=key, category=str(category), best_index=best, photos=photos, unusable_reason=reason
    )
    (garment_dir(key) / "garment.json").write_text(
        json.dumps(asdict(result), ensure_ascii=False, indent=2)
    )
    return result


def _save(out_dir: Path, i: int, url: str | None, p: PreparedGarment) -> PreparedPhoto:
    cutout_name = debug_name = None
    width = height = None
    if p.cutout is not None:
        cutout_name = f"{i}.png"
        Image.fromarray(p.cutout, "RGBA").save(out_dir / cutout_name, optimize=True)
        height, width = p.cutout.shape[:2]
    if p.debug is not None:
        debug_name = f"{i}_debug.jpg"
        Image.fromarray(p.debug).save(out_dir / debug_name, quality=85)
    return PreparedPhoto(
        index=i,
        source_url=url,
        kind=p.kind,
        score=p.score,
        reasons=p.reasons,
        cutout=cutout_name,
        debug=debug_name,
        width=width,
        height=height,
        keypoints={
            name: {"x": round(k.x, 1), "y": round(k.y, 1), "visibility": round(k.visibility, 2)}
            for name, k in p.keypoints.items()
        },
        body_profile=p.body_profile,
    )


async def _download(client: httpx.AsyncClient, url: str) -> np.ndarray | None:
    try:
        resp = await client.get(url)
        resp.raise_for_status()
    except httpx.HTTPError:
        return None
    return _decode(resp.content)


def _decode(data: bytes) -> np.ndarray:
    img = Image.open(io.BytesIO(data)).convert("RGB")
    img.thumbnail((settings.max_side, settings.max_side))
    return np.asarray(img)
