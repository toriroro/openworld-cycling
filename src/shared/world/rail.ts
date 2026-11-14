// 鉄道の生成（鉄道の草案、L1）。道路の後に引き、道路は変えない（決定 2026-11-14、案 A）。
// 依存の順序: 下地 → 川 → 結節点 → 道路（主要道・枝道・河川敷の自転車道）→ 拠点 → 線路 → 道路との交わり。
// どの結果も「種と位置」だけで決まり、計算の順序や起点によらない（モック仕様 4.2【固定】・4.6【固定】と同じ作法）。
// 分岐に関わる計算は加減乗除・sqrt・floor・abs・min・max だけで書く。

import { now } from "./clock.ts";
import { MAX_SEA_CROSSING, NODE_CELL, ORIGIN, ROAD_MIN_ELEVATION } from "./constants.ts";
import { hashUnit } from "./hash.ts";
import { longestSeaRun, nodeLess } from "./nodes.ts";
import { findRailRoute, RAIL_ROUTE_PARAMS, type RailGrid } from "./rail-route.ts";
import { catmullRom, circumradius, enforceMinRadius, polylineLength, resample, shapeCenterline } from "./shape.ts";
import type { RailCrossing, RailLine, RailSpan, RailStation, Road, WorldNode } from "./types.ts";
import type { Rect, World } from "./world.ts";

/** 拠点を 1 つ選ぶ格子 (m)。都市と交通の草案 2.2 の都市の核と同じ 24km */
export const RAIL_CELL = 24000;
/** 拠点の辺を探す範囲（自分の格子から ±2） */
const RAIL_REACH = 2;
/** 線路の探索の格子 (m) */
export const RAIL_GRID = 100;
/** 線路の点の間隔 (m) */
export const RAIL_STEP = 5;
/** 探索の範囲を両端の矩形から広げる量 (m) */
const RAIL_MARGIN = 3000;
/** 幹線・支線の最大勾配と最小曲線半径（鉄道の草案 4 章）【初期値】 */
export const RAIL_MAX_GRADE = 0.025;
const TRUNK_MIN_RADIUS = 300;
const BRANCH_MIN_RADIUS = 200;
/** 経路の長さが直線のこの倍（＋2km）を超える辺は作らない（大きく回り込んで高さを稼ぐ線を作らない）【初期値】 */
const MAX_DETOUR = 1.7;
/** 辺の最大の長さ (m) */
const MAX_EDGE = 60000;
/** 支線を出す拠点の割合と、廃線にする支線の割合 */
const BRANCH_RATIO = 0.3;
const ABANDON_RATIO = 0.35;
/** 支線の終点を探す距離 (m) */
const BRANCH_MIN = 8000;
const BRANCH_MAX = 22000;
/** 途中の駅: 線からの距離、駅の間隔、行き違いの駅の間隔 (m) */
const STATION_REACH = 1000;
const STATION_SPACING = 3000;
const PASSING_SPACING = 8000;
/** 駅の前後の平らな区間 (m) と勾配 */
const STATION_FLAT = 150;
const STATION_FLAT_BRANCH = 80;
const STATION_GRADE = 0.003;
/** 縦断の平滑化（ガウスの σ, m） */
const RAIL_SIGMA = 150;
/** 道路を越える橋の、道路から線路の高さ (m)。道路の橋の下を通る時の、橋の路面から線路の高さ (m) */
const OVER_CLEAR = 6.5;
const UNDER_CLEAR = 6;
/** 踏切にできる条件: 交わる角度の sin、道路の前後 15m の勾配 */
const LEVEL_MIN_SIN = 0.7071;
const LEVEL_MAX_ROAD_GRADE = 0.04;
/** 橋: 地面より高い量 (m) と長さ (m)。トンネル: 地面が高い量 (m) と長さ (m) */
const RAIL_BRIDGE_HEIGHT = 8;
const RAIL_BRIDGE_LENGTH = 30;
const RAIL_TUNNEL_COVER = 12;
const RAIL_TUNNEL_LENGTH = 80;
/** 水の上の線路の高さ (m)（水面から） */
const RAIL_DECK_OVER_WATER = 8;

const SALT_BRANCH = 31;
const SALT_ABANDON = 32;
const SALT_SIDE = 33;
const CHUNK = 64;
/** 拠点どうしを近づけない距離 (m)。隣の格子の拠点がこれより近く、重要度が高ければ拠点にしない */
const HUB_GAP = 12000;
/** 拠点の駅を町の中心から離す距離 (m) と、道路から離す距離 (m) */
const HUB_STATION_R = [300, 450];
const HUB_STATION_ROAD_GAP = 50;
/** 16 方向の単位ベクトル（三角関数を使わず定数で書く。noise.ts と同じ） */
const UX = [1, 0.92388, 0.70711, 0.38268, 0, -0.38268, -0.70711, -0.92388, -1, -0.92388, -0.70711, -0.38268, 0, 0.38268, 0.70711, 0.92388];
const UZ = [0, 0.38268, 0.70711, 0.92388, 1, 0.92388, 0.70711, 0.38268, 0, -0.38268, -0.70711, -0.92388, -1, -0.92388, -0.70711, -0.38268];

export interface RailEdge {
  id: string;
  kind: "trunk" | "branch";
  a: WorldNode;
  b: WorldNode;
  abandoned: boolean;
}

export interface RailTiming {
  id: string;
  ms: number;
  expanded: number;
}

