// 道路の整形・縦断・橋（モック仕様 4.7 手順2〜4）。
// 折れ線を間引き → 求心型 Catmull-Rom → 最小曲線半径を満たすまで平滑化 → ROAD_STEP 間隔に取り直す。

import {
  BRIDGE_DECK_OVER_WATER,
  BRIDGE_MIN_HEIGHT,
  BRIDGE_MIN_LENGTH,
  JUNCTION_FLAT_GRADE,
  JUNCTION_FLAT_LENGTH,
  PROFILE_SIGMA,
  ROAD_MIN_ELEVATION,
  ROAD_STEP,
  WATER_BRIDGE_MIN_LENGTH,
} from "./constants.ts";
import type { Span } from "./types.ts";

/** 折れ線（x, z の組） */
export type Polyline = Float64Array;

/** Douglas–Peucker で間引く。keep の点は必ず残す */
export function simplify(pts: Polyline, keep: Uint8Array, tol: number): Polyline {
  const n = pts.length / 2;
  if (n <= 2) return pts.slice();
  const mark = new Uint8Array(n);
  mark[0] = 1;
  mark[n - 1] = 1;
  for (let i = 0; i < n; i++) if (keep[i]) mark[i] = 1;
  const tol2 = tol * tol;
  const stack: number[] = [];
  // keep で区切った区間ごとに処理する
  let a = 0;
  for (let i = 1; i < n; i++) {
    if (!mark[i]) continue;
    stack.push(a, i);
    a = i;
  }
  while (stack.length) {
    const j = stack.pop()!;
    const i = stack.pop()!;
    if (j - i < 2) continue;
    const ax = pts[i * 2];
    const az = pts[i * 2 + 1];
    const bx = pts[j * 2];
    const bz = pts[j * 2 + 1];
    const vx = bx - ax;
    const vz = bz - az;
    const vv = vx * vx + vz * vz;
    let best = -1;
    let bestD = tol2;
    for (let k = i + 1; k < j; k++) {
      const px = pts[k * 2] - ax;
      const pz = pts[k * 2 + 1] - az;
      let d: number;
      if (vv === 0) d = px * px + pz * pz;
      else {
        const cr = px * vz - pz * vx;
        d = (cr * cr) / vv;
      }
      if (d > bestD) {
        bestD = d;
        best = k;
      }
    }
    if (best >= 0) {
      mark[best] = 1;
      stack.push(i, best, best, j);
    }
  }
  let m = 0;
  for (let i = 0; i < n; i++) if (mark[i]) m++;
  const out = new Float64Array(m * 2);
  let o = 0;
  for (let i = 0; i < n; i++)
    if (mark[i]) {
      out[o++] = pts[i * 2];
      out[o++] = pts[i * 2 + 1];
    }
  return out;
}

