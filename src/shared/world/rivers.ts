// 大きな川の網（河川の草案 3章、段階 R1）。
// 下地の高さ（川で削る前の routeHeight）だけから決まり、どこから・どの順で計算しても同じになる。
// 分岐に関わる計算は加減乗除・sqrt・floor・abs・min・max だけで書く（モック仕様 4.2【固定】）。
//
// 1. 川の格子（RIVER_GRID）の各点は、格子のハッシュでずらした位置の下地の高さを持つ。
// 2. 各点は周囲 8 点のうち「高さの差 ÷ 距離」が最も大きく下がる点へ流れる。海の点は終点。
// 3. どの隣より低い点（くぼ地）は、半径 RIVER_PIT_RADIUS 格子以内で最も近い低い点へ水路を切る。無ければ湖。
// 4. 流域 = 上流 RIVER_REACH 格子の道のり以内でそこへ流れ込む点の数。RIVER_MIN_ACC 以上を大きな川とする。
// 5. 川の線は格子点を結ぶ Catmull-Rom（接線の長さを弦の長さで抑える）。水面の高さは上流から下流へ上がらない。

import { hashUnit } from "./hash.ts";
import { smoothstep } from "./noise.ts";

/** 川の格子の一辺 (m) */
export const RIVER_GRID = 2000;
/** 流域を数える上流の道のり（格子の数。斜めは 1、水路はチェビシェフ距離で数える） */
export const RIVER_REACH = 40;
/** 大きな川とする流域（格子点の数。1 点 = 4km²） */
export const RIVER_MIN_ACC = 10;
/** くぼ地から水路を切る半径（格子） */
export const RIVER_PIT_RADIUS = 3;
/** 川の線の点の間隔 (m) */
export const RIVER_SAMPLE = 40;

/** 川のブロックの一辺（格子の数）。ブロックごとに川の線を求めて覚える */
const BLOCK = 16;
const BLOCK_SIZE = BLOCK * RIVER_GRID;
/** ブロックに入れる川の線の元の格子の余白（格子）。川の線の形と影響の幅がこの中に収まる（テストで確かめる） */
const SEG_MARGIN = 5;
export const RIVER_BLOCK_SIZE = BLOCK_SIZE;
export const RIVER_SEG_MARGIN = SEG_MARGIN;
/** 流域を求める範囲の余白（水路で入る上流の点を含める） */
const ACC_MARGIN = SEG_MARGIN + RIVER_PIT_RADIUS + 1;
/** 格子点の位置をずらす量（格子の割合、±） */
const JITTER = 0.3;
/** 空間索引の升目 (m) */
const INDEX_CELL = 500;
const INDEX_N = BLOCK_SIZE / INDEX_CELL;
/** 1 つのまとまりにする小区間の数（まとまりごとに外接矩形で絞る） */
const GROUP = 8;
/** 湖の半径 (m) */
const LAKE_RADIUS = 1200;
/** 輪が底とほとんど同じ高さの時の池の深さ (m) */
const LAKE_MIN_DEPTH = 2;

const KEY_OFF = 1 << 20;
const KEY_MUL = 2097152;

const SALT_JITTER = 71;

/** 流れの向きの符号: 0..48 = (dx+3)*7+(dz+3)、海 = 200、湖 = 201、未計算 = 255 */
const DIR_SEA = 200;
const DIR_LAKE = 201;
const DIR_UNSET = 255;

// 16 方向（noise.ts と同じ定数。三角関数は使わない）
const RX = [
  1, 0.92388, 0.70711, 0.38268, 0, -0.38268, -0.70711, -0.92388, -1, -0.92388, -0.70711, -0.38268, 0, 0.38268,
  0.70711, 0.92388,
];
const RZ = [
  0, 0.38268, 0.70711, 0.92388, 1, 0.92388, 0.70711, 0.38268, 0, -0.38268, -0.70711, -0.92388, -1, -0.92388,
  -0.70711, -0.38268,
];

function key(i: number, j: number): number {
  return (i + KEY_OFF) * KEY_MUL + (j + KEY_OFF);
}

/** 流域から川の大きさ（河川の草案 3.4 の表）。半幅 (m) */
export function riverSize(acc: number): { water: number; plain: number; levee: number; t: number } {
  const area = acc * 4;
  const sa = Math.sqrt(area);
  let water: number;
  let total: number;
  let levee: number;
  if (area < 200) {
    const t = clamp01((sa - 6.324555320336759) / (14.142135623730951 - 6.324555320336759));
    water = 8 + 12 * t;
    total = 20 + 30 * t;
    levee = 0;
  } else if (area < 1000) {
    const t = clamp01((sa - 14.142135623730951) / (31.622776601683793 - 14.142135623730951));
    water = 20 + 40 * t;
    total = 60 + 140 * t;
    levee = 4;
  } else {
    const t = clamp01((sa - 31.622776601683793) / (63.245553203367585 - 31.622776601683793));
    water = 60 + 90 * t;
    total = 200 + 300 * t;
    levee = 6;
  }
  return { water: water / 2, plain: total / 2, levee, t: clamp01((water - 8) / 142) };
}

