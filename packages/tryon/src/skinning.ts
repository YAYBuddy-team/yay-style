/**
 * 2D linear blend skinning: move a garment photographed on a model onto a user whose
 * limbs are posed differently.
 *
 * The body is a set of bones (torso or pelvis, upper/lower arms, thighs/shins). Each
 * bone gets its own transform from the model's pose to the user's pose; every point of
 * the garment moves by a blend of the transforms of the bones it is close to. So a
 * sleeve swings with the user's arm while the torso of the garment stays undistorted —
 * which a single smooth warp (TPS) can't do when an arm is raised on one side only.
 */

import { fitAffine, fitSimilarity, type Point, type Transform } from "./tps";
import type { GarmentCategory, KeypointName, Keypoints } from "./types";

type Seg = [KeypointName, KeypointName];

const ARM_BONES: { seg: Seg; parent: "core" | number }[] = [
  { seg: ["left_shoulder", "left_elbow"], parent: "core" },
  { seg: ["left_elbow", "left_wrist"], parent: 0 },
  { seg: ["right_shoulder", "right_elbow"], parent: "core" },
  { seg: ["right_elbow", "right_wrist"], parent: 2 },
];
const LEG_BONES: { seg: Seg; parent: "core" | number }[] = [
  { seg: ["left_hip", "left_knee"], parent: "core" },
  { seg: ["left_knee", "left_ankle"], parent: 0 },
  { seg: ["right_hip", "right_knee"], parent: "core" },
  { seg: ["right_knee", "right_ankle"], parent: 2 },
];

const BONES: Record<GarmentCategory, { seg: Seg; parent: "core" | number }[]> = {
  top: ARM_BONES,
  outerwear: ARM_BONES,
  full: ARM_BONES, // a skirt is a tube around both legs: it follows the core, not each leg
  bottom: LEG_BONES,
};

const MIN_VIS = 0.5;

function pt(kps: Keypoints, n: KeypointName): Point | null {
  const k = kps[n];
  return k && k.visibility >= MIN_VIS ? { x: k.x, y: k.y } : null;
}

export function fitSkinning(
  category: GarmentCategory,
  src: Keypoints,
  dst: Keypoints,
  /** Extra correction of the core (torso) placement in user space, e.g. widening it to
   * the user's silhouette. Limbs are left alone so sleeves aren't pushed outwards. */
  coreAdjust?: (p: Point) => Point,
): Transform | null {
  const base = coreBone(category, src, dst);
  if (!base) return null;
  const core: Core = coreAdjust
    ? { ...base, t: (x, y) => coreAdjust(base.t(x, y)) }
    : base;

  const bones: { a: Point; b: Point; t: Transform }[] = [];
  const defs = BONES[category];
  const fitted: (Transform | null)[] = [];
  for (const def of defs) {
    const [na, nb] = def.seg;
    const sa = pt(src, na);
    const sb = pt(src, nb);
    const da = pt(dst, na);
    const db = pt(dst, nb);
    const parent = def.parent === "core" ? core.t : fitted[def.parent] ?? core.t;
    let t: Transform;
    if (sa && sb && da && db) {
      t = segmentTransform(sa, sb, da, db, core.scale);
    } else {
      t = parent; // limb not visible on one side: let it hang with its parent
    }
    fitted.push(t);
    if (sa && sb) bones.push({ a: sa, b: sb, t });
  }

  // Inverse-distance weights with a sharp falloff: the nearest bone wins, neighbours blend
  // only in a narrow band. (Gaussian weights let the torso pull in sleeves that hang
  // right next to it.) `soft` keeps the blend smooth where distances are similar.
  const soft = 0.06 * core.width;
  const weight = (d: number) => 1 / (d + soft) ** 4;
  return (x, y) => {
    const p = { x, y };
    const coreD = core.inside(p) ? 0 : core.distance(p);
    const c = core.t(x, y);
    let wSum = weight(coreD);
    let ox = c.x * wSum;
    let oy = c.y * wSum;
    for (const bone of bones) {
      // Inside the torso, limbs get a reduced say, so an arm held across the body
      // doesn't drag the front of the shirt with it.
      const w = weight(segDistance(p, bone.a, bone.b)) * (coreD === 0 ? 0.15 : 1);
      const q = bone.t(x, y);
      ox += q.x * w;
      oy += q.y * w;
      wSum += w;
    }
    return { x: ox / wSum, y: oy / wSum };
  };
}

