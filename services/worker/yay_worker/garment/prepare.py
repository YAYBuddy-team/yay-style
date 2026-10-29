"""Turn one product photo into a try-on-ready garment: cutout + anchor keypoints + score.

Two kinds of photos are handled:

* **model** — the garment is worn by a model. We take the model's pose as anchor points
  (the try-on engine warps model body → user body) and isolate the garment from the
  model's other clothes with the multiclass "clothes" mask, pose lines and colour.
* **flatlay** — the garment alone on a plain background. Anchor points are estimated
  from the silhouette with per-category heuristics.

Everything here is classic CV on top of open detectors; nothing is generated.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Literal

import cv2
import numpy as np

from ..marketplaces.base import GarmentCategory
from . import vision
from .vision import Keypoint, Pose

Kind = Literal["model", "flatlay", "rejected"]

# Anchors the warp cannot do without. Whether the garment itself is fully in the frame
# is checked separately on the mask (knees under a long dress are fine to miss).
_TORSO = ("left_shoulder", "right_shoulder", "left_hip", "right_hip")
REQUIRED_POINTS: dict[GarmentCategory, tuple[str, ...]] = {
    GarmentCategory.TOP: _TORSO,
    GarmentCategory.OUTERWEAR: _TORSO,
    GarmentCategory.FULL: _TORSO,
    GarmentCategory.BOTTOM: ("left_hip", "right_hip"),
}

FLATLAY_BASE_SCORE = 0.6  # anchors are estimated, so prefer a good model photo
# Plausible height/width of a flat-lay silhouette per category.
_ASPECT: dict[GarmentCategory, tuple[float, float]] = {
    GarmentCategory.TOP: (0.5, 1.9),
    GarmentCategory.OUTERWEAR: (0.5, 2.4),
    GarmentCategory.FULL: (0.9, 4.0),
    GarmentCategory.BOTTOM: (0.5, 4.0),
}
MIN_GARMENT_FRACTION = 0.03


@dataclass
class PreparedGarment:
    kind: Kind
    score: float
    reasons: list[str] = field(default_factory=list)
    keypoints: dict[str, Keypoint] = field(default_factory=dict)  # in cutout coordinates
    cutout: np.ndarray | None = None  # RGBA
    debug: np.ndarray | None = None  # RGB visualisation
    # Pixels inside the garment hidden by the model's hands/hair, to be painted over.
    fill: np.ndarray | None = None
    # Model photos only: the model's body width at chest / waist / hips and the shoulder
    # joint distance, in pixels. The try-on engine compares it with the user's to size
    # the garment by the body's silhouette rather than by joints alone.
    body_profile: dict[str, float] | None = None


def prepare_image(rgb: np.ndarray, category: GarmentCategory) -> PreparedGarment:
    if category is GarmentCategory.UNSUPPORTED:
        return PreparedGarment("rejected", 0.0, ["Категория пока не поддерживается"])

    poses = vision.detect_poses(rgb)
    seg = vision.segment_person(rgb)
    if poses and _is_usable_person(poses[0], seg):
        result, mask, kps = _prepare_model(rgb, seg, category, poses)
    else:
        result, mask, kps = _prepare_flatlay(rgb, seg, category)

    if mask is None or mask.mean() < MIN_GARMENT_FRACTION:
        result.kind = "rejected"
        result.score = 0.0
        result.reasons.append("Вещь не найдена на фото")
        result.debug = _draw_debug(rgb, mask, kps, result)
        return result

    if result.kind != "rejected" and _touches_frame(mask, category):
        result.reasons.append("Вещь обрезана краем кадра")
        result.score = round(result.score * 0.35, 3)

    result.debug = _draw_debug(rgb, mask, kps, result)
    if result.fill is not None and result.fill.any():
        # Hands or hair over the garment leave holes that would show the user's own
        # clothes through it; reconstruct them from the surrounding fabric. The region is
        # grown a little so the skin-coloured fringe around the hole is repainted too.
        k = max(5, int(0.012 * max(mask.shape))) | 1
        grown = cv2.dilate(result.fill.astype(np.uint8), np.ones((k, k), np.uint8)).astype(bool)
        grown &= mask | result.fill
        rgb = cv2.inpaint(rgb, grown.astype(np.uint8) * 255, 9, cv2.INPAINT_TELEA)
        mask = mask | result.fill
    result.cutout, offset = _cutout(rgb, mask)
    result.keypoints = {
        name: Keypoint(k.x - offset[0], k.y - offset[1], k.visibility) for name, k in kps.items()
    }
    return result


# --------------------------------------------------------------------------- model photos


def _located(pose: Pose, *names: str) -> bool:
    return all(pose[n].visibility > 0.5 for n in names)


def _is_usable_person(pose: Pose, seg: np.ndarray) -> bool:
    """Pose anchors are trusted only when the face is really in the frame: on a legs-only
    crop MediaPipe still returns a confident skeleton squeezed into the visible part
    (shoulders on the waistband, hips mid-thigh, a "nose" on the shirt), which would
    misplace the garment entirely. So we check for face skin around the nose."""
    h, w = seg.shape
    if not _located(pose, "nose", "left_shoulder", "right_shoulder"):
        return False
    if vision.pose_extent(pose) < 0.25 * h:
        return False
    nose = pose["nose"]
    r = max(6, int(0.15 * abs(pose["left_shoulder"].x - pose["right_shoulder"].x)))
    y0, y1 = max(0, int(nose.y) - r), min(h, int(nose.y) + r)
    x0, x1 = max(0, int(nose.x) - r), min(w, int(nose.x) + r)
    box = seg[y0:y1, x0:x1]
    return box.size > 0 and (box == vision.SEG_FACE_SKIN).mean() > 0.2


def _touches_frame(mask: np.ndarray, category: GarmentCategory) -> bool:
    """A garment cut by the image border can't be placed whole on the user. Sides and
    bottom matter; the top edge only for bottoms (a cropped waistband)."""
    h, w = mask.shape
    edges = [mask[-1, :].mean(), mask[:, 0].mean() * w / h, mask[:, -1].mean() * w / h]
    if category is GarmentCategory.BOTTOM:
        edges.append(mask[0, :].mean())
    return max(edges) > 0.04


def _prepare_model(
    rgb: np.ndarray, seg: np.ndarray, category: GarmentCategory, poses: list[Pose]
) -> tuple[PreparedGarment, np.ndarray | None, dict[str, Keypoint]]:
    pose = poses[0]
    reasons: list[str] = []
    score = 1.0

    required = REQUIRED_POINTS[category]
    vis = min(pose[p].visibility for p in required)
    if vis < 0.5:
        reasons.append("На фото видна не вся вещь или фигура")
        score *= 0.3

    if (
        len(poses) > 1 and vision.pose_extent(poses[1]) > 0.6 * vision.pose_extent(pose)
    ) or _several_people(seg):
        # A second person's clothes leak into the cutout (same "clothes" class), and the
        # result can't be trusted: never pick such a photo.
        reasons.append("На фото несколько людей")
        score *= 0.1

    ls, rs, lh, rh = (pose[n] for n in _TORSO)
    hip_y = (lh.y + rh.y) / 2
    sh_y = (ls.y + rs.y) / 2
    torso = hip_y - sh_y
    if torso <= 0:
        return PreparedGarment("rejected", 0.0, ["Не удалось определить позу"]), None, {}

    # The person's left side appears on the image's right when they face the camera.
    if ls.x < rs.x:
        reasons.append("Модель стоит спиной")
        score *= 0.3
    elif abs(ls.x - rs.x) / torso < 0.45:
        reasons.append("Боковой ракурс")
        score *= 0.4

    if _arms_over_torso(pose, sh_y, hip_y):
        reasons.append("Руки перекрывают вещь")
        score *= 0.7

    alpha = vision.foreground_alpha(rgb)
    clothes = (seg == vision.SEG_CLOTHES) & (alpha > 127)
    mask = _isolate_garment(rgb, clothes, pose, category, sh_y, hip_y, torso)

    kps = {name: k for name, k in pose.items() if name != "nose"}
    result = PreparedGarment("model", round(score * max(vis, 0.0), 3), reasons)
    result.fill = _occluded_holes(mask, seg)
    result.body_profile = body_profile(
        (seg == vision.SEG_BODY_SKIN) | (seg == vision.SEG_CLOTHES), pose
    )
    return result, mask, kps


def _several_people(seg: np.ndarray) -> bool:
    """Two separate person-shaped blobs of comparable size (pose detection often finds
    only the person facing the camera)."""
    person = (seg != vision.SEG_BACKGROUND).astype(np.uint8)
    _n, _, stats, _ = cv2.connectedComponentsWithStats(person, 8)
    areas = sorted((a for a in stats[1:, cv2.CC_STAT_AREA] if a > 0.02 * person.size), reverse=True)
    return len(areas) > 1 and areas[1] > 0.3 * areas[0]


# Rows where the body width is measured, as fractions of the shoulder→hip distance below
# the shoulder line. Must match packages/tryon/src/profile.ts.
PROFILE_ROWS = {"chest": 0.3, "waist": 0.65, "hip": 1.05}


def body_profile(person: np.ndarray, pose: Pose) -> dict[str, float] | None:
    """Width of the body silhouette (skin + clothes, arms removed) at chest, waist and
    hips, measured as the run of person pixels that contains the torso's midline."""
    if not _located(pose, *_TORSO):
        return None
    h, w = person.shape
    ls, rs, lh, rh = (pose[n] for n in _TORSO)
    sh = ((ls.x + rs.x) / 2, (ls.y + rs.y) / 2)
    hp = ((lh.x + rh.x) / 2, (lh.y + rh.y) / 2)
    torso = hp[1] - sh[1]
    shoulder = float(np.hypot(ls.x - rs.x, ls.y - rs.y))
    if torso <= 0 or shoulder <= 0:
        return None

    body = person.astype(np.uint8)
    # Arms hanging next to the body would add to its width: carve them out.
    r = max(1, int(0.12 * shoulder))
    for a, b in (
        ("left_shoulder", "left_elbow"), ("left_elbow", "left_wrist"),
        ("right_shoulder", "right_elbow"), ("right_elbow", "right_wrist"),
    ):
        if _located(pose, a, b):
            pa, pb = pose[a], pose[b]
            cv2.line(body, (int(pa.x), int(pa.y)), (int(pb.x), int(pb.y)), 0, 2 * r)

    out: dict[str, float] = {"shoulder": round(shoulder, 1)}
    for name, f in PROFILE_ROWS.items():
        y = int(sh[1] + f * torso)
        x = int(sh[0] + (hp[0] - sh[0]) * f)
        if not (0 <= y < h and 0 <= x < w) or not body[y, x]:
            return None
        row = body[y]
        left = x
        while left > 0 and row[left - 1]:
            left -= 1
        right = x
        while right < w - 1 and row[right + 1]:
            right += 1
        out[name] = float(right - left + 1)
    return out


