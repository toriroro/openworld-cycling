// 世界の生成を束ねる。結節点 → 辺 → 主要道 → 枝道 → 接続点・立ち寄り地点。
// どの結果も「種と位置」だけで決まり、計算の順序や起点によらない（モック仕様 4.6、4.7、4.10）。

import {
  EDGE_CELL_REACH,
  PASS_PROMINENCE,
  NODE_CELL,
  ROAD_CLASSES,
  ROUTE_GRID,
  ROUTE_MARGIN,
} from "./constants.ts";
import { now } from "./clock.ts";
import { hashString } from "./hash.ts";
import { edgesOf, type EdgeInfo, makeNode, nodeId } from "./nodes.ts";
import { passName, viewpointName } from "./names.ts";
import { pickPois } from "./pois.ts";
import { DEFAULT_ROUTE_PARAMS, findRoute, type RouteGrid } from "./route.ts";
import { computeProfile, detectBridges, polylineLength, shapeCenterline } from "./shape.ts";
import { Terrain } from "./terrain.ts";
import type { Junction, Poi, Road, WorldNode } from "./types.ts";

export interface Rect {
  x0: number;
  z0: number;
  x1: number;
  z1: number;
}

/** 道路の端が主要道の途中にくっつく位置 */
export interface Attachment {
  road: string;
  s: number;
}

interface MainData {
  road: Road | null;
  /** 経路の格子番号 [ix, iz, ...] */
  cells: Int32Array | null;
  /** 格子ごとにその場所を通る道路（結節点で別の主要道へ合流させた区間は合流先の道路） */
  owners?: Road[];
}

export interface RoadTiming {
  id: string;
  ms: number;
  expanded: number;
}

const CHUNK = 64;
const CHUNK_KEY_OFFSET = 1 << 20;

export class World {
  readonly terrain: Terrain;
  private nodes = new Map<string, WorldNode | null>();
  private nodeEdges = new Map<string, EdgeInfo[]>();
  private raws = new Map<string, MainData>();
  private mains = new Map<string, MainData>();
  private branches = new Map<string, Road[]>();
  private chunks = new Map<number, Float64Array>();
  private poiCache = new Map<string, Poi[]>();
  /** 枝道の端が主要道の途中にくっつく位置（道路の識別子 → 始点・終点） */
  readonly attachments = new Map<string, { start?: Attachment; end?: Attachment }>();
  /** 経路が見つからなかった辺 */
  readonly failedEdges = new Set<string>();
  readonly timings: RoadTiming[] = [];

  constructor(readonly seed: number) {
    this.terrain = new Terrain(seed);
  }

  /**
   * 覚えている結果のうち keep の外のものを捨てる（走り続けてもメモリが増えないように）。
   * 捨てた結果は次に要る時に同じものが作り直される。
   */
  prune(keep: Rect) {
    const outCell = (cx: number, cz: number) =>
      (cx + 1) * NODE_CELL < keep.x0 || cx * NODE_CELL > keep.x1 || (cz + 1) * NODE_CELL < keep.z0 || cz * NODE_CELL > keep.z1;
    const parse = (id: string) => {
      const [, a, b] = id.split("_");
      return [Number(a), Number(b)] as const;
    };
    for (const id of this.nodes.keys()) {
      const [cx, cz] = parse(id);
      if (outCell(cx, cz)) {
        this.nodes.delete(id);
        this.nodeEdges.delete(id);
        this.poiCache.delete(`node:${id}`);
      }
    }
    const edgeOut = (eid: string) => {
      const [a, b] = eid.split("~");
      const [ax, az] = parse(a);
      const [bx, bz] = parse(b);
      return outCell(ax, az) && outCell(bx, bz);
    };
    for (const id of this.raws.keys()) if (edgeOut(id)) this.raws.delete(id);
    for (const [id, m] of this.mains)
      if (edgeOut(id)) {
        this.mains.delete(id);
        if (m.road) {
          this.poiCache.delete(m.road.id);
          this.attachments.delete(m.road.id);
        }
      }
    for (const [id, pieces] of this.branches)
      if (edgeOut(id)) {
        this.branches.delete(id);
        for (const p of pieces) {
          this.poiCache.delete(p.id);
          this.attachments.delete(p.id);
        }
      }
    for (const id of this.failedEdges) if (edgeOut(id)) this.failedEdges.delete(id);
    for (const key of this.chunks.keys()) {
      const kx = Math.floor(key / 2097152) - CHUNK_KEY_OFFSET;
      const kz = (key % 2097152) - CHUNK_KEY_OFFSET;
      const x0 = kx * CHUNK * ROUTE_GRID;
      const z0 = kz * CHUNK * ROUTE_GRID;
      const span = CHUNK * ROUTE_GRID;
      if (x0 + span < keep.x0 || x0 > keep.x1 || z0 + span < keep.z0 || z0 > keep.z1) this.chunks.delete(key);
    }
    if (this.timings.length > 2000) this.timings.splice(0, this.timings.length - 2000);
  }