export class Railways {
  private hubCache = new Map<string, WorldNode | null>();
  private rawHubCache = new Map<string, WorldNode | null>();
  private stationCache = new Map<string, { x: number; z: number; y: number }>();
  private edgeCache = new Map<string, RailEdge[]>();
  private branchCache = new Map<string, RailEdge | null>();
  private lineCache = new Map<string, RailLine | null>();
  private chunks = new Map<string, { h: Float64Array; f: Uint8Array }>();
  readonly timings: RailTiming[] = [];
  /** 経路が見つからなかった辺 */
  readonly failed = new Set<string>();

  constructor(private world: World) {}

  // ---- 拠点 ----

  /**
   * 格子 (rcx, rcz) の拠点: 格子の中の町のうち、重要度がいちばん高いもの（標高 400m 以上は除く）。
   * 隣の格子の候補が 12km 以内にあって重要度が高ければ、拠点にしない（拠点どうしが近すぎないように）
   */
  hub(rcx: number, rcz: number): WorldNode | null {
    const key = `${rcx},${rcz}`;
    if (this.hubCache.has(key)) return this.hubCache.get(key)!;
    let h = this.rawHub(rcx, rcz);
    // 起点の葛郷は必ず拠点にする（決定 2026-11-14）。葛郷から 12km 以内の隣の拠点は作らない
    if (h && h.id !== ORIGIN.node)
      for (let dz = -1; dz <= 1 && h; dz++)
        for (let dx = -1; dx <= 1 && h; dx++) {
          if (!dx && !dz) continue;
          const o = this.rawHub(rcx + dx, rcz + dz);
          if (!o || d2(o, h) > HUB_GAP * HUB_GAP) continue;
          if (o.id === ORIGIN.node || o.importance > h.importance || (o.importance === h.importance && nodeLess(o, h))) h = null;
        }
    this.hubCache.set(key, h);
    return h;
  }

  private rawHub(rcx: number, rcz: number): WorldNode | null {
    const key = `${rcx},${rcz}`;
    if (this.rawHubCache.has(key)) return this.rawHubCache.get(key)!;
    const k = RAIL_CELL / NODE_CELL;
    // 起点の格子では起点の町を拠点の候補にする
    const [ocx, ocz] = ORIGIN.node.slice(2).split("_").map(Number);
    if (Math.floor(ocx / k) === rcx && Math.floor(ocz / k) === rcz) {
      const o = this.world.node(ocx, ocz);
      if (o) {
        this.rawHubCache.set(key, o);
        return o;
      }
    }
    let best: WorldNode | null = null;
    for (let j = 0; j < k; j++)
      for (let i = 0; i < k; i++) {
        const n = this.world.node(rcx * k + i, rcz * k + j);
        if (!n || n.kind !== "town" || n.y > 400) continue;
        if (!best || n.importance > best.importance || (n.importance === best.importance && nodeLess(n, best))) best = n;
      }
    this.rawHubCache.set(key, best);
    return best;
  }

  /**
   * 拠点・終点の町の駅の位置。町の中心（道路が集まる接続点）から 300〜450m 離れた、平らで水の無い、
   * 道路から 50m 以上離れた所。どの線もこの点で終わる
   */
  stationPoint(n: WorldNode): { x: number; z: number; y: number } {
    const c = this.stationCache.get(n.id);
    if (c) return c;
    const t = this.world.terrain;
    const R = HUB_STATION_R[1] + 200;
    const pts: number[] = [];
    for (const r of this.world.roadsInRect({ x0: n.x - R, z0: n.z - R, x1: n.x + R, z1: n.z + R }))
      for (let i = 0; i < r.points.length; i += 3) pts.push(r.points[i] + r.origin[0], r.points[i + 2] + r.origin[1]);
    let best = { x: n.x, z: n.z, y: Math.max(n.y, ROAD_MIN_ELEVATION) };
    let bestScore = -Infinity;
    for (const rr of HUB_STATION_R)
      for (let k = 0; k < 16; k++) {
        const x = Math.round((n.x + UX[k] * rr) / RAIL_GRID) * RAIL_GRID;
        const z = Math.round((n.z + UZ[k] * rr) / RAIL_GRID) * RAIL_GRID;
        const smp = t.sample(x, z, false);
        if (smp.water !== 0 || smp.plainGap < 60 || smp.routeHeight < ROAD_MIN_ELEVATION) continue;
        let near = Infinity;
        for (let i = 0; i < pts.length; i += 2) {
          const dx = pts[i] - x;
          const dz = pts[i + 1] - z;
          const d = dx * dx + dz * dz;
          if (d < near) near = d;
        }
        near = Math.sqrt(near);
        if (near < HUB_STATION_ROAD_GAP) continue;
        const slope = t.slope(x, z, 100);
        const score = -slope * 60 - Math.abs(smp.routeHeight - n.y) / 8 - Math.abs(near - 120) / 150;
        if (score > bestScore) {
          bestScore = score;
          best = { x, z, y: smp.routeHeight };
        }
      }
    this.stationCache.set(n.id, best);
    return best;
  }

  private hubCell(n: WorldNode): [number, number] {
    const k = RAIL_CELL / NODE_CELL;
    return [Math.floor(n.cx / k), Math.floor(n.cz / k)];
  }

  private hubsAround(rcx: number, rcz: number): WorldNode[] {
    const out: WorldNode[] = [];
    for (let dz = -RAIL_REACH; dz <= RAIL_REACH; dz++)
      for (let dx = -RAIL_REACH; dx <= RAIL_REACH; dx++) {
        const h = this.hub(rcx + dx, rcz + dz);
        if (h) out.push(h);
      }
    return out;
  }

