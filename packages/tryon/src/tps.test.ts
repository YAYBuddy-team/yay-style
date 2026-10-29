import { describe, expect, it } from "vitest";

import { fitSimilarity, fitTps, solve } from "./tps";

describe("solve", () => {
  it("solves a small system", () => {
    const x = solve(
      [
        [2, 1],
        [1, 3],
      ],
      [3, 5],
    );
    expect(x[0]).toBeCloseTo(0.8);
    expect(x[1]).toBeCloseTo(1.4);
  });
});

describe("fitTps", () => {
  const src = [
    { x: 0, y: 0 },
    { x: 100, y: 0 },
    { x: 0, y: 100 },
    { x: 100, y: 100 },
    { x: 50, y: 50 },
  ];

  it("maps control points exactly without regularisation", () => {
    const dst = src.map((p) => ({ x: p.x * 1.5 + 10, y: p.y + (p.x === 50 ? 20 : 0) }));
    const t = fitTps(src, dst);
    src.forEach((p, i) => {
      const q = t(p.x, p.y);
      expect(q.x).toBeCloseTo(dst[i]!.x, 6);
      expect(q.y).toBeCloseTo(dst[i]!.y, 6);
    });
  });

  it("reproduces an affine map everywhere", () => {
    const affine = (p: { x: number; y: number }) => ({ x: 2 * p.x + 0.5 * p.y + 3, y: -p.x + p.y - 7 });
    const t = fitTps(src, src.map(affine));
    const q = t(37, 81);
    const e = affine({ x: 37, y: 81 });
    expect(q.x).toBeCloseTo(e.x, 6);
    expect(q.y).toBeCloseTo(e.y, 6);
  });
});

describe("fitSimilarity", () => {
  it("recovers scale, rotation and shift", () => {
    const ang = Math.PI / 6;
    const f = (p: { x: number; y: number }) => ({
      x: 2 * (p.x * Math.cos(ang) - p.y * Math.sin(ang)) + 5,
      y: 2 * (p.x * Math.sin(ang) + p.y * Math.cos(ang)) - 4,
    });
    const src = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 3, y: 7 },
    ];
    const t = fitSimilarity(src, src.map(f));
    const q = t(-4, 9);
    const e = f({ x: -4, y: 9 });
    expect(q.x).toBeCloseTo(e.x, 6);
    expect(q.y).toBeCloseTo(e.y, 6);
  });
});
