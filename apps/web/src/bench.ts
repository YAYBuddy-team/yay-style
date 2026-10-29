/**
 * Stage-0 benchmark log: blind "acceptable / not" verdicts per try-on, kept in this
 * browser and exported as JSON for the decision point (≥50% acceptable for tops).
 */

import type { GarmentCategory } from "@yay/tryon";

export interface BenchRecord {
  at: string;
  personPhoto: string;
  garmentKey: string;
  photoIndex: number;
  category: GarmentCategory;
  kind: "model" | "flatlay";
  manuallyAdjusted: boolean;
  verdict: "ok" | "bad";
  note?: string;
}

const KEY = "yay-bench-v1";

export function loadBench(): BenchRecord[] {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? "[]") as BenchRecord[];
  } catch {
    return [];
  }
}

export function saveBench(records: BenchRecord[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(records));
  } catch {
    /* private mode or quota: the in-memory list still works for this session */
  }
}

export function summarize(records: BenchRecord[]) {
  const by = new Map<string, { ok: number; total: number }>();
  for (const r of records) {
    for (const k of [r.category, "all"]) {
      const s = by.get(k) ?? { ok: 0, total: 0 };
      s.total += 1;
      if (r.verdict === "ok") s.ok += 1;
      by.set(k, s);
    }
  }
  return by;
}

export function downloadJson(name: string, data: unknown): void {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  URL.revokeObjectURL(a.href);
}
