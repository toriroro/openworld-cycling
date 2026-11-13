// 地形タイルの頂点計算（モック仕様 5.1）。Worker とメインスレッドの代替の両方で使う。DOM と Three.js を使わない。
// - 世界座標にそろえた正方形タイル。位置はタイルの左上からの相対（単精度）
// - 道路の近くは路面に合わせる: 道路端から 4m は路面と同じ高さ、そこから 40m で元の地形へ戻す
// - 路面の下にかかる三角形は頂点を路面より下げる（突き抜け防止。downhill-3D の terrain-clearance と同じ考え方）
// - 縁を下へ伸ばした面（スカート）で段の継ぎ目を隠す

import { gradNoise } from "../shared/world/noise.ts";
import type { Terrain } from "../shared/world/terrain.ts";
import { placeVegetation } from "./vegetation-place.ts";

/** 道路の点列（タイルの左上からの相対）。1点 5 要素: x, z, y, 半幅, 印（1 = 橋） */
export interface PackedRoads {
  pts: Float32Array;
  /** 各折れ線の始まりの点番号。最後に点の総数 */
  starts: Int32Array;
}

export interface TileInput {
  x0: number;
  z0: number;
  size: number;
  cells: number;
  skirt: number;
  roads: PackedRoads | null;
  /** 地表の細かい模様の繰り返し (m) */
  uvRepeat: number;
  /** 植生の細かさ（0 なし、1 木だけ、2 すべて）と密度の倍率 */
  vegDetail?: 0 | 1 | 2;
  vegDensity?: number;
}

export interface TileOutput {
  position: Float32Array;
  normal: Float32Array;
  color: Float32Array;
  uv: Float32Array;
  index: Uint16Array | Uint32Array;
  minY: number;
  maxY: number;
  lowered: number;
  /** 植生（vegetation-place の形） */
  veg: Float32Array;
}

/** 路面と同じ高さにする幅（道路端から）と、元の地形へ戻す幅 */
export const ROAD_FLAT = 4;
export const ROAD_BLEND = 40;
/** 路面の下の地面の深さ */
export const ROAD_CLEAR = 0.25;
/** 橋の床版の厚さ（橋の下の地面はこれより下げる） */
export const BRIDGE_DEPTH = 1.6;

// 色（線形でなく sRGB の 0〜1。マテリアル側で変換する）
const GRASS = [0.49, 0.6, 0.32];
const SATOYAMA = [0.3, 0.42, 0.21];
const FOREST = [0.24, 0.34, 0.18];
const ROCK = [0.5, 0.48, 0.44];
const SAND = [0.8, 0.74, 0.58];
const SHOULDER = [0.52, 0.49, 0.42];
const SEABED = [0.52, 0.5, 0.4];
const DRY = [0.62, 0.6, 0.38];
const COAST_GRASS = [0.58, 0.6, 0.38];

interface Nearest {
  e: number;
  y: number;
  bridge: boolean;
}

class RoadQuery {
  private cells = new Map<number, number[]>();
  private readonly cell = 32;
  constructor(private r: PackedRoads, reach: number) {
    const P = r.pts;
    for (let k = 0; k < r.starts.length - 1; k++) {
      for (let i = r.starts[k]; i < r.starts[k + 1] - 1; i++) {
        const ax = P[i * 5], az = P[i * 5 + 1], bx = P[i * 5 + 5], bz = P[i * 5 + 6];
        const pad = P[i * 5 + 3] + reach;
        const gx0 = Math.floor((Math.min(ax, bx) - pad) / this.cell);
        const gx1 = Math.floor((Math.max(ax, bx) + pad) / this.cell);
        const gz0 = Math.floor((Math.min(az, bz) - pad) / this.cell);
        const gz1 = Math.floor((Math.max(az, bz) + pad) / this.cell);
        for (let gz = gz0; gz <= gz1; gz++)
          for (let gx = gx0; gx <= gx1; gx++) {
            const key = (gx + 4096) * 8192 + (gz + 4096);
            const l = this.cells.get(key);
            if (l) l.push(i);
            else this.cells.set(key, [i]);
          }
      }
    }
  }
  segmentsAt(x: number, z: number): number[] | undefined {
    return this.cells.get((Math.floor(x / this.cell) + 4096) * 8192 + (Math.floor(z / this.cell) + 4096));
  }
  /** 道路端からの距離が最小の道路 */
  nearest(x: number, z: number): Nearest | null {
    const segs = this.segmentsAt(x, z);
    if (!segs) return null;
    const P = this.r.pts;
    let best: Nearest | null = null;
    for (const i of segs) {
      const ax = P[i * 5], az = P[i * 5 + 1], bx = P[i * 5 + 5], bz = P[i * 5 + 6];
      const vx = bx - ax, vz = bz - az;
      const vv = vx * vx + vz * vz;
      let t = vv > 0 ? ((x - ax) * vx + (z - az) * vz) / vv : 0;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const dx = ax + vx * t - x, dz = az + vz * t - z;
      const d = Math.sqrt(dx * dx + dz * dz);
      const hw = P[i * 5 + 3] + (P[i * 5 + 8] - P[i * 5 + 3]) * t;
      const e = d - hw;
      if (!best || e < best.e) {
        const bridge = P[i * 5 + 4] >= 1 || P[i * 5 + 9] >= 1;
        best = { e, y: P[i * 5 + 2] + (P[i * 5 + 7] - P[i * 5 + 2]) * t, bridge };
      }
    }
    return best;
  }
}

