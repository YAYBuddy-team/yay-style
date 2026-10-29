import { DEFAULT_ADJUST, type LayerAdjust } from "@yay/tryon";

import { CATEGORY_LABELS } from "../api";
import type { OutfitLayer } from "../outfit";

interface Props {
  layers: OutfitLayer[];
  tuckIn: boolean;
  onTuckIn: (v: boolean) => void;
  onChange: (id: string, patch: Partial<OutfitLayer>) => void;
  onRemove: (id: string) => void;
}

const SLIDERS: { key: keyof LayerAdjust; label: string; min: number; max: number; step: number }[] = [
  { key: "dx", label: "Сдвиг ←→", min: -0.6, max: 0.6, step: 0.01 },
  { key: "dy", label: "Сдвиг ↑↓", min: -0.6, max: 0.6, step: 0.01 },
  { key: "scale", label: "Размер", min: 0.7, max: 1.4, step: 0.01 },
  { key: "width", label: "Ширина", min: 0.7, max: 1.4, step: 0.01 },
  { key: "length", label: "Длина", min: 0.7, max: 1.5, step: 0.01 },
  { key: "rotation", label: "Поворот", min: -20, max: 20, step: 0.5 },
  { key: "brightness", label: "Яркость", min: 0.6, max: 1.4, step: 0.01 },
];

export function LayerPanel({ layers, tuckIn, onTuckIn, onChange, onRemove }: Props) {
  if (layers.length === 0) {
    return <p className="text-sm text-neutral-500">Добавьте вещь, и она появится здесь.</p>;
  }
  const hasTopAndBottom =
    layers.some((l) => l.asset.category === "top") && layers.some((l) => l.asset.category === "bottom");
  return (
    <section className="space-y-4">
      <h2 className="text-sm font-semibold uppercase tracking-wide text-neutral-500">3. Образ</h2>
      {hasTopAndBottom && (
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={tuckIn} onChange={(e) => onTuckIn(e.target.checked)} />
          Заправить верх
        </label>
      )}
      {layers.map((layer) => (
        <details key={layer.id} className="rounded-xl border border-neutral-200 p-3" open={layers.length === 1}>
          <summary className="flex cursor-pointer items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={layer.visible}
              onClick={(e) => e.stopPropagation()}
              onChange={(e) => onChange(layer.id, { visible: e.target.checked })}
            />
            <span className="flex-1 truncate">
              {CATEGORY_LABELS[layer.asset.category]}: {layer.garment.product?.name ?? "загруженная вещь"}
            </span>
            <button
              type="button"
              className="text-xs text-neutral-500 hover:text-red-600"
              onClick={(e) => {
                e.preventDefault();
                onRemove(layer.id);
              }}
            >
              убрать
            </button>
          </summary>
          <div className="mt-3 space-y-2">
            {SLIDERS.map((s) => (
              <label key={s.key} className="grid grid-cols-[6.5rem_1fr_2.5rem] items-center gap-2 text-xs">
                <span>{s.label}</span>
                <input
                  type="range"
                  min={s.min}
                  max={s.max}
                  step={s.step}
                  value={layer.adjust[s.key]}
                  onChange={(e) =>
                    onChange(layer.id, { adjust: { ...layer.adjust, [s.key]: Number(e.target.value) } })
                  }
                />
                <span className="text-right tabular-nums text-neutral-500">{layer.adjust[s.key].toFixed(2)}</span>
              </label>
            ))}
            <button
              type="button"
              className="text-xs underline"
              onClick={() => onChange(layer.id, { adjust: { ...DEFAULT_ADJUST } })}
            >
              Сбросить ручную правку
            </button>
          </div>
        </details>
      ))}
    </section>
  );
}
