// 市街地・郊外の度合い（建物の込み具合）と、幹線の歩道・街路樹（北海道の草案 19 章）。
// - 込み具合: 10m 格子の各点で、周り 110m 四方の建物の床面積の割合。地形のタイルの色・植生・農地の有無に使う
// - 歩道: 走る道の両側に、縁石で一段高い歩道（込み具合 0.06 以上）。建物に当たる所は狭め、狭すぎれば切る。
//   ほかの走る道の路面の上（交差点）・橋・トンネルでは切る
// - 街路樹: 市街地（込み具合 0.12 以上）の歩道に、縁石の近くに植える。幹線は 12m ごと、一般道は 6 割の道に 15m ごと
// - 歩道の点は 4m ごと（道路の点の 2 つおき）
// - 交差点（北海道の草案 26 章）: 歩道は接続点の口（実行時の junctionShape と同じ形）で止め、
//   隣り合う腕の歩道を、隅切りの曲線に沿った角の歩道でつなぐ。両側に歩道のある腕に横断歩道の印を付ける

import { BUILDING_REC, type HokkaidoSidewalkIndex, type HokkaidoStreetIndex } from "../../src/shared/world/hokkaido.ts";
import type { Junction, Road } from "../../src/shared/world/types.ts";
import { junctionShape, type JunctionShape } from "../../src/sim/junction-shape.ts";
import type { BuiltJunction, BuiltRoad } from "./roads.ts";

export interface CoverageGrid {
  x0: number;
  z0: number;
  step: number;
  nx: number;
  nz: number;
  /** 0〜1 */
  v: Float32Array;
}

/**
 * 建物の込み具合（建物の記録から）。onlyStyles を渡すと、その型（BUILDING_STYLES の番号）の建物だけで数える
 * （店・ビル・集合住宅の込み具合 = 舗装の多い街の中心かどうか）
 */
export function buildingCoverage(data: Float32Array, g: { x0: number; z0: number; step: number; nx: number; nz: number }, window = 110, onlyStyles?: Set<number>): CoverageGrid {
  const { nx, nz, step } = g;
  const area = new Float64Array(nx * nz);
  for (let o = 0; o < data.length; o += BUILDING_REC) {
    if (onlyStyles && !onlyStyles.has(data[o + 12])) continue;
    const i = Math.round((data[o] - g.x0) / step);
    const j = Math.round((data[o + 1] - g.z0) / step);
    if (i < 0 || j < 0 || i >= nx || j >= nz) continue;
    area[j * nx + i] += data[o + 2] * data[o + 3];
  }
  // 箱の平均（積分画像）
  const S = new Float64Array((nx + 1) * (nz + 1));
  for (let j = 0; j < nz; j++)
    for (let i = 0; i < nx; i++) S[(j + 1) * (nx + 1) + i + 1] = area[j * nx + i] + S[j * (nx + 1) + i + 1] + S[(j + 1) * (nx + 1) + i] - S[j * (nx + 1) + i];
  const r = Math.round(window / step / 2);
  const v = new Float32Array(nx * nz);
  for (let j = 0; j < nz; j++)
    for (let i = 0; i < nx; i++) {
      const i0 = Math.max(0, i - r), i1 = Math.min(nx, i + r + 1), j0 = Math.max(0, j - r), j1 = Math.min(nz, j + r + 1);
      const sum = S[j1 * (nx + 1) + i1] - S[j0 * (nx + 1) + i1] - S[j1 * (nx + 1) + i0] + S[j0 * (nx + 1) + i0];
      v[j * nx + i] = Math.min(1, sum / ((i1 - i0) * (j1 - j0) * step * step));
    }
  return { ...g, v };
}

export function coverageAt(c: CoverageGrid, x: number, z: number): number {
  const i = Math.round((x - c.x0) / c.step);
  const j = Math.round((z - c.z0) / c.step);
  if (i < 0 || j < 0 || i >= c.nx || j >= c.nz) return 0;
  return c.v[j * c.nx + i];
}