  node(cx: number, cz: number): WorldNode | null {
    const id = nodeId(cx, cz);
    let n = this.nodes.get(id);
    if (n === undefined) {
      n = makeNode(this.seed, this.terrain, cx, cz);
      this.nodes.set(id, n);
    }
    return n;
  }

  nodesInRect(r: Rect): WorldNode[] {
    const out: WorldNode[] = [];
    const cx0 = Math.floor(r.x0 / NODE_CELL);
    const cx1 = Math.floor(r.x1 / NODE_CELL);
    const cz0 = Math.floor(r.z0 / NODE_CELL);
    const cz1 = Math.floor(r.z1 / NODE_CELL);
    for (let cz = cz0; cz <= cz1; cz++)
      for (let cx = cx0; cx <= cx1; cx++) {
        const n = this.node(cx, cz);
        if (n && n.x >= r.x0 && n.x <= r.x1 && n.z >= r.z0 && n.z <= r.z1) out.push(n);
      }
    return out;
  }

  edgesOfNode(n: WorldNode): EdgeInfo[] {
    let e = this.nodeEdges.get(n.id);
    if (!e) {
      e = edgesOf(this.seed, this.terrain, this, n);
      this.nodeEdges.set(n.id, e);
    }
    return e;
  }

  /** 経路が rect にかかり得る辺（両端の矩形を ROUTE_MARGIN 広げたものが rect と重なる） */
  edgesNear(r: Rect, kind?: "main" | "branch"): EdgeInfo[] {
    const reach = (EDGE_CELL_REACH + 1) * NODE_CELL + ROUTE_MARGIN;
    const seen = new Map<string, EdgeInfo>();
    const cx0 = Math.floor((r.x0 - reach) / NODE_CELL);
    const cx1 = Math.floor((r.x1 + reach) / NODE_CELL);
    const cz0 = Math.floor((r.z0 - reach) / NODE_CELL);
    const cz1 = Math.floor((r.z1 + reach) / NODE_CELL);
    for (let cz = cz0; cz <= cz1; cz++)
      for (let cx = cx0; cx <= cx1; cx++) {
        const n = this.node(cx, cz);
        if (!n) continue;
        for (const e of this.edgesOfNode(n)) {
          if (kind && e.kind !== kind) continue;
          if (seen.has(e.id)) continue;
          const b = edgeRect(e);
          if (b.x1 < r.x0 || b.x0 > r.x1 || b.z1 < r.z0 || b.z0 > r.z1) continue;
          seen.set(e.id, e);
        }
      }
    return [...seen.values()].sort((p, q) => (p.id < q.id ? -1 : p.id > q.id ? 1 : 0));
  }

  /** 格子点の routeHeight（3.2km 角のかたまりで覚える） */
  gridHeight(ix: number, iz: number): number {
    const kx = Math.floor(ix / CHUNK);
    const kz = Math.floor(iz / CHUNK);
    const key = (kx + CHUNK_KEY_OFFSET) * 2097152 + (kz + CHUNK_KEY_OFFSET);
    let c = this.chunks.get(key);
    if (!c) {
      c = new Float64Array(CHUNK * CHUNK);
      for (let j = 0; j < CHUNK; j++)
        for (let i = 0; i < CHUNK; i++)
          c[j * CHUNK + i] = this.terrain.routeHeight((kx * CHUNK + i) * ROUTE_GRID, (kz * CHUNK + j) * ROUTE_GRID);
      this.chunks.set(key, c);
    }
    return c[(iz - kz * CHUNK) * CHUNK + (ix - kx * CHUNK)];
  }

