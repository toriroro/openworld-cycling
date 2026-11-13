// 町・集落の建物と喫茶店の配置（モック仕様 5.4）。結節点と道路だけから決まる（同じ場所なら同じ建物）。Three.js に依存しない。
// - 町と集落: 結節点の周囲（町 300〜600m、集落 300m）の道路沿いに、道路に面して敷地を取り、建物を並べる。中心に近いほど密で高い
// - 喫茶店: 立ち寄り地点の喫茶店ごとに、道路の脇に駐輪スペースを挟んで建てる
// どの建物もすべての道路の路面から離し、ほかの建物と重ねない。

import { hash, hashString } from "../shared/world/hash.ts";
import type { Poi, Road, WorldNode } from "../shared/world/types.ts";

export interface Building {
  x: number;
  z: number;
  /** 道路に沿う向きの幅・奥行き・高さ (m) */
  w: number;
  d: number;
  h: number;
  /** 幅の向き（atan2(z, x)） */
  angle: number;
  /** 色の番号 */
  tone: number;
  /** 地面の最低の高さ（壁はここから立てる） */
  base: number;
  /** 地面の最高の高さ（屋根の高さの基準） */
  top: number;
  /** 道路のある側（建物のローカル z の向き。+1 なら (−sin, cos) の向きに道路がある） */
  front: 1 | -1;
  /** 建物の正面から路面の端までの距離 (m) */
  gap: number;
  /** 前の道路の高さ */
  roadY: number;
  floors: number;
  roof: "gable" | "hip" | "flat";
  roofMat: "tile" | "metal";
  wallMat: "siding" | "plaster";
  /** 道路沿いのブロック塀 */
  fence: boolean;
  /** 窓の並びなど細部の種 */
  seed: number;
}

export interface Cafe {
  poi: Poi;
  x: number;
  z: number;
  w: number;
  d: number;
  h: number;
  angle: number;
  base: number;
  top: number;
  /** 店の前（道路側）の向き（単位ベクトル） */
  fx: number;
  fz: number;
  /** 店の前の道路上の点（立ち寄りの判定に使う） */
  roadX: number;
  roadZ: number;
  roadY: number;
}

/** 敷地（植生を置かない円、世界座標） */
export interface Lot {
  x: number;
  z: number;
  r: number;
}

type Ground = (x: number, z: number) => number;

/** 道路の線分の格子（距離の判定用） */
class RoadIndex {
  private cells = new Map<string, { ax: number; az: number; bx: number; bz: number; hw: number; ay: number; by: number }[]>();
  private static readonly C = 32;
  constructor(roads: Iterable<Road>) {
    const C = RoadIndex.C;
    for (const r of roads) {
      const P = r.points;
      const n = P.length / 3;
      const hw = r.width / 2;
      for (let i = 0; i < n - 1; i += 2) {
        const j = Math.min(n - 1, i + 2);
        const seg = { ax: P[i * 3] + r.origin[0], az: P[i * 3 + 2] + r.origin[1], bx: P[j * 3] + r.origin[0], bz: P[j * 3 + 2] + r.origin[1], hw, ay: P[i * 3 + 1], by: P[j * 3 + 1] };
        const x0 = Math.floor(Math.min(seg.ax, seg.bx) / C), x1 = Math.floor(Math.max(seg.ax, seg.bx) / C);
        const z0 = Math.floor(Math.min(seg.az, seg.bz) / C), z1 = Math.floor(Math.max(seg.az, seg.bz) / C);
        for (let gz = z0; gz <= z1; gz++)
          for (let gx = x0; gx <= x1; gx++) {
            const k = `${gx},${gz}`;
            const l = this.cells.get(k);
            if (l) l.push(seg);
            else this.cells.set(k, [seg]);
          }
      }
    }
  }
  /** 点から最も近い路面の端までの距離（路面の上なら負） */
  edge(x: number, z: number): number {
    return this.nearest(x, z).e;
  }
  /** 最も近い路面の端までの距離と、その道路の高さ（48m より遠ければ e = Infinity） */
  nearest(x: number, z: number): { e: number; y: number } {
    const C = RoadIndex.C;
    const gx = Math.floor(x / C), gz = Math.floor(z / C);
    let best = Infinity;
    let y = 0;
    for (let dz = -1; dz <= 1; dz++)
      for (let dx = -1; dx <= 1; dx++) {
        const l = this.cells.get(`${gx + dx},${gz + dz}`);
        if (!l) continue;
        for (const s of l) {
          const vx = s.bx - s.ax, vz = s.bz - s.az;
          const vv = vx * vx + vz * vz;
          let t = vv > 0 ? ((x - s.ax) * vx + (z - s.az) * vz) / vv : 0;
          t = t < 0 ? 0 : t > 1 ? 1 : t;
          const qx = s.ax + vx * t - x, qz = s.az + vz * t - z;
          const d = Math.sqrt(qx * qx + qz * qz) - s.hw;
          if (d < best) {
            best = d;
            y = s.ay + (s.by - s.ay) * t;
          }
        }
      }
    return { e: best, y };
  }
}

