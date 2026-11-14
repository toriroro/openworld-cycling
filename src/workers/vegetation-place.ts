// 植生の配置（モック仕様 5.4）。タイルごとにハッシュで決める（同じ場所は毎回同じ）。Worker で動く。
// 密度は景観タイプで変える: 山岳・里山は林、平野と海岸はまばら。道路の近く・水・急斜面・高すぎる所には置かない。
// 農地（render/farm/fields.ts）には木を置かず、防風林の並木・牧草ロール・道路沿いの作物の株を置く。

import { hash } from "../shared/world/hash.ts";
import { gradNoise } from "../shared/world/noise.ts";
import { BLOCK_U, BLOCK_V, CROP_BEAN, CROP_BEET, CROP_BUCKWHEAT, CROP_CORN, CROP_MOWN, CROP_PADDY, CROP_PASTURE, CROP_POTATO, CROP_WHEAT, fieldAt, ROWS, windbreakAt } from "../render/farm/fields.ts";

export const VEG_TREE = 0;
export const VEG_SHRUB = 1;
export const VEG_ROCK = 2;
export const VEG_GRASS = 3;
/** 牧草ロール（刈り取った牧草地） */
export const VEG_BALE = 4;
/** 作物の株（道路沿いの農地）: 葉の株、穂の束、細い葉の束、背の高い茎 */
export const VEG_CROP_LEAF = 5;
export const VEG_CROP_STALK = 6;
export const VEG_CROP_RICE = 7;
export const VEG_CROP_CORN = 8;
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
  /** 建物・喫茶店の敷地の中か */
  inLot?(lx: number, lz: number): boolean;
  /**
   * 農地の重み w（0〜1）と、田・畑・牧草地の寄り kind。農地には木・低木・岩を置かず、防風林と牧草ロールを置く。
   * 農地の中の、農地でない区画（林・草地）では w を負で返す。そこは木を増やして平地の林にする
   */
  farm?(lx: number, lz: number, out: { w: number; kind: number }): void;
  /** 農地の区画の種（render/farm/fields.ts の fieldSeed） */
  fieldSeed?: number;
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
  const fw = { w: 0, kind: 0.5 };
  const farmed = (lx: number, lz: number) => {
    if (!c.farm) return false;
    c.farm(lx, lz, fw);
    return fw.w > 0.4;
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
      // 農地の間の林（平地林）
      if (c.farm) {
        c.farm(lx, lz, fw);
        if (fw.w < -0.5) dens = Math.max(dens, (0.45 + 0.5 * Math.max(0, Math.min(1, 0.5 + clump * 1.5))) * c.density * (c.detail === 2 ? 1 : 0.6));
      }
      // 中景は木の数を減らし、その分を大きくして林に見せる
      dens *= c.density * (c.detail === 2 ? 0.75 : 0.5);
      if (r1 >= dens) continue;
      const h = c.ground(lx, lz);
      if (h < 1 || h > 1500) continue;
      if (c.slope(lx, lz) > 0.9) continue;
      if (c.roadEdge(lx, lz) < 5) continue;
      if (c.inLot?.(lx, lz)) continue;
      if (farmed(lx, lz)) continue;
      const big = w[2] > 0.5 ? 1.9 : 1.4;
      const scale = big * (0.75 + 0.6 * u(seed, gx, gz, 4)) * (c.detail === 1 ? 1.25 : 1);
      push(lx, lz, scale, u(seed, gx, gz, 5) * Math.PI * 2, VEG_TREE, 0.2);
    }
  // 防風林: 区画の西の縁（農道沿い）に、南北の並木。近景 6m ごと、中景 14m ごと
  if (c.farm && c.fieldSeed !== undefined) {
    const fs = c.fieldSeed;
    const pitch = c.detail === 2 ? 6 : 14;
    for (let iu = Math.ceil((c.x0 - 6) / BLOCK_U); iu * BLOCK_U + 5 < c.x0 + c.size; iu++) {
      const lx0 = iu * BLOCK_U + 5 - c.x0;
      if (lx0 < 0) continue;
      for (let k = Math.ceil(c.z0 / pitch); k * pitch < c.z0 + c.size; k++) {
        const wz = k * pitch;
        if (!windbreakAt(fs, iu, Math.floor(wz / BLOCK_V))) continue;
        const lx = Math.min(c.size - 0.01, lx0 + (u(seed, iu, k, 31) - 0.5) * 2.4), lz = wz - c.z0;
        c.farm(lx, lz, fw);
        if (fw.w < 0.5) continue;
        const h = c.ground(lx, lz);
        if (h < 1 || c.roadEdge(lx, lz) < 5 || c.inLot?.(lx, lz)) continue;
        push(lx, lz, (1.7 + 0.6 * u(seed, iu, k, 32)) * (c.detail === 1 ? 1.25 : 1), u(seed, iu, k, 33) * 6.283, VEG_TREE, 0.2);
      }
    }
  }
  if (c.detail < 2) return Float32Array.from(out);
  // 牧草ロール: 刈り取った牧草地に、24m 格子で 5 割
  if (c.farm && c.fieldSeed !== undefined) {
    const cellB = 24;
    for (let gz = Math.ceil(c.z0 / cellB); gz * cellB < c.z0 + c.size; gz++)
      for (let gx = Math.ceil(c.x0 / cellB); gx * cellB < c.x0 + c.size; gx++) {
        if (u(seed, gx, gz, 41) > 0.5) continue;
        const wx = gx * cellB + (u(seed, gx, gz, 42) - 0.5) * 14, wz = gz * cellB + (u(seed, gx, gz, 43) - 0.5) * 14;
        const lx = wx - c.x0, lz = wz - c.z0;
        if (lx < 0 || lz < 0 || lx >= c.size || lz >= c.size) continue;
        c.farm(lx, lz, fw);
        if (fw.w < 0.75) continue;
        const f = fieldAt(c.fieldSeed, wx, wz, fw.kind);
        if (f.crop !== CROP_MOWN || f.edge < 4) continue;
        if (c.roadEdge(lx, lz) < 6) continue;
        // 向きは南北か東西（刈り跡に沿う・直交）
        push(lx, lz, 1, u(seed, gx, gz, 44) < 0.7 ? 0 : 1.5708, VEG_BALE, 0.03);
      }
  }
  // 作物の株: 道路から 3.5〜45m の農地に、1.5m 格子。畝のある作物は畝の上にそろえる
  if (c.farm && c.fieldSeed !== undefined) {
    const cs = 1.5;
    for (let gz = Math.ceil(c.z0 / cs); gz * cs < c.z0 + c.size; gz++)
      for (let gx = Math.ceil(c.x0 / cs); gx * cs < c.x0 + c.size; gx++) {
        let wx = gx * cs, wz = gz * cs;
        const e = c.roadEdge(wx - c.x0, wz - c.z0);
        if (e < 2.5 || e > 45) continue;
        if (u(seed, gx, gz, 51) > 0.85 * c.density) continue;
        c.farm(wx - c.x0, wz - c.z0, fw);
        if (fw.w < 0.6) continue;
        wz += (u(seed, gx, gz, 52) - 0.5) * 1.2;
        const f = fieldAt(c.fieldSeed, wx, wz, fw.kind);
        if (f.edge < 1) continue;
        let type = -1, scale = 1;
        const r = u(seed, gx, gz, 53);
        if (f.crop === CROP_POTATO || f.crop === CROP_BEET || f.crop === CROP_BEAN || f.crop === CROP_CORN) {
          // 畝の上（材質の畝の明るい側）へ寄せる
          const period = ROWS[f.crop][0];
          const base = Math.floor(wx / BLOCK_U) * BLOCK_U;
          wx = base + (Math.round((wx - base) / period - 0.25) + 0.25) * period;
          if (f.crop === CROP_CORN) {
            type = VEG_CROP_CORN;
            scale = 0.85 + 0.25 * r;
          } else {
            type = VEG_CROP_LEAF;
            scale = 0.85 + 0.3 * r;
          }
        } else if (f.crop === CROP_WHEAT) {
          type = VEG_CROP_STALK;
          scale = 0.9 + 0.2 * r;
          wx += (u(seed, gx, gz, 54) - 0.5) * 1.2;
        } else if (f.crop === CROP_PADDY || f.crop === CROP_PASTURE || f.crop === CROP_BUCKWHEAT) {
          type = VEG_CROP_RICE;
          scale = f.crop === CROP_PADDY ? 0.9 + 0.2 * r : 0.6 + 0.4 * r;
          wx += (u(seed, gx, gz, 54) - 0.5) * 1.2;
        }
        if (type < 0) continue;
        const lx = wx - c.x0, lz = wz - c.z0;
        if (lx < 0 || lz < 0 || lx >= c.size || lz >= c.size) continue;
        push(lx, lz, scale, u(seed, gx, gz, 55) * 3.14, type, 0.02);
      }
  }
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
      if (c.inLot?.(lx, lz)) continue;
      if (farmed(lx, lz)) continue;
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
      if (c.inLot?.(lx, lz)) continue;
      if (u(seed, gx, gz, 23) > 0.55 * c.density) continue;
      if (farmed(lx, lz)) continue;
      const h = c.ground(lx, lz);
      if (h < 0.6) continue;
      push(lx, lz, 0.7 + 0.8 * u(seed, gx, gz, 24), u(seed, gx, gz, 25) * 6.283, VEG_GRASS, 0.02);
    }
  return Float32Array.from(out);
}
