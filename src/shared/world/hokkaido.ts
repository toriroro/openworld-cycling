// 北海道の世界（北海道の草案 2.2）。事前に変換したデータ（scripts/hokkaido/）を読み、
// 生成の世界の Terrain・World と同じ窓口で高さ・水・景観・道路を返す。
// データの取得（fetch）は呼ぶ側（Worker）が行い、ここには ArrayBuffer を渡す。DOM・三角関数を使わない（モック 4.2）。

import { smoothstep } from "./noise.ts";
import type { LandscapeWeights, TerrainSample } from "./terrain.ts";
import type { Junction, Poi, RailLine, Road, RoadClass, Span, WorldNode } from "./types.ts";
import type { CrossingInfo, Rect } from "./world.ts";

/** 保存データの generator に入れる値。道路の識別子が変わる変換をしたら上げる（走った区間・続きからの位置が道路の識別子を使うため） */
export const HOKKAIDO_GENERATOR = 1001;
/** 変換データの置き場（H0） */
export const HOKKAIDO_BASE = "/data/hokkaido/h0/";

/** 水の格子の値（TerrainSample.water と同じ番号） */
export const HOKKAIDO_WATER = { sea: 1, lake: 2, river: 3 } as const;
/** 土地利用の格子の値 */
export const HOKKAIDO_LANDUSE = { urban: 1, farm: 2, forest: 3, open: 4 } as const;

export interface HokkaidoRoadMeta {
  id: string;
  cls: RoadClass;
  width: number;
  surface: "paved" | "gravel";
  name: string;
  kind: "main" | "branch" | "cycleway";
  start: string;
  end: string;
  spans: Span[];
  origin: [number, number];
  length: number;
  /** roads.bin の中の位置（Float32 の個数）と点の数 */
  offset: number;
  count: number;
  minor: boolean;
  oneway: boolean;
  ways: number[];
}

export interface HokkaidoMeta {
  version: 1;
  area: string;
  attribution: string[];
  builtAt: string;
  /** terrain.bin の格子: 高さ Int16（0.1m）nx·nz 個、続けて水 Uint8、土地利用 Uint8 */
  grid: { x0: number; z0: number; step: number; nx: number; nz: number };
  roads: HokkaidoRoadMeta[];
  junctions: Junction[];
  nodes: WorldNode[];
  pois: Poi[];
}

export class HokkaidoTerrain {
  private readonly h: Int16Array;
  private readonly water: Uint8Array;
  private readonly landuse: Uint8Array;
  /** 建物の込み具合 0〜255（北海道の草案 19 章。古い変換データには無い） */
  private readonly density: Uint8Array | null;
  /** 店・ビル・集合住宅の込み具合 0〜255（北海道の草案 19 章） */
  private readonly commercial: Uint8Array | null;
  private readonly g: HokkaidoMeta["grid"];

  /** seed は植生・地面の模様の乱数に使う（地形には使わない） */
  constructor(grid: HokkaidoMeta["grid"], terrain: ArrayBuffer, readonly seed: number) {
    this.g = grid;
    const n = this.g.nx * this.g.nz;
    this.h = new Int16Array(terrain, 0, n);
    this.water = new Uint8Array(terrain, n * 2, n);
    this.landuse = new Uint8Array(terrain, n * 3, n);
    this.density = terrain.byteLength >= n * 5 ? new Uint8Array(terrain, n * 4, n) : null;
    this.commercial = terrain.byteLength >= n * 6 ? new Uint8Array(terrain, n * 5, n) : null;
  }

  /** データの範囲の内か */
  inside(x: number, z: number): boolean {
    const g = this.g;
    return x >= g.x0 && z >= g.z0 && x <= g.x0 + (g.nx - 1) * g.step && z <= g.z0 + (g.nz - 1) * g.step;
  }

