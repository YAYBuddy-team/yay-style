import type { BodyProfile, GarmentAsset, GarmentCategory, Keypoints } from "@yay/tryon";

export interface PreparedPhoto {
  index: number;
  source_url: string | null;
  kind: "model" | "flatlay" | "rejected";
  score: number;
  reasons: string[];
  cutout_url: string | null;
  debug_url: string | null;
  width: number | null;
  height: number | null;
  keypoints: Keypoints;
  body_profile: BodyProfile | null;
}

export interface PreparedGarment {
  key: string;
  category: GarmentCategory;
  usable: boolean;
  best_index: number | null;
  /** Why no photo was picked automatically (the user may still pick one by hand). */
  unusable_reason: string | null;
  photos: PreparedPhoto[];
  product?: { name: string; subject: string; url: string };
}

export class ApiError extends Error {}

async function handle<T>(resp: Response): Promise<T> {
  if (resp.ok) return resp.json() as Promise<T>;
  let message = `Ошибка сервера (${resp.status})`;
  try {
    const body = await resp.json();
    if (typeof body.detail === "string") message = body.detail;
  } catch {
    /* not JSON */
  }
  throw new ApiError(message);
}

export async function prepareFromLink(input: string): Promise<PreparedGarment> {
  const resp = await fetch("/v1/garments/prepare", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ input }),
  });
  return handle(resp);
}

export async function prepareFromFile(file: File, category: GarmentCategory): Promise<PreparedGarment> {
  const form = new FormData();
  form.append("file", file);
  form.append("category", category);
  return handle(await fetch("/v1/garments/upload", { method: "POST", body: form }));
}

export function toAsset(g: PreparedGarment, photo: PreparedPhoto): GarmentAsset {
  if (!photo.cutout_url || !photo.width || !photo.height || photo.kind === "rejected") {
    throw new ApiError("Это фото не подходит для примерки");
  }
  // Served through the dev proxy, so the PNG is same-origin and usable as a WebGL texture.
  const url = new URL(photo.cutout_url);
  return {
    id: `${g.key}#${photo.index}`,
    imageUrl: url.pathname,
    width: photo.width,
    height: photo.height,
    category: g.category,
    kind: photo.kind,
    keypoints: photo.keypoints,
    bodyProfile: photo.body_profile,
  };
}

export function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = () => reject(new ApiError("Не удалось загрузить изображение"));
    img.src = src;
  });
}

export const CATEGORY_LABELS: Record<GarmentCategory, string> = {
  top: "Верх",
  bottom: "Низ",
  full: "Платье / комбинезон",
  outerwear: "Верхняя одежда",
};