function smooth(e0: number, e1: number, x: number) {
  let t = (x - e0) / (e1 - e0);
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return t * t * (3 - 2 * t);
}

export function buildTile(terrain: Terrain, inp: TileInput): TileOutput {
  const { x0, z0, size, cells, skirt } = inp;
  const step = size / cells;
  const N = cells + 1;
  const G = N + 2; // 法線用に1格子の余白
  const hs = new Float64Array(G * G);
  const q = inp.roads && inp.roads.pts.length ? new RoadQuery(inp.roads, ROAD_FLAT + ROAD_BLEND + step) : null;
  const nearRoad = new Float32Array(G * G).fill(1e9);
  for (let j = 0; j < G; j++)
    for (let i = 0; i < G; i++) {
      const lx = (i - 1) * step;
      const lz = (j - 1) * step;
      let h = terrain.height(x0 + lx, z0 + lz);
      if (q) {
        const n = q.nearest(lx, lz);
        if (n) {
          nearRoad[j * G + i] = n.e;
          if (!n.bridge && n.e < ROAD_FLAT + ROAD_BLEND) {
            const target = n.y - ROAD_CLEAR;
            const t = smooth(ROAD_FLAT, ROAD_FLAT + ROAD_BLEND, n.e);
            h = target * (1 - t) + h * t;
          }
        }
      }
      hs[j * G + i] = h;
    }

  // 路面の下にかかる三角形の頂点を下げる
  let lowered = 0;
  if (q && inp.roads) lowered = clearUnderRoads(hs, G, step, inp.roads, q);

  const vCount = N * N + 4 * N;
  const position = new Float32Array(vCount * 3);
  const normal = new Float32Array(vCount * 3);
  const color = new Float32Array(vCount * 3);
  const uv = new Float32Array(vCount * 2);
  let minY = Infinity;
  let maxY = -Infinity;

  // 景観の重みは粗い格子で求めて補間する
  const L = 9;
  const lw = new Float64Array(L * L * 4);
  for (let j = 0; j < L; j++)
    for (let i = 0; i < L; i++) {
      const w = terrain.landscape(x0 + (i * size) / (L - 1), z0 + (j * size) / (L - 1));
      const k = (j * L + i) * 4;
      lw[k] = w.coast;
      lw[k + 1] = w.plain;
      lw[k + 2] = w.mountain;
      lw[k + 3] = w.other;
    }
  const uOff = (((x0 % inp.uvRepeat) + inp.uvRepeat) % inp.uvRepeat) / inp.uvRepeat;
  const vOff = (((z0 % inp.uvRepeat) + inp.uvRepeat) % inp.uvRepeat) / inp.uvRepeat;
  const w4 = [0, 0, 0, 0];
  const seedA = terrain.seed * 31 + 901;
  const seedB = terrain.seed * 31 + 902;
  const seedC = terrain.seed * 31 + 903;

  for (let j = 0; j < N; j++)
    for (let i = 0; i < N; i++) {
      const g = (j + 1) * G + (i + 1);
      const h = hs[g];
      const v = j * N + i;
      position[v * 3] = i * step;
      position[v * 3 + 1] = h;
      position[v * 3 + 2] = j * step;
      if (h < minY) minY = h;
      if (h > maxY) maxY = h;
      const nx = (hs[g - 1] - hs[g + 1]) / (2 * step);
      const nz = (hs[g - G] - hs[g + G]) / (2 * step);
      const nl = Math.sqrt(nx * nx + 1 + nz * nz);
      normal[v * 3] = nx / nl;
      normal[v * 3 + 1] = 1 / nl;
      normal[v * 3 + 2] = nz / nl;
      uv[v * 2] = uOff + (i * step) / inp.uvRepeat;
      uv[v * 2 + 1] = vOff + (j * step) / inp.uvRepeat;
      // 色: 景観の重み、傾斜、標高、道路端
      const fi = (i / cells) * (L - 1);
      const fj = (j / cells) * (L - 1);
      const ii = Math.min(L - 2, Math.floor(fi));
      const jj = Math.min(L - 2, Math.floor(fj));
      const u = fi - ii;
      const vv = fj - jj;
      for (let k = 0; k < 4; k++) {
        const a = lw[(jj * L + ii) * 4 + k], b = lw[(jj * L + ii + 1) * 4 + k];
        const c = lw[((jj + 1) * L + ii) * 4 + k], d = lw[((jj + 1) * L + ii + 1) * 4 + k];
        w4[k] = (a * (1 - u) + b * u) * (1 - vv) + (c * (1 - u) + d * u) * vv;
      }
      const slope = Math.sqrt(nx * nx + nz * nz);
      const rock = smooth(0.45, 0.9, slope) + smooth(1250, 1600, h) * 0.6;
      const sand = h < 0.8 ? 1 - smooth(0.3, 0.8, h) : 0;
      // 大きな模様（明るさと、枯れ草寄りの色）で一様な緑を崩す
      const wx = x0 + i * step, wz = z0 + j * step;
      const n1 = gradNoise(seedA, wx / 340, wz / 340);
      const n2 = gradNoise(seedB, wx / 70, wz / 70);
      const dry = smooth(0.15, 0.7, gradNoise(seedC, wx / 900, wz / 900)) * (1 - w4[2]);
      const bright = 1 + 0.13 * n1 + 0.07 * n2;
      // 林床: 山岳と里山の木の多い所（M3 で植生を置く前の色）
      for (let k = 0; k < 3; k++) {
        let c = GRASS[k] * w4[1] + SATOYAMA[k] * w4[3] + FOREST[k] * w4[2] + COAST_GRASS[k] * w4[0];
        c = (c * (1 - dry * 0.6) + DRY[k] * dry * 0.6) * bright;
        c = c * (1 - Math.min(1, rock)) + ROCK[k] * Math.min(1, rock);
        if (h < 0) c = SEABED[k];
        else c = c * (1 - sand) + SAND[k] * sand;
        const e = nearRoad[g];
        if (e < 2.5) c = SHOULDER[k] * (1 - smooth(0.5, 2.5, e)) + c * smooth(0.5, 2.5, e);
        color[v * 3 + k] = c;
      }
    }

  // スカート: 4 辺の頂点を下へ
  const edges: number[][] = [[], [], [], []];
  for (let i = 0; i < N; i++) {
    edges[0].push(i); // 北
    edges[1].push((N - 1) * N + i); // 南
    edges[2].push(i * N); // 西
    edges[3].push(i * N + N - 1); // 東
  }
  let sv = N * N;
  const skirtStart: number[] = [];
  for (const e of edges) {
    skirtStart.push(sv);
    for (const v of e) {
      position[sv * 3] = position[v * 3];
      position[sv * 3 + 1] = position[v * 3 + 1] - skirt;
      position[sv * 3 + 2] = position[v * 3 + 2];
      normal.copyWithin(sv * 3, v * 3, v * 3 + 3);
      color.copyWithin(sv * 3, v * 3, v * 3 + 3);
      uv.copyWithin(sv * 2, v * 2, v * 2 + 2);
      sv++;
    }
  }

  const triCount = cells * cells * 2 + 4 * cells * 2;
  const index = vCount > 65535 ? new Uint32Array(triCount * 3) : new Uint16Array(triCount * 3);
  let o = 0;
  for (let j = 0; j < cells; j++)
    for (let i = 0; i < cells; i++) {
      const a = j * N + i, b = a + 1, c = a + N, d = c + 1;
      // 対角線の向きを交互にして、縞の模様を減らす
      if ((i + j) & 1) {
        index[o++] = a; index[o++] = c; index[o++] = b;
        index[o++] = b; index[o++] = c; index[o++] = d;
      } else {
        index[o++] = a; index[o++] = c; index[o++] = d;
        index[o++] = a; index[o++] = d; index[o++] = b;
      }
    }
  // スカートの面（両面に見えるよう、外向きに張る）
  for (let k = 0; k < 4; k++) {
    const e = edges[k];
    const s0 = skirtStart[k];
    const flip = k === 0 || k === 3;
    for (let i = 0; i < cells; i++) {
      const a = e[i], b = e[i + 1], c = s0 + i, d = s0 + i + 1;
      if (flip) {
        index[o++] = a; index[o++] = b; index[o++] = c;
        index[o++] = b; index[o++] = d; index[o++] = c;
      } else {
        index[o++] = a; index[o++] = c; index[o++] = b;
        index[o++] = b; index[o++] = c; index[o++] = d;
      }
    }
  }
  const veg = placeVegetation({
    seed: terrain.seed,
    x0,
    z0,
    size,
    detail: inp.vegDetail ?? 0,
    density: inp.vegDensity ?? 1,
    ground: (lx, lz) => {
      const fi = lx / step + 1, fj = lz / step + 1;
      const i = Math.max(0, Math.min(G - 2, Math.floor(fi))), j = Math.max(0, Math.min(G - 2, Math.floor(fj)));
      const a = fi - i, b = fj - j;
      return (hs[j * G + i] * (1 - a) + hs[j * G + i + 1] * a) * (1 - b) + (hs[(j + 1) * G + i] * (1 - a) + hs[(j + 1) * G + i + 1] * a) * b;
    },
    slope: (lx, lz) => {
      const i = Math.max(1, Math.min(G - 2, Math.round(lx / step) + 1)), j = Math.max(1, Math.min(G - 2, Math.round(lz / step) + 1));
      const gx = (hs[j * G + i + 1] - hs[j * G + i - 1]) / (2 * step);
      const gz = (hs[(j + 1) * G + i] - hs[(j - 1) * G + i]) / (2 * step);
      return Math.sqrt(gx * gx + gz * gz);
    },
    landscape: (lx, lz) => {
      const fi = Math.max(0, Math.min(L - 1.001, (lx / size) * (L - 1))), fj = Math.max(0, Math.min(L - 1.001, (lz / size) * (L - 1)));
      const i = Math.floor(fi), j = Math.floor(fj), a = fi - i, b = fj - j;
      const r = [0, 0, 0, 0];
      for (let k = 0; k < 4; k++)
        r[k] = (lw[(j * L + i) * 4 + k] * (1 - a) + lw[(j * L + i + 1) * 4 + k] * a) * (1 - b) + (lw[((j + 1) * L + i) * 4 + k] * (1 - a) + lw[((j + 1) * L + i + 1) * 4 + k] * a) * b;
      return r;
    },
    roadEdge: (lx, lz) => q?.nearest(lx, lz)?.e ?? 1e9,
  });
  return { position, normal, color, uv, index, minY, maxY: maxY, lowered, veg };
}

