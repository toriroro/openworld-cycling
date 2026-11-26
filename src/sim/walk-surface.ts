// 歩く人の足元（配達の草案 16 章の歩く人。ビジュアルの点検 2026-11-26）: 幹線の歩道の上面の高さを、歩道の点の並び
// （北海道の草案 19 章。点ごとに [内側 x, z, 外側 x, z, 高さ]）から求める。DOM・Three.js を使わない。

import type { HokkaidoSidewalks } from "../shared/world/hokkaido.ts";

/** 点が三角形 (a, b, c) の中か（水平面で。辺の上を含む） */
function inTri(x: number, z: number, ax: number, az: number, bx: number, bz: number, cx: number, cz: number): boolean {
  const d1 = (x - bx) * (az - bz) - (ax - bx) * (z - bz);
  const d2 = (x - cx) * (bz - cz) - (bx - cx) * (z - cz);
  const d3 = (x - ax) * (cz - az) - (cx - ax) * (z - az);
  const neg = d1 < 0 || d2 < 0 || d3 < 0;
  const pos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(neg && pos);
}

/** 歩道の帯 1 本（歩道の点の並びの [最初の点の番号, 点の数]） */
export type SidewalkRun = readonly [number, number];

/** (x, z) が帯 run の上なら、その上面の高さ。外なら null */
export function heightOnRun(P: Float32Array, run: SidewalkRun, x: number, z: number): number | null {
  const [off, count] = run;
  for (let k = 0; k + 1 < count; k++) {
    const a = (off + k) * 5, b = a + 5;
    const ix0 = P[a], iz0 = P[a + 1], ex0 = P[a + 2], ez0 = P[a + 3];
    const ix1 = P[b], iz1 = P[b + 1], ex1 = P[b + 2], ez1 = P[b + 3];
    // 外接の箱で先に除く
    if (x < Math.min(ix0, ex0, ix1, ex1) || x > Math.max(ix0, ex0, ix1, ex1) || z < Math.min(iz0, ez0, iz1, ez1) || z > Math.max(iz0, ez0, iz1, ez1)) continue;
    // 描く側（city-build.ts の sidewalkStrip）と同じ分け方の 2 つの三角形（曲がり角などで四角形が凸でない時も同じ面になる）
    if (!inTri(x, z, ix0, iz0, ex0, ez0, ix1, iz1) && !inTri(x, z, ex0, ez0, ex1, ez1, ix1, iz1)) continue;
    // 高さは 2 点の間で、進む向きへの射影で移す
    const mx0 = (ix0 + ex0) / 2, mz0 = (iz0 + ez0) / 2, mx1 = (ix1 + ex1) / 2, mz1 = (iz1 + ez1) / 2;
    const dx = mx1 - mx0, dz = mz1 - mz0;
    const t = Math.max(0, Math.min(1, ((x - mx0) * dx + (z - mz0) * dz) / (dx * dx + dz * dz || 1)));
    return P[a + 4] + (P[b + 4] - P[a + 4]) * t;
  }
  return null;
}

/** 帯ごとの外接の箱 [x0, z0, x1, z1]（帯の最初の点の番号ごと。歩道の点の並びは頁を読むと伸びるだけなので変わらない） */
const boxes = new WeakMap<HokkaidoSidewalks, Map<number, Float32Array>>();
function boxOf(sw: HokkaidoSidewalks, run: SidewalkRun): Float32Array {
  let m = boxes.get(sw);
  if (!m) boxes.set(sw, (m = new Map()));
  let b = m.get(run[0]);
  if (!b) {
    const P = sw.pts;
    b = new Float32Array([Infinity, Infinity, -Infinity, -Infinity]);
    for (let k = 0; k < run[1]; k++) {
      const a = (run[0] + k) * 5;
      b[0] = Math.min(b[0], P[a], P[a + 2]);
      b[1] = Math.min(b[1], P[a + 1], P[a + 3]);
      b[2] = Math.max(b[2], P[a], P[a + 2]);
      b[3] = Math.max(b[3], P[a + 1], P[a + 3]);
    }
    m.set(run[0], b);
  }
  return b;
}

/** (x, z) の上にある幹線の歩道の帯。無ければ null（頁を読んでいない所も null） */
export function sidewalkRunAt(sw: HokkaidoSidewalks, x: number, z: number): SidewalkRun | null {
  const C = sw.index.cell;
  const ci = Math.floor(x / C), cj = Math.floor(z / C);
  for (let i = ci - 1; i <= ci + 1; i++)
    for (let j = cj - 1; j <= cj + 1; j++)
      for (const run of sw.index.sidewalks[`${i},${j}`] ?? []) {
        const b = boxOf(sw, run);
        if (x < b[0] || x > b[2] || z < b[1] || z > b[3]) continue;
        if (heightOnRun(sw.pts, run, x, z) !== null) return run;
      }
  return null;
}

/** (x, z) が幹線の歩道の上なら、その上面の高さ。歩道が無い・頁を読んでいなければ null */
export function sidewalkHeightAt(sw: HokkaidoSidewalks, x: number, z: number): number | null {
  const run = sidewalkRunAt(sw, x, z);
  return run ? heightOnRun(sw.pts, run, x, z) : null;
}