  /** 拠点 a から出る幹線の辺（拠点どうしの相対近傍グラフ。判定に使う第三の点は a と b の周囲の和集合） */
  trunkEdges(a: WorldNode): RailEdge[] {
    const cached = this.edgeCache.get(a.id);
    if (cached) return cached;
    const [acx, acz] = this.hubCell(a);
    const nearA = this.hubsAround(acx, acz);
    const out: RailEdge[] = [];
    for (const b of nearA) {
      if (b === a) continue;
      const ab = d2(a, b);
      if (ab > MAX_EDGE * MAX_EDGE) continue;
      const [bcx, bcz] = this.hubCell(b);
      const nearB = this.hubsAround(bcx, bcz);
      let ok = true;
      for (const c of [...nearA, ...nearB]) {
        if (c === a || c === b) continue;
        if (d2(a, c) < ab && d2(b, c) < ab) {
          ok = false;
          break;
        }
      }
      if (!ok) continue;
      if (longestSeaRun(this.world.terrain, a, b) > MAX_SEA_CROSSING) continue;
      const [p, q] = nodeLess(a, b) ? [a, b] : [b, a];
      out.push({ id: `r_${p.id}~${q.id}`, kind: "trunk", a: p, b: q, abandoned: false });
    }
    this.edgeCache.set(a.id, out);
    return out;
  }

  /** 拠点 a から出る支線（無ければ null）。終点は 8〜22km 先の、拠点でない町。海沿いを好む */
  branchEdge(a: WorldNode): RailEdge | null {
    if (this.branchCache.has(a.id)) return this.branchCache.get(a.id)!;
    let edge: RailEdge | null = null;
    if (hashUnit(this.world.seed, a.cx, a.cz, SALT_BRANCH) < BRANCH_RATIO) {
      const trunks = this.trunkEdges(a);
      const r = BRANCH_MAX;
      const cands = this.world.nodesInRect({ x0: a.x - r, z0: a.z - r, x1: a.x + r, z1: a.z + r });
      let best: WorldNode | null = null;
      let bestScore = -Infinity;
      for (const t of cands) {
        if (t.kind !== "town" || t === a) continue;
        const d = Math.sqrt(d2(a, t));
        if (d < BRANCH_MIN || d > BRANCH_MAX) continue;
        const [tcx, tcz] = this.hubCell(t);
        if (this.hub(tcx, tcz) === t) continue;
        // 幹線の向きと重ならない方（幹線の向きとの内積が小さい）
        let along = 0;
        for (const e of trunks) {
          const o = e.a === a ? e.b : e.a;
          const ox = o.x - a.x;
          const oz = o.z - a.z;
          const dot = ((t.x - a.x) * ox + (t.z - a.z) * oz) / (d * Math.sqrt(ox * ox + oz * oz) || 1);
          if (dot > along) along = dot;
        }
        if (along > 0.8) continue;
        const score = t.importance + (t.y < 40 ? 0.25 : 0) - 0.3 * along;
        if (score > bestScore || (score === bestScore && best && nodeLess(t, best))) {
          best = t;
          bestScore = score;
        }
      }
      if (best && longestSeaRun(this.world.terrain, a, best) <= MAX_SEA_CROSSING) {
        const abandoned = hashUnit(this.world.seed, a.cx, a.cz, SALT_ABANDON) < ABANDON_RATIO;
        edge = { id: `rb_${a.id}~${best.id}`, kind: "branch", a, b: best, abandoned };
      }
    }
    this.branchCache.set(a.id, edge);
    return edge;
  }

  /** rect にかかる辺（両端の矩形を広げたものが rect にかかる） */
  edgesNear(r: Rect): RailEdge[] {
    const k = RAIL_CELL;
    const seen = new Map<string, RailEdge>();
    const x0 = Math.floor(r.x0 / k) - RAIL_REACH;
    const x1 = Math.floor(r.x1 / k) + RAIL_REACH;
    const z0 = Math.floor(r.z0 / k) - RAIL_REACH;
    const z1 = Math.floor(r.z1 / k) + RAIL_REACH;
    for (let cz = z0; cz <= z1; cz++)
      for (let cx = x0; cx <= x1; cx++) {
        const h = this.hub(cx, cz);
        if (!h) continue;
        const es = [...this.trunkEdges(h)];
        const b = this.branchEdge(h);
        if (b) es.push(b);
        for (const e of es) {
          if (seen.has(e.id)) continue;
          const m = RAIL_MARGIN;
          if (Math.max(e.a.x, e.b.x) + m < r.x0 || Math.min(e.a.x, e.b.x) - m > r.x1) continue;
          if (Math.max(e.a.z, e.b.z) + m < r.z0 || Math.min(e.a.z, e.b.z) - m > r.z1) continue;
          seen.set(e.id, e);
        }
      }
    return [...seen.values()].sort((p, q) => (p.id < q.id ? -1 : p.id > q.id ? 1 : 0));
  }

  /** rect にかかる線路 */
  inRect(r: Rect): RailLine[] {
    const out: RailLine[] = [];
    for (const e of this.edgesNear(r)) {
      const l = this.line(e);
      if (!l) continue;
      const b = lineBounds(l);
      if (b.x1 < r.x0 || b.x0 > r.x1 || b.z1 < r.z0 || b.z0 > r.z1) continue;
      out.push(l);
    }
    return out;
  }

  // ---- 探索の格子 ----

