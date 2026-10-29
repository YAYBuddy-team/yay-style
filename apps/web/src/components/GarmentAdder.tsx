import type { GarmentCategory } from "@yay/tryon";
import { useState } from "react";

import { CATEGORY_LABELS, prepareFromFile, prepareFromLink, type PreparedGarment } from "../api";

interface Props {
  onPrepared: (g: PreparedGarment) => void;
}

export function GarmentAdder({ onPrepared }: Props) {
  const [link, setLink] = useState("");
  const [category, setCategory] = useState<GarmentCategory>("top");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async (job: () => Promise<PreparedGarment>) => {
    setBusy(true);
    setError(null);
    try {
      const g = await job();
      // Not usable automatically: still listed (with the reason) so the user sees why and
      // can pick a photo by hand.
      onPrepared(g);
      setLink("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="space-y-3">
      <h2 className="text-sm font-semibold uppercase tracking-wide text-neutral-500">2. Вещь</h2>
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (link.trim()) void run(() => prepareFromLink(link.trim()));
        }}
      >
        <input
          value={link}
          onChange={(e) => setLink(e.target.value)}
          placeholder="Ссылка Wildberries или артикул"
          className="min-w-0 flex-1 rounded-lg border border-neutral-300 px-3 py-2 text-sm"
          disabled={busy}
        />
        <button
          type="submit"
          disabled={busy || !link.trim()}
          className="rounded-lg bg-neutral-900 px-4 py-2 text-sm text-white disabled:opacity-40"
        >
          {busy ? "…" : "Добавить"}
        </button>
      </form>
      <div className="flex items-center gap-2 text-sm">
        <span className="text-neutral-500">или фото / скриншот:</span>
        <select
          value={category}
          onChange={(e) => setCategory(e.target.value as GarmentCategory)}
          className="rounded-md border border-neutral-300 px-2 py-1"
          disabled={busy}
        >
          {(Object.keys(CATEGORY_LABELS) as GarmentCategory[]).map((c) => (
            <option key={c} value={c}>
              {CATEGORY_LABELS[c]}
            </option>
          ))}
        </select>
        <label className="cursor-pointer rounded-md border border-neutral-300 px-2 py-1 hover:bg-neutral-100">
          Файл
          <input
            type="file"
            accept="image/*"
            className="hidden"
            disabled={busy}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void run(() => prepareFromFile(f, category));
              e.target.value = "";
            }}
          />
        </label>
      </div>
      {busy && <p className="text-sm text-neutral-600">Разбираю фото вещи… (первый раз до 10 секунд)</p>}
      {error && <p className="text-sm text-red-600">{error}</p>}
    </section>
  );
}