/** 建物の長方形の索引（点が建物の中か） */
export class BuildingIndex {
  private cells = new Map<string, number[]>();
  constructor(
    private data: Float32Array,
    private cell = 40,
  ) {
    for (let o = 0; o < data.length; o += BUILDING_REC) {
      const r = Math.hypot(data[o + 2], data[o + 3]) / 2 + 2;
      for (let i = Math.floor((data[o] - r) / cell); i <= Math.floor((data[o] + r) / cell); i++)
        for (let j = Math.floor((data[o + 1] - r) / cell); j <= Math.floor((data[o + 1] + r) / cell); j++) {
          const k = `${i},${j}`;
          (this.cells.get(k) ?? this.cells.set(k, []).get(k)!).push(o);
        }
    }
  }
  /** (x, z) が建物（margin m 広げた長方形）の中か */
  inside(x: number, z: number, margin: number): boolean {
    const D = this.data;
    for (const o of this.cells.get(`${Math.floor(x / this.cell)},${Math.floor(z / this.cell)}`) ?? []) {
      const ca = Math.cos(D[o + 5]), sa = Math.sin(D[o + 5]);
      const dx = x - D[o], dz = z - D[o + 1];
      const u = dx * ca + dz * sa;
      const v = -dx * sa + dz * ca;
      if (Math.abs(u) <= D[o + 2] / 2 + margin && Math.abs(v) <= D[o + 3] / 2 + margin) return true;
    }
    return false;
  }
}

/** 走る道の路面の索引（ほかの道の上か） */
export class RideIndex {
  private cells = new Map<string, { r: number; ax: number; az: number; bx: number; bz: number; hw: number }[]>();
  constructor(
    roads: BuiltRoad[],
    private cell = 40,
  ) {
    roads.forEach((road, ri) => {
      const P = road.points;
      const n = P.length / 3;
      for (let i = 0; i + 1 < n; i += 2) {
        const j = Math.min(n - 1, i + 2);
        const s = { r: ri, ax: P[i * 3] + road.origin[0], az: P[i * 3 + 2] + road.origin[1], bx: P[j * 3] + road.origin[0], bz: P[j * 3 + 2] + road.origin[1], hw: road.width / 2 };
        for (let cx = Math.floor((Math.min(s.ax, s.bx) - s.hw) / cell); cx <= Math.floor((Math.max(s.ax, s.bx) + s.hw) / cell); cx++)
          for (let cz = Math.floor((Math.min(s.az, s.bz) - s.hw) / cell); cz <= Math.floor((Math.max(s.az, s.bz) + s.hw) / cell); cz++) {
            const k = `${cx},${cz}`;
            (this.cells.get(k) ?? this.cells.set(k, []).get(k)!).push(s);
          }
      }
    });
  }
  /** (x, z) がほかの道（except 以外）の路面 + margin の中か */
  onOther(x: number, z: number, except: number | Set<number>, margin: number): boolean {
    for (const s of this.cells.get(`${Math.floor(x / this.cell)},${Math.floor(z / this.cell)}`) ?? []) {
      if (typeof except === "number" ? s.r === except : except.has(s.r)) continue;
      const dx = s.bx - s.ax, dz = s.bz - s.az;
      const l2 = dx * dx + dz * dz || 1;
      const t = Math.max(0, Math.min(1, ((x - s.ax) * dx + (z - s.az) * dz) / l2));
      if (Math.hypot(s.ax + dx * t - x, s.az + dz * t - z) < s.hw + margin) return true;
    }
    return false;
  }
}