  private chunk(kx: number, kz: number): { h: Float64Array; f: Uint8Array } {
    const key = `${kx},${kz}`;
    let c = this.chunks.get(key);
    if (!c) {
      c = { h: new Float64Array(CHUNK * CHUNK), f: new Uint8Array(CHUNK * CHUNK) };
      for (let j = 0; j < CHUNK; j++)
        for (let i = 0; i < CHUNK; i++) {
          const s = this.world.terrain.sample((kx * CHUNK + i) * RAIL_GRID, (kz * CHUNK + j) * RAIL_GRID, false);
          c.h[j * CHUNK + i] = s.routeHeight;
          c.f[j * CHUNK + i] = (s.water === 1 || s.water === 2 ? 1 : 0) | (s.plainGap < 50 ? 2 : 0);
        }
      this.chunks.set(key, c);
    }
    return c;
  }

  private grid(r: Rect): RailGrid {
    const ix0 = Math.floor(r.x0 / RAIL_GRID);
    const iz0 = Math.floor(r.z0 / RAIL_GRID);
    const ix1 = Math.ceil(r.x1 / RAIL_GRID);
    const iz1 = Math.ceil(r.z1 / RAIL_GRID);
    const w = ix1 - ix0 + 1;
    const h = iz1 - iz0 + 1;
    const heights = new Float64Array(w * h);
    const flags = new Uint8Array(w * h);
    for (let j = 0; j < h; j++)
      for (let i = 0; i < w; i++) {
        const gx = ix0 + i;
        const gz = iz0 + j;
        const kx = Math.floor(gx / CHUNK);
        const kz = Math.floor(gz / CHUNK);
        const c = this.chunk(kx, kz);
        const o = (gz - kz * CHUNK) * CHUNK + (gx - kx * CHUNK);
        heights[j * w + i] = c.h[o];
        flags[j * w + i] = c.f[o];
      }
    return { ix0, iz0, w, h, cell: RAIL_GRID, heights, flags };
  }

  // ---- 線路 1 本 ----

  line(e: RailEdge): RailLine | null {
    if (this.lineCache.has(e.id)) return this.lineCache.get(e.id)!;
    const t0 = now();
    const res = this.buildLine(e);
    this.timings.push({ id: e.id, ms: now() - t0, expanded: res.expanded });
    if (!res.line) this.failed.add(e.id);
    this.lineCache.set(e.id, res.line);
    return res.line;
  }

  private buildLine(e: RailEdge): { line: RailLine | null; expanded: number } {
    const a = this.stationPoint(e.a);
    const b = this.stationPoint(e.b);
    const rect = {
      x0: Math.min(a.x, b.x) - RAIL_MARGIN,
      z0: Math.min(a.z, b.z) - RAIL_MARGIN,
      x1: Math.max(a.x, b.x) + RAIL_MARGIN,
      z1: Math.max(a.z, b.z) + RAIL_MARGIN,
    };
    const grid = this.grid(rect);
    const sx = Math.round(a.x / RAIL_GRID) - grid.ix0;
    const sz = Math.round(a.z / RAIL_GRID) - grid.iz0;
    const gx = Math.round(b.x / RAIL_GRID) - grid.ix0;
    const gz = Math.round(b.z / RAIL_GRID) - grid.iz0;
    const route = findRailRoute(grid, sx, sz, gx, gz, { ...RAIL_ROUTE_PARAMS, maxGrade: RAIL_MAX_GRADE });
    if (!route) return { line: null, expanded: 0 };
    const n0 = route.cells.length / 2;
    const raw = new Float64Array(n0 * 2);
    const keep = new Uint8Array(n0);
    for (let i = 0; i < n0; i++) {
      raw[i * 2] = route.cells[i * 2] * RAIL_GRID;
      raw[i * 2 + 1] = route.cells[i * 2 + 1] * RAIL_GRID;
      // トンネル・高架の両端は残す（まっすぐな構造物の形を保つ）
      const k0 = route.kind[i];
      const k1 = i + 1 < n0 ? route.kind[i + 1] : 0;
      if (k0 >= 2 || k1 >= 2) keep[i] = 1;
    }
    keep[0] = keep[n0 - 1] = 1;
    raw[0] = a.x;
    raw[1] = a.z;
    raw[(n0 - 1) * 2] = b.x;
    raw[(n0 - 1) * 2 + 1] = b.z;
    const straight = Math.sqrt((a.x - b.x) * (a.x - b.x) + (a.z - b.z) * (a.z - b.z));
    if (polylineLength(raw) > MAX_DETOUR * straight + 2000) return { line: null, expanded: route.expanded };
    const minR = e.kind === "trunk" ? TRUNK_MIN_RADIUS : BRANCH_MIN_RADIUS;
    let xz = shapeCenterline(raw, keep, minR, RAIL_STEP);
    // 線路は道路より曲がりにくいので、半径が足りない所が残れば、ゆるめる回数を増やす
    for (let round = 0; round < 6 && tightAt(xz, minR); round++) xz = resample(catmullRom(enforceMinRadius(xz, minR * (1.1 + 0.05 * round), 30, 400), 1), RAIL_STEP);
    const n = xz.length / 2;
    const length = polylineLength(xz);
    const ds = length / (n - 1);

    // 沿線の地面・水
    const routeGround = new Float64Array(n);
    const ground = new Float64Array(n);
    const water = new Uint8Array(n);
    const target = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const s = this.world.terrain.sample(xz[i * 2], xz[i * 2 + 1], true);
      routeGround[i] = s.routeHeight;
      ground[i] = s.height;
      let t = Math.max(s.routeHeight, ROAD_MIN_ELEVATION);
      if (s.height < 0 || s.water === 1) {
        water[i] = 1;
        t = RAIL_DECK_OVER_WATER;
      } else if (s.water === 2 || s.water === 3 || s.floodplain) {
        water[i] = s.water ? 1 : 0;
        t = Math.max(t, s.waterLevel + RAIL_DECK_OVER_WATER);
      }
      target[i] = t;
    }
    // 探索でトンネル・高架にした区間は、両端の高さを結ぶ直線を目標にする（地形の山や谷に沿わせない）
    for (let i = 0; i + 1 < n0; i++) {
      if (route.kind[i + 1] !== 2 && route.kind[i + 1] !== 3) continue;
      const ia = nearestIndex(xz, raw[i * 2], raw[i * 2 + 1]);
      const ib = nearestIndex(xz, raw[(i + 1) * 2], raw[(i + 1) * 2 + 1]);
      if (ib <= ia + 1) continue;
      for (let k = ia + 1; k < ib; k++) target[k] = target[ia] + ((target[ib] - target[ia]) * (k - ia)) / (ib - ia);
    }