  private routeGrid(r: Rect): RouteGrid {
    const ix0 = Math.floor(r.x0 / ROUTE_GRID);
    const iz0 = Math.floor(r.z0 / ROUTE_GRID);
    const ix1 = Math.ceil(r.x1 / ROUTE_GRID);
    const iz1 = Math.ceil(r.z1 / ROUTE_GRID);
    const w = ix1 - ix0 + 1;
    const h = iz1 - iz0 + 1;
    const heights = new Float64Array(w * h);
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) heights[j * w + i] = this.gridHeight(ix0 + i, iz0 + j);
    return { ix0, iz0, w, h, heights };
  }

  /** 主要道の探索と整形の結果。両端の結節点だけで決まる */
  private rawMain(e: EdgeInfo): MainData {
    let m = this.raws.get(e.id);
    if (m) return m;
    const t0 = now();
    const spec = ROAD_CLASSES[e.cls];
    const grid = this.routeGrid(searchRect(e));
    const res = findRoute(
      grid,
      e.a.x / ROUTE_GRID,
      e.a.z / ROUTE_GRID,
      e.b.x / ROUTE_GRID,
      e.b.z / ROUTE_GRID,
      { ...DEFAULT_ROUTE_PARAMS, maxGrade: spec.maxGrade },
    );
    if (!res) {
      this.failedEdges.add(e.id);
      m = { road: null, cells: null };
    } else {
      const road = this.buildRoad(e.id, e, cellsToPolyline(res.cells), keepFromBridge(res.bridge), e.a.y, e.b.y, e.a.id, e.b.id, "main");
      m = { road, cells: res.cells };
      this.timings.push({ id: e.id, ms: now() - t0, expanded: res.expanded });
    }
    this.raws.set(e.id, m);
    return m;
  }

  /**
   * 主要道。結節点から優先の高い主要道に重なって出る区間は除き、重なりが終わる所でその道へ合流させる
   * （主要道は互いを見ずに引くので、同じ結節点から同じ谷へ出る2本が重なるため。GENERATOR_VERSION 4）。
   * 優先は 等級の高い順、同じ等級なら識別子の順。結節点を共有する主要道だけを見る。
   */
  mainRoad(e: EdgeInfo): MainData {
    let m = this.mains.get(e.id);
    if (m) return m;
    const raw = this.rawMain(e);
    m = raw;
    if (raw.road && raw.cells) {
      const road = raw.road;
      const ca = this.overlapAtNode(e, e.a, road, false);
      const cb = this.overlapAtNode(e, e.b, road, true);
      if (ca || cb) {
        const s0 = ca ? ca.s : 0;
        const s1 = cb ? road.length - cb.s : road.length;
        let piece: Road | null = null;
        if (s1 - s0 > 60) {
          const pa = pointAt(road, s0);
          const pb = pointAt(road, s1);
          const sa = ca ? nearestOnRoad(ca.target, pa.x, pa.z) : null;
          const sb = cb ? nearestOnRoad(cb.target, pb.x, pb.z) : null;
          piece = this.rebuildPiece(e, e.id, "main", road, s0, s1, sa, sb);
        }
        const owners: Road[] = [];
        for (let i = 0; i < raw.cells.length; i += 2) {
          const x = raw.cells[i] * ROUTE_GRID;
          const z = raw.cells[i + 1] * ROUTE_GRID;
          let best: Road | null = piece;
          let bd = piece ? nearestOnRoad(piece, x, z).d2 : Infinity;
          for (const c of [ca, cb]) {
            if (!c) continue;
            const d = nearestOnRoad(c.target, x, z).d2;
            if (d < bd) {
              bd = d;
              best = c.target;
            }
          }
          owners.push(best!);
        }
        m = { road: piece, cells: raw.cells, owners };
      }
    }
    this.mains.set(e.id, m);
    return m;
  }

  /** 結節点 node から出る道路 road が、同じ結節点から出る優先の高い主要道に重なって走る長さ（node の側からの道のり）と、その道路 */
  private overlapAtNode(e: EdgeInfo, node: WorldNode, road: Road, fromEnd: boolean): { s: number; target: Road } | null {
    let best: { s: number; target: Road } | null = null;
    for (const o of this.edgesOfNode(node)) {
      if (o.kind !== "main" || o.id === e.id) continue;
      if (!(o.cls < e.cls || (o.cls === e.cls && o.id < e.id))) continue;
      const t = this.mainRoad(o).road;
      // 相手がこの結節点まで届いていなければ（相手もここで別の道へ合流していれば）見ない
      if (!t || (t.start !== node.id && t.end !== node.id)) continue;
      const s = overlapLength(road, t, fromEnd);
      if (s >= OVERLAP_MIN && (!best || s > best.s || (s === best.s && t.id < best.target.id))) best = { s, target: t };
    }
    return best;
  }

  /** 道路の [s0, s1] の区間を、端を合流先の道路の上に置いて作り直す（端が合流しなければ結節点のまま） */
  private rebuildPiece(e: EdgeInfo, id: string, kind: "main" | "branch", road: Road, s0: number, s1: number, sa: SnapPoint | null, sb: SnapPoint | null): Road | null {
    const pts: number[] = [];
    const keep: number[] = [];
    const startJ = sa ? attachJunction(sa) : { id: e.a.id, y: e.a.y };
    const endJ = sb ? attachJunction(sb) : { id: e.b.id, y: e.b.y };
    if (startJ.id === endJ.id) return null;
    if (sa) pts.push(sa.x, sa.z);
    else pts.push(e.a.x, e.a.z);
    keep.push(0);
    // 合流点の 20m 先からは元の中心線を 10m ごとにたどる
    const a = s0 + (sa ? 20 : 10);
    const b = s1 - (sb ? 20 : 10);
    for (let s = a; s < b; s += 10) {
      const p = pointAt(road, s);
      pts.push(p.x, p.z);
      keep.push(inBridge(road, s) ? 1 : 0);
    }
    if (sb) pts.push(sb.x, sb.z);
    else pts.push(e.b.x, e.b.z);
    keep.push(0);
    const poly = Float64Array.from(pts);
    if (polylineLength(poly) < 30) return null;
    const out = this.buildRoad(id, e, poly, Uint8Array.from(keep), startJ.y, endJ.y, startJ.id, endJ.id, kind);
    this.setAttachments(id, sa, sb);
    return out;
  }

  private setAttachments(id: string, sa: SnapPoint | null, sb: SnapPoint | null) {
    const att: { start?: Attachment; end?: Attachment } = {};
    if (sa && !sa.atEnd) att.start = { road: sa.road.id, s: sa.s };
    if (sb && !sb.atEnd) att.end = { road: sb.road.id, s: sb.s };
    if (att.start || att.end) this.attachments.set(id, att);
  }

  /** 枝道。主要道に重なる区間は主要道を使い、残りを道路の断片として返す */
  branchRoads(e: EdgeInfo): Road[] {
    let out = this.branches.get(e.id);
    if (out) return out;
    out = [];
    const sr = searchRect(e);
    // 探索範囲にかかる主要道
    const mains = this.edgesNear(sr, "main")
      .map((me) => this.mainRoad(me))
      .filter((m) => m.cells !== null && (m.road !== null || m.owners !== undefined));
    const t0 = now();
    const spec = ROAD_CLASSES[e.cls];
    const grid = this.routeGrid(sr);
    const mask = new Uint8Array(grid.w * grid.h);
    const cellRoads = new Map<number, Road[]>();
    for (const m of mains) {
      const cells = m.cells!;
      for (let i = 0; i < cells.length; i += 2) {
        const lx = cells[i] - grid.ix0;
        const lz = cells[i + 1] - grid.iz0;
        if (lx < 0 || lz < 0 || lx >= grid.w || lz >= grid.h) continue;
        const c = lz * grid.w + lx;
        const owner = m.owners ? m.owners[i / 2] : m.road!;
        mask[c] = 1;
        const list = cellRoads.get(c);
        if (list) {
          if (!list.includes(owner)) list.push(owner);
        } else cellRoads.set(c, [owner]);
      }
    }
    grid.mainMask = mask;
    const res = findRoute(
      grid,
      e.a.x / ROUTE_GRID,
      e.a.z / ROUTE_GRID,
      e.b.x / ROUTE_GRID,
      e.b.z / ROUTE_GRID,
      { ...DEFAULT_ROUTE_PARAMS, maxGrade: spec.maxGrade },
    );
    if (!res) {
      this.failedEdges.add(e.id);
      this.branches.set(e.id, out);
      return out;
    }
    const n = res.cells.length / 2;
    const onMain = new Uint8Array(n);
    const local = (i: number) => (res.cells[i * 2 + 1] - grid.iz0) * grid.w + (res.cells[i * 2] - grid.ix0);
    for (let i = 0; i < n; i++) onMain[i] = mask[local(i)];
    // 主要道に乗っていない区間ごとに断片を作る
    let k = 0;
    let i = 0;
    while (i < n) {
      if (onMain[i]) {
        i++;
        continue;
      }
      let j = i;
      while (j < n && !onMain[j]) j++;
      // 断片は [i−1 .. j]（主要道の格子があれば両端に含める）
      const from = i > 0 ? i - 1 : 0;
      const to = j < n ? j : n - 1;
      if (to - from >= 1) {
        const startAttach = i > 0 ? this.snapToMain(res.cells, from, cellRoads.get(local(from))!) : null;
        const endAttach = j < n ? this.snapToMain(res.cells, to, cellRoads.get(local(to))!) : null;
        const piece = this.buildBranchPiece(e, k, res.cells, res.bridge, from, to, startAttach, endAttach);
        if (piece) {
          out.push(piece);
          k++;
        }
      }
      i = j;
    }
    this.timings.push({ id: e.id, ms: now() - t0, expanded: res.expanded });
    this.branches.set(e.id, out);
    return out;
  }

  /** 格子点に最も近い主要道上の点 */
  private snapToMain(cells: Int32Array, idx: number, roads: Road[]): SnapPoint {
    const px = cells[idx * 2] * ROUTE_GRID;
    const pz = cells[idx * 2 + 1] * ROUTE_GRID;
    let best: SnapPoint | null = null;
    for (const r of roads) {
      const p = nearestOnRoad(r, px, pz);
      if (!best || p.d2 < best.d2 || (p.d2 === best.d2 && r.id < best.road.id)) best = p;
    }
    return best!;
  }

  private buildBranchPiece(
    e: EdgeInfo,
    k: number,
    cells: Int32Array,
    bridge: Uint8Array,
    from: number,
    to: number,
    sa: SnapPoint | null,
    sb: SnapPoint | null,
  ): Road | null {
    const pts: number[] = [];
    const keep: number[] = [];
    const startJ = sa ? attachJunction(sa) : { id: e.a.id, y: e.a.y };
    const endJ = sb ? attachJunction(sb) : { id: e.b.id, y: e.b.y };
    if (startJ.id === endJ.id) return null;
    if (sa) pts.push(sa.x, sa.z);
    else pts.push(e.a.x, e.a.z);
    keep.push(0);
    for (let i = from + 1; i < to; i++) {
      pts.push(cells[i * 2] * ROUTE_GRID, cells[i * 2 + 1] * ROUTE_GRID);
      keep.push(bridge[i] || bridge[i + 1] ? 1 : 0);
    }
    if (sb) pts.push(sb.x, sb.z);
    else pts.push(e.b.x, e.b.z);
    keep.push(0);
    const id = `${e.id}#${k}`;
    const poly = Float64Array.from(pts);
    if (polylineLength(poly) < 30) return null;
    const road = this.buildRoad(id, e, poly, Uint8Array.from(keep), startJ.y, endJ.y, startJ.id, endJ.id, "branch");
    // 整形した後も合流先の道路に重なって走る区間があれば、重なりの終わる所で合流させ直す（GENERATOR_VERSION 4）
    const oa = sa ? overlapLength(road, sa.road, false) : 0;
    const ob = sb ? overlapLength(road, sb.road, true) : 0;
    if (oa >= OVERLAP_MIN || ob >= OVERLAP_MIN) {
      const s0 = oa >= OVERLAP_MIN ? oa : 0;
      const s1 = road.length - (ob >= OVERLAP_MIN ? ob : 0);
      if (s1 - s0 <= 60) return null;
      const pa = pointAt(road, s0);
      const pb = pointAt(road, s1);
      const na = sa && oa >= OVERLAP_MIN ? nearestOnRoad(sa.road, pa.x, pa.z) : sa;
      const nb = sb && ob >= OVERLAP_MIN ? nearestOnRoad(sb.road, pb.x, pb.z) : sb;
      return this.rebuildPiece(e, id, "branch", road, s0, s1, na, nb);
    }
    this.setAttachments(id, sa, sb);
    return road;
  }

  private buildRoad(
    id: string,
    e: EdgeInfo,
    raw: Float64Array,
    keep: Uint8Array,
    startY: number,
    endY: number,
    startId: string,
    endId: string,
    kind: "main" | "branch",
  ): Road {
    const spec = ROAD_CLASSES[e.cls];
    const xz = shapeCenterline(raw, keep, spec.minRadius);
    const n = xz.length / 2;
    const routeGround = new Float64Array(n);
    const ground = new Float64Array(n);
    const water = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      const s = this.terrain.sample(xz[i * 2], xz[i * 2 + 1], true);
      routeGround[i] = s.routeHeight;
      ground[i] = s.height;
      water[i] = s.height < 0 ? 1 : 0;
    }
    const y = computeProfile({ xz, routeGround, water, maxGrade: spec.maxGrade, startY, endY });
    const length = polylineLength(xz);
    const ds = n > 1 ? length / (n - 1) : 0;
    const spans = detectBridges(y, ground, water, ds);
    const ox = xz[0];
    const oz = xz[1];
    const points = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      points[i * 3] = xz[i * 2] - ox;
      points[i * 3 + 1] = y[i];
      points[i * 3 + 2] = xz[i * 2 + 1] - oz;
    }
    return {
      id,
      cls: e.cls,
      width: spec.width,
      surface: spec.surface,
      origin: [ox, oz],
      points,
      length,
      spans,
      name: `${e.a.name}${e.b.name}線`,
      kind,
      start: startId,
      end: endId,
    };
  }

  /** rect にかかる道路（主要道と枝道の断片） */
  roadsInRect(r: Rect): Road[] {
    const out: Road[] = [];
    const edges = this.edgesNear(r);
    for (const e of edges) if (e.kind === "main") {
      const m = this.mainRoad(e);
      if (m.road) out.push(m.road);
    }
    for (const e of edges) if (e.kind === "branch") out.push(...this.branchRoads(e));
    return out.filter((road) => roadIntersectsRect(road, r));
  }

  poisOf(road: Road): Poi[] {
    let p = this.poiCache.get(road.id);
    if (!p) {
      p = pickPois(this, road);
      this.poiCache.set(road.id, p);
    }
    return p;
  }

  /**
   * 結節点が峠になる場合（その結節点から出る主要道のうち2本以上が 100m 以上下る）。
   * 道路の縦断の極大が道路の端（結節点）にある時、道路ごとの判定では見つからないため。
   */
  nodePois(n: WorldNode): Poi[] {
    const key = `node:${n.id}`;
    let p = this.poiCache.get(key);
    if (p) return p;
    p = [];
    const descents: { road: Road; s: number }[] = [];
    for (const e of this.edgesOfNode(n)) {
      if (e.kind !== "main") continue;
      const road = this.mainRoad(e).road;
      if (!road || (road.start !== n.id && road.end !== n.id)) continue;
      const atStart = road.start === n.id;
      const cnt = road.points.length / 3;
      let lo = n.y;
      for (let k = 0; k < cnt; k++) {
        const y = road.points[(atStart ? k : cnt - 1 - k) * 3 + 1];
        if (y > n.y + 1) break;
        if (y < lo) lo = y;
        if (n.y - lo >= PASS_PROMINENCE) break;
      }
      if (n.y - lo >= PASS_PROMINENCE) descents.push({ road, s: atStart ? 0 : road.length });
    }
    if (descents.length >= 2) {
      descents.sort((a, b) => (a.road.id < b.road.id ? -1 : 1));
      const d = descents[0];
      p.push({ id: `p_${n.id}`, kind: "pass", road: d.road.id, s: d.s, side: 1, name: passName(this.seed, n.cx, n.cz) });
      p.push({ id: `v_${n.id}`, kind: "viewpoint", road: d.road.id, s: d.s, side: -1, name: viewpointName(this.seed, n.cx, n.cz) });
    }
    this.poiCache.set(key, p);
    return p;
  }

  /** rect にかかる世界のデータ一式 */
  region(r: Rect): { nodes: WorldNode[]; roads: Road[]; junctions: Junction[]; pois: Poi[]; crossings: CrossingInfo[] } {
    const roads = this.roadsInRect(r);
    const { junctions, crossings } = buildJunctions(this, roads);
    const nodes = this.nodesInRect(r);
    const pois = [...roads.flatMap((road) => this.poisOf(road)), ...nodes.flatMap((n) => this.nodePois(n))];
    return { nodes, roads, junctions, pois, crossings };
  }
}

