import { DEFAULT_ADJUST, PersonAnalyzer, type PersonAnalysis } from "@yay/tryon";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { loadImage, prepareFromLink, toAsset, type PreparedGarment } from "./api";
import { type BenchRecord, loadBench, saveBench } from "./bench";
import { BenchPanel } from "./components/BenchPanel";
import { GarmentAdder } from "./components/GarmentAdder";
import { GarmentList } from "./components/GarmentList";
import { LayerPanel } from "./components/LayerPanel";
import { PhotoPanel } from "./components/PhotoPanel";
import { TryOnStage } from "./components/TryOnStage";
import { addToOutfit, drawOrder, isAdjusted, type OutfitLayer } from "./outfit";

export function App() {
  const analyzerRef = useRef<Promise<PersonAnalyzer> | null>(null);
  const [person, setPerson] = useState<PersonAnalysis | null>(null);
  const [personName, setPersonName] = useState("");
  const [personStatus, setPersonStatus] = useState<string | null>(null);
  const [personError, setPersonError] = useState<string | null>(null);

  const [garments, setGarments] = useState<PreparedGarment[]>([]);
  const [layers, setLayers] = useState<OutfitLayer[]>([]);
  const [layerError, setLayerError] = useState<string | null>(null);
  const [tuckIn, setTuckIn] = useState(false);
  const [showDebug, setShowDebug] = useState(false);
  const [compare, setCompare] = useState(false);
  const [bench, setBench] = useState<BenchRecord[]>(loadBench);

  const onPhoto = useCallback(async (file: File) => {
    setPersonError(null);
    setPersonStatus("Загружаю модели распознавания (один раз)…");
    try {
      analyzerRef.current ??= PersonAnalyzer.create({ wasmBaseUrl: "/mediapipe/wasm" });
      const analyzer = await analyzerRef.current;
      setPersonStatus("Анализирую фото…");
      const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
      const result = analyzer.analyze(bitmap);
      bitmap.close();
      setPerson(result);
      setPersonName(file.name);
      setPersonStatus(null);
    } catch (e) {
      analyzerRef.current = null;
      setPersonStatus(null);
      setPersonError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  const wearGarmentPhoto = useCallback(async (g: PreparedGarment, photoIndex: number) => {
    setLayerError(null);
    const photo = g.photos.find((p) => p.index === photoIndex);
    if (!photo) return;
    try {
      const asset = toAsset(g, photo);
      const image = await loadImage(asset.imageUrl);
      setLayers((prev) => {
        const existing = prev.find((l) => l.garment.key === g.key);
        const layer: OutfitLayer = {
          id: g.key,
          garment: g,
          photoIndex,
          asset,
          image,
          adjust: existing?.adjust ?? { ...DEFAULT_ADJUST },
          visible: true,
        };
        return addToOutfit(prev, layer);
      });
    } catch (e) {
      setLayerError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  const onPrepared = useCallback(
    (g: PreparedGarment) => {
      setGarments((prev) => [g, ...prev.filter((x) => x.key !== g.key)]);
      if (g.best_index !== null) void wearGarmentPhoto(g, g.best_index);
    },
    [wearGarmentPhoto],
  );

  // Dev / benchmark shortcut: ?person=/dev/p1.jpg&items=165101072,230915455
  useEffect(() => {
    const params = new URLSearchParams(location.search);
    const personUrl = params.get("person");
    const items = params.get("items")?.split(",").map((s) => s.trim()).filter(Boolean) ?? [];
    void (async () => {
      if (personUrl) {
        const blob = await (await fetch(personUrl)).blob();
        await onPhoto(new File([blob], personUrl.split("/").pop() ?? "person.jpg", { type: blob.type }));
      }
      for (const item of items) {
        try {
          onPrepared(await prepareFromLink(item));
        } catch (e) {
          setLayerError(e instanceof Error ? e.message : String(e));
        }
      }
    })();
  }, [onPhoto, onPrepared]);

  const ordered = useMemo(() => drawOrder(layers, tuckIn), [layers, tuckIn]);

  const rate = (verdict: "ok" | "bad", note: string) => {
    const records: BenchRecord[] = layers
      .filter((l) => l.visible)
      .map((l) => ({
        at: new Date().toISOString(),
        personPhoto: personName,
        garmentKey: l.garment.key,
        photoIndex: l.photoIndex,
        category: l.asset.category,
        kind: l.asset.kind,
        manuallyAdjusted: isAdjusted(l),
        verdict,
        ...(note ? { note } : {}),
      }));
    const next = [...bench, ...records];
    setBench(next);
    saveBench(next);
  };

  return (
    <div className="min-h-screen bg-white text-neutral-900">
      <header className="flex items-center justify-between border-b border-neutral-200 px-4 py-3">
        <h1 className="text-lg font-semibold">
          yay-style <span className="font-normal text-neutral-500">· стенд примерки</span>
        </h1>
        <div className="flex gap-4 text-sm">
          <label className="flex items-center gap-1">
            <input type="checkbox" checked={compare} onChange={(e) => setCompare(e.target.checked)} />
            До
          </label>
          <label className="flex items-center gap-1">
            <input type="checkbox" checked={showDebug} onChange={(e) => setShowDebug(e.target.checked)} />
            Точки
          </label>
        </div>
      </header>
      <main className="grid gap-6 p-4 lg:grid-cols-[22rem_1fr_20rem]">
        <aside className="space-y-6">
          <PhotoPanel person={person} status={personStatus} error={personError} onFile={onPhoto} />
          <GarmentAdder onPrepared={onPrepared} />
          {layerError && <p className="text-sm text-red-600">{layerError}</p>}
          <GarmentList garments={garments} layers={layers} onUse={wearGarmentPhoto} showDebug={showDebug} />
        </aside>
        <TryOnStage person={person} layers={ordered} showDebug={showDebug} compare={compare} />
        <aside className="space-y-6">
          <LayerPanel
            layers={ordered}
            tuckIn={tuckIn}
            onTuckIn={setTuckIn}
            onChange={(id, patch) => setLayers((prev) => prev.map((l) => (l.id === id ? { ...l, ...patch } : l)))}
            onRemove={(id) => setLayers((prev) => prev.filter((l) => l.id !== id))}
          />
          <BenchPanel
            records={bench}
            canRate={!!person && layers.some((l) => l.visible)}
            onRate={rate}
            onClear={() => {
              setBench([]);
              saveBench([]);
            }}
          />
        </aside>
      </main>
    </div>
  );
}