    // 駅
    const stations = this.pickStations(e, xz, ds, length);
    const flat = e.kind === "trunk" ? STATION_FLAT : STATION_FLAT_BRANCH;
    const lim = new Float64Array(n).fill(RAIL_MAX_GRADE * ds);
    for (const st of stations) {
      const i0 = Math.max(0, Math.floor((st.s - flat) / ds));
      const i1 = Math.min(n - 1, Math.ceil((st.s + flat) / ds));
      for (let i = i0; i <= i1; i++) lim[i] = STATION_GRADE * ds;
    }
    const sm = smooth(target, RAIL_SIGMA / ds);
    const pins = new Map<number, number>();
    pins.set(0, Math.max(a.y, ROAD_MIN_ELEVATION));
    pins.set(n - 1, Math.max(b.y, ROAD_MIN_ELEVATION));
    // 1 回目: 両端だけを固定（駅は lim で平らにする）
    let prof = solveProfile(sm, lim, pins);

    // 道路との交わり
    const hits = this.roadHits(e.id, xz, ds);
    const crossings: RailCrossing[] = [];
    const cpins = new Map(pins);
    for (const h of hits) {
      const i = Math.max(1, Math.min(n - 2, Math.round(h.s / ds)));
      const y0 = prof.y[i];
      let kind: RailCrossing["kind"];
      let pin: number;
      // 道路の橋の下 → 線路がもともと十分高い所は跨道橋 → 高さが近く角度と道路の勾配がよい所は踏切 →
      // それ以外も、線路が道路より高ければ跨道橋、低ければ踏切（線路を道路の高さまで上げる）
      const levelOk = Math.abs(y0 - h.roadY) <= 5 && h.sin >= LEVEL_MIN_SIN && h.roadGrade <= LEVEL_MAX_ROAD_GRADE;
      if (h.roadBridge && y0 <= h.roadY - UNDER_CLEAR) {
        kind = "under";
        pin = Math.min(y0, h.roadY - UNDER_CLEAR);
      } else if (y0 >= h.roadY + OVER_CLEAR - 1.5) {
        kind = "over";
        pin = Math.max(y0, h.roadY + OVER_CLEAR);
      } else if (levelOk || y0 < h.roadY) {
        kind = "level";
        pin = h.roadY;
      } else {
        kind = "over";
        pin = Math.max(y0, h.roadY + OVER_CLEAR);
      }
      crossings.push({ id: `${e.id}#x${crossings.length}`, line: e.id, s: h.s, road: h.road, roadS: h.roadS, kind, ...({ _h: h } as object) });
      if (!cpins.has(i)) cpins.set(i, pin);
    }
    prof = solveProfile(sm, lim, cpins);
    // 合わせられなかった交わり（縦断の勾配の制限と両立しない）。解いた高さで跨道橋・橋の下になるなら、そう分け直す
    for (const c of crossings) {
      const h = (c as unknown as { _h: RoadHit })._h;
      delete (c as unknown as { _h?: RoadHit })._h;
      const i = Math.max(1, Math.min(n - 2, Math.round(c.s / ds)));
      if (!prof.dropped.has(i)) continue;
      const yy = prof.y[i];
      if (yy >= h.roadY + OVER_CLEAR - 0.5) c.kind = "over";
      else if (h.roadBridge && yy <= h.roadY - UNDER_CLEAR) c.kind = "under";
      else c.unresolved = true;
    }
    const y = prof.y;
    const spans = railSpans(y, ground, water, ds, crossings);

    // 線路の上に駅を置けない所（橋・トンネルの中）の途中の駅は外す
    const kept = stations.filter((st, k) => k === 0 || k === stations.length - 1 || !spans.some((sp) => st.s > sp.from - 40 && st.s < sp.to + 40));
    markPassing(kept, e.kind);