/** 求心型 Catmull-Rom で細かい折れ線にする（各区間を約 spacing m ごとに） */
export function catmullRom(pts: Polyline, spacing: number): Polyline {
  const n = pts.length / 2;
  if (n < 2) return pts.slice();
  const out: number[] = [];
  const P = (i: number, c: 0 | 1): number => {
    if (i < 0) return 2 * pts[c] - pts[2 + c];
    if (i >= n) return 2 * pts[(n - 1) * 2 + c] - pts[(n - 2) * 2 + c];
    return pts[i * 2 + c];
  };
  const knot = (ax: number, az: number, bx: number, bz: number) => {
    const d = Math.sqrt((bx - ax) * (bx - ax) + (bz - az) * (bz - az));
    return Math.sqrt(d) || 1e-6;
  };
  for (let i = 0; i < n - 1; i++) {
    const x0 = P(i - 1, 0), z0 = P(i - 1, 1);
    const x1 = P(i, 0), z1 = P(i, 1);
    const x2 = P(i + 1, 0), z2 = P(i + 1, 1);
    const x3 = P(i + 2, 0), z3 = P(i + 2, 1);
    const t0 = 0;
    const t1 = t0 + knot(x0, z0, x1, z1);
    const t2 = t1 + knot(x1, z1, x2, z2);
    const t3 = t2 + knot(x2, z2, x3, z3);
    const segLen = Math.sqrt((x2 - x1) * (x2 - x1) + (z2 - z1) * (z2 - z1));
    const m = Math.max(1, Math.ceil(segLen / spacing));
    for (let k = 0; k < m; k++) {
      const t = t1 + ((t2 - t1) * k) / m;
      const a1x = ((t1 - t) * x0 + (t - t0) * x1) / (t1 - t0);
      const a1z = ((t1 - t) * z0 + (t - t0) * z1) / (t1 - t0);
      const a2x = ((t2 - t) * x1 + (t - t1) * x2) / (t2 - t1);
      const a2z = ((t2 - t) * z1 + (t - t1) * z2) / (t2 - t1);
      const a3x = ((t3 - t) * x2 + (t - t2) * x3) / (t3 - t2);
      const a3z = ((t3 - t) * z2 + (t - t2) * z3) / (t3 - t2);
      const b1x = ((t2 - t) * a1x + (t - t0) * a2x) / (t2 - t0);
      const b1z = ((t2 - t) * a1z + (t - t0) * a2z) / (t2 - t0);
      const b2x = ((t3 - t) * a2x + (t - t1) * a3x) / (t3 - t1);
      const b2z = ((t3 - t) * a2z + (t - t1) * a3z) / (t3 - t1);
      out.push(((t2 - t) * b1x + (t - t1) * b2x) / (t2 - t1), ((t2 - t) * b1z + (t - t1) * b2z) / (t2 - t1));
    }
  }
  out.push(pts[(n - 1) * 2], pts[(n - 1) * 2 + 1]);
  return Float64Array.from(out);
}

export function polylineLength(pts: Polyline): number {
  let L = 0;
  for (let i = 2; i < pts.length; i += 2) {
    const dx = pts[i] - pts[i - 2];
    const dz = pts[i + 1] - pts[i - 1];
    L += Math.sqrt(dx * dx + dz * dz);
  }
  return L;
}

/** 弧長で等間隔に取り直す。間隔は length / ceil(length / step) */
export function resample(pts: Polyline, step: number): Polyline {
  const n = pts.length / 2;
  const cum = new Float64Array(n);
  for (let i = 1; i < n; i++) {
    const dx = pts[i * 2] - pts[i * 2 - 2];
    const dz = pts[i * 2 + 1] - pts[i * 2 - 1];
    cum[i] = cum[i - 1] + Math.sqrt(dx * dx + dz * dz);
  }
  const L = cum[n - 1];
  const m = Math.max(1, Math.ceil(L / step - 1e-9));
  const out = new Float64Array((m + 1) * 2);
  let j = 0;
  for (let k = 0; k <= m; k++) {
    if (k === m) {
      out[k * 2] = pts[(n - 1) * 2];
      out[k * 2 + 1] = pts[(n - 1) * 2 + 1];
      break;
    }
    const s = (L * k) / m;
    while (j < n - 2 && cum[j + 1] < s) j++;
    const seg = cum[j + 1] - cum[j];
    const t = seg > 0 ? (s - cum[j]) / seg : 0;
    out[k * 2] = pts[j * 2] + (pts[j * 2 + 2] - pts[j * 2]) * t;
    out[k * 2 + 1] = pts[j * 2 + 1] + (pts[j * 2 + 3] - pts[j * 2 + 1]) * t;
  }
  return out;
}

/** 3点を通る円の半径。一直線なら Infinity */
export function circumradius(ax: number, az: number, bx: number, bz: number, cx: number, cz: number): number {
  const abx = bx - ax, abz = bz - az;
  const bcx = cx - bx, bcz = cz - bz;
  const cax = ax - cx, caz = az - cz;
  const cross = abx * bcz - abz * bcx;
  if (cross === 0) return Infinity;
  const a = Math.sqrt(abx * abx + abz * abz);
  const b = Math.sqrt(bcx * bcx + bcz * bcz);
  const c = Math.sqrt(cax * cax + caz * caz);
  return (a * b * c) / (2 * Math.abs(cross));
}