/** 車の通る走らない道（住宅街の道・敷地の道）の索引。歩道をその道の口で切る */
export class StreetIndex {
  private cells = new Map<string, { ax: number; az: number; bx: number; bz: number; hw: number }[]>();
  constructor(
    streets: { pts: Float32Array; index: HokkaidoStreetIndex },
    private cell = 40,
  ) {
    for (const list of Object.values(streets.index.pieces))
      for (const [off, count, w10, kind] of list) {
        if (kind !== 0) continue;
        const P = streets.pts;
        for (let i = 0; i + 1 < count; i++) {
          const s = { ax: P[(off + i) * 2], az: P[(off + i) * 2 + 1], bx: P[(off + i + 1) * 2], bz: P[(off + i + 1) * 2 + 1], hw: w10 / 20 };
          for (let cx = Math.floor((Math.min(s.ax, s.bx) - s.hw) / cell); cx <= Math.floor((Math.max(s.ax, s.bx) + s.hw) / cell); cx++)
            for (let cz = Math.floor((Math.min(s.az, s.bz) - s.hw) / cell); cz <= Math.floor((Math.max(s.az, s.bz) + s.hw) / cell); cz++) {
              const k = `${cx},${cz}`;
              (this.cells.get(k) ?? this.cells.set(k, []).get(k)!).push(s);
            }
        }
      }
  }
  /** (x, z) が道の路面 + margin の中か */
  on(x: number, z: number, margin: number): boolean {
    for (const s of this.cells.get(`${Math.floor(x / this.cell)},${Math.floor(z / this.cell)}`) ?? []) {
      const dx = s.bx - s.ax, dz = s.bz - s.az;
      const l2 = dx * dx + dz * dz || 1;
      const t = Math.max(0, Math.min(1, ((x - s.ax) * dx + (z - s.az) * dz) / l2));
      if (Math.hypot(s.ax + dx * t - x, s.az + dz * t - z) < s.hw + margin) return true;
    }
    return false;
  }
}

export const CURB = 0.15;

function hashUnit(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return (h >>> 0) / 4294967296;
}

/**
 * 横断歩道の印（接続点の腕ごと。接続点の arms と同じ並び。北海道の草案 26 章）:
 * 0 なし、1 横断歩道、2 横断歩道と停止線（両方向の道で、接続点へ入る側の車線に）
 */
export type CrossMark = 0 | 1 | 2;

/** 角の歩道を作る、隣り合う腕の間の角度の上限（これより開いた側は、曲がり方が大きく形が崩れるので作らない） */
const CORNER_MAX_GAP = (215 * Math.PI) / 180;