  height(x: number, z: number): number {
    const g = this.g;
    const fx = (x - g.x0) / g.step;
    const fz = (z - g.z0) / g.step;
    if (fx < 0 || fz < 0 || fx > g.nx - 1 || fz > g.nz - 1) return 0;
    const i = Math.min(g.nx - 2, Math.floor(fx));
    const j = Math.min(g.nz - 2, Math.floor(fz));
    const u = fx - i;
    const v = fz - j;
    const k = j * g.nx + i;
    const h = this.h;
    return ((h[k] * (1 - u) + h[k + 1] * u) * (1 - v) + (h[k + g.nx] * (1 - u) + h[k + g.nx + 1] * u) * v) * 0.1;
  }

  routeHeight(x: number, z: number): number {
    return this.height(x, z);
  }

  /** 周囲 (±r m) の傾斜 */
  slope(x: number, z: number, r = 100): number {
    const gx = (this.height(x + r, z) - this.height(x - r, z)) / (2 * r);
    const gz = (this.height(x, z + r) - this.height(x, z - r)) / (2 * r);
    return Math.sqrt(gx * gx + gz * gz);
  }

  private nearest(arr: Uint8Array, x: number, z: number): number {
    const g = this.g;
    const i = Math.round((x - g.x0) / g.step);
    const j = Math.round((z - g.z0) / g.step);
    if (i < 0 || j < 0 || i >= g.nx || j >= g.nz) return 0;
    return arr[j * g.nx + i];
  }

  sample(x: number, z: number, _withDetail: boolean): TerrainSample {
    const height = this.height(x, z);
    const w = this.nearest(this.water, x, z) as TerrainSample["water"];
    return {
      height,
      routeHeight: height,
      mountain: smoothstep(320, 480, height),
      water: w,
      waterLevel: w ? height : 0,
      floodplain: false,
      plainGap: Infinity,
      riverNear: w === HOKKAIDO_WATER.river ? 0 : Infinity,
      riverHalf: 0,
    };
  }

  /** 建物の込み具合 0〜1（周り 110m 四方の建物の床面積の割合） */
  coverage(x: number, z: number): number {
    return this.density ? this.nearest(this.density, x, z) / 255 : 0;
  }

  /** 店・ビル・集合住宅の込み具合 0〜1 */
  commercialCoverage(x: number, z: number): number {
    return this.commercial ? this.nearest(this.commercial, x, z) / 255 : 0;
  }

  /**
   * 景観の重み（北海道の草案 19 章）。
   * - 店・ビル・集合住宅の込み具合 0.12〜0.22 以上（街の中心）: 舗装の地面（urban）。植生・農地なし（街路樹は歩道に別に植える）
   * - 建物の込み具合 0.06 以上（家の多い所・郊外）: 草地と、まばらな木・低木（plain と other）。農地にしない（town）
   * - それ以外: 土地利用があればそれ、無ければ高さで決める（平らな低地は草地・農地）
   */
  landscape(x: number, z: number): LandscapeWeights {
    const h = this.height(x, z);
    const lu = this.nearest(this.landuse, x, z);
    const mountain = smoothstep(320, 480, h);
    // 川・湖（3D の水面は R2 と共通で、まだ無い）は草地の色にする（市街地にしない）
    if (this.nearest(this.water, x, z)) return { coast: 0, plain: 0, mountain: 0, other: 1, town: 1 };
    const c = this.coverage(x, z);
    const town = lu === HOKKAIDO_LANDUSE.forest || lu === HOKKAIDO_LANDUSE.farm ? 0 : smoothstep(0.03, 0.06, c);
    if (town > 0 && lu !== HOKKAIDO_LANDUSE.forest && lu !== HOKKAIDO_LANDUSE.farm) {
      const urban = smoothstep(0.12, 0.22, this.commercialCoverage(x, z));
      const rest = 1 - urban;
      return { coast: 0, plain: rest * 0.7 * (1 - mountain), mountain: rest * mountain, other: rest * 0.3 * (1 - mountain), urban, town };
    }
    if (lu === HOKKAIDO_LANDUSE.urban) return { coast: 0, plain: 0.7, mountain: 0, other: 0.3, town: 1 };
    if (lu === HOKKAIDO_LANDUSE.farm) return { coast: 0, plain: 1 - mountain, mountain, other: 0 };
    if (lu === HOKKAIDO_LANDUSE.open) return { coast: 0, plain: 0, mountain, other: 1 - mountain };
    if (lu === HOKKAIDO_LANDUSE.forest) {
      const m = smoothstep(250, 450, h);
      return { coast: 0, plain: 0, mountain: m, other: 1 - m };
    }
    const plain = (1 - smoothstep(90, 160, h)) * (1 - smoothstep(0.06, 0.12, this.slope(x, z, 40))) * (1 - mountain);
    return { coast: 0, plain, mountain, other: Math.max(0, 1 - plain - mountain) };
  }
}

