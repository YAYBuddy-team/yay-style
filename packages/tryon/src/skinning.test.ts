import { describe, expect, it } from "vitest";

import { fitSkinning } from "./skinning";
import type { Keypoints } from "./types";

const k = (x: number, y: number) => ({ x, y, visibility: 1 });

// Facing the camera: the person's left side is on the image's right.
const standing: Keypoints = {
  left_shoulder: k(140, 100),
  right_shoulder: k(60, 100),
  left_elbow: k(150, 160),
  right_elbow: k(50, 160),
  left_wrist: k(155, 220),
  right_wrist: k(45, 220),
  left_hip: k(130, 220),
  right_hip: k(70, 220),
};

describe("fitSkinning", () => {
  it("is the identity when the poses match", () => {
    const t = fitSkinning("top", standing, standing)!;
    for (const [x, y] of [
      [100, 150],
      [150, 130],
      [45, 210],
    ] as const) {
      const p = t(x, y);
      expect(p.x).toBeCloseTo(x, 3);
      expect(p.y).toBeCloseTo(y, 3);
    }
  });

  it("swings a sleeve with a raised arm but keeps the torso in place", () => {
    // User raises their left arm horizontally to the image's right.
    const raised: Keypoints = {
      ...standing,
      left_elbow: k(200, 100),
      left_wrist: k(260, 100),
    };
    const t = fitSkinning("top", standing, raised)!;

    const chest = t(100, 150);
    expect(chest.x).toBeCloseTo(100, 0);
    expect(chest.y).toBeCloseTo(150, 0);

    // Mid forearm on the model (152, 190) should land near the user's mid forearm (230, 100).
    const forearm = t(152, 190);
    expect(Math.hypot(forearm.x - 230, forearm.y - 100)).toBeLessThan(25);

    // The other sleeve is untouched.
    const other = t(48, 190);
    expect(Math.hypot(other.x - 48, other.y - 190)).toBeLessThan(3);
  });

  it("needs the core joints", () => {
    const { left_hip: _l, ...noHip } = standing;
    expect(fitSkinning("top", noHip, standing)).toBeNull();
  });
});
