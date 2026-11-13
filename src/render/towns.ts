// 町・集落の建物と喫茶店の配置を、周りの道路が読み込まれてから一度だけ求めて覚える（モック仕様 5.4）。
// 地形の Worker には、植生を置かない敷地（円）を渡す。

import type { Terrain } from "../shared/world/terrain.ts";
import type { Rect } from "../shared/world/world.ts";
import type { RoadClient } from "../workers/road-client.ts";
import { type Building, type Cafe, layoutCafe, layoutTown, type Lot, lotsOf, RoadIndex } from "./town-layout.ts";

/** 町の建物を並べる最大の半径 + 余裕 (m) */
const TOWN_REACH = 640;

interface TownEntry {
  node: string;
  x: number;
  z: number;
  buildings: Building[];
  lots: Lot[];
}

interface CafeEntry {
  cafe: Cafe | null;
  lots: Lot[];
}

export class Towns {
  private towns = new Map<string, TownEntry>();
  private cafes = new Map<string, CafeEntry>();
  /** 町や店が増えるたびに増える */
  version = 0;

  constructor(
    private seed: number,
    private roads: RoadClient,
    private terrain: Terrain,
  ) {}

  /** 周りの道路が読み込み済みか（敷地が決められるか） */
  ready(r: Rect): boolean {
    const m = TOWN_REACH + 100;
    return this.roads.ready({ x0: r.x0 - m, z0: r.z0 - m, x1: r.x1 + m, z1: r.z1 + m });
  }

  private roadsIn(r: Rect) {
    const out = [];
    for (const e of this.roads.roadEntries()) {
      const b = e.bounds;
      if (b.x1 < r.x0 || b.x0 > r.x1 || b.z1 < r.z0 || b.z0 > r.z1) continue;
      out.push(e.road);
    }
    return out;
  }

  /** 喫茶店（求められなければ null） */
  cafe(poiId: string): Cafe | null {
    const hit = this.cafes.get(poiId);
    if (hit) return hit.cafe;
    const poi = this.roads.pois.get(poiId);
    if (!poi || poi.kind !== "cafe") return null;
    const road = this.roads.net.roads.get(poi.road);
    if (!road) return null;
    const n = road.points.length / 3;
    const i = Math.max(0, Math.min(n - 1, Math.round(poi.s / (road.length / (n - 1)))));
    const x = road.points[i * 3] + road.origin[0];
    const z = road.points[i * 3 + 2] + road.origin[1];
    const rect = { x0: x - 80, z0: z - 80, x1: x + 80, z1: z + 80 };
    if (!this.roads.ready(rect)) return null;
    const idx = new RoadIndex(this.roadsIn(rect));
    const cafe = layoutCafe(poi, road, idx, (px, pz) => this.terrain.height(px, pz));
    this.cafes.set(poiId, { cafe, lots: cafe ? lotsOf([], [cafe]) : [] });
    this.version++;
    return cafe;
  }

  /** 結節点の町・集落の建物（求められなければ null） */
  town(nodeId: string): TownEntry | null {
    const hit = this.towns.get(nodeId);
    if (hit) return hit;
    const node = this.roads.net.nodes.get(nodeId);
    if (!node) return null;
    const rect = { x0: node.x - TOWN_REACH, z0: node.z - TOWN_REACH, x1: node.x + TOWN_REACH, z1: node.z + TOWN_REACH };
    if (!this.roads.ready(rect)) return null;
    // 範囲の喫茶店を先に置き、建物はそれを避ける
    const cafes: Cafe[] = [];
    for (const p of this.roads.pois.values()) {
      if (p.kind !== "cafe") continue;
      const c = this.cafe(p.id);
      if (c && Math.abs(c.x - node.x) < TOWN_REACH + 30 && Math.abs(c.z - node.z) < TOWN_REACH + 30) cafes.push(c);
    }
    const roads = this.roadsIn({ x0: rect.x0 - 60, z0: rect.z0 - 60, x1: rect.x1 + 60, z1: rect.z1 + 60 });
    const idx = new RoadIndex(roads);
    const buildings = layoutTown(this.seed, node, roads, idx, (px, pz) => this.terrain.height(px, pz), cafes);
    const e: TownEntry = { node: nodeId, x: node.x, z: node.z, buildings, lots: lotsOf(buildings, []) };
    this.towns.set(nodeId, e);
    this.version++;
    return e;
  }

  /** (x, z) から range 以内の町（求められたものだけ） */
  townsNear(x: number, z: number, range: number): TownEntry[] {
    const out: TownEntry[] = [];
    for (const n of this.roads.net.nodes.values()) {
      if (n.kind === "junction") continue;
      if (Math.abs(n.x - x) > range + TOWN_REACH || Math.abs(n.z - z) > range + TOWN_REACH) continue;
      const t = this.town(n.id);
      if (t && t.buildings.length) out.push(t);
    }
    return out.sort((a, b) => (a.node < b.node ? -1 : 1));
  }

  /** (x, z) から range 以内の喫茶店 */
  cafesNear(x: number, z: number, range: number): Cafe[] {
    const out: Cafe[] = [];
    for (const p of this.roads.pois.values()) {
      if (p.kind !== "cafe") continue;
      const c = this.cafe(p.id);
      if (!c) continue;
      if (Math.abs(c.x - x) > range || Math.abs(c.z - z) > range) continue;
      out.push(c);
    }
    return out.sort((a, b) => (a.poi.id < b.poi.id ? -1 : 1));
  }

  /** 矩形にかかる敷地を、矩形の左上からの相対で [x, z, r, ...] にする */
  lotsIn(r: Rect): Float32Array {
    const cx = (r.x0 + r.x1) / 2, cz = (r.z0 + r.z1) / 2;
    const half = Math.max(r.x1 - r.x0, r.z1 - r.z0) / 2;
    const out: number[] = [];
    const add = (lots: Lot[]) => {
      for (const l of lots) if (l.x + l.r >= r.x0 && l.x - l.r <= r.x1 && l.z + l.r >= r.z0 && l.z - l.r <= r.z1) out.push(l.x - r.x0, l.z - r.z0, l.r);
    };
    for (const t of this.townsNear(cx, cz, half)) add(t.lots);
    for (const c of this.cafesNear(cx, cz, half + 40)) add(this.cafes.get(c.poi.id)?.lots ?? []);
    return Float32Array.from(out);
  }

  /** 遠くなったものを忘れる（走り続けてもメモリが増えないように） */
  prune(x: number, z: number, keep: number) {
    for (const [id, t] of this.towns) if (Math.abs(t.x - x) > keep || Math.abs(t.z - z) > keep) this.towns.delete(id);
    for (const [id, c] of this.cafes) {
      const p = c.cafe;
      if (!p || Math.abs(p.x - x) > keep || Math.abs(p.z - z) > keep) this.cafes.delete(id);
    }
  }
}