export class HokkaidoWorld {
  readonly terrain: HokkaidoTerrain;
  readonly meta: HokkaidoMeta;
  private readonly roads: { road: Road; bounds: Rect }[];
  private readonly junctions: Map<string, Junction>;
  /** 生成の世界と同じ形にそろえる（生成の時間は無い） */
  readonly timings: { id: string; ms: number }[] = [];
  /** 建物（メインスレッドで読んだ時だけ。北海道の草案 15 章） */
  buildings: HokkaidoBuildings | null = null;
  /** 走らない道（メインスレッドで読んだ時だけ。北海道の草案 17 章） */
  streets: HokkaidoStreets | null = null;
  /** 幹線の歩道と街路樹（メインスレッドで読んだ時だけ。北海道の草案 19 章） */
  sidewalks: HokkaidoSidewalks | null = null;
  /** 鉄道は北海道ではまだ出さない */
  readonly rail = { inRect: (_r: Rect): RailLine[] => [] };

  constructor(meta: HokkaidoMeta, terrain: ArrayBuffer, roads: ArrayBuffer, seed: number) {
    this.meta = meta;
    this.terrain = new HokkaidoTerrain(meta.grid, terrain, seed);
    const all = new Float32Array(roads);
    this.roads = meta.roads.map((m) => {
      const road: Road = {
        id: m.id,
        cls: m.cls,
        width: m.width,
        surface: m.surface,
        origin: m.origin,
        points: all.subarray(m.offset, m.offset + m.count * 3),
        length: m.length,
        spans: m.spans,
        name: m.name,
        kind: m.kind,
        start: m.start,
        end: m.end,
      };
      let x0 = Infinity;
      let z0 = Infinity;
      let x1 = -Infinity;
      let z1 = -Infinity;
      for (let i = 0; i < m.count; i++) {
        const x = road.points[i * 3] + m.origin[0];
        const z = road.points[i * 3 + 2] + m.origin[1];
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (z < z0) z0 = z;
        if (z > z1) z1 = z;
      }
      const pad = m.width;
      return { road, bounds: { x0: x0 - pad, z0: z0 - pad, x1: x1 + pad, z1: z1 + pad } };
    });
    this.junctions = new Map(meta.junctions.map((j) => [j.id, j]));
  }

  prune(_keep: Rect) {
    // 全部を読んだまま持つ（H0 は約 20km 四方なので小さい。H3 でタイルごとの読み書きにする）
  }

  roadsInRect(r: Rect): Road[] {
    return this.roads.filter(({ bounds: b }) => b.x1 >= r.x0 && b.x0 <= r.x1 && b.z1 >= r.z0 && b.z0 <= r.z1).map((e) => e.road);
  }

  region(r: Rect): { nodes: WorldNode[]; roads: Road[]; junctions: Junction[]; pois: Poi[]; crossings: CrossingInfo[] } {
    const roads = this.roadsInRect(r);
    const ids = new Set(roads.map((x) => x.id));
    const jids = new Set<string>();
    for (const x of roads) {
      jids.add(x.start);
      jids.add(x.end);
    }
    const junctions = [...jids].map((id) => this.junctions.get(id)).filter((j): j is Junction => !!j);
    const nodes = this.meta.nodes.filter((n) => n.x >= r.x0 && n.x <= r.x1 && n.z >= r.z0 && n.z <= r.z1);
    const pois = this.meta.pois.filter((p) => ids.has(p.road));
    return { nodes, roads, junctions, pois, crossings: [] };
  }
}