def _occluded_holes(mask: np.ndarray, seg: np.ndarray) -> np.ndarray:
    """Holes fully enclosed by the garment that the model's skin or hair covered.
    Enclosed background (the gap between an arm on the hip and the waist) stays a hole."""
    h, w = mask.shape
    # Pad with background so the flood starts outside even if the garment touches (0, 0).
    inv = np.pad((~mask).astype(np.uint8), 1, constant_values=1)
    cv2.floodFill(inv, np.zeros((h + 4, w + 4), np.uint8), (0, 0), 2)
    holes = inv[1:-1, 1:-1] == 1
    occluder = (seg == vision.SEG_BODY_SKIN) | (seg == vision.SEG_HAIR) | (
        seg == vision.SEG_FACE_SKIN
    ) | (seg == vision.SEG_OTHERS)
    n, labels, stats, _ = cv2.connectedComponentsWithStats(holes.astype(np.uint8), 8)
    fill = np.zeros_like(mask)
    limit = 0.15 * mask.sum()
    for i in range(1, n):
        part = labels == i
        if stats[i, cv2.CC_STAT_AREA] < limit and occluder[part].mean() > 0.5:
            fill |= part
    return fill


def _arms_over_torso(pose: Pose, sh_y: float, hip_y: float) -> bool:
    left = min(pose["left_shoulder"].x, pose["right_shoulder"].x)
    right = max(pose["left_shoulder"].x, pose["right_shoulder"].x)
    margin = 0.15 * (right - left)
    for wrist in (pose["left_wrist"], pose["right_wrist"]):
        if (
            wrist.visibility > 0.5
            and left + margin < wrist.x < right - margin
            and sh_y < wrist.y < hip_y
        ):
            return True
    return False