export interface SnapPoint {
  road: Road;
  s: number;
  x: number;
  y: number;
  z: number;
  d2: number;
  /** 道路の端（結節点）に当たる */
  atEnd: boolean;
}

/** 重なりとみなす最短の長さ (m) */
const OVERLAP_MIN = 20;

/**
 * 道路 road が端（fromEnd なら終点側）から道路 t に重なって走る長さ。
 * 重なり = 中心線の距離が 2本の幅の半分の和 + 2m 以内。離れても 40m 以内なら重なりの続きとみなす（浅い角度で交わり直すため）。
 */
function overlapLength(road: Road, t: Road, fromEnd: boolean): number {
  const thr = (road.width + t.width) / 2 + 2;
  const n = road.points.length / 3;
  const ds = road.length / (n - 1);
  let last = -1;
  for (let k = 0; k < n; k += 2) {
    const i = fromEnd ? n - 1 - k : k;
    const p = pointAt(road, i * ds);
    const d2 = nearestOnRoad(t, p.x, p.z).d2;
    if (d2 <= thr * thr) last = k;
    else if (d2 > 1600) break;
  }
  return last > 0 ? last * ds : 0;
}

function attachJunction(p: SnapPoint): { id: string; y: number } {
  if (p.atEnd) return { id: p.s < 1 ? p.road.start : p.road.end, y: p.y };
  return { id: mergeJunctionId(p.road.id, p.s), y: p.y };
}

