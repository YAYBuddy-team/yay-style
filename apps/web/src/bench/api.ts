import type { GarmentCategory } from "@yay/tryon";

export interface BenchGarment {
  id: number;
  category: GarmentCategory;
  subject: string;
  name: string;
  usable: boolean;
}

export interface BenchPerson {
  id: string;
  file: string;
  sex: "f" | "m";
}
 
export interface BenchConfig {
  garments: Record<GarmentCategory, BenchGarment[]>;
  persons: BenchPerson[];
}

/** What the run produced for one person × garment pair. */
export interface RenderEntry {
  render: string;
  person: string;
  garmentId: number;
  category: GarmentCategory;
  subject: string;
  kind: "model" | "flatlay" | null;
  photoIndex: number | null;
  error: string | null;
}

export interface Rating {
  render: string;
  verdict: "ok" | "bad";
  rater: string;
}

async function json<T>(resp: Response): Promise<T> {
  if (!resp.ok) {
    let detail = `HTTP ${resp.status}`;
    try {
      detail = (await resp.json()).detail ?? detail;
    } catch {
      /* not JSON */
    }
    throw new Error(detail);
  }
  return resp.json() as Promise<T>;
}

export const benchApi = {
  config: () => fetch("/dev/bench/config").then((r) => json<BenchConfig>(r)),
  saveFile: (run: string, name: string, body: Blob) =>
    fetch(`/dev/bench/runs/${run}/renders/${name}`, { method: "PUT", body }).then((r) => json(r)),
  renders: (run: string) => fetch(`/dev/bench/runs/${run}/renders`).then((r) => json<string[]>(r)),
  manifest: (run: string) =>
    fetch(`/files/bench/runs/${run}/renders/manifest.json`).then((r) => json<RenderEntry[]>(r)),
  ratings: (run: string) => fetch(`/dev/bench/runs/${run}/ratings`).then((r) => json<Rating[]>(r)),
  rate: (run: string, rating: Rating) =>
    fetch(`/dev/bench/runs/${run}/ratings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(rating),
    }).then((r) => json(r)),
};

export function renderUrl(run: string, name: string): string {
  return `/files/bench/runs/${run}/renders/${name}`;
}

/** Dresses and skirts are only tried on women in the benchmark set. */
export function compatible(person: BenchPerson, g: BenchGarment): boolean {
  if (person.sex === "f") return true;
  return g.category !== "full" && !/юбк/i.test(g.subject);
}