def _isolate_garment(
    rgb: np.ndarray,
    clothes: np.ndarray,
    pose: Pose,
    category: GarmentCategory,
    sh_y: float,
    hip_y: float,
    torso: float,
) -> np.ndarray:
    h, w = clothes.shape
    ys = np.arange(h)[:, None]
    lab = cv2.cvtColor(rgb, cv2.COLOR_RGB2LAB).astype(np.float32)

    sx = sorted([pose["left_shoulder"].x, pose["right_shoulder"].x])
    hx = sorted([pose["left_hip"].x, pose["right_hip"].x])
    top_core = _box_mask(
        (h, w), sx[0] + 0.2 * (sx[1] - sx[0]), sh_y + 0.25 * torso,
        sx[1] - 0.2 * (sx[1] - sx[0]), sh_y + 0.6 * torso,
    )
    bottom_core = _box_mask(
        (h, w), hx[0] - 0.1 * (hx[1] - hx[0]), hip_y + 0.15 * torso,
        hx[1] + 0.1 * (hx[1] - hx[0]), hip_y + 0.5 * torso,
    )
    top_color = _median_color(lab, clothes & top_core)
    bottom_color = _median_color(lab, clothes & bottom_core)
    split_by_color = (
        top_color is not None
        and bottom_color is not None
        and float(np.linalg.norm(top_color - bottom_color)) > 18
    )
    if split_by_color:
        closer_to_top = np.linalg.norm(lab - top_color, axis=2) < np.linalg.norm(
            lab - bottom_color, axis=2
        )

    if category is GarmentCategory.TOP:
        candidate = clothes & (ys < hip_y + 0.9 * torso)
        if split_by_color:
            candidate &= closer_to_top | (ys < hip_y - 0.1 * torso)
        else:
            candidate &= ys < hip_y + 0.15 * torso
        anchor = top_core
    elif category is GarmentCategory.BOTTOM:
        candidate = clothes & (ys > sh_y + 0.5 * torso)
        if split_by_color:
            candidate &= ~closer_to_top | (ys > hip_y + 0.2 * torso)
        else:
            candidate &= ys > hip_y - 0.1 * torso
        anchor = bottom_core
    elif category is GarmentCategory.OUTERWEAR:
        # Jackets vary in length, so only drop clearly different-coloured trousers below.
        candidate = clothes.copy()
        if split_by_color:
            candidate &= closer_to_top | (ys < hip_y - 0.15 * torso)
        anchor = top_core
    else:  # FULL
        candidate = clothes.copy()
        anchor = top_core

    candidate &= _body_envelope(pose, (h, w), sh_y, hip_y)
    # Sleeves are often a different print or colour than the body of the garment (the
    # palette comes from the chest), so the palette filter must not touch the arms.
    arms = _arm_capsules(pose, (h, w))
    candidate = np.where(arms, candidate, _drop_off_palette(lab, candidate, anchor))
    if category in (GarmentCategory.TOP, GarmentCategory.OUTERWEAR) and hip_y - 0.1 * torso < h:
        # Below the hem line, thin same-coloured strands are trouser shadows, not garment.
        # Only opened there, so thin straps of tank tops near the shoulders survive.
        hem = int(max(0, hip_y - 0.1 * torso))
        k = max(3, int(0.08 * torso)) | 1
        lower = cv2.morphologyEx(
            candidate[hem:].astype(np.uint8), cv2.MORPH_OPEN,
            cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (k, k)),
        )
        candidate[hem:] = lower.astype(bool)
    return _keep_components(_clean(candidate), anchor)