export function mergeJunctionId(roadId: string, s: number): string {
  return `j_${roadId}_${Math.round(s * 10)}`;
}

/** 道路上で (px, pz) に最も近い点 */
export function nearestOnRoad(r: Road, px: number, pz: number): SnapPoint {
  const P = r.points;
  const n = P.length / 3;
  const ox = r.origin[0];
  const oz = r.origin[1];
  const ds = n > 1 ? r.length / (n - 1) : 0;
  let best = { d2: Infinity, i: 0, t: 0 };
  for (let i = 0; i < n - 1; i++) {
    const ax = P[i * 3] + ox;
    const az = P[i * 3 + 2] + oz;
    const bx = P[i * 3 + 3] + ox;
    const bz = P[i * 3 + 5] + oz;
    const vx = bx - ax;
    const vz = bz - az;
    const vv = vx * vx + vz * vz;
    let t = vv > 0 ? ((px - ax) * vx + (pz - az) * vz) / vv : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const qx = ax + vx * t - px;
    const qz = az + vz * t - pz;
    const d2 = qx * qx + qz * qz;
    if (d2 < best.d2) best = { d2, i, t };
  }
  let s = (best.i + best.t) * ds;
  // 端から 1 点以内なら端に寄せる（結節点の接続点を使う）
  let atEnd = false;
  if (s <= ds * 1.01) {
    s = 0;
    atEnd = true;
  } else if (s >= r.length - ds * 1.01) {
    s = r.length;
    atEnd = true;
  }
  const at = pointAt(r, s);
  return { road: r, s, x: at.x, y: at.y, z: at.z, d2: best.d2, atEnd };
}

