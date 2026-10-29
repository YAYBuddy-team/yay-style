/**
 * Analyse the user's photo in the browser: pose keypoints, what must stay above clothes
 * (hair, face, hands), and photo-quality issues. The photo never leaves the device.
 */

import {
  FilesetResolver,
  ImageSegmenter,
  type NormalizedLandmark,
  PoseLandmarker,
} from "@mediapipe/tasks-vision";

import { type BodyProfile, measureProfile } from "./profile";
import {
  KEYPOINT_NAMES,
  type Keypoint,
  type Keypoints,
  type PersonAnalysis,
  type PersonClothing,
  type PhotoIssue,
} from "./types";

const MP_INDEX: Record<(typeof KEYPOINT_NAMES)[number], number> = {
  nose: 0,
  left_shoulder: 11,
  right_shoulder: 12,
  left_elbow: 13,
  right_elbow: 14,
  left_wrist: 15,
  right_wrist: 16,
  left_hip: 23,
  right_hip: 24,
  left_knee: 25,
  right_knee: 26,
  left_ankle: 27,
  right_ankle: 28,
};
// Hand landmarks (wrist, pinky, index, thumb) used to keep hands above the clothes.
const HAND_POINTS = [15, 17, 19, 21, 16, 18, 20, 22];

// selfie_multiclass_256x256 classes
const SEG_HAIR = 1;
const SEG_BODY_SKIN = 2;
const SEG_FACE_SKIN = 3;
const SEG_CLOTHES = 4;

const MODEL_BASE = "https://storage.googleapis.com/mediapipe-models";

export interface PersonAnalyzerOptions {
  /** Where the tasks-vision wasm files are served (self-hosted by the app). */
  wasmBaseUrl: string;
  poseModelUrl?: string;
  segmenterModelUrl?: string;
  /** Longest side the photo is reduced to before analysis and rendering. */
  maxSide?: number;
}

export class PersonAnalyzer {
  private constructor(
    private pose: PoseLandmarker,
    private segmenter: ImageSegmenter,
    private maxSide: number,
  ) {}

  static async create(opts: PersonAnalyzerOptions): Promise<PersonAnalyzer> {
    const fileset = await FilesetResolver.forVisionTasks(opts.wasmBaseUrl);
    const make = async <T>(fn: (delegate: "GPU" | "CPU") => Promise<T>): Promise<T> => {
      try {
        return await fn("GPU");
      } catch {
        return fn("CPU"); // no WebGL2 / unsupported GPU
      }
    };
    const pose = await make((delegate) =>
      PoseLandmarker.createFromOptions(fileset, {
        baseOptions: {
          modelAssetPath:
            opts.poseModelUrl ??
            `${MODEL_BASE}/pose_landmarker/pose_landmarker_full/float16/latest/pose_landmarker_full.task`,
          delegate,
        },
        runningMode: "IMAGE",
        numPoses: 2,
      }),
    );
    const segmenter = await make((delegate) =>
      ImageSegmenter.createFromOptions(fileset, {
        baseOptions: {
          modelAssetPath:
            opts.segmenterModelUrl ??
            `${MODEL_BASE}/image_segmenter/selfie_multiclass_256x256/float32/latest/selfie_multiclass_256x256.tflite`,
          delegate,
        },
        runningMode: "IMAGE",
        outputConfidenceMasks: true,
        outputCategoryMask: false,
      }),
    );
    return new PersonAnalyzer(pose, segmenter, opts.maxSide ?? 1280);
  }

  analyze(source: HTMLImageElement | ImageBitmap): PersonAnalysis {
    const image = downscale(source, this.maxSide);
    const { width, height } = image;

    const poseResult = this.pose.detect(image);
    const poses = [...poseResult.landmarks].sort((a, b) => extent(b) - extent(a));
    const main = poses[0];
    const keypoints: Keypoints = {};
    if (main) {
      for (const name of KEYPOINT_NAMES) {
        keypoints[name] = toKeypoint(main[MP_INDEX[name]]!, width, height);
      }
    }

    const seg = this.segmenter.segment(image);
    const masks = seg.confidenceMasks ?? [];
    const occluder = buildOccluder(image, masks, main, width, height);
    const classes = masks.length >= 5 ? readClasses(masks) : null;
    seg.close();

    const bodyProfile = classes ? profileFromClasses(classes, keypoints, width, height) : null;
    const clothing = classes
      ? detectClothing(classes, keypoints, width, height)
      : { longSleeves: false, handsOnBody: false };
    return {
      width,
      height,
      image,
      keypoints,
      occluder,
      bodyProfile,
      clothing,
      issues: [...photoIssues(poses, keypoints), ...clothingIssues(clothing)],
    };
  }