def _drop_off_palette(lab: np.ndarray, candidate: np.ndarray, core: np.ndarray) -> np.ndarray:
    """Remove pixels whose colour matches nothing in the garment's own palette.

    The palette comes from the core region (the middle of the garment, prints included),
    so a black bag or a tattooed leg touching a pink dress is dropped, while the dress's
    own folds and shadows stay (they are close in colour to some palette entry)."""
    core_px = lab[candidate & core]
    if len(core_px) < 200:
        return candidate
    sample = core_px[np.random.default_rng(0).choice(len(core_px), min(4000, len(core_px)))]
    k = 4
    _, _, centers = cv2.kmeans(
        sample.astype(np.float32), k, None,
        (cv2.TERM_CRITERIA_EPS + cv2.TERM_CRITERIA_MAX_ITER, 20, 1.0), 2, cv2.KMEANS_PP_CENTERS,
    )
    ys, xs = np.nonzero(candidate)
    px = lab[ys, xs]
    dist = np.min(np.linalg.norm(px[:, None, :] - centers[None, :, :], axis=2), axis=1)
    keep = candidate.copy()
    keep[ys[dist > 40], xs[dist > 40]] = False
    return keep


def _arm_capsules(pose: Pose, shape: tuple[int, int]) -> np.ndarray:
    """Thick lines along the upper and lower arms, outside the torso."""
    m = np.zeros(shape, np.uint8)
    sw = abs(pose["left_shoulder"].x - pose["right_shoulder"].x)
    r = max(2, int(0.3 * sw))
    for a, b in (
        ("left_shoulder", "left_elbow"), ("left_elbow", "left_wrist"),
        ("right_shoulder", "right_elbow"), ("right_elbow", "right_wrist"),
    ):
        pa, pb = pose[a], pose[b]
        cv2.line(m, (int(pa.x), int(pa.y)), (int(pb.x), int(pb.y)), 1, 2 * r)
    return m.astype(bool)


