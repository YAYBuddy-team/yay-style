import { describe, expect, it } from "vitest";

import { measureProfile, widenToSilhouette, type BodyProfile } from "./profile";
import type { Keypoints } from "./types";

const k = (x: number, y: number) => ({ x, y, visibility: 1 });

// 200×300 mask: a torso rectangle x∈[60,140) from y=40 down, plus "arms" hanging along it.
function figure(torsoHalfWidth: number): { mask: Uint8Array; kps: Keypoints } {
  const w = 200;
  const h = 300;
  const mask = new Uint8Array(w * h);
  for (let y = 40; y < 300; y++) {
    for (let x = 100 - torsoHalfWidth; x < 100 + torsoHalfWidth; x++) mask[y * w + x] = 1;
    // arms touching the body at x = ±(half+0..8)
    if (y < 180) {
      for (let x = 100 + torsoHalfWidth; x < 100 + torsoHalfWidth + 8; x++) mask[y * w + x] = 1;
      for (let x = 100 - torsoHalfWidth - 8; x < 100 - torsoHalfWidth; x++) mask[y * w + x] = 1;
    }
  }
  const armX = torsoHalfWidth + 4;
  const kps: Keypoints = {
    left_shoulder: k(130, 50),
    right_shoulder: k(70, 50),
    left_hip: k(120, 150),
    right_hip: k(80, 150),
    left_elbow: k(100 + armX, 110),
    right_elbow: k(100 - armX, 110),
    left_wrist: k(100 + armX, 170),
    right_wrist: k(100 - armX, 170),
  };
  return { mask, kps };
}

describe("measureProfile", () => {
  it("measures the torso without the arms hanging next to it", () => {
    const { mask, kps } = figure(40);
    const p = measureProfile(mask, 200, 300, kps)!;
    expect(p.shoulder).toBeCloseTo(60);
    // Arms (+16 px) are excluded. The upper-arm capsule also nibbles the torso edge near the
    // armpit (shoulder joints sit inside the silhouette); the bias is the same for model
    // and user, and only their ratio is used.
    expect(p.chest).toBeGreaterThan(50);
    expect(p.chest).toBeLessThanOrEqual(80);
    expect(p.hip).toBeGreaterThan(70);
    expect(p.hip).toBeLessThanOrEqual(80);
  });

  it("returns null when the torso midline is not on the body", () => {
    const { kps } = figure(40);
    expect(measureProfile(new Uint8Array(200 * 300), 200, 300, kps)).toBeNull();
  });
});

describe("widenToSilhouette", () => {
  const kps: Keypoints = {
    left_shoulder: k(130, 50),
    right_shoulder: k(70, 50),
    left_hip: k(120, 150),
    right_hip: k(80, 150),
  };
  const model: BodyProfile = { shoulder: 60, chest: 70, waist: 60, hip: 70 };

  it("leaves the garment alone when proportions match", () => {
    const f = widenToSilhouette({ ...model }, model, kps)!;
    const p = f({ x: 130, y: 100 });
    expect(p.x).toBeCloseTo(130);
  });

  it("widens around the midline for a fuller figure, within limits", () => {
    const fuller: BodyProfile = { shoulder: 60, chest: 91, waist: 90, hip: 200 };
    const f = widenToSilhouette(fuller, model, kps)!;
    const chestY = 50 + 0.3 * 100;
    const mid = 100 + (100 - 100) * 0.3;
    const p = f({ x: mid + 20, y: chestY });
    expect(p.x - mid).toBeCloseTo(20 * 1.3, 1);
    // hip ratio would be 2.86 — clamped to 1.6
    const q = f({ x: 120, y: 50 + 1.05 * 100 });
    expect(q.x - 100).toBeCloseTo(20 * 1.6, 1);
  });
});