    const ox = xz[0];
    const oz = xz[1];
    const points = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      points[i * 3] = xz[i * 2] - ox;
      points[i * 3 + 1] = y[i];
      points[i * 3 + 2] = xz[i * 2 + 1] - oz;
    }
    // 幹線は両端の町の名前の 1 字ずつ（同じ字なら終点の 2 字目）、支線は終点の町の名前
    const ca = e.a.name.slice(0, 1);
    const cb = e.b.name.slice(0, 1) === ca ? e.b.name.slice(1, 2) || e.b.name.slice(0, 1) : e.b.name.slice(0, 1);
    const name = e.kind === "trunk" ? `${ca}${cb}線` : `${e.b.name}線`;
    return {
      line: {
        id: e.id,
        kind: e.kind,
        status: e.abandoned ? "abandoned" : "open",
        name,
        origin: [ox, oz],
        points,
        length,
        spans,
        stations: kept,
        crossings,
        start: e.a.id,
        end: e.b.id,
      },
      expanded: route.expanded,
    };
  }

  /** 線から 600m 以内の町・集落に駅を置く。駅どうしは 3km 以上離す（重要度の高い方を残す） */
  private pickStations(e: RailEdge, xz: Float64Array, ds: number, length: number): RailStation[] {
    const n = xz.length / 2;
    const b = { x0: Infinity, z0: Infinity, x1: -Infinity, z1: -Infinity };
    for (let i = 0; i < n; i++) {
      b.x0 = Math.min(b.x0, xz[i * 2]);
      b.x1 = Math.max(b.x1, xz[i * 2]);
      b.z0 = Math.min(b.z0, xz[i * 2 + 1]);
      b.z1 = Math.max(b.z1, xz[i * 2 + 1]);
    }
    const m = STATION_REACH;
    const cands = this.world.nodesInRect({ x0: b.x0 - m, z0: b.z0 - m, x1: b.x1 + m, z1: b.z1 + m });
    const seed = this.world.seed;
    const side = (nd: WorldNode) => (hashUnit(seed, nd.cx, nd.cz, SALT_SIDE) < 0.5 ? -1 : 1) as 1 | -1;
    const ends: RailStation[] = [
      { id: `${e.id}#st_${e.a.id}`, s: 0, name: e.a.name, node: e.a.id, kind: "hub", side: side(e.a) },
      { id: `${e.id}#st_${e.b.id}`, s: length, name: e.b.name, node: e.b.id, kind: e.kind === "branch" ? "terminus" : "hub", side: side(e.b) },
    ];
    const found: { nd: WorldNode; s: number }[] = [];
    const stride = Math.max(1, Math.round(20 / ds));
    for (const nd of cands) {
      if (nd === e.a || nd === e.b || nd.kind === "junction") continue;
      let best = Infinity;
      let bi = 0;
      for (let i = 0; i < n; i += stride) {
        const dx = xz[i * 2] - nd.x;
        const dz = xz[i * 2 + 1] - nd.z;
        const d = dx * dx + dz * dz;
        if (d < best) {
          best = d;
          bi = i;
        }
      }
      if (best > m * m) continue;
      const s = bi * ds;
      if (s < STATION_SPACING || s > length - STATION_SPACING) continue;
      found.push({ nd, s });
    }
    found.sort((p, q) => q.nd.importance - p.nd.importance || (nodeLess(p.nd, q.nd) ? -1 : 1));
    const chosen: { nd: WorldNode; s: number }[] = [];
    for (const f of found) if (!chosen.some((c) => Math.abs(c.s - f.s) < STATION_SPACING)) chosen.push(f);
    chosen.sort((p, q) => p.s - q.s);
    return [
      ends[0],
      ...chosen.map((c) => ({ id: `${e.id}#st_${c.nd.id}`, s: c.s, name: c.nd.name, node: c.nd.id, kind: "small" as const, side: side(c.nd) })),
      ends[1],
    ];
  }

  /** 線路と道路が交わる所。線路の近く（幅 200m の帯）にかかる道路だけを生成して調べる */
  private roadHits(lineId: string, xz: Float64Array, ds: number): RoadHit[] {
    const n = xz.length / 2;
    const roads = new Map<string, Road>();
    const piece = Math.max(1, Math.round(2000 / ds));
    for (let i0 = 0; i0 < n - 1; i0 += piece) {
      const i1 = Math.min(n - 1, i0 + piece);
      let x0 = Infinity;
      let z0 = Infinity;
      let x1 = -Infinity;
      let z1 = -Infinity;
      for (let i = i0; i <= i1; i++) {
        x0 = Math.min(x0, xz[i * 2]);
        x1 = Math.max(x1, xz[i * 2]);
        z0 = Math.min(z0, xz[i * 2 + 1]);
        z1 = Math.max(z1, xz[i * 2 + 1]);
      }
      for (const r of this.world.roadsInRect({ x0: x0 - 100, z0: z0 - 100, x1: x1 + 100, z1: z1 + 100 })) roads.set(r.id, r);
    }
    const hits: RoadHit[] = [];
    // 線路の線分を 200m の升目に入れて、道路の線分と交わるものを探す
    const G = 200;
    const buckets = new Map<string, number[]>();
    for (let i = 0; i < n - 1; i++) {
      const kx = Math.floor((xz[i * 2] + xz[i * 2 + 2]) * 0.5 / G);
      const kz = Math.floor((xz[i * 2 + 1] + xz[i * 2 + 3]) * 0.5 / G);
      for (let dz = -1; dz <= 1; dz++)
        for (let dx = -1; dx <= 1; dx++) {
          const k = `${kx + dx},${kz + dz}`;
          let l = buckets.get(k);
          if (!l) buckets.set(k, (l = []));
          l.push(i);
        }
    }
    for (const r of [...roads.values()].sort((p, q) => (p.id < q.id ? -1 : 1))) {
      const P = r.points;
      const m = P.length / 3;
      const rds = r.length / (m - 1);
      const found: RoadHit[] = [];
      for (let j = 0; j < m - 1; j++) {
        const ax = P[j * 3] + r.origin[0];
        const az = P[j * 3 + 2] + r.origin[1];
        const bx = P[j * 3 + 3] + r.origin[0];
        const bz = P[j * 3 + 5] + r.origin[1];
        const l = buckets.get(`${Math.floor((ax + bx) * 0.5 / G)},${Math.floor((az + bz) * 0.5 / G)}`);
        if (!l) continue;
        for (const i of l) {
          const cx = xz[i * 2];
          const cz = xz[i * 2 + 1];
          const ex = xz[i * 2 + 2];
          const ez = xz[i * 2 + 3];
          const t = segT(cx, cz, ex, ez, ax, az, bx, bz);
          if (!t) continue;
          const s = (i + t[0]) * ds;
          const roadS = (j + t[1]) * rds;
          if (found.some((f) => Math.abs(f.roadS - roadS) < 20)) continue;
          // 交わる角度
          const ux = ex - cx;
          const uz = ez - cz;
          const vx = bx - ax;
          const vz = bz - az;
          const sin = Math.abs(ux * vz - uz * vx) / (Math.sqrt(ux * ux + uz * uz) * Math.sqrt(vx * vx + vz * vz) || 1);
          const y0 = roadY(r, roadS - 15);
          const y1 = roadY(r, roadS + 15);
          found.push({
            road: r.id,
            roadS,
            s,
            roadY: roadY(r, roadS),
            roadBridge: r.spans.some((sp) => roadS >= sp.from && roadS <= sp.to),
            roadGrade: Math.abs(y1 - y0) / 30,
            sin,
          });
        }
      }
      hits.push(...found);
    }
    hits.sort((p, q) => p.s - q.s);
    // 同じ所（10m 以内）の交わりは 1 つにする（道路の重なり）
    const out: RoadHit[] = [];
    for (const h of hits) if (!out.some((o) => Math.abs(o.s - h.s) < 10)) out.push(h);
    void lineId;
    return out;
  }
}