def _body_envelope(
    pose: Pose, shape: tuple[int, int], sh_y: float, hip_y: float
) -> np.ndarray:
    """Generous region around the skeleton that worn clothes can occupy. Cuts off what the
    segmenter wrongly calls "clothes": a bag, a chair cushion, a second person's sleeve."""
    _h, w = shape
    env = np.zeros(shape, np.uint8)
    p = {n: (int(k.x), int(k.y)) for n, k in pose.items()}
    hip_w = abs(pose["left_hip"].x - pose["right_hip"].x)
    if _located(pose, "left_shoulder", "right_shoulder"):
        sw = abs(pose["left_shoulder"].x - pose["right_shoulder"].x)
    else:
        sw = 1.3 * hip_w
    sw = max(sw, 0.05 * w)
    cx = (pose["left_hip"].x + pose["right_hip"].x) / 2

    # Torso, scaled outwards around its centre.
    quad = np.array(
        [p["left_shoulder"], p["right_shoulder"], p["right_hip"], p["left_hip"]], np.float32
    )
    centre = quad.mean(axis=0)
    cv2.fillConvexPoly(env, ((quad - centre) * 1.45 + centre).astype(np.int32), 1)
    # Collar / hood zone.
    neck = ((p["left_shoulder"][0] + p["right_shoulder"][0]) // 2, int(sh_y))
    cv2.circle(env, neck, int(0.6 * sw), 1, -1)
    # Limbs as thick capsules (wide sleeves, flared trousers).
    r = max(2, int(0.45 * sw))
    for a, b in (
        ("left_shoulder", "left_elbow"), ("left_elbow", "left_wrist"),
        ("right_shoulder", "right_elbow"), ("right_elbow", "right_wrist"),
        ("left_hip", "left_knee"), ("left_knee", "left_ankle"),
        ("right_hip", "right_knee"), ("right_knee", "right_ankle"),
    ):
        cv2.line(env, p[a], p[b], 1, 2 * r)
    # Skirt / dress / coat hem: a trapezoid flaring out below the hips.
    foot_y = max(pose["left_ankle"].y, pose["right_ankle"].y, hip_y + 2 * (hip_y - sh_y))
    skirt = np.array(
        [
            (cx - 0.9 * sw, hip_y - 0.1 * sw), (cx + 0.9 * sw, hip_y - 0.1 * sw),
            (cx + 1.6 * sw, foot_y), (cx - 1.6 * sw, foot_y),
        ],
        np.int32,
    )
    cv2.fillConvexPoly(env, skirt, 1)
    return env.astype(bool)


def _box_mask(shape: tuple[int, int], x0: float, y0: float, x1: float, y1: float) -> np.ndarray:
    h, w = shape
    m = np.zeros(shape, bool)
    m[max(0, int(y0)) : min(h, int(y1)), max(0, int(x0)) : min(w, int(x1))] = True
    return m


def _median_color(lab: np.ndarray, region: np.ndarray) -> np.ndarray | None:
    if region.sum() < 50:
        return None
    return np.median(lab[region], axis=0)


# ------------------------------------------------------------------------ flat-lay photos


def _prepare_flatlay(
    rgb: np.ndarray, seg: np.ndarray, category: GarmentCategory
) -> tuple[PreparedGarment, np.ndarray | None, dict[str, Keypoint]]:
    reasons: list[str] = []
    score = FLATLAY_BASE_SCORE
    fg = vision.foreground_alpha(rgb) > 127

    # A cropped shot of a model (legs only, torso only) has no usable pose but still
    # shows skin and shoes; keep only the "clothes" pixels in that case.
    skin = (seg == vision.SEG_BODY_SKIN) | (seg == vision.SEG_FACE_SKIN)
    if skin.mean() > 0.01 and (fg & (seg == vision.SEG_CLOTHES)).mean() > MIN_GARMENT_FRACTION:
        fg &= seg == vision.SEG_CLOTHES
        reasons.append("Фрагмент фигуры модели")
        score *= 0.8
    mask = _clean(fg)

    n, labels, stats, _ = cv2.connectedComponentsWithStats(mask.astype(np.uint8), 8)
    areas = sorted(stats[1:, cv2.CC_STAT_AREA], reverse=True) if n > 1 else []
    if not areas:
        return PreparedGarment("rejected", 0.0, ["Вещь не найдена на фото"]), None, {}
    if len(areas) > 1 and areas[1] > 0.3 * areas[0]:
        reasons.append("Похоже на коллаж из нескольких вещей")
        score *= 0.4
    # Text-heavy slides (care instructions, size charts) break into many small blobs.
    if sum(a > 0.0005 * mask.size for a in areas) > 25:
        reasons.append("Похоже на инфографику с текстом")
        score *= 0.2
    biggest = 1 + int(np.argmax(stats[1:, cv2.CC_STAT_AREA]))
    mask = labels == biggest

    _x, _y, bw, bh = stats[biggest, :4]
    fill = areas[0] / float(bw * bh)
    if fill > 0.9 and bw * bh > 0.3 * mask.size:
        # Garments are never near-perfect rectangles; tables and banners are.
        reasons.append("Похоже на таблицу или баннер, а не на вещь")
        score *= 0.1
    lo, hi = _ASPECT[category]
    if not lo <= bh / bw <= hi:
        reasons.append("Необычная для категории форма")
        score *= 0.5
    if mask.mean() > 0.9:
        reasons.append("Не удалось отделить вещь от фона")
        score *= 0.2

    kps = _flatlay_keypoints(mask, category)
    if not kps:
        return PreparedGarment("rejected", 0.0, ["Не удалось разметить вещь"]), mask, {}
    return PreparedGarment("flatlay", round(score, 3), reasons), mask, kps


def _row_extent(mask: np.ndarray, y: float) -> tuple[float, float] | None:
    y = int(np.clip(y, 0, mask.shape[0] - 1))
    xs = np.flatnonzero(mask[y])
    return (float(xs[0]), float(xs[-1])) if xs.size else None


def _flatlay_keypoints(mask: np.ndarray, category: GarmentCategory) -> dict[str, Keypoint]:
    ys, _xs = np.nonzero(mask)
    top, bottom = float(ys.min()), float(ys.max())
    h = bottom - top
    if h < 10:
        return {}
    est = 0.5  # visibility for estimated anchors
    kp: dict[str, Keypoint] = {}

    if category is GarmentCategory.BOTTOM:
        hips = _row_extent(mask, top + 0.12 * h)
        if not hips:
            return {}
        cx = (hips[0] + hips[1]) / 2
        foot = mask[int(bottom - 0.08 * h) : int(bottom) + 1]
        _fy, fx = np.nonzero(foot)
        # Garment faces the viewer: the person's right leg is on the image's left.
        r_x = float(fx[fx < cx].mean()) if (fx < cx).any() else hips[0]
        l_x = float(fx[fx >= cx].mean()) if (fx >= cx).any() else hips[1]
        kp["right_hip"] = Keypoint(hips[0], top + 0.12 * h, est)
        kp["left_hip"] = Keypoint(hips[1], top + 0.12 * h, est)
        kp["right_ankle"] = Keypoint(r_x, bottom, est)
        kp["left_ankle"] = Keypoint(l_x, bottom, est)
        for side in ("left", "right"):
            hip, ankle = kp[f"{side}_hip"], kp[f"{side}_ankle"]
            kp[f"{side}_knee"] = Keypoint((hip.x + ankle.x) / 2, (hip.y + ankle.y) / 2, est)
        return kp

    torso_row = top + (0.3 if category is GarmentCategory.FULL else 0.55) * h
    torso = _row_extent(mask, torso_row)
    if not torso:
        return {}
    shoulder_y = top + 0.06 * h
    width = torso[1] - torso[0]
    hip_y = bottom - 0.03 * h if category is GarmentCategory.TOP else min(
        bottom, shoulder_y + 1.35 * width
    )
    kp["right_shoulder"] = Keypoint(torso[0], shoulder_y, est)
    kp["left_shoulder"] = Keypoint(torso[1], shoulder_y, est)
    hips = _row_extent(mask, hip_y) or torso
    kp["right_hip"] = Keypoint(hips[0], hip_y, est)
    kp["left_hip"] = Keypoint(hips[1], hip_y, est)

    # Sleeves: silhouette extremes in the upper part that stick out past the torso.
    upper = mask[int(top) : int(top + 0.75 * h)]
    uy, ux = np.nonzero(upper)
    if ux.size:
        for side, idx, beyond in (
            ("right", int(np.argmin(ux)), torso[0] - ux.min()),
            ("left", int(np.argmax(ux)), ux.max() - torso[1]),
        ):
            if beyond > 0.15 * width:
                wrist = Keypoint(float(ux[idx]), float(uy[idx] + top), est)
                shoulder = kp[f"{side}_shoulder"]
                kp[f"{side}_wrist"] = wrist
                kp[f"{side}_elbow"] = Keypoint(
                    (shoulder.x + wrist.x) / 2, (shoulder.y + wrist.y) / 2, est
                )

    if category is GarmentCategory.FULL and bottom > hip_y + 0.3 * (hip_y - shoulder_y):
        knee_y = min(bottom, hip_y + 0.9 * (hip_y - shoulder_y))
        knees = _row_extent(mask, knee_y) or hips
        kp["right_knee"] = Keypoint(knees[0], knee_y, est)
        kp["left_knee"] = Keypoint(knees[1], knee_y, est)
    return kp


# ------------------------------------------------------------------------------- helpers


def _clean(mask: np.ndarray) -> np.ndarray:
    m = mask.astype(np.uint8)
    k = max(3, int(min(m.shape) * 0.004)) | 1
    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (k, k))
    m = cv2.morphologyEx(m, cv2.MORPH_CLOSE, kernel)
    m = cv2.morphologyEx(m, cv2.MORPH_OPEN, kernel)
    return m.astype(bool)