/** 道のり s の位置（世界座標） */
export function pointAt(r: Road, s: number): { x: number; y: number; z: number } {
  const P = r.points;
  const n = P.length / 3;
  const ds = n > 1 ? r.length / (n - 1) : 1;
  let f = s / ds;
  if (f < 0) f = 0;
  if (f > n - 1) f = n - 1;
  const i = Math.min(n - 2, Math.floor(f));
  const t = f - i;
  return {
    x: r.origin[0] + P[i * 3] + (P[i * 3 + 3] - P[i * 3]) * t,
    y: P[i * 3 + 1] + (P[i * 3 + 4] - P[i * 3 + 1]) * t,
    z: r.origin[1] + P[i * 3 + 2] + (P[i * 3 + 5] - P[i * 3 + 2]) * t,
  };
}

export function roadBounds(r: Road): Rect {
  let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
  const P = r.points;
  for (let i = 0; i < P.length; i += 3) {
    const x = P[i] + r.origin[0];
    const z = P[i + 2] + r.origin[1];
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (z < z0) z0 = z;
    if (z > z1) z1 = z;
  }
  return { x0, z0, x1, z1 };
}

function roadIntersectsRect(road: Road, r: Rect): boolean {
  const b = roadBounds(road);
  return !(b.x1 < r.x0 || b.x0 > r.x1 || b.z1 < r.z0 || b.z0 > r.z1);
}