interface RoadHit {
  road: string;
  roadS: number;
  s: number;
  roadY: number;
  roadBridge: boolean;
  roadGrade: number;
  sin: number;
}

/** 前後 30m の 3 点で測った半径が最小曲線半径の 95% を下回る点があるか */
function tightAt(p: Float64Array, minR: number): boolean {
  const n = p.length / 2;
  const k = Math.max(3, Math.round(30 / RAIL_STEP));
  for (let i = k; i < n - k; i++) {
    const r = circumradius(p[(i - k) * 2], p[(i - k) * 2 + 1], p[i * 2], p[i * 2 + 1], p[(i + k) * 2], p[(i + k) * 2 + 1]);
    if (r < minR * 0.95) return true;
  }
  return false;
}

function d2(a: WorldNode, b: WorldNode): number {
  const dx = a.x - b.x;
  const dz = a.z - b.z;
  return dx * dx + dz * dz;
}

function nearestIndex(xz: Float64Array, x: number, z: number): number {
  let best = Infinity;
  let bi = 0;
  for (let i = 0; i < xz.length / 2; i++) {
    const dx = xz[i * 2] - x;
    const dz = xz[i * 2 + 1] - z;
    const d = dx * dx + dz * dz;
    if (d < best) {
      best = d;
      bi = i;
    }
  }
  return bi;
}

/** 線分 cd と ab が交われば、それぞれの上の位置 [t, u]（0〜1） */
function segT(cx: number, cz: number, dx: number, dz: number, ax: number, az: number, bx: number, bz: number): [number, number] | null {
  const rx = dx - cx;
  const rz = dz - cz;
  const sx = bx - ax;
  const sz = bz - az;
  const den = rx * sz - rz * sx;
  if (den === 0) return null;
  const qx = ax - cx;
  const qz = az - cz;
  const t = (qx * sz - qz * sx) / den;
  const u = (qx * rz - qz * rx) / den;
  if (t < 0 || t > 1 || u < 0 || u > 1) return null;
  return [t, u];
}

function roadY(r: Road, s: number): number {
  const n = r.points.length / 3;
  const ds = r.length / (n - 1);
  let f = s / ds;
  if (f < 0) f = 0;
  if (f > n - 1) f = n - 1;
  const i = Math.min(n - 2, Math.floor(f));
  const t = f - i;
  return r.points[i * 3 + 1] + (r.points[i * 3 + 4] - r.points[i * 3 + 1]) * t;
}

/** 多項式の核での平滑化（exp を使わない。shape.ts の computeProfile と同じ近似） */
function smooth(v: Float64Array, sig: number): Float64Array {
  const n = v.length;
  const R = Math.ceil(sig * 3);
  const kern = new Float64Array(R + 1);
  for (let k = 0; k <= R; k++) {
    const u = (k * k) / (sig * sig) / 8;
    const b = 1 - u;
    kern[k] = b > 0 ? b * b * b * b : 0;
  }
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let sum = 0;
    let ws = 0;
    const lo = Math.max(0, i - R);
    const hi = Math.min(n - 1, i + R);
    for (let j = lo; j <= hi; j++) {
      const w = kern[j > i ? j - i : i - j];
      sum += w * v[j];
      ws += w;
    }
    out[i] = sum / ws;
  }
  return out;
}

/**
 * 縦断を解く: 目標 base に近く、区間ごとの高さの差が lim 以内で、固定点 pins を通る列。
 * 隣り合う固定点の間で、両方から届く範囲 [L, U] に目標を収め、上下の包絡線の平均を取る（平均も lim を守る）。
 * 両立しない固定点は外し、dropped に入れる。
 */