function clamp01(t: number): number {
  return t < 0 ? 0 : t > 1 ? 1 : t;
}

/** 川の線（格子点 1 つから下流の格子点まで） */
export interface RiverSeg {
  /** 元の格子 */
  i: number;
  j: number;
  /** 下流の格子 */
  di: number;
  dj: number;
  n: number;
  x: Float64Array;
  z: Float64Array;
  /** 水面の高さ */
  w: Float64Array;
  /** 水面の半幅 */
  ww: Float64Array;
  /** 河原（河川敷）を含む半幅 */
  wf: Float64Array;
  /** 谷の斜面の幅 */
  v: Float64Array;
  /** 堤防の高さ（0 = なし） */
  lv: Float64Array;
  /** 影響の及ぶ距離（河原の半幅 + 谷の幅） */
  r: Float64Array;
  /** 流域（元の格子点、下流の格子点） */
  acc: number;
  accEnd: number;
  /** 水面の下の深さ、河原の水面からの高さ */
  depth: number;
  fpH: number;
  toSea: boolean;
  toLake: boolean;
  /** 本流として続く（下流の格子点の本流の上流がこの格子） */
  main: boolean;
  /** 影響の及ぶ外接矩形 */
  x0: number;
  z0: number;
  x1: number;
  z1: number;
  /** 小区間のまとまりごとの影響の外接矩形 [x0, z0, x1, z1, ...] */
  gb: Float64Array;
}

export interface Lake {
  i: number;
  j: number;
  x: number;
  z: number;
  bottom: number;
  level: number;
  r: number;
}

interface CellChunk {
  x: Float64Array;
  z: Float64Array;
  h: Float64Array;
  dir: Uint8Array;
}

interface RiverBlock {
  segs: RiverSeg[];
  lakes: Lake[];
  /** 空間索引: 升目ごとの川の線の番号 */
  index: (number[] | null)[];
  /** 河口（海へ出る川の線の、海岸を越える点） */
  mouths: { x: number; z: number; acc: number }[];
  /** 元の格子 → 川の線 */
  byCell: Map<number, RiverSeg>;
}

/** 点の周りの川の情報（query の結果。使い回す） */
export interface RiverHit {
  /** 削った後の高さ（下地の高さ以下） */
  carve: number;
  /** 堤防の盛り上がり */
  levee: number;
  /** 細部を消す割合 0〜1（河原と水面の中で 1） */
  flat: number;
  /** 川の水面の内側 */
  water: boolean;
  /** 川の水面の高さ（water の時） */
  waterLevel: number;
  /** 河原の内側（水面を含む） */
  floodplain: boolean;
  /** 河原の内側の時、その川の水面の高さ（河原の縁から最も深く入っている川） */
  plainLevel: number;
  /** 河原の縁までの距離の最小（影響の範囲外なら Infinity） */
  plainGap: number;
  /** 最も近い川の線までの距離（影響の範囲外なら Infinity）とその流域 */
  near: number;
  nearAcc: number;
  /** 最も近い川の線の水面の半幅 */
  nearHalf: number;
  /** 湖の内側と湖面の高さ */
  lake: boolean;
  lakeLevel: number;
}

export function emptyHit(): RiverHit {
  return {
    carve: 0,
    levee: 0,
    flat: 0,
    water: false,
    waterLevel: 0,
    floodplain: false,
    plainLevel: 0,
    plainGap: Infinity,
    near: Infinity,
    nearAcc: 0,
    nearHalf: 0,
    lake: false,
    lakeLevel: 0,
  };
}

export interface RiverStats {
  cells: number;
  sea: number;
  pits: number;
  channels: number;
  lakes: number;
}

export class RiverNet {
  private chunks = new Map<number, CellChunk>();
  private blocks = new Map<number, RiverBlock>();
  private segCache = new Map<number, RiverSeg | null>();
  private lakeCache = new Map<number, Lake>();
  /** 計測用: ブロックの計算時間 (ms) の合計と回数 */
  blockMs = 0;
  blockCount = 0;

  /**
   * @param base 下地の高さ（川で削る前の routeHeight）
   * @param reach 流域を数える上流の道のり（試作の比較用に変えられる）
   */
  constructor(
    readonly seed: number,
    private readonly base: (x: number, z: number) => number,
    readonly reach = RIVER_REACH,
    private readonly clock: () => number = () => 0,
    readonly pitRadius = RIVER_PIT_RADIUS,
  ) {}

  // ---- 格子点 ----

