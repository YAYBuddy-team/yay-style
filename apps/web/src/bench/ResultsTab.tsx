import { useEffect, useState } from "react";

import { CATEGORY_LABELS } from "../api";
import { downloadJson } from "../bench";
import { benchApi, type Rating, type RenderEntry } from "./api";

const THRESHOLD = 0.5; // decision point from the plan: ≥50% acceptable for tops

interface Row {
  label: string;
  ok: number;
  total: number;
}

export function ResultsTab({ run }: { run: string }) {
  const [data, setData] = useState<{ manifest: RenderEntry[]; ratings: Rating[] } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void Promise.all([benchApi.manifest(run), benchApi.ratings(run)])
      .then(([manifest, ratings]) => setData({ manifest, ratings }))
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, [run]);

  if (error) return <p className="text-sm text-red-600">{error}</p>;
  if (!data) return <p className="text-sm">Загрузка…</p>;

  const byRender = new Map(data.manifest.map((m) => [m.render, m]));
  const raters = [...new Set(data.ratings.map((r) => r.rater))];
  const group = (
    key: (m: RenderEntry) => string,
    rater: string,
    include: (m: RenderEntry) => boolean = () => true,
  ): Row[] => {
    const rows = new Map<string, Row>();
    for (const r of data.ratings.filter((x) => x.rater === rater)) {
      const m = byRender.get(r.render);
      if (!m || !include(m)) continue;
      for (const label of [key(m), "Всего"]) {
        const row = rows.get(label) ?? { label, ok: 0, total: 0 };
        row.total += 1;
        if (r.verdict === "ok") row.ok += 1;
        rows.set(label, row);
      }
    }
    return [...rows.values()];
  };
  const failed = data.manifest.filter((m) => m.error).length;
  const coverage = 1 - failed / Math.max(1, data.manifest.length);

  return (
    <div className="space-y-6">
      <p className="text-sm text-neutral-600">
        Отрисовок: {data.manifest.length}. Честный отказ («примерка недоступна»): {failed} — охват{" "}
        {Math.round(coverage * 100)}%. Отказы показаны оценщику с красной плашкой и считаются «нет»; ниже —
        доля «приемлемо» и среди всех пар, и среди тех, что примерялись. Порог решения: ≥{THRESHOLD * 100}%
        для верха.
      </p>
      {raters.length === 0 && <p className="text-sm">Оценок пока нет.</p>}
      {raters.map((rater) => (
        <div key={rater} className="space-y-3">
          <h3 className="font-semibold">Оценщик: {rater}</h3>
          <div className="grid gap-6 md:grid-cols-3">
            <Table title="По категориям, все пары" rows={group((m) => CATEGORY_LABELS[m.category], rater)} highlight />
            <Table
              title="По категориям, только примеренные"
              rows={group((m) => CATEGORY_LABELS[m.category], rater, (m) => !m.error)}
              highlight
            />
            <Table title="По типу фото вещи" rows={group((m) => (m.kind === "model" ? "на модели" : m.kind ?? "не примерено"), rater)} />
            <Table title="По фото пользователя" rows={group((m) => m.person, rater)} />
          </div>
        </div>
      ))}
      <button type="button" className="text-sm underline" onClick={() => downloadJson(`bench-${run}.json`, data)}>
        Скачать сырые данные
      </button>
    </div>
  );
}

function Table({ title, rows, highlight }: { title: string; rows: Row[]; highlight?: boolean }) {
  return (
    <table className="w-full text-sm">
      <caption className="mb-1 text-left text-xs uppercase text-neutral-500">{title}</caption>
      <tbody>
        {rows.map((r) => {
          const share = r.ok / r.total;
          return (
            <tr key={r.label} className="border-t border-neutral-100">
              <td className="py-1">{r.label}</td>
              <td
                className={[
                  "py-1 text-right tabular-nums",
                  highlight && r.label !== "Всего" ? (share >= THRESHOLD ? "text-emerald-700" : "text-red-600") : "",
                ].join(" ")}
              >
                {r.ok}/{r.total} · {Math.round(share * 100)}%
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