/** 建物の重なりの判定 */
class Occupancy {
  private cells = new Map<string, { x: number; z: number; r: number }[]>();
  free(x: number, z: number, r: number): boolean {
    const gx = Math.floor(x / 48), gz = Math.floor(z / 48);
    for (let dz = -1; dz <= 1; dz++)
      for (let dx = -1; dx <= 1; dx++)
        for (const o of this.cells.get(`${gx + dx},${gz + dz}`) ?? []) {
          const ex = o.x - x, ez = o.z - z;
          if (ex * ex + ez * ez < (o.r + r) * (o.r + r)) return false;
        }
    return true;
  }
  add(x: number, z: number, r: number) {
    const k = `${Math.floor(x / 48)},${Math.floor(z / 48)}`;
    const l = this.cells.get(k);
    if (l) l.push({ x, z, r });
    else this.cells.set(k, [{ x, z, r }]);
  }
}

/**
 * 道路に合わせた後の地面の高さ（地形の Worker と同じ式: 路面の端から 4m は道路の高さ − 0.25m、そこから 40m でもとの地形へ）。
 * raw は地形の高さ。
 */
export function conformedGround(idx: RoadIndex, raw: Ground): Ground {
  return (x, z) => {
    const h = raw(x, z);
    const n = idx.nearest(x, z);
    if (n.e >= 44) return h;
    let t = (n.e - 4) / 40;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    t = t * t * (3 - 2 * t);
    return (n.y - 0.25) * (1 - t) + h * t;
  };
}

const unit = (seed: number, a: number, b: number, c: number) => (hash(seed, a, b, c) >>> 0) / 4294967296;

/** 長方形の四隅と中心と辺の中点 */
function footprint(x: number, z: number, w: number, d: number, angle: number): [number, number][] {
  const c = Math.cos(angle), s = Math.sin(angle);
  const out: [number, number][] = [[x, z]];
  for (const [a, b] of [
    [-0.5, -0.5],
    [0.5, -0.5],
    [0.5, 0.5],
    [-0.5, 0.5],
    [0, -0.5],
    [0, 0.5],
    [-0.5, 0],
    [0.5, 0],
  ])
    out.push([x + a * w * c - b * d * s, z + a * w * s + b * d * c]);
  return out;
}

function roadFrameAt(r: Road, s: number) {
  const P = r.points;
  const n = P.length / 3;
  const ds = r.length / (n - 1);
  const i = Math.max(0, Math.min(n - 1, Math.round(s / ds)));
  const a = Math.max(0, i - 2), b = Math.min(n - 1, i + 2);
  let tx = P[b * 3] - P[a * 3], tz = P[b * 3 + 2] - P[a * 3 + 2];
  const l = Math.sqrt(tx * tx + tz * tz) || 1;
  tx /= l;
  tz /= l;
  return { x: P[i * 3] + r.origin[0], y: P[i * 3 + 1], z: P[i * 3 + 2] + r.origin[1], tx, tz };
}

/** 建物を置けるか（すべての道路の路面から 2m 以上、地面が水面より上、傾斜が大きすぎない）。置けるなら地面の最低と最高 */
function siteOk(idx: RoadIndex, ground: Ground, x: number, z: number, w: number, d: number, angle: number, clear: number): { base: number; top: number } | null {
  let lo = Infinity, hi = -Infinity;
  for (const [px, pz] of footprint(x, z, w, d, angle)) {
    if (idx.edge(px, pz) < clear) return null;
    const g = ground(px, pz);
    if (g < 1) return null;
    lo = Math.min(lo, g);
    hi = Math.max(hi, g);
  }
  if (hi - lo > Math.max(2.5, Math.min(w, d) * 0.3)) return null;
  return { base: lo - 0.4, top: hi };
}

/** 喫茶店の配置。置けなければ反対側、それでも無理なら null */
export function layoutCafe(poi: Poi, road: Road, idx: RoadIndex, raw: Ground): Cafe | null {
  const ground = conformedGround(idx, raw);
  const f = roadFrameAt(road, poi.s);
  const hw = road.width / 2;
  const w = 11, d = 9, h = 4.4;
  for (const side of [poi.side, -poi.side as 1 | -1]) {
    // 右向き = (−tz, tx)。店は道路の脇に、駐輪スペース 7m を挟んで建てる
    const rx = -f.tz * side, rz = f.tx * side;
    const off = hw + 7 + d / 2;
    const x = f.x + rx * off, z = f.z + rz * off;
    const angle = Math.atan2(f.tz, f.tx);
    const site = siteOk(idx, ground, x, z, w, d, angle, 1.5);
    if (!site) continue;
    return { poi, x, z, w, d, h, angle, base: site.base, top: site.top, fx: -rx, fz: -rz, roadX: f.x, roadZ: f.z, roadY: f.y };
  }
  return null;
}

/**
 * 町・集落の建物。roads は結節点の周りの道路（読み込み済みのすべて）。cafes は先に置いた喫茶店（重ならないようにする）。
 */