  private chunk(ci: number, cj: number): CellChunk {
    const k = key(ci, cj);
    let c = this.chunks.get(k);
    if (c) return c;
    const N = BLOCK * BLOCK;
    c = { x: new Float64Array(N), z: new Float64Array(N), h: new Float64Array(N), dir: new Uint8Array(N).fill(DIR_UNSET) };
    for (let b = 0; b < BLOCK; b++)
      for (let a = 0; a < BLOCK; a++) {
        const i = ci * BLOCK + a;
        const j = cj * BLOCK + b;
        const ux = hashUnit(this.seed, i, j, SALT_JITTER * 2);
        const uz = hashUnit(this.seed, i, j, SALT_JITTER * 2 + 1);
        const x = (i + 0.5 + JITTER * (2 * ux - 1)) * RIVER_GRID;
        const z = (j + 0.5 + JITTER * (2 * uz - 1)) * RIVER_GRID;
        const o = b * BLOCK + a;
        c.x[o] = x;
        c.z[o] = z;
        c.h[o] = this.base(x, z);
      }
    if (this.chunks.size > 900) this.chunks.delete(this.chunks.keys().next().value!);
    this.chunks.set(k, c);
    return c;
  }

  private at(i: number, j: number): { c: CellChunk; o: number } {
    const ci = Math.floor(i / BLOCK);
    const cj = Math.floor(j / BLOCK);
    return { c: this.chunk(ci, cj), o: (j - cj * BLOCK) * BLOCK + (i - ci * BLOCK) };
  }

  /** 格子点の下地の高さ */
  cellHeight(i: number, j: number): number {
    const { c, o } = this.at(i, j);
    return c.h[o];
  }

  /** 格子点の位置 */
  cellPos(i: number, j: number): [number, number] {
    const { c, o } = this.at(i, j);
    return [c.x[o], c.z[o]];
  }

  /** 流れの向きの符号 */
  dir(i: number, j: number): number {
    const { c, o } = this.at(i, j);
    let d = c.dir[o];
    if (d !== DIR_UNSET) return d;
    d = this.computeDir(i, j, c.h[o]);
    c.dir[o] = d;
    return d;
  }

