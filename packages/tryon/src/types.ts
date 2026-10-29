import type { BodyProfile } from "./profile";

export type { BodyProfile };

export const KEYPOINT_NAMES = [
  "nose",
  "left_shoulder",
  "right_shoulder",
  "left_elbow",
  "right_elbow",
  "left_wrist",
  "right_wrist",
  "left_hip",
  "right_hip",
  "left_knee",
  "right_knee",
  "left_ankle",
  "right_ankle",
] as const;

export type KeypointName = (typeof KEYPOINT_NAMES)[number];

/** Pixel coordinates. `visibility` means "located in the frame" (0..1), as on the backend. */
export interface Keypoint {
  x: number;
  y: number;
  visibility: number;
}

export type Keypoints = Partial<Record<KeypointName, Keypoint>>;

export type GarmentCategory = "top" | "bottom" | "full" | "outerwear";

/** A garment prepared by the backend: RGBA cutout + anchor keypoints in cutout pixels. */
export interface GarmentAsset {
  id: string;
  imageUrl: string;
  width: number;
  height: number;
  category: GarmentCategory;
  /** "model": keypoints are the model's real body points; "flatlay": estimated. */
  kind: "model" | "flatlay";
  keypoints: Keypoints;
  /** Model photos: the model's silhouette widths (see profile.ts). */
  bodyProfile?: BodyProfile | null;
}

export type PhotoIssueCode =
  | "no_person"
  | "several_people"
  | "not_full_body"
  | "back_view"
  | "side_view"
  | "arms_over_body"
  | "too_small"
  | "long_sleeves"
  | "hands_on_body";

export interface PhotoIssue {
  code: PhotoIssueCode;
  severity: "error" | "warning";
  message: string;
}

/** What on the user's photo will show through or over a garment (no generative model to
 * erase it). */
export interface PersonClothing {
  longSleeves: boolean;
  handsOnBody: boolean;
}

export interface PersonAnalysis {
  width: number;
  height: number;
  /** The (downscaled) photo all coordinates refer to. */
  image: HTMLCanvasElement;
  keypoints: Keypoints;
  /** The photo with alpha kept only where it must stay above clothes: hair, face, hands. */
  occluder: HTMLCanvasElement;
  /** Silhouette widths, so garments are sized by the body and not only by joints. */
  bodyProfile: BodyProfile | null;
  /** What the user is wearing, as far as it matters for try-on. */
  clothing: PersonClothing;
  issues: PhotoIssue[];
}

/** Manual fine-tuning on top of the automatic fit. */
export interface LayerAdjust {
  /** Shift, in fractions of the user's shoulder width. */
  dx: number;
  dy: number;
  /** Overall size multiplier. */
  scale: number;
  /** Extra horizontal / vertical stretch. */
  width: number;
  length: number;
  rotation: number; // degrees
  brightness: number; // 1 = unchanged
}

export const DEFAULT_ADJUST: LayerAdjust = {
  dx: 0,
  dy: 0,
  scale: 1,
  width: 1,
  length: 1,
  rotation: 0,
  brightness: 1,
};

export interface TryOnLayer {
  asset: GarmentAsset;
  image: HTMLImageElement | ImageBitmap;
  adjust: LayerAdjust;
  visible: boolean;
}

/** Garments are drawn bottom-up in this order; a tucked-in top swaps top and bottom. */
export const CATEGORY_ORDER: Record<GarmentCategory, number> = {
  bottom: 1,
  full: 2,
  top: 3,
  outerwear: 4,
};