/**
 * 路面（点の間の四角形）に平面で重なる三角形の頂点を、その四角形の低い方の高さ − ROAD_CLEAR（橋なら床版の下）まで下げる。
 * 格子の三角形はタイル内の位置で決まるので、hs の格子で直接調べる。
 */
function clearUnderRoads(hs: Float64Array, G: number, step: number, roads: PackedRoads, q: RoadQuery): number {
  const P = roads.pts;
  const ceil = new Float64Array(G * G).fill(Infinity);
  // 各道路の四角形について、重なり得る格子の範囲の三角形を調べる
  const quad = [0, 0, 0, 0, 0, 0, 0, 0];
  const tri = [0, 0, 0, 0, 0, 0];
  void q;
  for (let k = 0; k < roads.starts.length - 1; k++) {
    for (let i = roads.starts[k]; i < roads.starts[k + 1] - 1; i++) {
      const ax = P[i * 5], az = P[i * 5 + 1], bx = P[i * 5 + 5], bz = P[i * 5 + 6];
      let tx = bx - ax, tz = bz - az;
      const tl = Math.sqrt(tx * tx + tz * tz) || 1;
      tx /= tl;
      tz /= tl;
      const hwA = P[i * 5 + 3] + 0.4;
      const hwB = P[i * 5 + 8] + 0.4;
      // 四角形（少し前後に伸ばして継ぎ目の隙間をなくす）
      const ex = tx * 0.3, ez = tz * 0.3;
      quad[0] = ax - ex - tz * hwA; quad[1] = az - ez + tx * hwA;
      quad[2] = ax - ex + tz * hwA; quad[3] = az - ez - tx * hwA;
      quad[4] = bx + ex + tz * hwB; quad[5] = bz + ez - tx * hwB;
      quad[6] = bx + ex - tz * hwB; quad[7] = bz + ez + tx * hwB;
      const bridge = P[i * 5 + 4] >= 1 || P[i * 5 + 9] >= 1;
      const floor = Math.min(P[i * 5 + 2], P[i * 5 + 7]) - (bridge ? BRIDGE_DEPTH : ROAD_CLEAR);
      let mnx = Infinity, mxx = -Infinity, mnz = Infinity, mxz = -Infinity;
      for (let c = 0; c < 4; c++) {
        mnx = Math.min(mnx, quad[c * 2]); mxx = Math.max(mxx, quad[c * 2]);
        mnz = Math.min(mnz, quad[c * 2 + 1]); mxz = Math.max(mxz, quad[c * 2 + 1]);
      }
      // 格子番号（余白 1 を含む hs の添字は i+1）
      const gi0 = Math.max(-1, Math.floor(mnx / step));
      const gi1 = Math.min(G - 3, Math.floor(mxx / step));
      const gj0 = Math.max(-1, Math.floor(mnz / step));
      const gj1 = Math.min(G - 3, Math.floor(mxz / step));
      for (let gj = gj0; gj <= gj1; gj++)
        for (let gi = gi0; gi <= gi1; gi++) {
          const a = (gj + 1) * G + (gi + 1), b = a + 1, c = a + G, d = c + 1;
          const x0 = gi * step, x1 = x0 + step, z0 = gj * step, z1 = z0 + step;
          // 2 つの三角形（どちらの対角線でも両方の三角形がこのセルに収まるので、セル全体で判定する）
          tri[0] = x0; tri[1] = z0; tri[2] = x1; tri[3] = z0; tri[4] = x1; tri[5] = z1;
          const hit1 = convexOverlap(tri, 3, quad, 4);
          tri[0] = x0; tri[1] = z0; tri[2] = x0; tri[3] = z1; tri[4] = x1; tri[5] = z1;
          const hit2 = convexOverlap(tri, 3, quad, 4);
          if (!hit1 && !hit2) continue;
          for (const v of [a, b, c, d]) if (floor < ceil[v]) ceil[v] = floor;
        }
    }
  }
  let lowered = 0;
  for (let v = 0; v < G * G; v++)
    if (hs[v] > ceil[v]) {
      hs[v] = ceil[v];
      lowered++;
    }
  return lowered;
}

/** 平面上の凸多角形どうしの重なり（分離軸） */
function convexOverlap(a: number[], na: number, b: number[], nb: number): boolean {
  for (let pass = 0; pass < 2; pass++) {
    const poly = pass === 0 ? a : b;
    const n = pass === 0 ? na : nb;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const nx = poly[j * 2 + 1] - poly[i * 2 + 1];
      const nz = poly[i * 2] - poly[j * 2];
      let amin = Infinity, amax = -Infinity, bmin = Infinity, bmax = -Infinity;
      for (let k = 0; k < na; k++) {
        const d = a[k * 2] * nx + a[k * 2 + 1] * nz;
        if (d < amin) amin = d;
        if (d > amax) amax = d;
      }
      for (let k = 0; k < nb; k++) {
        const d = b[k * 2] * nx + b[k * 2 + 1] * nz;
        if (d < bmin) bmin = d;
        if (d > bmax) bmax = d;
      }
      if (amax < bmin - 1e-7 || bmax < amin - 1e-7) return false;
    }
  }
  return true;
}