  private computeDir(i: number, j: number, h: number): number {
    if (h < 0) return DIR_SEA;
    // 一番大きく下がる隣。同じ値なら格子番号の小さい方（j、次に i）
    let best = -1;
    let bestDrop = 0;
    for (let dz = -1; dz <= 1; dz++)
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dz === 0) continue;
        const hn = this.cellHeight(i + dx, j + dz);
        let drop = h - hn;
        if (dx !== 0 && dz !== 0) drop *= Math.SQRT1_2;
        if (drop > bestDrop) {
          bestDrop = drop;
          best = (dx + 3) * 7 + (dz + 3);
        }
      }
    if (best >= 0) return best;
    // くぼ地: 半径 RIVER_PIT_RADIUS 以内で最も近い低い点（同じ距離なら最も低い点、次に格子番号の小さい方）
    const R = this.pitRadius;
    let bd = Infinity;
    let bh = Infinity;
    for (let dz = -R; dz <= R; dz++)
      for (let dx = -R; dx <= R; dx++) {
        const d2 = dx * dx + dz * dz;
        if (d2 === 0 || d2 > R * R) continue;
        const hn = this.cellHeight(i + dx, j + dz);
        if (hn >= h) continue;
        if (d2 < bd || (d2 === bd && hn < bh)) {
          bd = d2;
          bh = hn;
          best = (dx + 3) * 7 + (dz + 3);
        }
      }
    return best >= 0 ? best : DIR_LAKE;
  }

  /** 終点の種類（海・湖）。終点でなければ null */
  terminal(i: number, j: number): "sea" | "lake" | null {
    const d = this.dir(i, j);
    return d === DIR_SEA ? "sea" : d === DIR_LAKE ? "lake" : null;
  }

  /** 格子 (i, j) から出る川の線（大きな川でなければ null） */
  segAt(i: number, j: number): RiverSeg | null {
    const [x, z] = this.cellPos(i, j);
    const b = this.block(Math.floor(x / BLOCK_SIZE), Math.floor(z / BLOCK_SIZE));
    return b.byCell.get(key(i, j)) ?? null;
  }

  /** 格子 (i, j) へ本流として流れ込む川の線 */
  mainUpSeg(i: number, j: number): RiverSeg | null {
    const R = this.pitRadius;
    for (let dz = -R; dz <= R; dz++)
      for (let dx = -R; dx <= R; dx++) {
        if (dx === 0 && dz === 0) continue;
        const d = this.down(i + dx, j + dz);
        if (!d || d[0] !== i || d[1] !== j) continue;
        const s = this.segAt(i + dx, j + dz);
        if (s && s.main) return s;
      }
    return null;
  }

  /** 下流の格子（終点なら null） */
  down(i: number, j: number): [number, number] | null {
    const d = this.dir(i, j);
    if (d >= DIR_SEA) return null;
    return [i + Math.floor(d / 7) - 3, j + (d % 7) - 3];
  }

  private isLocalMin(i: number, j: number): boolean {
    const h = this.cellHeight(i, j);
    for (let dz = -1; dz <= 1; dz++)
      for (let dx = -1; dx <= 1; dx++) {
        if ((dx !== 0 || dz !== 0) && this.cellHeight(i + dx, j + dz) < h) return false;
      }
    return true;
  }

  // ---- 流域 ----

  /**
   * 範囲 [i0, i1) × [j0, j1) の格子点の流域。
   * 上流 reach 格子の道のり以内の点だけを数えるので、範囲を reach 広げた窓の点から下流へたどれば足りる。
   */
  accumulation(i0: number, j0: number, i1: number, j1: number): Int32Array {
    const w = i1 - i0;
    const h = j1 - j0;
    const acc = new Int32Array(w * h);
    const R = this.reach;
    for (let qj = j0 - R; qj < j1 + R; qj++)
      for (let qi = i0 - R; qi < i1 + R; qi++) {
        let ci = qi;
        let cj = qj;
        let budget = R;
        for (;;) {
          // 範囲から budget より遠ければ、もう範囲に届かない
          const ox = ci < i0 ? i0 - ci : ci >= i1 ? ci - i1 + 1 : 0;
          const oz = cj < j0 ? j0 - cj : cj >= j1 ? cj - j1 + 1 : 0;
          const out = ox > oz ? ox : oz;
          if (out > budget) break;
          if (out === 0) acc[(cj - j0) * w + (ci - i0)]++;
          const d = this.dir(ci, cj);
          if (d >= DIR_SEA) break;
          const dx = Math.floor(d / 7) - 3;
          const dz = (d % 7) - 3;
          const step = Math.max(Math.abs(dx), Math.abs(dz));
          budget -= step;
          if (budget < 0) break;
          ci += dx;
          cj += dz;
        }
      }
    return acc;
  }

  // ---- ブロック ----

  private block(bi: number, bj: number): RiverBlock {
    const k = key(bi, bj);
    let b = this.blocks.get(k);
    if (b) return b;
    const t0 = this.clock();
    b = this.buildBlock(bi, bj);
    this.blockMs += this.clock() - t0;
    this.blockCount++;
    if (this.blocks.size > 24) this.blocks.delete(this.blocks.keys().next().value!);
    this.blocks.set(k, b);
    return b;
  }

  /** ブロックに入る川の線（計測・地図・テスト用） */
  blockAt(x: number, z: number): { segs: RiverSeg[]; lakes: Lake[]; mouths: { x: number; z: number; acc: number }[] } {
    return this.block(Math.floor(x / BLOCK_SIZE), Math.floor(z / BLOCK_SIZE));
  }

  /** rect にかかる川の線と湖 */
  inRect(x0: number, z0: number, x1: number, z1: number): { segs: RiverSeg[]; lakes: Lake[] } {
    const segs = new Map<string, RiverSeg>();
    const lakes = new Map<string, Lake>();
    for (let bj = Math.floor(z0 / BLOCK_SIZE); bj <= Math.floor(z1 / BLOCK_SIZE); bj++)
      for (let bi = Math.floor(x0 / BLOCK_SIZE); bi <= Math.floor(x1 / BLOCK_SIZE); bi++) {
        const b = this.block(bi, bj);
        for (const s of b.segs) if (s.x1 >= x0 && s.x0 <= x1 && s.z1 >= z0 && s.z0 <= z1) segs.set(`${s.i}_${s.j}`, s);
        for (const l of b.lakes)
          if (l.x + l.r >= x0 && l.x - l.r <= x1 && l.z + l.r >= z0 && l.z - l.r <= z1) lakes.set(`${l.i}_${l.j}`, l);
      }
    const order = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
    return {
      segs: [...segs.entries()].sort((a, b) => order(a[0], b[0])).map((e) => e[1]),
      lakes: [...lakes.entries()].sort((a, b) => order(a[0], b[0])).map((e) => e[1]),
    };
  }

  private buildBlock(bi: number, bj: number): RiverBlock {
    const ci0 = bi * BLOCK;
    const cj0 = bj * BLOCK;
    // 流域を求める範囲
    const ai0 = ci0 - ACC_MARGIN;
    const aj0 = cj0 - ACC_MARGIN;
    const ai1 = ci0 + BLOCK + ACC_MARGIN;
    const aj1 = cj0 + BLOCK + ACC_MARGIN;
    const aw = ai1 - ai0;
    let acc: Int32Array | null = null;
    const accAt = (i: number, j: number) => {
      if (!acc) acc = this.accumulation(ai0, aj0, ai1, aj1);
      return acc[(j - aj0) * aw + (i - ai0)];
    };
    const segs: RiverSeg[] = [];
    const byCell = new Map<number, RiverSeg>();
    const lakes: Lake[] = [];
    const mouths: { x: number; z: number; acc: number }[] = [];
    for (let j = cj0 - SEG_MARGIN; j < cj0 + BLOCK + SEG_MARGIN; j++)
      for (let i = ci0 - SEG_MARGIN; i < ci0 + BLOCK + SEG_MARGIN; i++) {
        const k = key(i, j);
        let s = this.segCache.get(k);
        if (s === undefined) {
          s = this.buildSeg(i, j, accAt);
          if (this.segCache.size > 40000) this.segCache.delete(this.segCache.keys().next().value!);
          this.segCache.set(k, s);
        }
        if (s) {
          segs.push(s);
          byCell.set(k, s);
          if (s.toSea) {
            // 河口: 水面が 0 になった最初の点
            let m = s.n - 1;
            for (let p = 0; p < s.n; p++)
              if (s.w[p] <= 0) {
                m = p;
                break;
              }
            mouths.push({ x: s.x[m], z: s.z[m], acc: s.acc });
          }
        }
        if (this.dir(i, j) === DIR_LAKE) lakes.push(this.lake(i, j));
      }
    // 空間索引
    const index: (number[] | null)[] = new Array(INDEX_N * INDEX_N).fill(null);
    const bx0 = bi * BLOCK_SIZE;
    const bz0 = bj * BLOCK_SIZE;
    segs.forEach((s, si) => {
      const gx0 = Math.max(0, Math.floor((s.x0 - bx0) / INDEX_CELL));
      const gx1 = Math.min(INDEX_N - 1, Math.floor((s.x1 - bx0) / INDEX_CELL));
      const gz0 = Math.max(0, Math.floor((s.z0 - bz0) / INDEX_CELL));
      const gz1 = Math.min(INDEX_N - 1, Math.floor((s.z1 - bz0) / INDEX_CELL));
      for (let gz = gz0; gz <= gz1; gz++)
        for (let gx = gx0; gx <= gx1; gx++) {
          const c = gz * INDEX_N + gx;
          const l = index[c];
          if (l) l.push(si);
          else index[c] = [si];
        }
    });
    return { segs, lakes, index, mouths, byCell };
  }

  /** 流れ込む格子のうち流域が最大のもの（本流の上流）。同じなら格子番号の小さい方 */
  private mainUp(i: number, j: number, accAt: (i: number, j: number) => number): [number, number, number] | null {
    const R = RIVER_PIT_RADIUS;
    let best: [number, number, number] | null = null;
    for (let dz = -R; dz <= R; dz++)
      for (let dx = -R; dx <= R; dx++) {
        if (dx === 0 && dz === 0) continue;
        const d = this.down(i + dx, j + dz);
        if (!d || d[0] !== i || d[1] !== j) continue;
        const a = accAt(i + dx, j + dz);
        if (!best || a > best[2]) best = [i + dx, j + dz, a];
      }
    return best;
  }

  private buildSeg(i: number, j: number, accAt: (i: number, j: number) => number): RiverSeg | null {
    const accA = accAt(i, j);
    if (accA < RIVER_MIN_ACC) return null;
    const dn = this.down(i, j);
    if (!dn) return null;
    const [bi, bj] = dn;
    const accB = accAt(bi, bj);
    const dB = this.dir(bi, bj);
    const toSea = dB === DIR_SEA;
    const toLake = dB === DIR_LAKE;
    const up = this.mainUp(i, j, accAt);
    const upB = this.mainUp(bi, bj, accAt);
    const main = !!upB && upB[0] === i && upB[1] === j;
    const [ax, az] = this.cellPos(i, j);
    let [bx, bz] = this.cellPos(bi, bj);
    // 湖へ流れ込む川は湖の底で終える
    const lakeEnd = toLake ? this.lake(bi, bj) : null;
    if (lakeEnd) [bx, bz] = [lakeEnd.x, lakeEnd.z];
    // 前後の点（無ければ反対側へ折り返した点）
    let px: number;
    let pz: number;
    if (up && up[2] >= RIVER_MIN_ACC) [px, pz] = this.cellPos(up[0], up[1]);
    else {
      px = 2 * ax - bx;
      pz = 2 * az - bz;
    }
    const dd = toSea || toLake ? null : this.down(bi, bj);
    let qx: number;
    let qz: number;
    if (dd) [qx, qz] = this.cellPos(dd[0], dd[1]);
    else {
      qx = 2 * bx - ax;
      qz = 2 * bz - az;
    }
    const L = Math.sqrt((bx - ax) * (bx - ax) + (bz - az) * (bz - az));
    // Catmull-Rom の接線。長さを弦の長さまでに抑えて、線が元の格子から離れすぎないようにする
    let m1x = (bx - px) * 0.5;
    let m1z = (bz - pz) * 0.5;
    let m2x = (qx - ax) * 0.5;
    let m2z = (qz - az) * 0.5;
    const l1 = Math.sqrt(m1x * m1x + m1z * m1z);
    if (l1 > L) {
      m1x *= L / l1;
      m1z *= L / l1;
    }
    const l2 = Math.sqrt(m2x * m2x + m2z * m2z);
    if (l2 > L) {
      m2x *= L / l2;
      m2z *= L / l2;
    }
    const n = Math.max(2, Math.ceil(L / RIVER_SAMPLE) + 1);
    const X = new Float64Array(n);
    const Z = new Float64Array(n);
    for (let p = 0; p < n; p++) {
      const t = p / (n - 1);
      const t2 = t * t;
      const t3 = t2 * t;
      const h00 = 2 * t3 - 3 * t2 + 1;
      const h10 = t3 - 2 * t2 + t;
      const h01 = -2 * t3 + 3 * t2;
      const h11 = t3 - t2;
      X[p] = h00 * ax + h10 * m1x + h01 * bx + h11 * m2x;
      Z[p] = h00 * az + h10 * m1z + h01 * bz + h11 * m2z;
    }
    X[0] = ax;
    Z[0] = az;
    X[n - 1] = bx;
    Z[n - 1] = bz;

    // 大きさ: 元の格子の流域。本流は終わりの 30% で下流の流域へ寄せる
    const sA = riverSize(accA);
    const sB = riverSize(main ? accB : accA);
    const W = new Float64Array(n);
    const WW = new Float64Array(n);
    const WF = new Float64Array(n);
    const V = new Float64Array(n);
    const LV = new Float64Array(n);
    const RR = new Float64Array(n);
    const hA = Math.max(0, this.cellHeight(i, j));
    const hB = Math.max(0, lakeEnd ? lakeEnd.bottom : this.cellHeight(bi, bj));
    let run = hA;
    for (let p = 0; p < n; p++) {
      const t = p / (n - 1);
      const u = smoothstep(0.7, 1, t);
      WW[p] = sA.water + (sB.water - sA.water) * u;
      WF[p] = sA.plain + (sB.plain - sA.plain) * u;
      const lvMax = sA.levee + (sB.levee - sA.levee) * u;
      // 横断の向き
      const p0 = p > 0 ? p - 1 : p;
      const p1 = p < n - 1 ? p + 1 : p;
      let tx = X[p1] - X[p0];
      let tz = Z[p1] - Z[p0];
      const tl = Math.sqrt(tx * tx + tz * tz) || 1;
      tx /= tl;
      tz /= tl;
      const hc = this.base(X[p], Z[p]);
      const hl = this.base(X[p] - tz * WF[p], Z[p] + tx * WF[p]);
      const hr = this.base(X[p] + tz * WF[p], Z[p] - tx * WF[p]);
      const lo = Math.min(hc, hl, hr);
      if (p === 0) W[p] = hA;
      else if (p === n - 1) W[p] = hB;
      else {
        if (lo < run) run = lo;
        W[p] = Math.min(hA, Math.max(hB, run));
      }
      const cut = Math.max(0, Math.max(hc, hl, hr) - W[p]);
      V[p] = Math.min(1500, 100 + 3 * cut);
      // 堤防は平地（低く、谷が浅い所）だけ
      LV[p] = lvMax * (1 - smoothstep(60, 150, W[p])) * (1 - smoothstep(8, 25, cut));
      RR[p] = WF[p] + V[p];
    }
    // 外接矩形
    let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
    const ng = Math.ceil((n - 1) / GROUP);
    const gb = new Float64Array(ng * 4);
    for (let g = 0; g < ng; g++) {
      let gx0 = Infinity, gz0 = Infinity, gx1 = -Infinity, gz1 = -Infinity;
      const pe = Math.min(n - 1, (g + 1) * GROUP);
      for (let p = g * GROUP; p <= pe; p++) {
        const r = RR[p];
        if (X[p] - r < gx0) gx0 = X[p] - r;
        if (X[p] + r > gx1) gx1 = X[p] + r;
        if (Z[p] - r < gz0) gz0 = Z[p] - r;
        if (Z[p] + r > gz1) gz1 = Z[p] + r;
      }
      gb[g * 4] = gx0;
      gb[g * 4 + 1] = gz0;
      gb[g * 4 + 2] = gx1;
      gb[g * 4 + 3] = gz1;
      if (gx0 < x0) x0 = gx0;
      if (gz0 < z0) z0 = gz0;
      if (gx1 > x1) x1 = gx1;
      if (gz1 > z1) z1 = gz1;
    }
    return {
      i,
      j,
      di: bi,
      dj: bj,
      n,
      x: X,
      z: Z,
      w: W,
      ww: WW,
      wf: WF,
      v: V,
      lv: LV,
      r: RR,
      acc: accA,
      accEnd: accB,
      depth: 0.8 + 2.2 * sA.t,
      fpH: 0.6 + 1.4 * sA.t,
      toSea,
      toLake,
      main,
      x0,
      z0,
      x1,
      z1,
      gb,
    };
  }

  /** 出口のないくぼ地の湖 */
  lake(i: number, j: number): Lake {
    const k = key(i, j);
    let l = this.lakeCache.get(k);
    if (!l) {
      l = this.buildLake(i, j);
      if (this.lakeCache.size > 4000) this.lakeCache.delete(this.lakeCache.keys().next().value!);
      this.lakeCache.set(k, l);
    }
    return l;
  }

  /**
   * 湖: 格子点の周り（半径 1500m）で下地の最も低い点を底とし、底の周りの輪（半径 900m・1200m）の
   * 最も低い所まで水を張る（河川の草案 3.3 の 2）。輪がほとんど底と同じ高さなら、底から LAKE_MIN_DEPTH の池にする。
   */
  private buildLake(i: number, j: number): Lake {
    const [x, z] = this.cellPos(i, j);
    let bx = x;
    let bz = z;
    let bottom = this.cellHeight(i, j);
    const S = 250;
    const N = 6;
    for (let b = -N; b <= N; b++)
      for (let a = -N; a <= N; a++) {
        if (a * a + b * b > N * N) continue;
        const h = this.base(x + a * S, z + b * S);
        if (h < bottom) {
          bottom = h;
          bx = x + a * S;
          bz = z + b * S;
        }
      }
    let level = Infinity;
    for (const r of [900, LAKE_RADIUS])
      for (let k = 0; k < 16; k++) level = Math.min(level, this.base(bx + RX[k] * r, bz + RZ[k] * r));
    if (level < bottom + LAKE_MIN_DEPTH) level = bottom + LAKE_MIN_DEPTH;
    return { i, j, x: bx, z: bz, bottom, level, r: LAKE_RADIUS };
  }

  // ---- 点の問い合わせ ----

  /**
   * 点 (x, z) の周りの川。base はその点の下地の高さ。
   * 削った高さ = 下地と、近くの小区間ごとの横断の形の最小（最小をとるので連続になり、遠い小区間を含めても結果は変わらない）。
   */
  query(x: number, z: number, base: number, out: RiverHit): RiverHit {
    out.carve = base;
    out.levee = 0;
    out.flat = 0;
    out.water = false;
    out.waterLevel = 0;
    out.floodplain = false;
    out.plainLevel = 0;
    out.plainGap = Infinity;
    out.near = Infinity;
    out.nearAcc = 0;
    out.nearHalf = 0;
    out.lake = false;
    out.lakeLevel = 0;
    const bi = Math.floor(x / BLOCK_SIZE);
    const bj = Math.floor(z / BLOCK_SIZE);
    const b = this.block(bi, bj);
    // ブロックの右端・下端のすぐ手前では引き算の丸めで INDEX_N になり得るので抑える
    const gx = Math.min(INDEX_N - 1, Math.floor((x - bi * BLOCK_SIZE) / INDEX_CELL));
    const gz = Math.min(INDEX_N - 1, Math.floor((z - bj * BLOCK_SIZE) / INDEX_CELL));
    const list = b.index[gz * INDEX_N + gx];
    let clear = 1;
    let leveeMax = 0;
    let waterRatio = Infinity;
    if (list) {
      for (const si of list) {
        const s = b.segs[si];
        if (x < s.x0 || x > s.x1 || z < s.z0 || z > s.z1) continue;
        const ng = s.gb.length / 4;
        for (let g = 0; g < ng; g++) {
          if (x < s.gb[g * 4] || z < s.gb[g * 4 + 1] || x > s.gb[g * 4 + 2] || z > s.gb[g * 4 + 3]) continue;
          const pe = Math.min(s.n - 1, (g + 1) * GROUP);
          for (let p = g * GROUP; p < pe; p++) {
            const ax = s.x[p];
            const az = s.z[p];
            const vx = s.x[p + 1] - ax;
            const vz = s.z[p + 1] - az;
            const vv = vx * vx + vz * vz;
            let t = vv > 0 ? ((x - ax) * vx + (z - az) * vz) / vv : 0;
            t = t < 0 ? 0 : t > 1 ? 1 : t;
            const qx = ax + vx * t - x;
            const qz = az + vz * t - z;
            const d2 = qx * qx + qz * qz;
            const r = s.r[p] > s.r[p + 1] ? s.r[p] : s.r[p + 1];
            if (d2 >= r * r) continue;
            const d = Math.sqrt(d2);
            const wf = s.wf[p] + (s.wf[p + 1] - s.wf[p]) * t;
            const v = s.v[p] + (s.v[p + 1] - s.v[p]) * t;
            if (d >= wf + v) continue;
            const ww = s.ww[p] + (s.ww[p + 1] - s.ww[p]) * t;
            const wl = s.w[p] + (s.w[p + 1] - s.w[p]) * t;
            const lv = s.lv[p] + (s.lv[p + 1] - s.lv[p]) * t;
            const fpLevel = wl + s.fpH;
            let g2: number;
            if (d < ww) {
              const u = d / ww;
              g2 = wl - s.depth * (1 - u * u);
            } else if (d < wf) {
              const bank = Math.min(wf - ww, 2 + 0.1 * ww);
              g2 = wl + s.fpH * smoothstep(ww, ww + bank, d);
            } else {
              g2 = fpLevel + (base - fpLevel) * smoothstep(wf, wf + v, d);
            }
            if (g2 < out.carve) out.carve = g2;
            const fl = 1 - smoothstep(wf, wf + 60, d);
            if (fl > out.flat) out.flat = fl;
            if (d < ww && d / ww < waterRatio) {
              waterRatio = d / ww;
              out.water = true;
              out.waterLevel = wl;
            }
            if (d < wf) out.floodplain = true;
            if (d - wf < out.plainGap) {
              out.plainGap = d - wf;
              out.plainLevel = wl;
            }
            const c = smoothstep(wf, wf + 2, d);
            if (c < clear) clear = c;
            if (lv > 0) {
              // 堤防: 河原の外側の台形（内のり 1:2、天端 6m、外のり 1:2）
              const e = d - wf;
              let bump = 0;
              if (e > 0) {
                if (e < 2 * lv) bump = e * 0.5;
                else if (e < 2 * lv + 6) bump = lv;
                else if (e < 4 * lv + 6) bump = lv - (e - 2 * lv - 6) * 0.5;
              }
              if (bump > leveeMax) leveeMax = bump;
            }
            if (d < out.near) {
              out.near = d;
              out.nearAcc = s.acc;
              out.nearHalf = ww;
            }
          }
        }
      }
    }
    // 堤防は陸の上だけ（海の中へ続かないように）
    out.levee = leveeMax * clear * smoothstep(0, 2, out.carve);
    for (const l of b.lakes) {
      const dx = x - l.x;
      const dz = z - l.z;
      if (dx * dx + dz * dz < l.r * l.r && out.carve + out.levee < l.level) {
        out.lake = true;
        out.lakeLevel = l.level;
      }
    }
    return out;
  }

  /** 点 (x, z) から半径 r 以内の川の線への距離（大きな川の流域 minAcc 以上）と、河口への距離 */
  nearRiver(x: number, z: number, r: number, minAcc: number): { river: number; mouth: number } {
    const b = this.block(Math.floor(x / BLOCK_SIZE), Math.floor(z / BLOCK_SIZE));
    let best = Infinity;
    for (const s of b.segs) {
      if (s.acc < minAcc) continue;
      if (x < s.x0 - r || x > s.x1 + r || z < s.z0 - r || z > s.z1 + r) continue;
      for (let p = 0; p < s.n - 1; p++) {
        const ax = s.x[p];
        const az = s.z[p];
        const vx = s.x[p + 1] - ax;
        const vz = s.z[p + 1] - az;
        const vv = vx * vx + vz * vz;
        let t = vv > 0 ? ((x - ax) * vx + (z - az) * vz) / vv : 0;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const qx = ax + vx * t - x;
        const qz = az + vz * t - z;
        const d2 = qx * qx + qz * qz;
        if (d2 < best) best = d2;
      }
    }
    let mouth = Infinity;
    for (const m of b.mouths) {
      if (m.acc < minAcc) continue;
      const dx = m.x - x;
      const dz = m.z - z;
      const d2 = dx * dx + dz * dz;
      if (d2 < mouth) mouth = d2;
    }
    const river = Math.sqrt(best);
    return { river: river <= r ? river : Infinity, mouth: Math.sqrt(mouth) };
  }

  /** 範囲の格子点の統計（試作の確認用） */
  stats(i0: number, j0: number, i1: number, j1: number): RiverStats {
    const st: RiverStats = { cells: 0, sea: 0, pits: 0, channels: 0, lakes: 0 };
    for (let j = j0; j < j1; j++)
      for (let i = i0; i < i1; i++) {
        if (this.cellHeight(i, j) < 0) continue;
        st.cells++;
        const d = this.dir(i, j);
        if (d === DIR_LAKE) {
          st.pits++;
          st.lakes++;
          continue;
        }
        if (this.isLocalMin(i, j)) {
          st.pits++;
          st.channels++;
        }
        // 海まで流れ下るか
        let ci = i;
        let cj = j;
        for (let k = 0; k < 5000; k++) {
          const dd = this.dir(ci, cj);
          if (dd === DIR_SEA) {
            st.sea++;
            break;
          }
          if (dd === DIR_LAKE) break;
          ci += Math.floor(dd / 7) - 3;
          cj += (dd % 7) - 3;
        }
      }
    return st;
  }
}