function edgeRect(e: EdgeInfo): Rect {
  return searchRect(e);
}

/** 経路探索の範囲（両端を含む矩形を ROUTE_MARGIN 広げる） */
export function searchRect(e: EdgeInfo): Rect {
  return {
    x0: Math.min(e.a.x, e.b.x) - ROUTE_MARGIN,
    z0: Math.min(e.a.z, e.b.z) - ROUTE_MARGIN,
    x1: Math.max(e.a.x, e.b.x) + ROUTE_MARGIN,
    z1: Math.max(e.a.z, e.b.z) + ROUTE_MARGIN,
  };
}

function cellsToPolyline(cells: Int32Array): Float64Array {
  const out = new Float64Array(cells.length);
  for (let i = 0; i < cells.length; i++) out[i] = cells[i] * ROUTE_GRID;
  return out;
}

/** 橋の移動の両端は間引かない */
function keepFromBridge(bridge: Uint8Array): Uint8Array {
  const n = bridge.length;
  const keep = new Uint8Array(n);
  for (let i = 1; i < n; i++)
    if (bridge[i]) {
      keep[i] = 1;
      keep[i - 1] = 1;
    }
  return keep;
}

export interface CrossingInfo {
  id: string;
  a: string;
  b: string;
  sa: number;
  sb: number;
  /** 2本の路面の高さの差 */
  dy: number;
  /** どちらかが橋で、立体交差として接続しない */
  separated: boolean;
}

function inBridge(r: Road, s: number): boolean {
  for (const sp of r.spans) if (s >= sp.from - 1 && s <= sp.to + 1) return true;
  return false;
}

/** 接続点を組み立てる: 結節点、枝道の合流・分岐点、道路どうしの交差 */
export function buildJunctions(world: World, roads: Road[]): { junctions: Junction[]; crossings: CrossingInfo[] } {
  const map = new Map<string, Junction>();
  const byId = new Map(roads.map((r) => [r.id, r]));
  const add = (id: string, x: number, y: number, z: number, arm: Junction["arms"][number], node?: string) => {
    let j = map.get(id);
    if (!j) {
      j = { id, x, y, z, arms: [] };
      if (node) j.node = node;
      map.set(id, j);
    }
    if (!j.arms.some((a) => a.road === arm.road && a.s === arm.s && a.dir === arm.dir)) j.arms.push(arm);
  };
  for (const r of roads) {
    const a = pointAt(r, 0);
    const b = pointAt(r, r.length);
    add(r.start, a.x, a.y, a.z, { road: r.id, s: 0, dir: 1 }, r.start.startsWith("n_") ? r.start : undefined);
    add(r.end, b.x, b.y, b.z, { road: r.id, s: r.length, dir: -1 }, r.end.startsWith("n_") ? r.end : undefined);
    const att = world.attachments.get(r.id);
    for (const at of [att?.start, att?.end]) {
      if (!at) continue;
      const main = byId.get(at.road);
      if (!main) continue;
      const jid = mergeJunctionId(at.road, at.s);
      const p = pointAt(main, at.s);
      add(jid, p.x, p.y, p.z, { road: main.id, s: at.s, dir: 1 });
      add(jid, p.x, p.y, p.z, { road: main.id, s: at.s, dir: -1 });
    }
  }
  const crossings = findCrossings(roads);
  for (const c of crossings) {
    if (c.separated) continue;
    const ra = byId.get(c.a)!;
    const rb = byId.get(c.b)!;
    const p = pointAt(ra, c.sa);
    add(c.id, p.x, p.y, p.z, { road: ra.id, s: c.sa, dir: 1 });
    add(c.id, p.x, p.y, p.z, { road: ra.id, s: c.sa, dir: -1 });
    add(c.id, p.x, p.y, p.z, { road: rb.id, s: c.sb, dir: 1 });
    add(c.id, p.x, p.y, p.z, { road: rb.id, s: c.sb, dir: -1 });
  }
  // 道路の端にある腕は外向きだけにする（s=0 で dir −1、s=L で dir +1 は出られない）
  for (const j of map.values()) {
    j.arms = j.arms.filter((a) => {
      const r = byId.get(a.road);
      if (!r) return true;
      if (a.s <= 0 && a.dir === -1) return false;
      if (a.s >= r.length && a.dir === 1) return false;
      return true;
    });
  }
  const junctions = [...map.values()].sort((p, q) => (p.id < q.id ? -1 : 1));
  return { junctions, crossings };
}

