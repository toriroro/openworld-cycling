// 2D 地図のタイル画像（標高の陰影、景観タイプの色、海）。DOM を使わず RGBA の配列を作る。

import type { Terrain } from "../shared/world/terrain.ts";

export const TILE_PX = 256;

type RGB = [number, number, number];

const C_COAST: RGB = [222, 214, 172];
const C_PLAIN: RGB = [190, 214, 140];
const C_OTHER: RGB = [128, 172, 104];
const C_MOUNTAIN: RGB = [150, 140, 118];
const C_HIGH: RGB = [196, 190, 182];
const C_SEA_SHALLOW: RGB = [150, 196, 222];
const C_SEA_DEEP: RGB = [62, 108, 160];
const C_RIVER: RGB = [70, 128, 196];
const C_LAKE: RGB = [96, 150, 204];
const C_FLOODPLAIN: RGB = [206, 210, 176];

/** タイル（左上 x0, z0、1画素 mpp m）の RGBA */
export function renderTile(terrain: Terrain, x0: number, z0: number, mpp: number): Uint8ClampedArray {
  const N = TILE_PX;
  const G = N + 2;
  const hs = new Float64Array(G * G);
  // 水の種類: 0 陸、1 川（細い川は 1 画素以上の線にする）、2 湖、3 河原
  const wk = new Uint8Array(N * N);
  for (let j = 0; j < G; j++)
    for (let i = 0; i < G; i++) {
      const s = terrain.sample(x0 + (i - 1 + 0.5) * mpp, z0 + (j - 1 + 0.5) * mpp, true);
      hs[j * G + i] = s.height;
      if (i < 1 || j < 1 || i > N || j > N) continue;
      const k = (j - 1) * N + (i - 1);
      if (s.water === 1) continue;
      if (s.water === 3 || s.riverNear < Math.max(s.riverHalf, 0.6 * mpp)) wk[k] = 1;
      else if (s.water === 2) wk[k] = 2;
      else if (s.floodplain) wk[k] = 3;
    }

  // 景観の重みは粗い格子で求めて補間する
  const L = 17;
  const step = N / (L - 1);
  const lw = new Float64Array(L * L * 4);
  for (let j = 0; j < L; j++)
    for (let i = 0; i < L; i++) {
      const w = terrain.landscape(x0 + i * step * mpp, z0 + j * step * mpp);
      const k = (j * L + i) * 4;
      lw[k] = w.coast;
      lw[k + 1] = w.plain;
      lw[k + 2] = w.mountain;
      lw[k + 3] = w.other;
    }

  const out = new Uint8ClampedArray(N * N * 4);
  // 陰影の光源は北西の上空
  const lx = -0.6;
  const lz = -0.6;
  const ly = 0.53;
  const exag = Math.max(1, Math.min(6, 30 / mpp + 1));
  for (let j = 0; j < N; j++)
    for (let i = 0; i < N; i++) {
      const h = hs[(j + 1) * G + i + 1];
      const o = (j * N + i) * 4;
      let c: RGB;
      const water = wk[j * N + i];
      if (h < 0) {
        const t = Math.min(1, -h / 120);
        c = mix(C_SEA_SHALLOW, C_SEA_DEEP, t);
        out[o] = c[0];
        out[o + 1] = c[1];
        out[o + 2] = c[2];
        out[o + 3] = 255;
        continue;
      }
      const fi = i / step;
      const fj = j / step;
      const ii = Math.min(L - 2, Math.floor(fi));
      const jj = Math.min(L - 2, Math.floor(fj));
      const u = fi - ii;
      const v = fj - jj;
      const wv = [0, 0, 0, 0];
      for (let k = 0; k < 4; k++) {
        const a = lw[(jj * L + ii) * 4 + k];
        const b = lw[(jj * L + ii + 1) * 4 + k];
        const cc = lw[((jj + 1) * L + ii) * 4 + k];
        const d = lw[((jj + 1) * L + ii + 1) * 4 + k];
        wv[k] = (a * (1 - u) + b * u) * (1 - v) + (cc * (1 - u) + d * u) * v;
      }
      if (water === 1 || water === 2) {
        c = water === 1 ? C_RIVER : C_LAKE;
        out[o] = c[0];
        out[o + 1] = c[1];
        out[o + 2] = c[2];
        out[o + 3] = 255;
        continue;
      }
      const mtn = h > 900 ? mix(C_MOUNTAIN, C_HIGH, Math.min(1, (h - 900) / 600)) : C_MOUNTAIN;
      c = [
        C_COAST[0] * wv[0] + C_PLAIN[0] * wv[1] + mtn[0] * wv[2] + C_OTHER[0] * wv[3],
        C_COAST[1] * wv[0] + C_PLAIN[1] * wv[1] + mtn[1] * wv[2] + C_OTHER[1] * wv[3],
        C_COAST[2] * wv[0] + C_PLAIN[2] * wv[1] + mtn[2] * wv[2] + C_OTHER[2] * wv[3],
      ];
      if (water === 3) c = mix(c, C_FLOODPLAIN, 0.7);
      // 陰影
      const dx = (hs[(j + 1) * G + i + 2] - hs[(j + 1) * G + i]) / (2 * mpp) * exag;
      const dz = (hs[(j + 2) * G + i + 1] - hs[j * G + i + 1]) / (2 * mpp) * exag;
      const nl = Math.sqrt(dx * dx + 1 + dz * dz);
      const shade = (-dx * lx + ly - dz * lz) / nl;
      const k = 0.45 + 0.75 * Math.max(0, shade);
      out[o] = c[0] * k;
      out[o + 1] = c[1] * k;
      out[o + 2] = c[2] * k;
      out[o + 3] = 255;
    }
  return out;
}

function mix(a: RGB, b: RGB, t: number): RGB {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}