def _keep_components(mask: np.ndarray, anchor: np.ndarray) -> np.ndarray:
    """Keep connected pieces that touch the anchor region (or the largest one)."""
    n, labels, stats, _ = cv2.connectedComponentsWithStats(mask.astype(np.uint8), 8)
    if n <= 1:
        return mask
    touching = np.unique(labels[anchor & mask])
    touching = touching[touching != 0]
    if touching.size == 0:
        touching = np.array([1 + int(np.argmax(stats[1:, cv2.CC_STAT_AREA]))])
    min_area = 0.002 * mask.size
    keep = [i for i in touching if stats[i, cv2.CC_STAT_AREA] >= min_area] or list(touching)
    return np.isin(labels, keep)


def _cutout(rgb: np.ndarray, mask: np.ndarray) -> tuple[np.ndarray, tuple[int, int]]:
    ys, xs = np.nonzero(mask)
    h, w = mask.shape
    pad = int(0.04 * max(h, w))
    x0, y0 = max(0, xs.min() - pad), max(0, ys.min() - pad)
    x1, y1 = min(w, xs.max() + pad + 1), min(h, ys.max() + pad + 1)
    alpha = cv2.GaussianBlur(mask.astype(np.uint8) * 255, (0, 0), 1.2)
    rgba = np.dstack([rgb, alpha])[y0:y1, x0:x1]
    return np.ascontiguousarray(rgba), (int(x0), int(y0))


