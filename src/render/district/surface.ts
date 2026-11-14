// 街の地面の高さ（造成した面）。8m の格子に持ち、地形タイルの三角形と同じ切り方で補間する。
// - 幹線（世界の道路）の近くは路面の高さ、離れるにつれて、ならした地形の高さ
// - 地形タイルはこの面の少し下に合わせる（terrain-tile）。街路・歩道・敷地はこの面の上に載せる
// Worker でも使うので DOM と Three.js に依存しない。

import type { Road } from "../../shared/world/types.ts";
import { type P2, polySignedDist, segDist } from "./geom.ts";

export interface SurfaceGrid {
  /** 格子の左上（世界座標、step の倍数） */
  x0: number;
  z0: number;
  step: number;
  nx: number;
  nz: number;
  /** 面の高さ */
  h: Float32Array;
  /** 街の中か（1 = 中、外周から外へ 0 まで下がる） */
  m: Float32Array;
}

export const SURFACE_STEP = 8;
/** 地形タイルを面より下げる深さ (m) */
export const DISTRICT_CLEAR = 0.15;
/** 幹線の端から、路面と同じ高さにする幅と、ならした地形へ戻す幅 */
const FLAT = 12;
const BLEND = 44;
/** 外周の外で地形へ戻す幅 */
const FADE = 20;

function smooth(t: number) {
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return t * t * (3 - 2 * t);
}

export function buildSurface(boundary: P2[], roads: Road[], raw: (x: number, z: number) => number): SurfaceGrid {
  let bx0 = Infinity, bz0 = Infinity, bx1 = -Infinity, bz1 = -Infinity;
  for (const [x, z] of boundary) {
    bx0 = Math.min(bx0, x);
    bx1 = Math.max(bx1, x);
    bz0 = Math.min(bz0, z);
    bz1 = Math.max(bz1, z);
  }
  const S = SURFACE_STEP;
  const pad = FADE + S * 2;
  const x0 = Math.floor((bx0 - pad) / S) * S, z0 = Math.floor((bz0 - pad) / S) * S;
  const nx = Math.ceil((bx1 + pad - x0) / S) + 1, nz = Math.ceil((bz1 + pad - z0) / S) + 1;
  // ならした地形: 生の高さに 3×3 の平均を 2 回
  let g = new Float32Array(nx * nz);
  for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) g[j * nx + i] = raw(x0 + i * S, z0 + j * S);
  for (let pass = 0; pass < 2; pass++) {
    const o = new Float32Array(nx * nz);
    for (let j = 0; j < nz; j++)
      for (let i = 0; i < nx; i++) {
        let s = 0, c = 0;
        for (let dj = -1; dj <= 1; dj++)
          for (let di = -1; di <= 1; di++) {
            const a = i + di, b = j + dj;
            if (a < 0 || b < 0 || a >= nx || b >= nz) continue;
            s += g[b * nx + a];
            c++;
          }
        o[j * nx + i] = s / c;
      }
    g = o;
  }
  // 道路の線分（8m ごと。範囲の近くだけ）
  const segs: number[] = [];
  const reach = FLAT + BLEND + 20;
  for (const r of roads) {
    if (r.kind === "cycleway") continue;
    const P = r.points;
    const n = P.length / 3;
    const hw = r.width / 2;
    for (let i = 0; i < n - 1; i += 4) {
      const j = Math.min(n - 1, i + 4);
      const ax = P[i * 3] + r.origin[0], az = P[i * 3 + 2] + r.origin[1];
      const cx = P[j * 3] + r.origin[0], cz = P[j * 3 + 2] + r.origin[1];
      if (Math.max(ax, cx) < x0 - reach || Math.min(ax, cx) > x0 + nx * S + reach || Math.max(az, cz) < z0 - reach || Math.min(az, cz) > z0 + nz * S + reach) continue;
      segs.push(ax, az, P[i * 3 + 1], cx, cz, P[j * 3 + 1], hw);
    }
  }
  const h = new Float32Array(nx * nz);
  const m = new Float32Array(nx * nz);
  for (let j = 0; j < nz; j++)
    for (let i = 0; i < nx; i++) {
      const x = x0 + i * S, z = z0 + j * S;
      let e = Infinity, y = 0;
      for (let k = 0; k < segs.length; k += 7) {
        const q = segDist(x, z, segs[k], segs[k + 1], segs[k + 3], segs[k + 4]);
        const d = q.d - segs[k + 6];
        if (d < e) {
          e = d;
          y = segs[k + 2] + (segs[k + 5] - segs[k + 2]) * q.t;
        }
      }
      const t = e === Infinity ? 1 : smooth((e - FLAT) / BLEND);
      h[j * nx + i] = y * (1 - t) + g[j * nx + i] * t;
      const sd = polySignedDist(boundary, x, z);
      // 水面の近く（ならした地形が 1.2m 未満）は街にしない（海・川・湖を埋めない。既存の建物の基準は 1m）
      m[j * nx + i] = (sd <= 0 ? 1 : 1 - smooth(sd / FADE)) * smooth((g[j * nx + i] - 0.6) / 0.6);
    }
  return { x0, z0, step: S, nx, nz, h, m };
}

/**
 * 面の高さと、街の中かの重み。格子の外は null。
 * 補間は地形タイル（terrain-tile）の三角形と同じ: 升目の番号の和が奇数なら右上-左下の対角、偶数なら左上-右下。
 */
export function sampleSurface(g: SurfaceGrid, x: number, z: number, out: { h: number; m: number }): boolean {
  const fx = (x - g.x0) / g.step, fz = (z - g.z0) / g.step;
  if (fx < 0 || fz < 0 || fx > g.nx - 1 || fz > g.nz - 1) return false;
  const i = Math.min(g.nx - 2, Math.floor(fx)), j = Math.min(g.nz - 2, Math.floor(fz));
  const u = fx - i, v = fz - j;
  const k = j * g.nx + i;
  const odd = ((Math.round(g.x0 / g.step) + i + Math.round(g.z0 / g.step) + j) & 1) === 1;
  out.h = tri(g.h[k], g.h[k + 1], g.h[k + g.nx], g.h[k + g.nx + 1], u, v, odd);
  out.m = tri(g.m[k], g.m[k + 1], g.m[k + g.nx], g.m[k + g.nx + 1], u, v, odd);
  return true;
}

function tri(a: number, b: number, c: number, d: number, u: number, v: number, odd: boolean): number {
  if (odd) return u + v <= 1 ? a + (b - a) * u + (c - a) * v : d + (c - d) * (1 - u) + (b - d) * (1 - v);
  return u >= v ? a + (b - a) * u + (d - b) * v : a + (c - a) * v + (d - c) * u;
}