/**
 * 最小曲線半径を満たすまで局所的に平滑化する。両端は動かさない。
 * spacing 間隔の折れ線で行い、半径は隣り合う3点で測る。
 */
export function enforceMinRadius(pts: Polyline, minRadius: number, spacing: number, maxIter = 120): Polyline {
  let p = resample(pts, spacing);
  for (let it = 0; it < maxIter; it++) {
    const n = p.length / 2;
    if (n < 3) break;
    const bad = new Uint8Array(n);
    let any = false;
    for (let i = 1; i < n - 1; i++) {
      const r = circumradius(p[i * 2 - 2], p[i * 2 - 1], p[i * 2], p[i * 2 + 1], p[i * 2 + 2], p[i * 2 + 3]);
      if (r < minRadius * 1.08) {
        any = true;
        for (let k = Math.max(1, i - 2); k <= Math.min(n - 2, i + 2); k++) bad[k] = 1;
      }
    }
    if (!any) break;
    const q = p.slice();
    for (let i = 1; i < n - 1; i++) {
      if (!bad[i]) continue;
      const mx = (p[i * 2 - 2] + p[i * 2 + 2]) * 0.5;
      const mz = (p[i * 2 - 1] + p[i * 2 + 3]) * 0.5;
      q[i * 2] = p[i * 2] + (mx - p[i * 2]) * 0.5;
      q[i * 2 + 1] = p[i * 2 + 1] + (mz - p[i * 2 + 1]) * 0.5;
    }
    p = it % 6 === 5 ? resample(q, spacing) : q;
  }
  return p;
}

/** 中心線の整形。raw は格子点の列、keep は必ず残す点 */
export function shapeCenterline(raw: Polyline, keep: Uint8Array, minRadius: number): Polyline {
  const thin = simplify(raw, keep, 12);
  const smooth = catmullRom(thin, 4);
  const spacing = Math.max(4, Math.min(16, minRadius / 3));
  const relaxed = enforceMinRadius(smooth, minRadius, spacing);
  const curve = catmullRom(relaxed, 1);
  return resample(curve, ROAD_STEP);
}

/** 長さ L の道の各点で許す勾配（両端の接続点の前後はゆるく） */
function gradeLimits(n: number, ds: number, maxGrade: number, flatStart: boolean, flatEnd: boolean): Float64Array {
  const g = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const s = i * ds;
    const e = (n - 1 - i) * ds;
    g[i] = (flatStart && s <= JUNCTION_FLAT_LENGTH) || (flatEnd && e <= JUNCTION_FLAT_LENGTH) ? JUNCTION_FLAT_GRADE : maxGrade;
  }
  return g;
}

export interface ProfileInput {
  /** 中心線（ROAD_STEP 間隔の x, z） */
  xz: Polyline;
  /** 各点の細部を除いた地面の高さ */
  routeGround: Float64Array;
  /** 各点が水の上か */
  water: Uint8Array;
  maxGrade: number;
  startY: number;
  endY: number;
}

/**
 * 縦断。地面をガウスで平滑化し、最大勾配に収まるよう前後から制限し、両端を指定の高さに合わせる。
 * 結果は各区間で勾配の上限を守る（上下の包絡線の平均は同じ上限を守るため）。
 */
