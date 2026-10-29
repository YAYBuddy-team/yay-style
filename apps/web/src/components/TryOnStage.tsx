import { TryOnRenderer, type PersonAnalysis, type RenderResult } from "@yay/tryon";
import { useEffect, useRef, useState } from "react";

import type { OutfitLayer } from "../outfit";

interface Props {
  person: PersonAnalysis | null;
  layers: OutfitLayer[]; // already in draw order
  showDebug: boolean;
  compare: boolean;
}

export function TryOnStage({ person, layers, showDebug, compare }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const rendererRef = useRef<TryOnRenderer | null>(null);
  const [errors, setErrors] = useState<string[]>([]);
  const [glError, setGlError] = useState<string | null>(null);

  useEffect(() => {
    if (!person || !canvasRef.current) return;
    try {
      rendererRef.current ??= new TryOnRenderer(canvasRef.current);
    } catch (e) {
      setGlError(e instanceof Error ? e.message : String(e));
      return;
    }
    const result = rendererRef.current.render(person, compare ? [] : layers);
    setErrors(result.errors.filter((e): e is string => !!e));
    drawDebug(overlayRef.current, person, showDebug && !compare ? result : null);
  }, [person, layers, showDebug, compare]);

  const download = () => {
    canvasRef.current?.toBlob((blob) => {
      if (!blob) return;
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = "yay-style-primerka.png";
      a.click();
      URL.revokeObjectURL(a.href);
    });
  };

  if (!person) {
    return (
      <div className="flex aspect-[3/4] w-full items-center justify-center rounded-2xl bg-neutral-100 text-sm text-neutral-500">
        Загрузите своё фото, чтобы начать
      </div>
    );
  }
  return (
    <div className="space-y-2">
      <div className="relative mx-auto w-fit max-w-full">
        <canvas ref={canvasRef} className="block max-h-[78vh] max-w-full rounded-2xl" />
        <canvas
          ref={overlayRef}
          className="pointer-events-none absolute inset-0 h-full w-full"
        />
      </div>
      {glError && <p className="text-sm text-red-600">{glError}</p>}
      {errors.map((e) => (
        <p key={e} className="text-sm text-red-600">
          {e}
        </p>
      ))}
      <div className="flex justify-center">
        <button type="button" onClick={download} className="text-sm underline">
          Скачать картинку
        </button>
      </div>
    </div>
  );
}

function drawDebug(canvas: HTMLCanvasElement | null, person: PersonAnalysis, result: RenderResult | null) {
  if (!canvas) return;
  canvas.width = person.width;
  canvas.height = person.height;
  const ctx = canvas.getContext("2d")!;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (!result) return;
  const r = Math.max(3, person.width * 0.006);
  for (const kp of Object.values(person.keypoints)) {
    if (!kp || kp.visibility < 0.5) continue;
    ctx.fillStyle = "#22c55e";
    ctx.beginPath();
    ctx.arc(kp.x, kp.y, r, 0, Math.PI * 2);
    ctx.fill();
  }
  for (const mesh of result.meshes) {
    for (const p of mesh?.landed ?? []) {
      ctx.strokeStyle = "#ec4899";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(p.to.x, p.to.y, r * 1.6, 0, Math.PI * 2);
      ctx.stroke();
    }
  }
}