  close(): void {
    this.pose.close();
    this.segmenter.close();
  }
}

interface ClassMaps {
  w: number;
  h: number;
  skin: Float32Array;
  clothes: Float32Array;
}

function readClasses(masks: { width: number; height: number; getAsFloat32Array(): Float32Array }[]): ClassMaps {
  return {
    w: masks[0]!.width,
    h: masks[0]!.height,
    skin: masks[SEG_BODY_SKIN]!.getAsFloat32Array(),
    clothes: masks[SEG_CLOTHES]!.getAsFloat32Array(),
  };
}

/** Keypoints rescaled from photo pixels to mask pixels. */
function toMaskSpace(kps: Keypoints, sx: number, sy: number): Keypoints {
  const out: Keypoints = {};
  for (const [n, k] of Object.entries(kps) as [keyof Keypoints, Keypoint][]) {
    out[n] = { x: k.x * sx, y: k.y * sy, visibility: k.visibility };
  }
  return out;
}

function profileFromClasses(c: ClassMaps, kps: Keypoints, width: number, height: number): BodyProfile | null {
  const body = new Uint8Array(c.w * c.h);
  for (let i = 0; i < body.length; i++) body[i] = c.skin[i]! + c.clothes[i]! > 0.5 ? 1 : 0;
  const m = measureProfile(body, c.w, c.h, toMaskSpace(kps, c.w / width, c.h / height));
  if (!m) return null;
  const ls = kps.left_shoulder!;
  const rs = kps.right_shoulder!;
  // Widths are horizontal runs: scale back with the horizontal factor only.
  const k = width / c.w;
  return { shoulder: Math.hypot(ls.x - rs.x, ls.y - rs.y), chest: m.chest * k, waist: m.waist * k, hip: m.hip * k };
}

/**
 * Without a generative model we can't erase what the user is wearing, so clothes that
 * stick out from under a garment matter: long sleeves under a T-shirt, a long skirt
 * under trousers. Detected from the clothes/skin masks along the forearms and shins.
 */
function detectClothing(c: ClassMaps, kps: Keypoints, width: number, height: number) {
  const m = toMaskSpace(kps, c.w / width, c.h / height);
  const seen = (n: keyof Keypoints) => (m[n]?.visibility ?? 0) > 0.5;
  const at = (x: number, y: number) => {
    const xi = Math.round(x);
    const yi = Math.round(y);
    if (xi < 0 || yi < 0 || xi >= c.w || yi >= c.h) return null;
    return { clothes: c.clothes[yi * c.w + xi]!, skin: c.skin[yi * c.w + xi]! };
  };
  // Share of the middle of a segment that is covered by clothes rather than skin.
  const covered = (a: keyof Keypoints, b: keyof Keypoints) => {
    if (!seen(a) || !seen(b)) return null;
    let clothes = 0;
    let total = 0;
    for (let s = 0.2; s <= 0.8; s += 0.05) {
      const p = at(m[a]!.x + (m[b]!.x - m[a]!.x) * s, m[a]!.y + (m[b]!.y - m[a]!.y) * s);
      if (!p || p.clothes + p.skin < 0.5) continue;
      total++;
      if (p.clothes > p.skin) clothes++;
    }
    return total >= 4 ? clothes / total : null;
  };
  const forearms = [covered("left_elbow", "left_wrist"), covered("right_elbow", "right_wrist")].filter(
    (v): v is number => v !== null,
  );
  const longSleeves = forearms.length > 0 && forearms.every((v) => v > 0.6);
  // A long skirt under trousers would matter too, but "fabric between the shins" can't
  // tell a skirt from wide-leg trousers (2 of 3 false alarms in the benchmark set), so it
  // is deliberately not detected.
  return { longSleeves, handsOnBody: handsOnBody(c, m) };
}