_SKELETON = [
    ("left_shoulder", "right_shoulder"), ("left_shoulder", "left_elbow"),
    ("left_elbow", "left_wrist"), ("right_shoulder", "right_elbow"),
    ("right_elbow", "right_wrist"), ("left_shoulder", "left_hip"),
    ("right_shoulder", "right_hip"), ("left_hip", "right_hip"), ("left_hip", "left_knee"),
    ("left_knee", "left_ankle"), ("right_hip", "right_knee"), ("right_knee", "right_ankle"),
]


def _draw_debug(
    rgb: np.ndarray, mask: np.ndarray | None, kps: dict[str, Keypoint], res: PreparedGarment
) -> np.ndarray:
    out = (rgb * 0.45).astype(np.uint8)
    if mask is not None:
        out[mask] = (rgb[mask] * 0.6 + np.array([255, 60, 140]) * 0.4).astype(np.uint8)
    for a, b in _SKELETON:
        if a in kps and b in kps:
            pa = (int(kps[a].x), int(kps[a].y))
            pb = (int(kps[b].x), int(kps[b].y))
            cv2.line(out, pa, pb, (80, 220, 255), 2, cv2.LINE_AA)
    for k in kps.values():
        color = (60, 255, 120) if k.visibility >= 0.5 else (255, 200, 0)
        cv2.circle(out, (int(k.x), int(k.y)), 5, color, -1, cv2.LINE_AA)
    label = f"{res.kind} score={res.score:.2f}"
    cv2.putText(out, label, (12, 32), cv2.FONT_HERSHEY_SIMPLEX, 0.9, (255, 255, 255), 2)
    return out