export function buildSidewalks(
  roads: BuiltRoad[],
  junctions: BuiltJunction[],
  buildings: Float32Array,
  cov: CoverageGrid,
  cell: number,
  streets?: { pts: Float32Array; index: HokkaidoStreetIndex },
) {
  const bidx = new BuildingIndex(buildings);
  const ridx = new RideIndex(roads);
  const sidx = streets ? new StreetIndex(streets) : null;
  const pts: number[] = [];
  const trees: number[] = [];
  const index: HokkaidoSidewalkIndex = { cell, rec: 5, sidewalks: {}, trees: {}, poles: {} };
  const stats = { km: 0, trees: 0, runs: 0, cornerKm: 0, corners: 0, crosswalks: 0, junctionsWithCrosswalks: 0 };
  let treeSeed = 1;
  const rand = () => {
    treeSeed = (Math.imul(treeSeed, 1103515245) + 12345) >>> 0;
    return treeSeed / 4294967296;
  };
  const emitRun = (run: number[], key: string) => {
    if (run.length < 10) return false;
    const off = pts.length / 5;
    for (const v of run) pts.push(Math.round(v * 100) / 100);
    (index.sidewalks[key] ??= []).push([off, run.length / 5]);
    stats.runs++;
    return true;
  };

  // 実行時と同じ接続点の形（道のりは world.json と同じ丸めにする。口の点の番号が同じになるように）
  const asRoad = new Map<string, Road>();
  const roadIndex = new Map<string, number>();
  roads.forEach((r, i) => {
    asRoad.set(r.id, { ...r, length: +r.length.toFixed(3) });
    roadIndex.set(r.id, i);
  });
  const onRoad = new Map<string, { junction: Junction; s: number }[]>();
  for (const j of junctions) for (const a of j.arms) (onRoad.get(a.road) ?? onRoad.set(a.road, []).get(a.road)!).push({ junction: j, s: a.s });
  for (const l of onRoad.values()) l.sort((a, b) => a.s - b.s);
  const net = { roads: asRoad, junctionsOn: (id: string) => onRoad.get(id) ?? [] };
  const shapes: JunctionShape[] = [];
  /** 道路の端（"道路|0" 始点、"道路|1" 終点）の口の点の番号 */
  const mouthIdx = new Map<string, number>();
  const endOf = (dir: 1 | -1) => (dir > 0 ? 0 : 1);
  for (const j of junctions) {
    const sh = junctionShape(net, j);
    shapes.push(sh);
    for (const a of sh.arms) {
      const ds = a.road.length / (a.road.points.length / 3 - 1);
      mouthIdx.set(`${a.road.id}|${endOf(a.arm.dir)}`, Math.round(a.mouthS / ds));
    }
  }
  /** 道路の端・側ごとの、口の点の歩道の幅（無ければ 0）。"道路|端|側" */
  const mouthW = new Map<string, number>();
  /** 道路の側ごとの、口から口までの 4m ごとの点と歩道の幅（電柱・街灯を置くため。poles.ts）。"道路の番号|側" */
  const roadside = new Map<string, RoadsideSample[]>();

  roads.forEach((road, ri) => {
    if (road.kind === "cycleway") return;
    const P = road.points;
    const n = P.length / 3;
    const ds = road.length / (n - 1);
    const hw = road.width / 2;
    const inSpan = (s: number) => road.spans.some((sp) => s >= sp.from - 2 && s <= sp.to + 2);
    // 口から口まで（口の内側は接続点の舗装面と角の歩道）。口の点は必ず通る
    const i0 = mouthIdx.get(`${road.id}|0`) ?? 0;
    const i1 = mouthIdx.get(`${road.id}|1`) ?? n - 1;
    if (i1 - i0 < 1) return;
    const idxs: number[] = [];
    for (let i = i0; i < i1; i += 2) idxs.push(i);
    idxs.push(i1);
    for (const side of [1, -1] as const) {
      let run: number[] = [];
      let runKey = "";
      let runLen = 0;
      let lastTree = -Infinity;
      const flush = () => {
        if (run.length) emitRun(run, runKey);
        run = [];
        runLen = 0;
        lastTree = -Infinity;
      };
      // 一般道は道ごとに街路樹があるかを決める
      const treeRoad = road.cls === 0 || (road.cls === 1 && hashUnit(road.id) < 0.6);
      const pitch = road.cls === 0 ? 12 : 15;
      for (const i of idxs) {
        const x = P[i * 3] + road.origin[0];
        const z = P[i * 3 + 2] + road.origin[1];
        const a = Math.max(0, i - 1);
        const b = Math.min(n - 1, i + 1);
        let tx = P[b * 3] - P[a * 3];
        let tz = P[b * 3 + 2] - P[a * 3 + 2];
        const tl = Math.hypot(tx, tz) || 1;
        tx /= tl;
        tz /= tl;
        // 右向き (−tz, tx) を side 倍
        const nx = -tz * side;
        const nz = tx * side;
        const c = coverageAt(cov, x, z);
        let w = c >= 0.25 ? 3 : c >= 0.06 ? 2.4 : 0;
        if (w > 0 && inSpan(i * ds)) w = 0;
        // ほかの道の上（交差点の中）
        if (w > 0 && (ridx.onOther(x + nx * (hw + 0.3), z + nz * (hw + 0.3), ri, 0.5) || ridx.onOther(x + nx * (hw + w), z + nz * (hw + w), ri, 0.3))) w = 0;
        // 住宅街の道・敷地の道の口（縁石で道を塞がない）
        if (w > 0 && sidx && (sidx.on(x + nx * (hw + 0.6), z + nz * (hw + 0.6), 0.8) || sidx.on(x + nx * (hw + w * 0.5), z + nz * (hw + w * 0.5), 0.8))) w = 0;
        // 建物に当たる所は狭める
        while (w >= 1.2 && (bidx.inside(x + nx * (hw + w), z + nz * (hw + w), 0.15) || bidx.inside(x + nx * (hw + w * 0.5), z + nz * (hw + w * 0.5), 0.15))) w -= 0.4;
        if (i === i0) mouthW.set(`${road.id}|0|${side}`, w >= 1.2 ? w : 0);
        if (i === i1) mouthW.set(`${road.id}|1|${side}`, w >= 1.2 ? w : 0);
        (roadside.get(`${ri}|${side}`) ?? roadside.set(`${ri}|${side}`, []).get(`${ri}|${side}`)!).push({ i, s: i * ds, x, z, nx, nz, y: P[i * 3 + 1], walk: w >= 1.2 ? w : 0, span: inSpan(i * ds) });
        if (w < 1.2) {
          flush();
          continue;
        }
        const key = `${Math.floor(x / cell)},${Math.floor(z / cell)}`;
        if (run.length && key !== runKey) {
          // 区画の境: 最後の点を次の組の最初にも使う
          const last = run.slice(-5);
          emitRun(run, runKey);
          run = last;
        }
        runKey = key;
        const y = P[i * 3 + 1] + CURB;
        run.push(x + nx * hw, z + nz * hw, x + nx * (hw + w), z + nz * (hw + w), y);
        if (run.length > 5) {
          const lx = run[run.length - 10], lz = run[run.length - 9];
          const step = Math.hypot(x + nx * hw - lx, z + nz * hw - lz);
          runLen += step;
          stats.km += step / 1000;
        }
        // 街路樹: 市街地の幹線・一般道、歩道の幅 2.2m 以上、12m ごと（組の始めの 6m は空ける）
        if (treeRoad && c >= 0.12 && w >= 2.2 && runLen > 6 && runLen - lastTree >= pitch) {
          const px = x + nx * (hw + 0.9);
          const pz = z + nz * (hw + 0.9);
          if (!bidx.inside(px, pz, 1.8) && !ridx.onOther(px, pz, ri, 2)) {
            const tk = `${Math.floor(px / cell)},${Math.floor(pz / cell)}`;
            const toff = trees.length / 5;
            trees.push(Math.round(px * 100) / 100, Math.round(y * 100) / 100, Math.round(pz * 100) / 100, 0.85 + 0.3 * rand(), rand() * 6.283);
            (index.trees[tk] ??= []).push(toff);
            stats.trees++;
            lastTree = runLen;
          }
        }
      }
      flush();
    }
  });

  // 角の歩道と横断歩道の印
  const cross: Record<string, CrossMark[]> = {};
  for (const sh of shapes) {
    const n = sh.arms.length;
    if (n < 2) continue;
    const armRoads = new Set(sh.arms.map((a) => roadIndex.get(a.road.id)!));
    const wAt = (a: (typeof sh.arms)[number], side: 1 | -1) => mouthW.get(`${a.road.id}|${endOf(a.arm.dir)}|${side}`) ?? 0;
    sh.edges.forEach((e, i) => {
      if (sh.gaps[i] > CORNER_MAX_GAP) return;
      const a = sh.arms[i];
      const b = sh.arms[(i + 1) % n];
      // 腕 a の +r の側（外向きに見て右 = 道のりの向きに見て dir の側）、腕 b の −r の側
      const wa = wAt(a, a.arm.dir);
      const wb = wAt(b, b.arm.dir === 1 ? -1 : 1);
      if (wa <= 0 && wb <= 0) return;
      // 曲線の外向き（進む向きの左）。両端は腕の断面の向きにそろえる（腕の歩道とすき間なくつなぐ）
      const L = e.length;
      const outN = e.map((_, q) => {
        const p0 = e[Math.max(0, q - 1)];
        const p1 = e[Math.min(L - 1, q + 1)];
        let tx = p1.x - p0.x;
        let tz = p1.z - p0.z;
        const l = Math.hypot(tx, tz) || 1;
        tx /= l;
        tz /= l;
        return [tz, -tx];
      });
      outN[0] = [-a.oz, a.ox];
      outN[L - 1] = [b.oz, -b.ox];
      let run: number[] = [];
      let len = 0;
      const flush = () => {
        if (run.length >= 10 && emitRun(run, `${Math.floor(run[0] / cell)},${Math.floor(run[1] / cell)}`)) {
          stats.corners++;
          stats.km += len / 1000;
          stats.cornerKm += len / 1000;
        }
        run = [];
        len = 0;
      };
      for (let q = 0; q < L; q++) {
        const t = q / (L - 1);
        // 幅は両端の腕の歩道の幅の間で移す。片方に歩道が無ければ、その端で 0 に細める
        const target = wa > 0 && wb > 0 ? wa + (wb - wa) * t : wa > 0 ? wa * (1 - t) : wb * t;
        const { x, z } = e[q];
        const [nx, nz] = outN[q];
        let w = target;
        if (w > 0) {
          if (sidx && (sidx.on(x + nx * 0.6, z + nz * 0.6, 0.8) || sidx.on(x + nx * w * 0.5, z + nz * w * 0.5, 0.8))) w = 0;
          else if (ridx.onOther(x + nx * w, z + nz * w, armRoads, 0.3)) w = 0;
          while (w > 0.3 && (bidx.inside(x + nx * w, z + nz * w, 0.15) || bidx.inside(x + nx * w * 0.5, z + nz * w * 0.5, 0.15))) w -= 0.4;
          if (w < 0.3) {
            flush();
            continue;
          }
        }
        if (run.length) len += Math.hypot(x - run[run.length - 5], z - run[run.length - 4]);
        run.push(x, z, x + nx * w, z + nz * w, e[q].y + CURB);
        // 細めて 0 になった端で終わる
        if (w === 0) flush();
      }
      flush();
    });
    // 横断歩道: 幹線か一般道を含む 3 本以上の接続点で、両側の口に歩道のある舗装の腕（幅 5m 以上、口の外に 10m 以上）
    if (n >= 3 && sh.arms.some((a) => a.road.cls <= 1)) {
      const marks: CrossMark[] = sh.junction.arms.map(() => 0);
      let any = false;
      for (const a of sh.arms) {
        if (a.road.surface !== "paved" || a.road.kind === "cycleway" || a.hw < 2.5) continue;
        const room = a.arm.dir > 0 ? a.road.length - a.mouthS : a.mouthS;
        if (room < 10) continue;
        if (wAt(a, 1) <= 0 || wAt(a, -1) <= 0) continue;
        const k = sh.junction.arms.indexOf(a.arm);
        if (k < 0) continue;
        marks[k] = roads[roadIndex.get(a.road.id)!].oneway ? 1 : 2;
        any = true;
        stats.crosswalks++;
      }
      if (any) {
        cross[sh.junction.id] = marks;
        stats.junctionsWithCrosswalks++;
      }
    }
  }
  stats.km = Math.round(stats.km * 10) / 10;
  stats.cornerKm = Math.round(stats.cornerKm * 10) / 10;
  return { pts: Float32Array.from(pts), trees: Float32Array.from(trees), index, stats, cross, roadside, indexes: { bidx, ridx, sidx } };
}

/** 走る道の側の点（4m ごと）。walk は歩道の幅（無ければ 0） */
export interface RoadsideSample {
  i: number;
  s: number;
  x: number;
  z: number;
  /** 道路から外への単位ベクトル */
  nx: number;
  nz: number;
  /** 路面の高さ */
  y: number;
  walk: number;
  /** 橋・トンネル */
  span: boolean;
}
