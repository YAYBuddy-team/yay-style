/**
 * Body width profile: silhouette width at chest, waist and hips plus the shoulder joint
 * distance. Measured the same way as on the backend (services/.../prepare.py,
 * `body_profile`): run of body pixels (skin + clothes, arms carved out) containing the
 * torso midline, on rows placed relative to the shoulder→hip distance.
 */

import type { Point } from "./tps";
import type { KeypointName, Keypoints } from "./types";

export interface BodyProfile {
  shoulder: number;
  chest: number;
  waist: number;
  hip: number;
}

/** Row positions as fractions of shoulder→hip distance below the shoulder line. */
export const PROFILE_ROWS = { chest: 0.3, waist: 0.65, hip: 1.05 } as const;

const ARMS: [KeypointName, KeypointName][] = [
  ["left_shoulder", "left_elbow"],
  ["left_elbow", "left_wrist"],
  ["right_shoulder", "right_elbow"],
  ["right_elbow", "right_wrist"],
];

const seen = (k: Keypoints, n: KeypointName) => (k[n]?.visibility ?? 0) > 0.5;

/**
 * @param body  per-pixel body mask (1 = skin or clothes) of size w×h
 * @param kps   keypoints in the same pixel space as the mask
 */
export function measureProfile(body: Uint8Array, w: number, h: number, kps: Keypoints): BodyProfile | null {
  const torsoNames: KeypointName[] = ["left_shoulder", "right_shoulder", "left_hip", "right_hip"];
  if (!torsoNames.every((n) => seen(kps, n))) return null;
  const ls = kps.left_shoulder!;
  const rs = kps.right_shoulder!;
  const lh = kps.left_hip!;
  const rh = kps.right_hip!;
  const sh = { x: (ls.x + rs.x) / 2, y: (ls.y + rs.y) / 2 };
  const hp = { x: (lh.x + rh.x) / 2, y: (lh.y + rh.y) / 2 };
  const torso = hp.y - sh.y;
  const shoulder = Math.hypot(ls.x - rs.x, ls.y - rs.y);
  if (torso <= 0 || shoulder <= 0) return null;

  const mask = new Uint8Array(body);
  const r = Math.max(1, Math.round(0.12 * shoulder));
  for (const [a, b] of ARMS) {
    if (seen(kps, a) && seen(kps, b)) clearCapsule(mask, w, h, kps[a]!, kps[b]!, r);
  }

  const out: BodyProfile = { shoulder, chest: 0, waist: 0, hip: 0 };
  for (const [name, f] of Object.entries(PROFILE_ROWS) as [keyof typeof PROFILE_ROWS, number][]) {
    const y = Math.trunc(sh.y + f * torso);
    const x = Math.trunc(sh.x + (hp.x - sh.x) * f);
    if (y < 0 || y >= h || x < 0 || x >= w || !mask[y * w + x]) return null;
    let left = x;
    while (left > 0 && mask[y * w + left - 1]) left--;
    let right = x;
    while (right < w - 1 && mask[y * w + right + 1]) right++;
    out[name] = right - left + 1;
  }
  return out;
}

function clearCapsule(mask: Uint8Array, w: number, h: number, a: Point, b: Point, r: number) {
  const len = Math.hypot(b.x - a.x, b.y - a.y);
  const steps = Math.max(1, Math.ceil(len / Math.max(1, r / 2)));
  for (let s = 0; s <= steps; s++) {
    const cx = a.x + ((b.x - a.x) * s) / steps;
    const cy = a.y + ((b.y - a.y) * s) / steps;
    for (let y = Math.max(0, Math.floor(cy - r)); y <= Math.min(h - 1, Math.ceil(cy + r)); y++) {
      for (let x = Math.max(0, Math.floor(cx - r)); x <= Math.min(w - 1, Math.ceil(cx + r)); x++) {
        if ((x - cx) ** 2 + (y - cy) ** 2 <= r * r) mask[y * w + x] = 0;
      }
    }
  }
}

export function scaleProfile(p: BodyProfile, k: number): BodyProfile {
  return { shoulder: p.shoulder * k, chest: p.chest * k, waist: p.waist * k, hip: p.hip * k };
}

/**
 * Horizontal stretch of the garment's torso so it covers the user's silhouette:
 * ratio of "body width relative to shoulder joints" between user and model, per row,
 * applied around the user's torso midline. Rows in between are interpolated.
 */
export function widenToSilhouette(
  user: BodyProfile,
  model: BodyProfile,
  userKps: Keypoints,
): ((p: Point) => Point) | null {
  const ls = userKps.left_shoulder;
  const rs = userKps.right_shoulder;
  const lh = userKps.left_hip;
  const rh = userKps.right_hip;
  if (!ls || !rs || !lh || !rh) return null;
  const sh = { x: (ls.x + rs.x) / 2, y: (ls.y + rs.y) / 2 };
  const hp = { x: (lh.x + rh.x) / 2, y: (lh.y + rh.y) / 2 };
  const torso = hp.y - sh.y;
  if (torso <= 0) return null;

  const factor = (row: "chest" | "waist" | "hip") =>
    clamp(user[row] / user.shoulder / (model[row] / model.shoulder), 0.9, 1.6);
  const stops: [number, number][] = [
    [PROFILE_ROWS.chest, factor("chest")],
    [PROFILE_ROWS.waist, factor("waist")],
    [PROFILE_ROWS.hip, factor("hip")],
  ];
  const kAt = (t: number) => {
    if (t <= stops[0]![0]) return stops[0]![1];
    for (let i = 1; i < stops.length; i++) {
      const [t0, k0] = stops[i - 1]!;
      const [t1, k1] = stops[i]!;
      if (t <= t1) return k0 + ((k1 - k0) * (t - t0)) / (t1 - t0);
    }
    return stops[stops.length - 1]![1];
  };
  return (p) => {
    const t = (p.y - sh.y) / torso;
    const cx = sh.x + (hp.x - sh.x) * clamp(t, 0, 1.2);
    return { x: cx + kAt(t) * (p.x - cx), y: p.y };
  };
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}