// ---- 建物（北海道の草案 15 章）。buildings.bin は区画の順に並べた Float32 の記録 ----

/** 1 棟の記録の長さ（Float32 の個数） */
export const BUILDING_REC = 16;
/**
 * 記録の並び: 0 x, 1 z, 2 幅, 3 奥行き, 4 壁の高さ, 5 幅の向き, 6 地面の低い所, 7 地面の高い所, 8 前の道路の高さ, 9 前の道路までの間, 10 道路の側 (±1),
 * 11 階数, 12 型（BUILDING_STYLES の番号）, 13 屋根（BUILDING_ROOFS の番号）, 14 印（1 瓦, 2 塗り壁, 4 1 階が店）, 15 種
 */
export const BUILDING_STYLES = ["house", "oldhouse", "apartment", "mansion", "shop", "oldshop", "tenant", "strip"] as const;
export const BUILDING_ROOFS = ["gable", "hip", "shed", "flat"] as const;

export interface HokkaidoBuildingIndex {
  /** 区画の一辺 (m) */
  cell: number;
  rec: number;
  /** "cx,cz" → [最初の記録の番号, 数] */
  cells: Record<string, [number, number]>;
}

/** 建物の記録を区画ごとに引く（描画の側で town-layout の Building に直す） */
export class HokkaidoBuildings {
  readonly data: Float32Array;
  constructor(
    readonly index: HokkaidoBuildingIndex,
    buf: ArrayBuffer,
  ) {
    this.data = new Float32Array(buf);
  }
  get count(): number {
    return this.data.length / BUILDING_REC;
  }
  /** 区画 (cx, cz) の記録の範囲 */
  cell(cx: number, cz: number): [number, number] | null {
    return this.index.cells[`${cx},${cz}`] ?? null;
  }
}

// ---- 走らない道（見た目だけ。北海道の草案 17 章）。streets.bin は折れ線の [x, z] の並び（高さは描く側が地形から取る） ----

export const HOKKAIDO_STREET_KINDS = ["street", "path"] as const;

export interface HokkaidoStreetIndex {
  /** 区画の一辺 (m) */
  cell: number;
  kinds: string[];
  /** "cx,cz" → [最初の点の番号, 点の数, 幅 × 10, 種類] の並び */
  pieces: Record<string, [number, number, number, number][]>;
}

export class HokkaidoStreets {
  readonly pts: Float32Array;
  constructor(
    readonly index: HokkaidoStreetIndex,
    buf: ArrayBuffer,
  ) {
    this.pts = new Float32Array(buf);
  }
  cell(cx: number, cz: number): [number, number, number, number][] | null {
    return this.index.pieces[`${cx},${cz}`] ?? null;
  }
}

// ---- 幹線の歩道と街路樹（北海道の草案 19 章）。sidewalks.bin は点ごとに [内側 x, z, 外側 x, z, 高さ]、trees.bin は [x, y, z, 大きさ, 向き] ----

export interface HokkaidoSidewalkIndex {
  cell: number;
  /** 点 1 つの数（5） */
  rec: number;
  /** "cx,cz" → [最初の点の番号, 点の数] の並び */
  sidewalks: Record<string, [number, number][]>;
  /** "cx,cz" → 木の番号の並び */
  trees: Record<string, number[]>;
}

export class HokkaidoSidewalks {
  readonly pts: Float32Array;
  readonly trees: Float32Array;
  constructor(
    readonly index: HokkaidoSidewalkIndex,
    pts: ArrayBuffer,
    trees: ArrayBuffer,
  ) {
    this.pts = new Float32Array(pts);
    this.trees = new Float32Array(trees);
  }
}
