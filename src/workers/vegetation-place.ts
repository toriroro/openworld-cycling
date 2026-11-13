// 植生の配置（モック仕様 5.4）。タイルごとにハッシュで決める（同じ場所は毎回同じ）。Worker で動く。
// 密度は景観タイプで変える: 山岳・里山は林、平野と海岸はまばら。道路の近く・水・急斜面・高すぎる所には置かない。

import { hash } from "../shared/world/hash.ts";
import { gradNoise } from "../shared/world/noise.ts";

export const VEG_TREE = 0;
export const VEG_SHRUB = 1;
export const VEG_ROCK = 2;
export const VEG_GRASS = 3;
/** 1つの植生の要素数: x, y, z（タイルの左上から）, 大きさ, 向き, 種類 */
export const VEG_STRIDE = 6;

export interface VegContext {
  seed: number;
  x0: number;
  z0: number;
  size: number;
  /** 細かさ: 0 = なし、1 = 木だけまばら（中景）、2 = すべて（近景） */
  detail: 0 | 1 | 2;
  /** 密度の倍率（軽量画質で 0.5） */
  density: number;
  /** タイル内の位置の地面の高さ（道路に合わせた後の面） */
  ground(lx: number, lz: number): number;
  /** タイル内の位置の傾斜 */
  slope(lx: number, lz: number): number;
  /** タイル内の位置の景観の重み [海岸, 平野, 山岳, その他] */
  landscape(lx: number, lz: number): number[];
  /** 道路端からの距離（道路がなければ大きな値） */
  roadEdge(lx: number, lz: number): number;
}

function u(seed: number, a: number, b: number, c: number) {
  return hash(seed, a, b, c) / 4294967296;
}

export function placeVegetation(c: VegContext): Float32Array {
  if (c.detail === 0) return new Float32Array(0);
  const out: number[] = [];
  const seed = (c.seed * 131 + 17) | 0;
  const push = (lx: number, lz: number, scale: number, rot: number, type: number, sink: number) => {
    out.push(lx, c.ground(lx, lz) - sink, lz, scale, rot, type);
  };
  // 木: 格子ごとに1本の候補（近景 7m、中景 16m）
  const cell = c.detail === 2 ? 7 : 16;
  const n = Math.round(c.size / cell);
  for (let j = 0; j < n; j++)
    for (let i = 0; i < n; i++) {
      const gx = Math.round(c.x0 / cell) + i;
      const gz = Math.round(c.z0 / cell) + j;
      const r1 = u(seed, gx, gz, 1);
      const lx = (i + 0.15 + 0.7 * u(seed, gx, gz, 2)) * cell;
      const lz = (j + 0.15 + 0.7 * u(seed, gx, gz, 3)) * cell;
      const w = c.landscape(lx, lz);
      const wx = c.x0 + lx, wz = c.z0 + lz;
      // 林のまとまりと切れ目
      const clump = gradNoise(seed + 5, wx / 260, wz / 260);
      let dens = w[2] * 0.95 + w[3] * 0.8 + w[1] * 0.06 + w[0] * 0.05;
      dens *= Math.max(0, Math.min(1, 0.55 + clump * 1.2));
      // 中景は木の数を減らし、その分を大きくして林に見せる
      dens *= c.density * (c.detail === 2 ? 0.75 : 0.5);
      if (r1 >= dens) continue;
      const h = c.ground(lx, lz);
      if (h < 1 || h > 1500) continue;
      if (c.slope(lx, lz) > 0.9) continue;
      if (c.roadEdge(lx, lz) < 5) continue;
      const big = w[2] > 0.5 ? 1.9 : 1.4;
      const scale = big * (0.75 + 0.6 * u(seed, gx, gz, 4)) * (c.detail === 1 ? 1.25 : 1);
      push(lx, lz, scale, u(seed, gx, gz, 5) * Math.PI * 2, VEG_TREE, 0.2);
    }
  if (c.detail < 2) return Float32Array.from(out);
  // 低木と岩: 12m 格子
  const n2 = Math.round(c.size / 12);
  for (let j = 0; j < n2; j++)
    for (let i = 0; i < n2; i++) {
      const gx = Math.round(c.x0 / 12) + i;
      const gz = Math.round(c.z0 / 12) + j;
      const lx = (i + u(seed, gx, gz, 11)) * 12;
      const lz = (j + u(seed, gx, gz, 12)) * 12;
      const e = c.roadEdge(lx, lz);
      if (e < 2.5) continue;
      const h = c.ground(lx, lz);
      if (h < 0.5) continue;
      const w = c.landscape(lx, lz);
      const sl = c.slope(lx, lz);
      const r = u(seed, gx, gz, 13);
      const shrub = (0.1 + w[3] * 0.25 + w[2] * 0.15 + (e < 20 ? 0.15 : 0)) * c.density;
      const rock = (0.02 + w[2] * 0.08 + Math.max(0, sl - 0.35) * 0.4) * c.density;
      if (r < shrub) push(lx, lz, 1.2 + 1.4 * u(seed, gx, gz, 14), u(seed, gx, gz, 15) * 6.283, VEG_SHRUB, 0.1);
      else if (r < shrub + rock) push(lx, lz, 0.8 + 1.8 * u(seed, gx, gz, 16) ** 2, u(seed, gx, gz, 17) * 6.283, VEG_ROCK, 0.25);
    }
  // 草の株: 道路から 1.5〜30m の帯だけ（視点の近くでしか見えないため）、3m 格子
  const n3 = Math.round(c.size / 3);
  for (let j = 0; j < n3; j++)
    for (let i = 0; i < n3; i++) {
      const gx = Math.round(c.x0 / 3) + i;
      const gz = Math.round(c.z0 / 3) + j;
      const lx = (i + u(seed, gx, gz, 21)) * 3;
      const lz = (j + u(seed, gx, gz, 22)) * 3;
      const e = c.roadEdge(lx, lz);
      if (e < 1.5 || e > 30) continue;
      if (u(seed, gx, gz, 23) > 0.55 * c.density) continue;
      const h = c.ground(lx, lz);
      if (h < 0.6) continue;
      push(lx, lz, 0.7 + 0.8 * u(seed, gx, gz, 24), u(seed, gx, gz, 25) * 6.283, VEG_GRASS, 0.02);
    }
  return Float32Array.from(out);
}
