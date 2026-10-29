import { DEFAULT_ADJUST, PersonAnalyzer, TryOnRenderer, type PersonAnalysis } from "@yay/tryon";
import { useRef, useState } from "react";

import { loadImage, prepareFromLink, toAsset } from "../api";
import { benchApi, compatible, type RenderEntry } from "./api";

/**
 * Render every compatible person × garment pair with the real engine, at default
 * settings (no manual adjustment), and upload the composites for rating.
 */
export function RunTab({ run }: { run: string }) {
  const [log, setLog] = useState<string[]>([]);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const say = (line: string) => setLog((l) => [...l.slice(-200), line]);

  const start = async () => {
    setBusy(true);
    setLog([]);
    try {
      const cfg = await benchApi.config();
      const garments = Object.values(cfg.garments).flat();
      say(`Вещей: ${garments.length}, людей: ${cfg.persons.length}`);

      const analyzer = await PersonAnalyzer.create({ wasmBaseUrl: "/mediapipe/wasm" });
      const persons = new Map<string, PersonAnalysis>();
      for (const p of cfg.persons) {
        const img = await loadImage(`/files/bench/persons/${p.file}`);
        const a = analyzer.analyze(img);
        persons.set(p.id, a);
        say(`${p.id}: ${a.issues.map((i) => i.message).join("; ") || "фото в порядке"}`);
      }

      const prepared = new Map<number, Awaited<ReturnType<typeof prepareFromLink>> | Error>();
      for (const g of garments) {
        try {
          prepared.set(g.id, await prepareFromLink(String(g.id)));
        } catch (e) {
          prepared.set(g.id, e instanceof Error ? e : new Error(String(e)));
        }
      }

      const renderer = new TryOnRenderer(canvasRef.current!);
      const pairs = cfg.persons.flatMap((p) => garments.filter((g) => compatible(p, g)).map((g) => ({ p, g })));
      setProgress({ done: 0, total: pairs.length });
      const manifest: RenderEntry[] = [];

      for (const [i, { p, g }] of pairs.entries()) {
        const person = persons.get(p.id)!;
        const prep = prepared.get(g.id)!;
        const name = `${p.id}__wb-${g.id}.jpg`;
        const entry: RenderEntry = {
          render: name, person: p.id, garmentId: g.id, category: g.category, subject: g.subject,
          kind: null, photoIndex: null, error: null,
        };
        try {
          if (prep instanceof Error) throw prep;
          const photo = prep.photos.find((x) => x.index === prep.best_index);
          if (!photo) throw new Error(prep.unusable_reason ?? "Нет годного фото вещи");
          const asset = toAsset(prep, photo);
          entry.kind = asset.kind;
          entry.photoIndex = photo.index;
          const image = await loadImage(asset.imageUrl);
          const res = renderer.render(person, [{ asset, image, adjust: { ...DEFAULT_ADJUST }, visible: true }]);
          if (res.errors[0]) throw new Error(res.errors[0]);
        } catch (e) {
          entry.error = e instanceof Error ? e.message : String(e);
          renderer.render(person, []);
        }
        await benchApi.saveFile(run, name, await toJpeg(canvasRef.current!, entry.error ?? undefined));
        manifest.push(entry);
        setProgress({ done: i + 1, total: pairs.length });
      }
      await benchApi.saveFile(
        run,
        "manifest.json",
        new Blob([JSON.stringify(manifest, null, 1)], { type: "application/json" }),
      );
      const failed = manifest.filter((m) => m.error).length;
      say(`Готово: ${manifest.length} отрисовок, не примерено: ${failed}`);
    } catch (e) {
      say(`Ошибка: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      <p className="text-sm text-neutral-600">
        Прогоняет все пары «человек × вещь» через движок без ручной правки и сохраняет картинки на
        сервер (прогон <b>{run}</b>). Платья и юбки примеряются только на женские фото.
      </p>
      <button
        type="button"
        onClick={start}
        disabled={busy}
        className="rounded-lg bg-neutral-900 px-4 py-2 text-sm text-white disabled:opacity-40"
      >
        {busy ? "Идёт прогон…" : "Запустить прогон"}
      </button>
      {progress && (
        <p className="text-sm tabular-nums" data-testid="bench-progress">
          {progress.done} / {progress.total}
        </p>
      )}
      <pre className="max-h-72 overflow-auto rounded-lg bg-neutral-50 p-3 text-xs">{log.join("\n")}</pre>
      <canvas ref={canvasRef} className="max-h-96 max-w-full" />
    </div>
  );
}

/** JPEG of the composite, long side capped at 1000 px (enough detail to rate). A failed
 * pair is stamped with the reason, so raters see it as a failure rather than a blank. */
function toJpeg(canvas: HTMLCanvasElement, failure?: string): Promise<Blob> {
  const k = Math.min(1, 1000 / Math.max(canvas.width, canvas.height));
  const out = document.createElement("canvas");
  out.width = Math.round(canvas.width * k);
  out.height = Math.round(canvas.height * k);
  const ctx = out.getContext("2d")!;
  ctx.drawImage(canvas, 0, 0, out.width, out.height);
  if (failure) {
    ctx.fillStyle = "rgba(200,0,0,0.8)";
    ctx.fillRect(0, 0, out.width, 56);
    ctx.fillStyle = "white";
    ctx.font = "bold 20px sans-serif";
    ctx.fillText(`НЕ ПРИМЕРЕНО: ${failure}`.slice(0, 70), 14, 35);
  }
  return new Promise((resolve, reject) =>
    out.toBlob((b) => (b ? resolve(b) : reject(new Error("toBlob failed"))), "image/jpeg", 0.88),
  );
}