/**
 * Hands resting on the body (in pockets, on the waist, crossed) are kept above the
 * garment by the occluder, so they read as holes in it (benchmark r2: hands in pockets
 * — 3/13 tops acceptable). Detected as hand skin inside the torso outline.
 */
function handsOnBody(c: ClassMaps, m: Keypoints): boolean {
  const names = ["left_shoulder", "right_shoulder", "right_hip", "left_hip"] as const;
  if (!names.every((n) => (m[n]?.visibility ?? 0) > 0.5)) return false;
  const [ls, rs, rh, lh] = names.map((n) => m[n]!);
  // Torso outline down to the pockets: hips extended by a quarter of the torso.
  const down = (h: Keypoint, s: Keypoint) => ({ x: h.x + (h.x - s.x) * 0.25, y: h.y + (h.y - s.y) * 0.25 });
  const poly = [ls!, rs!, down(rh!, rs!), down(lh!, ls!)];
  const sw = Math.hypot(ls!.x - rs!.x, ls!.y - rs!.y);
  const r = 0.35 * sw;
  let inside = 0;
  for (const w of [m.left_wrist, m.right_wrist]) {
    if (!w || w.visibility < 0.5) continue;
    for (let y = Math.max(0, Math.floor(w.y - r)); y < Math.min(c.h, w.y + r); y++) {
      for (let x = Math.max(0, Math.floor(w.x - r)); x < Math.min(c.w, w.x + r); x++) {
        const i = y * c.w + x;
        if (c.skin[i]! > 0.5 && (x - w.x) ** 2 + (y - w.y) ** 2 < r * r && inPolygon(x, y, poly)) inside++;
      }
    }
  }
  // Two hand-sized blobs of skin (a hand is roughly (0.2·shoulder width)²) inside the torso.
  return inside > 0.03 * sw * sw;
}