/** 別々の道路が交わる所（端の付近は除く） */
export function findCrossings(roads: Road[]): CrossingInfo[] {
  const CELL = 64;
  const grid = new Map<string, { r: number; i: number }[]>();
  const W: { ax: number; az: number; bx: number; bz: number }[][] = [];
  roads.forEach((road, ri) => {
    const P = road.points;
    const n = P.length / 3;
    const segs: { ax: number; az: number; bx: number; bz: number }[] = [];
    for (let i = 0; i < n - 1; i++) {
      const ax = P[i * 3] + road.origin[0];
      const az = P[i * 3 + 2] + road.origin[1];
      const bx = P[i * 3 + 3] + road.origin[0];
      const bz = P[i * 3 + 5] + road.origin[1];
      segs.push({ ax, az, bx, bz });
      const gx0 = Math.floor(Math.min(ax, bx) / CELL);
      const gx1 = Math.floor(Math.max(ax, bx) / CELL);
      const gz0 = Math.floor(Math.min(az, bz) / CELL);
      const gz1 = Math.floor(Math.max(az, bz) / CELL);
      for (let gz = gz0; gz <= gz1; gz++)
        for (let gx = gx0; gx <= gx1; gx++) {
          const k = `${gx},${gz}`;
          const l = grid.get(k);
          if (l) l.push({ r: ri, i });
          else grid.set(k, [{ r: ri, i }]);
        }
    }
    W.push(segs);
  });
  const found = new Map<string, CrossingInfo>();
  for (const list of grid.values()) {
    for (let p = 0; p < list.length; p++)
      for (let q = p + 1; q < list.length; q++) {
        let A = list[p];
        let B = list[q];
        if (A.r === B.r) continue;
        if (roads[A.r].id > roads[B.r].id) [A, B] = [B, A];
        const key = `${A.r}:${A.i}:${B.r}:${B.i}`;
        if (found.has(key)) continue;
        const s1 = W[A.r][A.i];
        const s2 = W[B.r][B.i];
        const hit = segIntersect(s1.ax, s1.az, s1.bx, s1.bz, s2.ax, s2.az, s2.bx, s2.bz);
        if (!hit) continue;
        const ra = roads[A.r];
        const rb = roads[B.r];
        const dsa = ra.length / (ra.points.length / 3 - 1);
        const dsb = rb.length / (rb.points.length / 3 - 1);
        const sa = (A.i + hit.t) * dsa;
        const sb = (B.i + hit.u) * dsb;
        // 端の近く（合流・結節点）は接続点が別にある
        if (sa < 4 || sa > ra.length - 4 || sb < 4 || sb > rb.length - 4) continue;
        const ya = pointAt(ra, sa).y;
        const yb = pointAt(rb, sb).y;
        found.set(key, {
          id: `x_${ra.id}_${rb.id}_${Math.round(sa)}`,
          a: ra.id,
          b: rb.id,
          sa,
          sb,
          dy: Math.abs(ya - yb),
          separated: inBridge(ra, sa) || inBridge(rb, sb),
        });
      }
  }
  return [...found.values()].sort((p, q) => (p.id < q.id ? -1 : 1));
}

function segIntersect(
  ax: number, az: number, bx: number, bz: number,
  cx: number, cz: number, dx: number, dz: number,
): { t: number; u: number } | null {
  const rx = bx - ax, rz = bz - az;
  const sx = dx - cx, sz = dz - cz;
  const den = rx * sz - rz * sx;
  if (den === 0) return null;
  const qx = cx - ax, qz = cz - az;
  const t = (qx * sz - qz * sx) / den;
  const u = (qx * rz - qz * rx) / den;
  if (t < 0 || t >= 1 || u < 0 || u >= 1) return null;
  return { t, u };
}

/** 道路の識別子から作る種 */
export function roadSeed(seed: number, id: string): number {
  return (seed * 31 + hashString(id)) | 0;
}
