// 高さ関数と景観タイプ（モック仕様 4.3、4.4）。
// 分岐に使う値なので加減乗除・sqrt・floor・abs・min・max だけで計算する。

import { now } from "./clock.ts";
import { fbm, gradNoise, ridged, smoothstep } from "./noise.ts";
import { emptyHit, RiverNet, type RiverHit } from "./rivers.ts";

const S_WARP_X = 101;
const S_WARP_Z = 102;
const S_WARP2_X = 103;
const S_WARP2_Z = 104;
const S_CONTINENT = 201;
const S_MOUNTAIN = 301;
const S_RIDGE = 401;
const S_HILL = 501;
const S_DETAIL_A = 601;
const S_DETAIL_B = 602;

/**
 * 低い所を平らに寄せる高さ (m)。これより下は 0.5t + t² − 0.5t³ で縮める。
 * 海面で傾きを 0 にすると海岸の 1〜2km が標高 1m 未満の平地になるため、0.5 の傾きを残す（GENERATOR_VERSION 3）
 */
const FLATTEN_HEIGHT = 140;

export interface TerrainSample {
  /** 細部を含む高さ */
  height: number;
  /** 細部を除いた高さ（経路探索と縦断に使う） */
  routeHeight: number;
  /** 山地の分布 0〜1 */
  mountain: number;
  /** 水: 0 = 陸、1 = 海（高さ 0 未満）、2 = 湖、3 = 川の水面 */
  water: 0 | 1 | 2 | 3;
  /** 水面の高さ（water が 0 でない時。川の河原の内側ではその川の水面の高さ） */
  waterLevel: number;
  /** 川の河原（河川敷）の内側。水面を含む */
  floodplain: boolean;
  /** 川の河原の縁までの距離（影響の範囲外なら Infinity） */
  plainGap: number;
  /** 最も近い川の線までの距離（影響の範囲外なら Infinity）と、その川の水面の半幅 */
  riverNear: number;
  riverHalf: number;
}

interface BaseSample {
  base: number;
  mountain: number;
  wx: number;
  wz: number;
}

export interface LandscapeWeights {
  coast: number;
  plain: number;
  mountain: number;
  other: number;
}

export class Terrain {
  /** 大きな川の網（河川の草案 3章）。下地の高さだけから決まる */
  readonly rivers: RiverNet;
  private readonly hit: RiverHit = emptyHit();

  constructor(readonly seed: number) {
    this.rivers = new RiverNet(seed, (x, z) => this.baseSample(x, z).base, undefined, now);
  }

  private s(k: number): number {
    return (this.seed * 7919 + k) | 0;
  }

  /** 細部を除いた高さ */
  routeHeight(x: number, z: number): number {
    return this.sample(x, z, false).routeHeight;
  }

  /** 細部を含む高さ */
  height(x: number, z: number): number {
    return this.sample(x, z, true).height;
  }

  /**
   * 下地の高さ: 大陸・山地・山脈・丘を足し、低地を平らに寄せた値（河川の草案 3.1）。
   * 川の網はこの値だけから決め、決めた川でこれを削ったものを routeHeight にする。
   */
  baseHeight(x: number, z: number): number {
    return this.baseSample(x, z).base;
  }

  private baseSample(x: number, z: number): BaseSample {
    // ドメインワープで直線的な模様を消す
    const wx1 = x + 3000 * fbm(this.s(S_WARP_X), x, z, 24000, 2);
    const wz1 = z + 3000 * fbm(this.s(S_WARP_Z), x, z, 24000, 2);
    const wx = wx1 + 500 * gradNoise(this.s(S_WARP2_X), wx1 / 5200, wz1 / 5200);
    const wz = wz1 + 500 * gradNoise(this.s(S_WARP2_Z), wx1 / 5200, wz1 / 5200);

    // 大陸: 陸と海。陸に寄せる
    const land = fbm(this.s(S_CONTINENT), wx, wz, 150000, 3) * 1.15 + 0.22;
    const inland = smoothstep(0.0, 0.14, land);

    // 山地の分布（60km）
    const mDist = fbm(this.s(S_MOUNTAIN), wx, wz, 60000, 2);
    const mountain = smoothstep(0.02, 0.42, mDist) * smoothstep(0.04, 0.3, land);

    // 山脈（20km、尾根型）
    const ridge = ridged(this.s(S_RIDGE), wx, wz, 20000, 3);
    // 丘（4km）。山地と内陸ほど強く
    const hill = fbm(this.s(S_HILL), wx, wz, 4000, 2);
    const hillAmp = (14 + 150 * mountain + 40 * smoothstep(0.15, 0.5, land)) * (0.35 + 0.65 * inland);

    let e = land * 420 + mountain * ridge * 1500 + hill * hillAmp;

    let base: number;
    if (e > 0) {
      if (e < FLATTEN_HEIGHT) {
        const t = e / FLATTEN_HEIGHT;
        e = FLATTEN_HEIGHT * t * (0.5 + t * (1 - 0.5 * t));
      }
      base = e;
    } else {
      // 海底: 海岸から沖へゆるく深くなり −200m 程度で止まる
      const d = -e / 160;
      base = -200 * (d >= 1 ? 1 : d * (2 - d));
    }
    return { base, mountain, wx, wz };
  }