export function solveProfile(base: Float64Array, lim: Float64Array, pins: Map<number, number>): { y: Float64Array; dropped: Set<number> } {
  const n = base.length;
  const cum = new Float64Array(n);
  for (let i = 1; i < n; i++) cum[i] = cum[i - 1] + Math.min(lim[i], lim[i - 1]);
  // 固定点を前から確かめ、前の固定点から届かないものを外す（両端は外さない）
  const idx = [...pins.keys()].sort((p, q) => p - q);
  const dropped = new Set<number>();
  const kept: number[] = [];
  for (const i of idx) {
    const prev = kept[kept.length - 1];
    if (prev !== undefined && Math.abs(pins.get(i)! - pins.get(prev)!) > cum[i] - cum[prev] + 1e-9 && i !== n - 1) {
      dropped.add(i);
      continue;
    }
    kept.push(i);
  }
  // 終点が届かない時は、終点の手前の固定点を外していく
  while (kept.length > 2) {
    const last = kept[kept.length - 1];
    const prev = kept[kept.length - 2];
    if (Math.abs(pins.get(last)! - pins.get(prev)!) <= cum[last] - cum[prev] + 1e-9) break;
    dropped.add(prev);
    kept.splice(kept.length - 2, 1);
  }
  const y = new Float64Array(n);
  for (let k = 0; k + 1 < kept.length; k++) {
    const p = kept[k];
    const q = kept[k + 1];
    const yp = pins.get(p)!;
    const yq = pins.get(q)!;
    const m = q - p + 1;
    const t = new Float64Array(m);
    for (let i = p; i <= q; i++) {
      const U = Math.min(yp + (cum[i] - cum[p]), yq + (cum[q] - cum[i]));
      const L = Math.max(yp - (cum[i] - cum[p]), yq - (cum[q] - cum[i]));
      t[i - p] = Math.max(L, Math.min(U, base[i]));
    }
    // 下の包絡線（t 以下で傾きが lim 以内の最大のもの）と上の包絡線
    const lo = t.slice();
    const hi = t.slice();
    for (let i = 1; i < m; i++) {
      const d = cum[p + i] - cum[p + i - 1];
      if (lo[i] > lo[i - 1] + d) lo[i] = lo[i - 1] + d;
      if (hi[i] < hi[i - 1] - d) hi[i] = hi[i - 1] - d;
    }
    for (let i = m - 2; i >= 0; i--) {
      const d = cum[p + i + 1] - cum[p + i];
      if (lo[i] > lo[i + 1] + d) lo[i] = lo[i + 1] + d;
      if (hi[i] < hi[i + 1] - d) hi[i] = hi[i + 1] - d;
    }
    for (let i = 0; i < m; i++) y[p + i] = (lo[i] + hi[i]) * 0.5;
    y[p] = yp;
    y[q] = yq;
  }
  return { y, dropped };
}

/** 橋（地面より高い・水の上・道路を越える所）とトンネル（地面が高い所） */
function railSpans(y: Float64Array, ground: Float64Array, water: Uint8Array, ds: number, crossings: RailCrossing[]): RailSpan[] {
  const n = y.length;
  const kind = new Uint8Array(n); // 1 = 橋、2 = トンネル
  const runs = (test: (i: number) => boolean, minLen: number, k: number) => {
    let st = -1;
    for (let i = 0; i <= n; i++) {
      const on = i < n && test(i);
      if (on && st < 0) st = i;
      if (!on && st >= 0) {
        if ((i - st) * ds >= minLen) for (let j = st; j < i; j++) kind[j] = k;
        st = -1;
      }
    }
  };
  runs((i) => !water[i] && y[i] - ground[i] >= RAIL_BRIDGE_HEIGHT, RAIL_BRIDGE_LENGTH, 1);
  runs((i) => water[i] === 1, 0, 1);
  for (const c of crossings) {
    if (c.kind !== "over") continue;
    const i0 = Math.max(0, Math.floor((c.s - 12) / ds));
    const i1 = Math.min(n - 1, Math.ceil((c.s + 12) / ds));
    for (let i = i0; i <= i1; i++) kind[i] = 1;
  }
  runs((i) => ground[i] - y[i] >= RAIL_TUNNEL_COVER, RAIL_TUNNEL_LENGTH, 2);
  const out: RailSpan[] = [];
  let st = -1;
  for (let i = 0; i <= n; i++) {
    const k = i < n ? kind[i] : 0;
    if (st >= 0 && k !== kind[st]) {
      // 短すぎる橋（細い川）は 10m にする
      let from = st * ds;
      let to = (i - 1) * ds;
      if (to - from < 10) {
        const mid = (from + to) / 2;
        from = Math.max(0, mid - 5);
        to = Math.min((n - 1) * ds, mid + 5);
      }
      out.push({ from, to, kind: kind[st] === 1 ? "bridge" : "tunnel" });
      st = -1;
    }
    if (k && st < 0) st = i;
  }
  return out;
}

/** 行き違いの駅: 拠点と、前の行き違いの駅から 8km 以上離れた駅 */
function markPassing(st: RailStation[], kind: "trunk" | "branch") {
  let last = 0;
  for (let k = 1; k < st.length - 1; k++) {
    if (st[k].s - last >= PASSING_SPACING && st[st.length - 1].s - st[k].s >= PASSING_SPACING / 2) {
      st[k].kind = "passing";
      last = st[k].s;
    }
  }
  void kind;
}

export function lineBounds(l: RailLine): Rect {
  let x0 = Infinity;
  let z0 = Infinity;
  let x1 = -Infinity;
  let z1 = -Infinity;
  const P = l.points;
  for (let i = 0; i < P.length; i += 3) {
    x0 = Math.min(x0, P[i]);
    x1 = Math.max(x1, P[i]);
    z0 = Math.min(z0, P[i + 2]);
    z1 = Math.max(z1, P[i + 2]);
  }
  return { x0: x0 + l.origin[0], z0: z0 + l.origin[1], x1: x1 + l.origin[0], z1: z1 + l.origin[1] };
}