export function computeProfile(inp: ProfileInput): Float64Array {
  const n = inp.xz.length / 2;
  const ds = n > 1 ? polylineLength(inp.xz) / (n - 1) : ROAD_STEP;
  const target = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    target[i] = inp.water[i] ? BRIDGE_DECK_OVER_WATER : Math.max(inp.routeGround[i], ROAD_MIN_ELEVATION);
  }
  // ガウスの平滑化
  const sig = PROFILE_SIGMA / ds;
  const R = Math.ceil(sig * 3);
  const kern = new Float64Array(R + 1);
  for (let k = 0; k <= R; k++) {
    // exp を使わず、(1 − x²/(2·4))^4 で近似する（分岐に関わる値なので多項式で）
    const u = (k * k) / (sig * sig) / 8;
    const b = 1 - u;
    kern[k] = b > 0 ? b * b * b * b : 0;
  }
  const sm = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let sum = 0;
    let wsum = 0;
    const lo = Math.max(0, i - R);
    const hi = Math.min(n - 1, i + R);
    for (let j = lo; j <= hi; j++) {
      const w = kern[j > i ? j - i : i - j];
      sum += w * target[j];
      wsum += w;
    }
    sm[i] = sum / wsum;
  }
  sm[0] = inp.startY;
  sm[n - 1] = inp.endY;
  const g = gradeLimits(n, ds, inp.maxGrade, true, true);
  const lim = (i: number) => Math.min(g[i], g[i - 1]) * ds; // 区間 i−1→i の許容差
  const U = sm.slice();
  const Lo = sm.slice();
  for (let i = 1; i < n; i++) {
    const d = lim(i);
    if (U[i] > U[i - 1] + d) U[i] = U[i - 1] + d;
    if (Lo[i] < Lo[i - 1] - d) Lo[i] = Lo[i - 1] - d;
  }
  for (let i = n - 2; i >= 0; i--) {
    const d = lim(i + 1);
    if (U[i] > U[i + 1] + d) U[i] = U[i + 1] + d;
    if (Lo[i] < Lo[i + 1] - d) Lo[i] = Lo[i + 1] - d;
  }
  const y = new Float64Array(n);
  for (let i = 0; i < n; i++) y[i] = (U[i] + Lo[i]) * 0.5;
  // 両端を合わせる（前から、後ろから）
  y[0] = inp.startY;
  for (let i = 1; i < n; i++) {
    const d = lim(i);
    if (y[i] > y[i - 1] + d) y[i] = y[i - 1] + d;
    else if (y[i] < y[i - 1] - d) y[i] = y[i - 1] - d;
  }
  y[n - 1] = inp.endY;
  for (let i = n - 2; i >= 0; i--) {
    const d = lim(i + 1);
    if (y[i] > y[i + 1] + d) y[i] = y[i + 1] + d;
    else if (y[i] < y[i + 1] - d) y[i] = y[i + 1] - d;
  }
  return y;
}

/** 橋の区間。路面が地面より 6m 以上高い所が 40m 以上続く所と、水面上の区間 */
export function detectBridges(y: Float64Array, ground: Float64Array, water: Uint8Array, ds: number): Span[] {
  const n = y.length;
  const isB = new Uint8Array(n);
  // 高架
  let runStart = -1;
  for (let i = 0; i <= n; i++) {
    const high = i < n && !water[i] && y[i] - ground[i] >= BRIDGE_MIN_HEIGHT;
    if (high && runStart < 0) runStart = i;
    if (!high && runStart >= 0) {
      if ((i - 1 - runStart) * ds >= BRIDGE_MIN_LENGTH) for (let k = runStart; k < i; k++) isB[k] = 1;
      runStart = -1;
    }
  }
  // 水面上
  runStart = -1;
  const pad = Math.ceil(6 / ds);
  for (let i = 0; i <= n; i++) {
    const w = i < n && water[i] === 1;
    if (w && runStart < 0) runStart = i;
    if (!w && runStart >= 0) {
      if ((i - runStart) * ds >= WATER_BRIDGE_MIN_LENGTH)
        for (let k = Math.max(0, runStart - pad); k < Math.min(n, i + pad); k++) isB[k] = 1;
      runStart = -1;
    }
  }
  const spans: Span[] = [];
  runStart = -1;
  for (let i = 0; i <= n; i++) {
    const b = i < n && isB[i] === 1;
    if (b && runStart < 0) runStart = i;
    if (!b && runStart >= 0) {
      spans.push({ from: runStart * ds, to: (i - 1) * ds, kind: "bridge" });
      runStart = -1;
    }
  }
  return spans;
}
