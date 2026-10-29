/**
 * Fit a garment onto a person: build a deformed triangle mesh in person-photo pixels.
 *
 * - Model photos: the garment's keypoints are the model's joints, so skeletal skinning
 *   (see skinning.ts) carries the garment from the model's pose to the user's: the torso
 *   follows shoulders and hips, sleeves and trouser legs follow each limb segment. A
 *   thin-plate spline is the fallback when the core joints are missing.
 * - Flat-lay photos: keypoints are silhouette estimates at the garment's edges, so only a
 *   similarity transform is used, aimed at the user's estimated body edges.
 */

import { type BodyProfile, widenToSilhouette } from "./profile";
import { fitSkinning } from "./skinning";
import { fitSimilarity, fitTps, type Point, type Transform } from "./tps";
import type {
  GarmentAsset,
  GarmentCategory,
  KeypointName,
  Keypoints,
  LayerAdjust,
  PersonAnalysis,
} from "./types";

const ANCHORS: Record<GarmentCategory, KeypointName[]> = {
  top: [
    "left_shoulder", "right_shoulder", "left_elbow", "right_elbow",
    "left_wrist", "right_wrist", "left_hip", "right_hip",
  ],
  outerwear: [
    "left_shoulder", "right_shoulder", "left_elbow", "right_elbow",
    "left_wrist", "right_wrist", "left_hip", "right_hip",
  ],
  full: [
    "left_shoulder", "right_shoulder", "left_elbow", "right_elbow",
    "left_wrist", "right_wrist", "left_hip", "right_hip", "left_knee", "right_knee",
  ],
  bottom: ["left_hip", "right_hip", "left_knee", "right_knee", "left_ankle", "right_ankle"],
};

const FLATLAY_ANCHORS: Record<GarmentCategory, KeypointName[]> = {
  top: ["left_shoulder", "right_shoulder", "left_hip", "right_hip"],
  outerwear: ["left_shoulder", "right_shoulder", "left_hip", "right_hip"],
  full: ["left_shoulder", "right_shoulder"],
  bottom: ["left_hip", "right_hip"],
};

/**
 * MediaPipe joints sit inside the body outline (hip joints especially), while flat-lay
 * anchors sit on the garment's edges. Widen the user's joint pairs to approximate where
 * the garment edge should land.
 */
const EDGE_WIDEN: Partial<Record<KeypointName, number>> = {
  left_shoulder: 1.18,
  right_shoulder: 1.18,
  left_hip: 1.7,
  right_hip: 1.7,
};

const MIN_VISIBILITY = 0.5;
const TPS_LAMBDA = 0.002;

export interface GarmentMesh {
  positions: Float32Array; // x,y in person pixels
  uvs: Float32Array; // 0..1 texture coords
  indices: Uint32Array;
  /** Debug: where each matched garment keypoint landed. */
  landed: { name: KeypointName; from: Point; to: Point }[];
}

export class FitError extends Error {}

export function fitGarment(
  asset: GarmentAsset,
  person: PersonAnalysis,
  adjust: LayerAdjust,
  gridCols = 40,
): GarmentMesh {
  const { transform, matched } = baseTransform(asset, person);
  const anchor = anchorPoint(asset.category, person.keypoints);
  const shoulderWidth = bodyWidth(person.keypoints, person.width);
  const adjusted = withAdjust(transform, adjust, anchor, shoulderWidth);

  const cols = gridCols;
  const rows = Math.max(2, Math.round((gridCols * asset.height) / asset.width));
  const positions = new Float32Array((cols + 1) * (rows + 1) * 2);
  const uvs = new Float32Array((cols + 1) * (rows + 1) * 2);
  let i = 0;
  for (let r = 0; r <= rows; r++) {
    for (let c = 0; c <= cols; c++) {
      const u = c / cols;
      const v = r / rows;
      const p = adjusted(u * asset.width, v * asset.height);
      positions[i] = p.x;
      positions[i + 1] = p.y;
      uvs[i] = u;
      uvs[i + 1] = v;
      i += 2;
    }
  }
  const indices = new Uint32Array(cols * rows * 6);
  let k = 0;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const a = r * (cols + 1) + c;
      const b = a + 1;
      const d = a + cols + 1;
      const e = d + 1;
      indices.set([a, b, d, b, e, d], k);
      k += 6;
    }
  }
  const landed = matched.map((m) => ({ name: m.name, from: m.src, to: adjusted(m.src.x, m.src.y) }));
  return { positions, uvs, indices, landed };
}

interface Match {
  name: KeypointName;
  src: Point;
  dst: Point;
}

function seen(kps: Keypoints, name: KeypointName): boolean {
  return (kps[name]?.visibility ?? 0) >= MIN_VISIBILITY;
}

