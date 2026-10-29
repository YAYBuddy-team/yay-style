import { CATEGORY_LABELS, type PreparedGarment } from "../api";
import type { OutfitLayer } from "../outfit";

interface Props {
  garments: PreparedGarment[];
  layers: OutfitLayer[];
  onUse: (g: PreparedGarment, photoIndex: number) => void;
  showDebug: boolean;
}

export function GarmentList({ garments, layers, onUse, showDebug }: Props) {
  if (garments.length === 0) return null;
  return (
    <section className="space-y-4">
      {garments.map((g) => {
        const active = layers.find((l) => l.garment.key === g.key);
        return (
          <div key={g.key} className="space-y-2">
            <div className="text-sm">
              <span className="font-medium">{g.product?.name || "Загруженная вещь"}</span>
              <span className="text-neutral-500"> · {CATEGORY_LABELS[g.category]}</span>
              {g.product && (
                <a href={g.product.url} target="_blank" rel="noreferrer" className="ml-2 text-xs underline">
                  в магазине
                </a>
              )}
            </div>
            {g.unusable_reason && (
              <p className="text-xs text-amber-700">
                {g.unusable_reason}. Можно выбрать фото вручную — результат будет менее точным.
              </p>
            )}
            <div className="flex gap-2 overflow-x-auto pb-1">
              {g.photos.map((p) => {
                const usable = p.kind !== "rejected" && p.cutout_url;
                const isActive = active?.photoIndex === p.index;
                const src = showDebug ? p.debug_url : (p.cutout_url ?? p.debug_url);
                return (
                  <button
                    key={p.index}
                    type="button"
                    disabled={!usable}
                    onClick={() => onUse(g, p.index)}
                    title={p.reasons.join("; ") || `${p.kind}, оценка ${p.score.toFixed(2)}`}
                    className={[
                      "relative h-24 w-18 shrink-0 overflow-hidden rounded-lg border-2 bg-neutral-100",
                      isActive ? "border-neutral-900" : "border-transparent",
                      usable ? "hover:border-neutral-400" : "opacity-30",
                    ].join(" ")}
                  >
                    {src && <img src={new URL(src).pathname} alt="" className="h-full w-full object-contain" />}
                    <span className="absolute bottom-0 left-0 right-0 bg-white/80 text-[10px]">
                      {p.index === g.best_index ? "★ " : ""}
                      {p.score.toFixed(2)}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        );
      })}
    </section>
  );
}
