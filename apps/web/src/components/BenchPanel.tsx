import { useState } from "react";

import { CATEGORY_LABELS } from "../api";
import { type BenchRecord, downloadJson, summarize } from "../bench";

interface Props {
  records: BenchRecord[];
  canRate: boolean;
  onRate: (verdict: "ok" | "bad", note: string) => void;
  onClear: () => void;
}

export function BenchPanel({ records, canRate, onRate, onClear }: Props) {
  const [note, setNote] = useState("");
  const stats = summarize(records);
  const rate = (v: "ok" | "bad") => {
    onRate(v, note.trim());
    setNote("");
  };
  return (
    <section className="space-y-3 rounded-xl bg-neutral-50 p-3">
      <h2 className="text-sm font-semibold uppercase tracking-wide text-neutral-500">Оценка (бенчмарк)</h2>
      <p className="text-xs text-neutral-500">
        Выглядит ли примерка приемлемо — так, что по ней можно решить, брать вещь или нет?
      </p>
      <input
        value={note}
        onChange={(e) => setNote(e.target.value)}
        placeholder="Комментарий (необязательно)"
        className="w-full rounded-md border border-neutral-300 px-2 py-1 text-sm"
      />
      <div className="flex gap-2">
        <button
          type="button"
          disabled={!canRate}
          onClick={() => rate("ok")}
          className="flex-1 rounded-lg bg-emerald-600 py-2 text-sm text-white disabled:opacity-40"
        >
          Приемлемо
        </button>
        <button
          type="button"
          disabled={!canRate}
          onClick={() => rate("bad")}
          className="flex-1 rounded-lg bg-red-600 py-2 text-sm text-white disabled:opacity-40"
        >
          Нет
        </button>
      </div>
      {records.length > 0 && (
        <>
          <table className="w-full text-xs">
            <tbody>
              {[...stats.entries()].map(([k, s]) => (
                <tr key={k}>
                  <td>{k === "all" ? "Всего" : CATEGORY_LABELS[k as keyof typeof CATEGORY_LABELS]}</td>
                  <td className="text-right tabular-nums">
                    {s.ok}/{s.total} · {Math.round((100 * s.ok) / s.total)}%
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="flex gap-3 text-xs">
            <button type="button" className="underline" onClick={() => downloadJson("yay-bench.json", records)}>
              Скачать JSON
            </button>
            <button
              type="button"
              className="text-neutral-500 underline"
              onClick={() => confirm("Удалить все оценки?") && onClear()}
            >
              Очистить
            </button>
          </div>
        </>
      )}
    </section>
  );
}