export function layoutTown(seed: number, node: WorldNode, roads: Road[], idx: RoadIndex, raw: Ground, cafes: Cafe[] = []): Building[] {
  if (node.kind === "junction") return [];
  const radius = node.kind === "town" ? 300 + 300 * Math.min(1, node.importance) : 300;
  const ground = conformedGround(idx, raw);
  const occ = new Occupancy();
  for (const c of cafes) occ.add(c.x, c.z, Math.hypot(c.w, c.d + 14) / 2);
  const out: Building[] = [];
  const nh = hashString(node.id);
  const sorted = [...roads].sort((a, b) => (a.id < b.id ? -1 : 1));
  for (const r of sorted) {
    const rh = hashString(r.id);
    const hw = r.width / 2;
    const P = r.points;
    const n = P.length / 3;
    const ds = r.length / (n - 1);
    for (const side of [-1, 1] as const) {
      let s = 6 + unit(seed, nh, rh, side * 7) * 10;
      let k = 0;
      while (s < r.length - 6) {
        k++;
        const f = roadFrameAt(r, s);
        const dx = f.x - node.x, dz = f.z - node.z;
        const dist = Math.sqrt(dx * dx + dz * dz);
        const u1 = unit(seed, rh, k, side * 11 + 1);
        const u2 = unit(seed, rh, k, side * 11 + 2);
        const u3 = unit(seed, rh, k, side * 11 + 3);
        const u4 = unit(seed, rh, k, side * 11 + 4);
        const central = dist / radius;
        const w = 8 + u2 * 6 + (central < 0.35 && node.kind === "town" ? 4 : 0);
        if (dist <= radius && r.cls < 3) {
          // 中心ほど密に、外ほどまばらに
          const p = 0.92 - central * central * 0.75;
          if (u1 < p) {
            const d = 8 + u3 * 5;
            const floors = node.kind === "town" && central < 0.35 ? 2 + Math.floor(u4 * 3) : 1 + Math.floor(u4 * 2);
            const h = floors === 1 ? 4.2 : floors === 2 ? 6.6 : floors * 3.1;
            const gap = 2.5 + u2 * 3;
            const setback = hw + gap + d / 2;
            const rx = -f.tz * side, rz = f.tx * side;
            const x = f.x + rx * setback, z = f.z + rz * setback;
            const angle = Math.atan2(f.tz, f.tx);
            const rr = Math.hypot(w, d) / 2 * 0.92;
            if (occ.free(x, z, rr)) {
              const site = siteOk(idx, ground, x, z, w, d, angle, 2);
              if (site) {
                occ.add(x, z, rr);
                const hh = hash(seed, rh, k, side * 13);
                const tall = floors >= 3;
                // 塀は路面の端から 0.6m 内側。ほかの道路にかからない時だけ
                const fz = gap - 0.6;
                const fcx = x - rx * (d / 2 + fz), fcz = z - rz * (d / 2 + fz);
                const ext = w / 2 + 1.5;
                const fenceOk =
                  !tall &&
                  (hh & 3) < 2 &&
                  idx.edge(fcx + f.tx * ext, fcz + f.tz * ext) > 0.3 &&
                  idx.edge(fcx - f.tx * ext, fcz - f.tz * ext) > 0.3 &&
                  idx.edge(fcx, fcz) > 0.3;
                out.push({
                  x,
                  z,
                  w,
                  d,
                  h,
                  angle,
                  tone: hash(seed, rh, k, side) % 7,
                  base: site.base,
                  top: site.top,
                  front: (-side) as 1 | -1,
                  gap,
                  roadY: f.y,
                  floors,
                  roof: tall ? "flat" : (hh >>> 3) & 1 ? "hip" : "gable",
                  roofMat: ((hh >>> 4) % 10) < 6 ? "tile" : "metal",
                  wallMat: tall ? "plaster" : ((hh >>> 8) % 10) < 6 ? "siding" : "plaster",
                  fence: fenceOk,
                  seed: hh >>> 12,
                });
              }
            }
          }
        }
        // 次の敷地へ（建物の幅と隙間）。範囲の外は粗く進む
        s += dist <= radius + 40 ? w + 2 + unit(seed, rh, k, side * 11 + 5) * 6 : Math.max(20, (dist - radius) * 0.8);
        void ds;
      }
    }
  }
  return out;
}

/** 植生を置かない敷地 */
export function lotsOf(buildings: Building[], cafes: Cafe[]): Lot[] {
  const out: Lot[] = [];
  for (const b of buildings) out.push({ x: b.x, z: b.z, r: Math.hypot(b.w, b.d) / 2 + 2.5 });
  for (const c of cafes) {
    out.push({ x: c.x, z: c.z, r: Math.hypot(c.w, c.d) / 2 + 3 });
    // 駐輪スペース
    out.push({ x: (c.x + c.roadX) / 2, z: (c.z + c.roadZ) / 2, r: 8 });
  }
  return out;
}

export { RoadIndex };