function baseTransform(
  asset: GarmentAsset,
  analysis: PersonAnalysis,
): { transform: Transform; matched: Match[] } {
  const person = analysis.keypoints;
  const flat = asset.kind === "flatlay";
  const names = (flat ? FLATLAY_ANCHORS : ANCHORS)[asset.category];
  // Flat-lay anchors are estimates (visibility 0.5), so accept them as they come.
  const garmentOk = (n: KeypointName) =>
    flat ? asset.keypoints[n] !== undefined : seen(asset.keypoints, n);
  const usable = names.filter((n) => garmentOk(n) && seen(person, n));
  const targets = flat ? widenPairs(person, usable, analysis.bodyProfile) : person;

  const matched: Match[] = usable.map((name) => ({
    name,
    src: { x: asset.keypoints[name]!.x, y: asset.keypoints[name]!.y },
    dst: { x: targets[name]!.x, y: targets[name]!.y },
  }));
  if (matched.length < 2) {
    throw new FitError("Не хватает точек на фото, чтобы приложить вещь");
  }
  const src = matched.map((m) => m.src);
  const dst = matched.map((m) => m.dst);
  if (flat || matched.length < 4) return { transform: fitSimilarity(src, dst), matched };
  // Size the torso by the silhouettes (benchmark r1: joints alone made garments too narrow
  // on fuller figures and let the user's own looser clothes show at the sides).
  const widen =
    asset.bodyProfile && analysis.bodyProfile && asset.category !== "bottom"
      ? widenToSilhouette(analysis.bodyProfile, asset.bodyProfile, person) ?? undefined
      : undefined;
  const skinned = fitSkinning(asset.category, asset.keypoints, person, widen);
  if (skinned) return { transform: skinned, matched };
  try {
    return { transform: fitTps(src, dst, TPS_LAMBDA), matched };
  } catch {
    return { transform: fitSimilarity(src, dst), matched };
  }
}

function widenPairs(kps: Keypoints, names: KeypointName[], profile: BodyProfile | null): Keypoints {
  const out: Keypoints = { ...kps };
  for (const [l, r] of [
    ["left_shoulder", "right_shoulder"],
    ["left_hip", "right_hip"],
  ] as const) {
    const a = kps[l];
    const b = kps[r];
    if (!a || !b || !names.includes(l) || !names.includes(r)) continue;
    const joints = Math.hypot(a.x - b.x, a.y - b.y) || 1;
    // With a measured silhouette, aim the garment's edges at the body's real edges.
    const measured = profile ? (l === "left_shoulder" ? profile.chest : profile.hip) / joints : null;
    const f = measured
      ? Math.min(l === "left_shoulder" ? 1.9 : 2.6, Math.max(l === "left_shoulder" ? 1.1 : 1.4, measured))
      : EDGE_WIDEN[l] ?? 1;
    const cx = (a.x + b.x) / 2;
    const cy = (a.y + b.y) / 2;
    out[l] = { ...a, x: cx + (a.x - cx) * f, y: cy + (a.y - cy) * f };
    out[r] = { ...b, x: cx + (b.x - cx) * f, y: cy + (b.y - cy) * f };
  }
  return out;
}

function mid(kps: Keypoints, a: KeypointName, b: KeypointName): Point | null {
  const p = kps[a];
  const q = kps[b];
  return p && q ? { x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 } : null;
}

/** Manual adjustments pivot here: shoulders for upper garments, waist for bottoms,
 * so "length" grows the garment downwards from where it hangs. */
function anchorPoint(category: GarmentCategory, kps: Keypoints): Point {
  const p =
    category === "bottom"
      ? mid(kps, "left_hip", "right_hip")
      : mid(kps, "left_shoulder", "right_shoulder");
  return p ?? { x: 0, y: 0 };
}

export function bodyWidth(kps: Keypoints, fallback: number): number {
  const ls = kps.left_shoulder;
  const rs = kps.right_shoulder;
  if (ls && rs) return Math.max(Math.hypot(ls.x - rs.x, ls.y - rs.y), 1);
  const lh = kps.left_hip;
  const rh = kps.right_hip;
  if (lh && rh) return Math.max(1.4 * Math.hypot(lh.x - rh.x, lh.y - rh.y), 1);
  return fallback * 0.25;
}

function withAdjust(t: Transform, adj: LayerAdjust, anchor: Point, sw: number): Transform {
  const rad = (adj.rotation * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const sx = adj.scale * adj.width;
  const sy = adj.scale * adj.length;
  return (x, y) => {
    const p = t(x, y);
    const dx = (p.x - anchor.x) * sx;
    const dy = (p.y - anchor.y) * sy;
    return {
      x: anchor.x + dx * cos - dy * sin + adj.dx * sw,
      y: anchor.y + dx * sin + dy * cos + adj.dy * sw,
    };
  };
}