interface Core {
  t: Transform;
  scale: number; // how much the body is scaled across (for limb thickness)
  width: number; // source body width, sets the blending radius
  inside: (p: Point) => boolean;
  distance: (p: Point) => number;
}

function coreBone(category: GarmentCategory, src: Keypoints, dst: Keypoints): Core | null {
  const names: KeypointName[] =
    category === "bottom"
      ? ["left_hip", "right_hip"]
      : ["left_shoulder", "right_shoulder", "left_hip", "right_hip"];
  const s = names.map((n) => pt(src, n));
  const d = names.map((n) => pt(dst, n));
  if (s.some((p) => !p) || d.some((p) => !p)) return null;
  const sp = s as Point[];
  const dp = d as Point[];

  if (category === "bottom") {
    // Pelvis: hips only, so a similarity (no reliable vertical reference).
    const t = fitSimilarity(sp, dp);
    const width = dist(sp[0]!, sp[1]!) * 1.6;
    const scale = dist(dp[0]!, dp[1]!) / Math.max(dist(sp[0]!, sp[1]!), 1);
    const mid = { x: (sp[0]!.x + sp[1]!.x) / 2, y: (sp[0]!.y + sp[1]!.y) / 2 };
    // Pelvis region: a band around the hip line, down to the crotch.
    const band = (p: Point) => Math.max(0, Math.abs(p.x - mid.x) - width / 2) +
      Math.max(0, p.y - (mid.y + width * 0.35)) + Math.max(0, mid.y - width * 0.6 - p.y);
    return { t, scale, width, inside: (p) => band(p) === 0, distance: band };
  }

  const t = fitAffine(sp, dp);
  const width = dist(sp[0]!, sp[1]!);
  // The core region runs below the hips: a hem (or a whole skirt) hangs from the torso,
  // and must not be pulled by a hand that happens to rest next to it.
  const below = category === "full" ? 2.0 : 0.6;
  const [ls, rs, lh, rh] = sp as [Point, Point, Point, Point];
  const down = (h: Point, s: Point) => ({ x: h.x + (h.x - s.x) * below, y: h.y + (h.y - s.y) * below });
  const poly = expand([ls, rs, down(rh, rs), down(lh, ls)], 1.15);
  return {
    t,
    scale: Math.sqrt(Math.abs(t.det)),
    width,
    inside: (p) => inPolygon(p, poly),
    distance: (p) => polyDistance(p, poly),
  };
}

/** Rotate + scale a limb segment onto the target: along the bone by the length ratio,
 * across it by the body's scale (so sleeves don't balloon on long arms). */
function segmentTransform(sa: Point, sb: Point, da: Point, db: Point, across: number): Transform {
  const sl = Math.max(dist(sa, sb), 1e-3);
  const dl = Math.max(dist(da, db), 1e-3);
  const su = { x: (sb.x - sa.x) / sl, y: (sb.y - sa.y) / sl };
  const du = { x: (db.x - da.x) / dl, y: (db.y - da.y) / dl };
  const along = dl / sl;
  return (x, y) => {
    const rx = x - sa.x;
    const ry = y - sa.y;
    const l = rx * su.x + ry * su.y; // along the bone
    const w = -rx * su.y + ry * su.x; // across (perpendicular, left-hand)
    return {
      x: da.x + along * l * du.x - across * w * du.y,
      y: da.y + along * l * du.y + across * w * du.x,
    };
  };
}

function dist(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function segDistance(p: Point, a: Point, b: Point): number {
  const vx = b.x - a.x;
  const vy = b.y - a.y;
  const len2 = vx * vx + vy * vy || 1;
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * vx + (p.y - a.y) * vy) / len2));
  return Math.hypot(p.x - (a.x + t * vx), p.y - (a.y + t * vy));
}

function expand(ps: Point[], f: number): Point[] {
  const cx = ps.reduce((s, p) => s + p.x, 0) / ps.length;
  const cy = ps.reduce((s, p) => s + p.y, 0) / ps.length;
  return ps.map((p) => ({ x: cx + (p.x - cx) * f, y: cy + (p.y - cy) * f }));
}

function inPolygon(p: Point, poly: Point[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i]!;
    const b = poly[j]!;
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) {
      inside = !inside;
    }
  }
  return inside;
}

function polyDistance(p: Point, poly: Point[]): number {
  let best = Infinity;
  for (let i = 0; i < poly.length; i++) {
    best = Math.min(best, segDistance(p, poly[i]!, poly[(i + 1) % poly.length]!));
  }
  return best;
}