  sample(x: number, z: number, withDetail: boolean): TerrainSample {
    const b = this.baseSample(x, z);
    const { mountain, wx, wz } = b;
    // 大きな川で削る（河川の草案 3.6）。堤防は削った後に足す
    const rv = this.rivers.query(x, z, b.base, this.hit);
    const routeH = rv.carve + rv.levee;

    let h = routeH;
    if (withDetail) {
      // 細部（500m と 60m）。海面付近と川の河原・水面では消す
      const rough = 0.25 + 0.75 * mountain;
      const nearSea = smoothstep(2, 14, routeH < 0 ? -routeH : routeH) * (1 - rv.flat);
      const d1 = gradNoise(this.s(S_DETAIL_A), wx / 500, wz / 500) * 14 * rough;
      const d2 = gradNoise(this.s(S_DETAIL_B), x / 60, z / 60) * 1.3 * (0.4 + rough);
      h = routeH + (d1 + d2) * nearSea;
    }
    let water: TerrainSample["water"] = 0;
    let waterLevel = rv.floodplain ? rv.plainLevel : 0;
    if (routeH < 0) {
      water = 1;
      waterLevel = 0;
    }
    else if (rv.water) {
      water = 3;
      waterLevel = rv.waterLevel;
    } else if (rv.lake) {
      water = 2;
      waterLevel = rv.lakeLevel;
    }
    return {
      height: h,
      routeHeight: routeH,
      mountain,
      water,
      waterLevel,
      floodplain: rv.floodplain,
      plainGap: rv.plainGap,
      riverNear: rv.near,
      riverHalf: rv.nearHalf,
    };
  }

  /** 周囲 (±r m) の傾斜（細部を除いた高さから） */
  slope(x: number, z: number, r = 100): number {
    const gx = (this.routeHeight(x + r, z) - this.routeHeight(x - r, z)) / (2 * r);
    const gz = (this.routeHeight(x, z + r) - this.routeHeight(x, z - r)) / (2 * r);
    return Math.sqrt(gx * gx + gz * gz);
  }

  /** 600m 以内の海の近さ 0〜1（8 方向 × 2 距離の標本） */
  seaNearness(x: number, z: number): number {
    let best = 0;
    for (let k = 0; k < 8; k++) {
      const dx = DIR8X[k];
      const dz = DIR8Z[k];
      if (this.routeHeight(x + dx * 300, z + dz * 300) < 0) return 1;
      if (this.routeHeight(x + dx * 600, z + dz * 600) < 0) best = 0.6;
    }
    return best;
  }

  /** 景観タイプの重み（合計 1）。境界は連続的に混ぜる */
  landscape(x: number, z: number): LandscapeWeights {
    const e = this.routeHeight(x, z);
    const sl = this.slope(x, z);
    const sea = e < 20 ? this.seaNearness(x, z) : 0;
    const coast = sea * (1 - smoothstep(12, 26, e));
    const mountainW = Math.max(smoothstep(320, 480, e), smoothstep(0.16, 0.24, sl));
    const plainW = (1 - smoothstep(110, 190, e)) * (1 - smoothstep(0.03, 0.05, sl));
    const wc = coast;
    const wm = (1 - wc) * mountainW;
    const wp = (1 - wc - wm) * plainW;
    const wo = Math.max(0, 1 - wc - wm - wp);
    return { coast: wc, plain: wp, mountain: wm, other: wo };
  }
}

const DIR8X = [1, 0.70711, 0, -0.70711, -1, -0.70711, 0, 0.70711];
const DIR8Z = [0, 0.70711, 1, 0.70711, 0, -0.70711, -1, -0.70711];