function inPolygon(x: number, y: number, poly: { x: number; y: number }[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i]!;
    const b = poly[j]!;
    if (a.y > y !== b.y > y && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

function clothingIssues(c: PersonClothing): PhotoIssue[] {
  const out: PhotoIssue[] = [];
  if (c.longSleeves) {
    out.push({
      code: "long_sleeves",
      severity: "warning",
      message: "Длинные рукава будут видны из-под футболок — лучше фото в майке или футболке",
    });
  }
  if (c.handsOnBody) {
    out.push({
      code: "hands_on_body",
      severity: "warning",
      message: "Руки на теле или в карманах будут поверх одежды — лучше опустить их вдоль тела",
    });
  }
  return out;
}

function downscale(src: HTMLImageElement | ImageBitmap, maxSide: number): HTMLCanvasElement {
  const w = "naturalWidth" in src ? src.naturalWidth : src.width;
  const h = "naturalHeight" in src ? src.naturalHeight : src.height;
  const k = Math.min(1, maxSide / Math.max(w, h));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(w * k);
  canvas.height = Math.round(h * k);
  canvas.getContext("2d")!.drawImage(src, 0, 0, canvas.width, canvas.height);
  return canvas;
}

/** Same convention as the backend: visibility = presence, zeroed outside the frame. */
function toKeypoint(lm: NormalizedLandmark, w: number, h: number): Keypoint {
  const inside = lm.x >= -0.02 && lm.x <= 1.02 && lm.y >= -0.02 && lm.y <= 1.02;
  const conf = lm.presence ?? lm.visibility ?? 0;
  return { x: lm.x * w, y: lm.y * h, visibility: inside ? conf : 0 };
}

function extent(lms: NormalizedLandmark[]): number {
  const ys = lms.filter((l) => (l.presence ?? l.visibility ?? 0) > 0.5).map((l) => l.y);
  return ys.length ? Math.max(...ys) - Math.min(...ys) : 0;
}

function buildOccluder(
  image: HTMLCanvasElement,
  masks: { width: number; height: number; getAsFloat32Array(): Float32Array }[],
  pose: NormalizedLandmark[] | undefined,
  width: number,
  height: number,
): HTMLCanvasElement {
  const out = document.createElement("canvas");
  out.width = width;
  out.height = height;
  const ctx = out.getContext("2d")!;
  if (masks.length < 4) return out; // nothing to keep above clothes

  const mw = masks[0]!.width;
  const mh = masks[0]!.height;
  const hair = masks[SEG_HAIR]!.getAsFloat32Array();
  const face = masks[SEG_FACE_SKIN]!.getAsFloat32Array();
  const skin = masks[SEG_BODY_SKIN]!.getAsFloat32Array();

  // Hands: body skin near the hand landmarks only. Arms elsewhere go under sleeves.
  const handR2 = Math.pow(0.05 * Math.max(mw, mh), 2);
  const hands = (pose ?? [])
    .filter((_, i) => HAND_POINTS.includes(i))
    .filter((l) => (l.presence ?? l.visibility ?? 0) > 0.5)
    .map((l) => ({ x: l.x * mw, y: l.y * mh }));

  const small = new ImageData(mw, mh);
  for (let y = 0; y < mh; y++) {
    for (let x = 0; x < mw; x++) {
      const i = y * mw + x;
      let a = hair[i]! + face[i]!;
      if (skin[i]! > 0.5 && hands.some((h) => (h.x - x) ** 2 + (h.y - y) ** 2 < handR2)) {
        a += skin[i]!;
      }
      small.data[i * 4 + 3] = Math.min(255, Math.round(a * 255));
    }
  }
  const maskCanvas = document.createElement("canvas");
  maskCanvas.width = mw;
  maskCanvas.height = mh;
  maskCanvas.getContext("2d")!.putImageData(small, 0, 0);

  ctx.drawImage(image, 0, 0);
  ctx.globalCompositeOperation = "destination-in";
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(maskCanvas, 0, 0, width, height);
  ctx.globalCompositeOperation = "source-over";
  return out;
}

function photoIssues(poses: NormalizedLandmark[][], kps: Keypoints): PhotoIssue[] {
  const issues: PhotoIssue[] = [];
  if (poses.length === 0) {
    return [{ code: "no_person", severity: "error", message: "На фото не найден человек" }];
  }
  if (poses.length > 1 && extent(poses[1]!) > 0.5 * extent(poses[0]!)) {
    issues.push({
      code: "several_people",
      severity: "error",
      message: "На фото несколько людей — нужен один человек",
    });
  }
  const seen = (n: keyof Keypoints) => (kps[n]?.visibility ?? 0) > 0.5;
  const body = ["left_shoulder", "right_shoulder", "left_hip", "right_hip"] as const;
  if (!body.every(seen)) {
    issues.push({
      code: "not_full_body",
      severity: "error",
      message: "Не видны плечи и бёдра — нужно фото в полный рост",
    });
    return issues;
  }
  if (!(["left_ankle", "right_ankle"] as const).every(seen)) {
    issues.push({
      code: "not_full_body",
      severity: "warning",
      message: "Ноги обрезаны — брюки и платья примерить не получится",
    });
  }
  const ls = kps.left_shoulder!;
  const rs = kps.right_shoulder!;
  const torso = (kps.left_hip!.y + kps.right_hip!.y) / 2 - (ls.y + rs.y) / 2;
  if (ls.x < rs.x) {
    issues.push({ code: "back_view", severity: "error", message: "Встаньте лицом к камере" });
  } else if (torso > 0 && Math.abs(ls.x - rs.x) / torso < 0.45) {
    issues.push({ code: "side_view", severity: "warning", message: "Повернитесь прямо к камере" });
  }
  const left = Math.min(ls.x, rs.x);
  const right = Math.max(ls.x, rs.x);
  const crossing = (["left_wrist", "right_wrist"] as const).some((n) => {
    const w = kps[n];
    return (
      w && w.visibility > 0.5 && w.x > left + 0.15 * (right - left) &&
      w.x < right - 0.15 * (right - left) && w.y > ls.y && w.y < kps.left_hip!.y
    );
  });
  if (crossing) {
    issues.push({
      code: "arms_over_body",
      severity: "warning",
      message: "Опустите руки вдоль тела, чтобы они не закрывали одежду",
    });
  }
  if (extent(poses[0]!) < 0.5) {
    issues.push({
      code: "too_small",
      severity: "warning",
      message: "Человек занимает мало места в кадре — подойдите ближе",
    });
  }
  return issues;
}
