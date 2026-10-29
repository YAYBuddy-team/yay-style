/**
 * Thin-plate spline: the smoothest 2D mapping that sends each source control point to
 * its target. With `lambda > 0` it trades exactness for smoothness, which keeps a few
 * noisy keypoints from crumpling the garment.
 */

export interface Point {
  x: number;
  y: number;
}

export interface Transform {
  (x: number, y: number): Point;
}

function kernel(r2: number): number {
  return r2 === 0 ? 0 : r2 * Math.log(r2);
}

/** Solve A·x = b in place by Gaussian elimination with partial pivoting. */
export function solve(a: number[][], b: number[]): number[] {
  const n = b.length;
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++) {
      if (Math.abs(a[r]![col]!) > Math.abs(a[pivot]![col]!)) pivot = r;
    }
    if (Math.abs(a[pivot]![col]!) < 1e-12) throw new Error("singular system");
    [a[col], a[pivot]] = [a[pivot]!, a[col]!];
    [b[col], b[pivot]] = [b[pivot]!, b[col]!];
    for (let r = col + 1; r < n; r++) {
      const f = a[r]![col]! / a[col]![col]!;
      if (f === 0) continue;
      for (let c = col; c < n; c++) a[r]![c]! -= f * a[col]![c]!;
      b[r]! -= f * b[col]!;
    }
  }
  const x = new Array<number>(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    let s = b[r]!;
    for (let c = r + 1; c < n; c++) s -= a[r]![c]! * x[c]!;
    x[r] = s / a[r]![r]!;
  }
  return x;
}

export function fitTps(src: Point[], dst: Point[], lambda = 0): Transform {
  const n = src.length;
  if (n < 3) throw new Error("TPS needs at least 3 points");
  // Normalise coordinates so the kernel and lambda behave the same at any image size.
  const scale = Math.max(...src.map((p) => Math.max(Math.abs(p.x), Math.abs(p.y))), 1);
  const s = src.map((p) => ({ x: p.x / scale, y: p.y / scale }));

  const size = n + 3;
  const build = () => {
    const a = Array.from({ length: size }, () => new Array<number>(size).fill(0));
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        const dx = s[i]!.x - s[j]!.x;
        const dy = s[i]!.y - s[j]!.y;
        a[i]![j] = kernel(dx * dx + dy * dy) + (i === j ? lambda : 0);
      }
      a[i]![n] = 1;
      a[i]![n + 1] = s[i]!.x;
      a[i]![n + 2] = s[i]!.y;
      a[n]![i] = 1;
      a[n + 1]![i] = s[i]!.x;
      a[n + 2]![i] = s[i]!.y;
    }
    return a;
  };
  const rhs = (k: "x" | "y") => [...dst.map((p) => p[k]), 0, 0, 0];
  const wx = solve(build(), rhs("x"));
  const wy = solve(build(), rhs("y"));

  return (x: number, y: number) => {
    const px = x / scale;
    const py = y / scale;
    let ox = wx[n]! + wx[n + 1]! * px + wx[n + 2]! * py;
    let oy = wy[n]! + wy[n + 1]! * px + wy[n + 2]! * py;
    for (let i = 0; i < n; i++) {
      const dx = px - s[i]!.x;
      const dy = py - s[i]!.y;
      const k = kernel(dx * dx + dy * dy);
      ox += wx[i]! * k;
      oy += wy[i]! * k;
    }
    return { x: ox, y: oy };
  };
}

/** Least-squares affine map (needs ≥3 non-collinear points). */
export function fitAffine(src: Point[], dst: Point[]): Transform & { det: number } {
  // Normal equations for [a b c; d e f] · [x y 1]^T.
  const m = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ];
  const bx = [0, 0, 0];
  const by = [0, 0, 0];
  src.forEach((p, i) => {
    const v = [p.x, p.y, 1];
    for (let r = 0; r < 3; r++) {
      for (let c = 0; c < 3; c++) m[r]![c]! += v[r]! * v[c]!;
      bx[r]! += v[r]! * dst[i]!.x;
      by[r]! += v[r]! * dst[i]!.y;
    }
  });
  const [a, b, c] = solve(m.map((r) => [...r]), bx);
  const [d, e, f] = solve(m.map((r) => [...r]), by);
  const t = ((x: number, y: number) => ({ x: a! * x + b! * y + c!, y: d! * x + e! * y + f! })) as Transform & {
    det: number;
  };
  t.det = a! * e! - b! * d!;
  return t;
}

/**
 * Least-squares similarity (uniform scale + rotation + shift). Used when the source
 * points are estimates (flat-lay garments): it places and sizes the garment without
 * stretching it to match guessed proportions.
 */
export function fitSimilarity(src: Point[], dst: Point[]): Transform {
  const n = src.length;
  if (n === 0) throw new Error("need at least 1 point");
  const mean = (ps: Point[]) => ({
    x: ps.reduce((a, p) => a + p.x, 0) / ps.length,
    y: ps.reduce((a, p) => a + p.y, 0) / ps.length,
  });
  const ms = mean(src);
  const md = mean(dst);
  let sxx = 0;
  let sxy = 0;
  let norm = 0;
  for (let i = 0; i < n; i++) {
    const ax = src[i]!.x - ms.x;
    const ay = src[i]!.y - ms.y;
    const bx = dst[i]!.x - md.x;
    const by = dst[i]!.y - md.y;
    sxx += ax * bx + ay * by;
    sxy += ax * by - ay * bx;
    norm += ax * ax + ay * ay;
  }
  const a = norm > 0 ? sxx / norm : 1; // scale·cos
  const b = norm > 0 ? sxy / norm : 0; // scale·sin
  return (x: number, y: number) => {
    const dx = x - ms.x;
    const dy = y - ms.y;
    return { x: md.x + a * dx - b * dy, y: md.y + b * dx + a * dy };
  };
}
