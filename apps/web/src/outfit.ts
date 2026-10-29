import { CATEGORY_ORDER, DEFAULT_ADJUST, type GarmentCategory, type TryOnLayer } from "@yay/tryon";

import type { PreparedGarment } from "./api";

export interface OutfitLayer extends TryOnLayer {
  id: string;
  garment: PreparedGarment;
  photoIndex: number;
}

/** Garments that can't be worn together with a newly added one. */
const REPLACES: Record<GarmentCategory, GarmentCategory[]> = {
  top: ["top", "full"],
  bottom: ["bottom", "full"],
  full: ["full", "top", "bottom"],
  outerwear: ["outerwear"],
};

export function addToOutfit(layers: OutfitLayer[], layer: OutfitLayer): OutfitLayer[] {
  const drop = REPLACES[layer.asset.category];
  return [...layers.filter((l) => !drop.includes(l.asset.category)), layer];
}

/** Draw order, bottom-up. "Заправить" puts the top under the trousers/skirt. */
export function drawOrder(layers: OutfitLayer[], tuckIn: boolean): OutfitLayer[] {
  const rank = (c: GarmentCategory) => {
    if (tuckIn && c === "top") return CATEGORY_ORDER.bottom - 0.5;
    return CATEGORY_ORDER[c];
  };
  return [...layers].sort((a, b) => rank(a.asset.category) - rank(b.asset.category));
}

export function isAdjusted(layer: OutfitLayer): boolean {
  return (Object.keys(DEFAULT_ADJUST) as (keyof typeof DEFAULT_ADJUST)[]).some(
    (k) => layer.adjust[k] !== DEFAULT_ADJUST[k],
  );
}
