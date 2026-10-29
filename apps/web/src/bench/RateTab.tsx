import { useCallback, useEffect, useMemo, useState } from "react";

import { benchApi, renderUrl } from "./api";

/** Blind rating: shuffled composites, no garment or category shown. */
export function RateTab({ run, rater }: { run: string; rater: string }) {
  const [queue, setQueue] = useState<string[] | null>(null);
  const [rated, setRated] = useState(0);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const [renders, ratings] = await Promise.all([benchApi.renders(run), benchApi.ratings(run)]);
        const done = new Set(ratings.filter((r) => r.rater === rater).map((r) => r.render));
        setQueue(shuffle(renders.filter((r) => !done.has(r)), seed(rater)));
        setRated(done.size);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    })();
  }, [run, rater]);

  const current = queue?.[0];
  const vote = useCallback(
    async (verdict: "ok" | "bad") => {
      if (!current) return;
      await benchApi.rate(run, { render: current, verdict, rater });
      setQueue((q) => q?.slice(1) ?? null);
      setRated((n) => n + 1);
    },
    [current, run, rater],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowRight" || e.key === "1") void vote("ok");
      if (e.key === "ArrowLeft" || e.key === "0") void vote("bad");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [vote]);

  const total = useMemo(() => (queue ? queue.length + rated : 0), [queue, rated]);

  if (error) return <p className="text-sm text-red-600">{error}</p>;
  if (!queue) return <p className="text-sm">Загрузка…</p>;
  if (!current) return <p className="text-sm">Всё оценено: {rated} из {total}. Смотрите «Итоги».</p>;
  return (
    <div className="space-y-3">
      <p className="text-sm text-neutral-600">
        Можно ли по этой картинке понять, как вещь будет смотреться, и решить, брать её или нет?
        <br />→ или 1 — приемлемо, ← или 0 — нет. Оценено {rated} из {total}.
      </p>
      <div className="flex gap-3">
        <button type="button" onClick={() => vote("bad")} className="flex-1 rounded-lg bg-red-600 py-3 text-white">
          ← Нет
        </button>
        <button type="button" onClick={() => vote("ok")} className="flex-1 rounded-lg bg-emerald-600 py-3 text-white">
          Приемлемо →
        </button>
      </div>
      <img src={renderUrl(run, current)} alt="" className="mx-auto max-h-[75vh] rounded-xl" />
    </div>
  );
}

function seed(s: string): number {
  let h = 2166136261;
  for (const c of s) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return h >>> 0;
}

function shuffle<T>(xs: T[], s: number): T[] {
  const a = [...xs];
  let x = s || 1;
  for (let i = a.length - 1; i > 0; i--) {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    const j = (x >>> 0) % (i + 1);
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}
