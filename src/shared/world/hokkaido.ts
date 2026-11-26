// 北海道の世界（北海道の草案 2.2）。事前に変換したデータ（scripts/hokkaido/）を読み、
// 生成の世界の Terrain・World と同じ窓口で高さ・水・景観・道路を返す。
// データの取得（fetch）は呼ぶ側（Worker）が行い、ここには ArrayBuffer を渡す。DOM・三角関数を使わない（モック 4.2）。

import { type TruckRoute, TruckGraph } from "./truck-route.ts";
import { smoothstep } from "./noise.ts";
import type { LandscapeWeights, TerrainSample } from "./terrain.ts";
import type { Junction, Poi, RailLine, Road, RoadClass, Span, WorldNode } from "./types.ts";
import type { CrossingInfo, Rect } from "./world.ts";

/** 保存データの generator に入れる値。道路の識別子が変わる変換をしたら上げる（走った区間・続きからの位置が道路の識別子を使うため） */
export const HOKKAIDO_GENERATOR = 1004;
/** 変換データの置き場（H2: 札幌圏 約 60km 四方） */
export const HOKKAIDO_BASE = "/data/hokkaido/h2/";
/** 地形・建物・走らない道・歩道の頁の一辺 (m)（北海道の草案 20 章） */
export const HOKKAIDO_PAGE = 2000;

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
  /** 道路網の一番大きなつながりに入らない（Road.island） */
  island?: boolean;
}

export interface HokkaidoGrid {
  x0: number;
  z0: number;
  step: number;
  nx: number;
  nz: number;
}

/** 頁の並び（北海道の草案 20 章）。頁 (px, pz) は格子の原点から px·size, pz·size の所 */
export interface HokkaidoPages {
  size: number;
  /** 地形の頁 1 枚の格子の間の数（頁の点は per + 1 四方） */
  per: number;
  npx: number;
  npz: number;
  /** 中身のある頁の "px_pz" */
  buildings: string[];
  streets: string[];
  sidewalks: string[];
}

export interface HokkaidoMeta {
  version: 2;
  area: string;
  attribution: string[];
  builtAt: string;
  /** 地形の 10m 格子。頁ごとに高さ Int16（0.1m）、続けて水・土地利用・建物の込み具合・店の込み具合 Uint8 */
  grid: HokkaidoGrid;
  pages: HokkaidoPages;
  /** 全体の縮図（overview.bin。頁と同じ 5 層） */
  overview: HokkaidoGrid;
  roads: HokkaidoRoadMeta[];
  junctions: Junction[];
  nodes: WorldNode[];
  pois: Poi[];
}

/** 頁を読む関数（呼ぶ側が fetch する。無ければ null） */
export type HokkaidoPageLoader = (path: string) => Promise<ArrayBuffer | null>;

/** 地形の 1 頁、または縮図（5 層） */
class TerrainLayers {
  readonly h: Int16Array;
  readonly water: Uint8Array;
  readonly landuse: Uint8Array;
  readonly density: Uint8Array;
  readonly commercial: Uint8Array;
  constructor(buf: ArrayBuffer, n: number) {
    this.h = new Int16Array(buf, 0, n);
    this.water = new Uint8Array(buf, n * 2, n);
    this.landuse = new Uint8Array(buf, n * 3, n);
    this.density = new Uint8Array(buf, n * 4, n);
    this.commercial = new Uint8Array(buf, n * 5, n);
  }
}

type LayerName = "water" | "landuse" | "density" | "commercial";

/** 矩形（世界座標） */
export interface PageRect {
  x0: number;
  z0: number;
  x1: number;
  z1: number;
}

/**
 * 北海道の地形（北海道の草案 20 章）。10m 格子を 2km 四方の頁に分けて持ち、近くの頁だけ読む。
 * 読んでいない所は全体の縮図（50m 格子）で答える。頁を読む・捨てるのは ensure・evict（呼ぶ側が決める）。
 */
export class HokkaidoTerrain {
  private readonly g: HokkaidoGrid;
  private readonly p: HokkaidoPages;
  private readonly ov: TerrainLayers;
  private readonly og: HokkaidoGrid;
  private readonly pages = new Map<number, { layers: TerrainLayers; used: number }>();
  private readonly loading = new Map<number, Promise<void>>();
  private tick = 0;
  /** 頁を読み込むたびに増える（描く側が作り直しの判断に使う） */
  version = 0;

  /** seed は植生・地面の模様の乱数に使う（地形には使わない） */
  constructor(
    meta: Pick<HokkaidoMeta, "grid" | "pages" | "overview">,
    overview: ArrayBuffer,
    readonly seed: number,
    private readonly load: HokkaidoPageLoader,
  ) {
    this.g = meta.grid;
    this.p = meta.pages;
    this.og = meta.overview;
    this.ov = new TerrainLayers(overview, this.og.nx * this.og.nz);
  }

  get loadedPages(): number {
    return this.pages.size;
  }

  private pageKey(px: number, pz: number) {
    return px * 4096 + pz;
  }

  /** (x, z) の地形の頁を読み終えているか（読んでいない所の高さは縮図の値） */
  hasPage(x: number, z: number): boolean {
    const S = this.p.size;
    return this.pages.has(this.pageKey(Math.floor((x - this.g.x0) / S), Math.floor((z - this.g.z0) / S)));
  }

  /** 矩形にかかる頁を読む（読み終えたら解決） */
  ensure(r: PageRect): Promise<void> {
    const g = this.g;
    const S = this.p.size;
    const px0 = Math.max(0, Math.floor((r.x0 - g.x0) / S));
    const px1 = Math.min(this.p.npx - 1, Math.floor((r.x1 - g.x0) / S));
    const pz0 = Math.max(0, Math.floor((r.z0 - g.z0) / S));
    const pz1 = Math.min(this.p.npz - 1, Math.floor((r.z1 - g.z0) / S));
    const wait: Promise<void>[] = [];
    const t = ++this.tick;
    for (let pz = pz0; pz <= pz1; pz++)
      for (let px = px0; px <= px1; px++) {
        const k = this.pageKey(px, pz);
        const have = this.pages.get(k);
        if (have) {
          have.used = t;
          continue;
        }
        let l = this.loading.get(k);
        if (!l) {
          const n = (this.p.per + 1) * (this.p.per + 1);
          l = this.load(`pages/terrain/${px}_${pz}.bin`).then(
            (buf) => {
              this.loading.delete(k);
              if (buf) {
                this.pages.set(k, { layers: new TerrainLayers(buf, n), used: this.tick });
                this.version++;
              }
            },
            () => {
              this.loading.delete(k);
            },
          );
          this.loading.set(k, l);
        }
        wait.push(l);
      }
    return Promise.all(wait).then(() => undefined);
  }

  /** 中心 (x, z) から keep m より遠い頁を捨てる。maxPages を超えたら、使ったのが古い順にも捨てる */
  evict(x: number, z: number, keep: number, maxPages = Infinity) {
    const S = this.p.size;
    for (const k of [...this.pages.keys()]) {
      const px = Math.floor(k / 4096);
      const pz = k - px * 4096;
      const cx = this.g.x0 + (px + 0.5) * S;
      const cz = this.g.z0 + (pz + 0.5) * S;
      if (Math.abs(cx - x) > keep + S / 2 || Math.abs(cz - z) > keep + S / 2) this.pages.delete(k);
    }
    if (this.pages.size > maxPages) {
      const list = [...this.pages].sort((a, b) => a[1].used - b[1].used);
      for (let i = 0; i < list.length - maxPages; i++) this.pages.delete(list[i][0]);
    }
  }

  /** 格子の点 (gi, gj) を含む頁と、頁の中の位置。(gi, gj) から (gi + 1, gj + 1) まで同じ頁に入るように選ぶ */
  private pageAt(gi: number, gj: number): { L: TerrainLayers; k: number } | null {
    const per = this.p.per;
    const px = Math.min(this.p.npx - 1, Math.floor(gi / per));
    const pz = Math.min(this.p.npz - 1, Math.floor(gj / per));
    const e = this.pages.get(this.pageKey(px, pz));
    if (!e) return null;
    return { L: e.layers, k: (gj - pz * per) * (per + 1) + (gi - px * per) };
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
    const pg = this.pageAt(i, j);
    if (!pg) return this.overviewHeight(x, z);
    const u = fx - i;
    const v = fz - j;
    const k = pg.k;
    const W = this.p.per + 1;
    const h = pg.L.h;
    return ((h[k] * (1 - u) + h[k + 1] * u) * (1 - v) + (h[k + W] * (1 - u) + h[k + W + 1] * u) * v) * 0.1;
  }

  private overviewHeight(x: number, z: number): number {
    const g = this.og;
    const fx = Math.max(0, Math.min(g.nx - 1.000001, (x - g.x0) / g.step));
    const fz = Math.max(0, Math.min(g.nz - 1.000001, (z - g.z0) / g.step));
    const i = Math.floor(fx);
    const j = Math.floor(fz);
    const u = fx - i;
    const v = fz - j;
    const k = j * g.nx + i;
    const h = this.ov.h;
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

  private nearest(layer: LayerName, x: number, z: number): number {
    const g = this.g;
    const i = Math.round((x - g.x0) / g.step);
    const j = Math.round((z - g.z0) / g.step);
    if (i < 0 || j < 0 || i >= g.nx || j >= g.nz) return 0;
    const pg = this.pageAt(Math.min(g.nx - 2, i), Math.min(g.nz - 2, j));
    if (pg) {
      // 最後の点では pageAt が 1 つ前の点を基準にしているので、ずらす
      const W = this.p.per + 1;
      return pg.L[layer][pg.k + (i === g.nx - 1 ? 1 : 0) + (j === g.nz - 1 ? W : 0)];
    }
    const o = this.og;
    const oi = Math.min(o.nx - 1, Math.round((x - o.x0) / o.step));
    const oj = Math.min(o.nz - 1, Math.round((z - o.z0) / o.step));
    if (oi < 0 || oj < 0) return 0;
    return this.ov[layer][oj * o.nx + oi];
  }

  sample(x: number, z: number, _withDetail: boolean): TerrainSample {
    const height = this.height(x, z);
    const w = this.nearest("water", x, z) as TerrainSample["water"];
    return {
      height,
      routeHeight: height,
      mountain: smoothstep(320, 480, height),
      water: w,
      waterLevel: w === HOKKAIDO_WATER.sea ? 0 : w ? height : 0,
      floodplain: false,
      plainGap: Infinity,
      riverNear: w === HOKKAIDO_WATER.river ? 0 : Infinity,
      riverHalf: 0,
    };
  }

  /** 建物の込み具合 0〜1（周り 110m 四方の建物の床面積の割合） */
  coverage(x: number, z: number): number {
    return this.nearest("density", x, z) / 255;
  }

  /** 店・ビル・集合住宅の込み具合 0〜1 */
  commercialCoverage(x: number, z: number): number {
    return this.nearest("commercial", x, z) / 255;
  }

  /**
   * 景観の重み（北海道の草案 19 章）。
   * - 店・ビル・集合住宅の込み具合 0.12〜0.22 以上（街の中心）: 舗装の地面（urban）。植生・農地なし（街路樹は歩道に別に植える）
   * - 建物の込み具合 0.06 以上（家の多い所・郊外）: 草地と、まばらな木・低木（plain と other）。農地にしない（town）
   * - それ以外: 土地利用があればそれ、無ければ高さで決める（平らな低地は草地・農地）
   */
  landscape(x: number, z: number): LandscapeWeights {
    const h = this.height(x, z);
    const lu = this.nearest("landuse", x, z);
    const mountain = smoothstep(320, 480, h);
    // 川・湖（3D の水面は R2 と共通で、まだ無い）は草地の色にする（市街地にしない）
    if (this.nearest("water", x, z)) return { coast: 0, plain: 0, mountain: 0, other: 1, town: 1 };
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

  constructor(meta: HokkaidoMeta, overview: ArrayBuffer, roads: ArrayBuffer, seed: number, load: HokkaidoPageLoader) {
    this.meta = meta;
    this.terrain = new HokkaidoTerrain(meta, overview, seed, load);
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
      if (m.island) road.island = true;
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

  private truckGraph: TruckGraph | null = null;

  /** 長距離の便の経路（配達の草案 22 章）。道路網の全体で、時間の短い道 */
  truckRoute(fx: number, fz: number, tx: number, tz: number): TruckRoute | null {
    this.truckGraph ??= new TruckGraph(
      this.roads.map((r) => r.road),
      this.junctions.values(),
    );
    return this.truckGraph.route(fx, fz, tx, tz);
  }

  prune(_keep: Rect) {
    // 道路は全部を読んだまま持つ（H2 は約 60km 四方で 30MB ほど。H3 で頁ごとの読み書きにする）
  }

  /**
   * (x, z) の周りの頁を読む（メインスレッド。北海道の草案 20 章）。地形は terrainRange、建物・道・歩道は cityRange の内。
   * 地形は keep より遠い頁を捨てる。建物などは捨てない（H2 では全部読んでも 1 つの世界で 100MB ほど。H3 で捨てる）。
   */
  ensureAround(x: number, z: number, terrainRange = 3000, cityRange = 2000, keep = 5000): Promise<void> {
    const r = (d: number) => ({ x0: x - d, z0: z - d, x1: x + d, z1: z + d });
    this.terrain.evict(x, z, keep);
    return Promise.all([
      this.terrain.ensure(r(terrainRange)),
      this.buildings?.ensure(r(cityRange)),
      this.streets?.ensure(r(cityRange)),
      this.sidewalks?.ensure(r(cityRange)),
    ]).then(() => undefined);
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

// ---- 建物・走らない道・歩道の頁（北海道の草案 20 章） ----
// 頁ファイルは [Uint32 索引の長さ][索引の JSON][4 バイトにそろえる余白][Float32 の並び…]（scripts/hokkaido/pages.ts）。
// 読んだ頁の並びは 1 本の伸びる配列（arena）の後ろに足し、索引の位置をそこへずらす。今までの描く側のコードが
// 「1 つの配列と位置」のまま使えるように。頁は捨てない（H3 で捨てる時は詰め直す）。

/** 伸びる Float32 の配列 */
class Arena {
  data = new Float32Array(1 << 16);
  used = 0;
  /** 後ろに足して、足した先の位置を返す */
  push(a: Float32Array): number {
    if (this.used + a.length > this.data.length) {
      let n = this.data.length;
      while (n < this.used + a.length) n *= 2;
      const d = new Float32Array(n);
      d.set(this.data.subarray(0, this.used));
      this.data = d;
    }
    const at = this.used;
    this.data.set(a, at);
    this.used += a.length;
    return at;
  }
}

/** 頁ファイルを索引と Float32 の並びに分ける */
export function splitPage(buf: ArrayBuffer): { index: unknown; floats: Float32Array } {
  const len = new DataView(buf).getUint32(0, true);
  // 索引は ASCII だけ（区画の鍵・数・種類の名前）。TextDecoder（DOM の型）を使わずに文字列にする
  const bytes = new Uint8Array(buf, 4, len);
  let text = "";
  for (let i = 0; i < len; i += 8192) text += String.fromCharCode(...bytes.subarray(i, Math.min(len, i + 8192)));
  const index = JSON.parse(text);
  const head = 4 + len;
  const start = head + ((4 - (head % 4)) % 4);
  return { index, floats: new Float32Array(buf, start, (buf.byteLength - start) / 4) };
}

/** 頁を読む共通の部分。pages は中身のある頁の "px_pz" */
abstract class PagedStore {
  private readonly have = new Set<string>();
  private readonly loading = new Map<string, Promise<void>>();
  private readonly exists: Set<string>;
  /** 頁を読み込むたびに増える */
  version = 0;
  constructor(
    private readonly kind: string,
    private readonly grid: HokkaidoGrid,
    private readonly pageSize: number,
    pages: string[],
    private readonly load: HokkaidoPageLoader,
  ) {
    this.exists = new Set(pages);
  }
  get loadedPages(): number {
    return this.have.size;
  }
  protected abstract addPage(index: unknown, floats: Float32Array): void;

  /** (x, z) の頁を読み終えているか（中身の無い頁は読み終えたとする） */
  hasPage(x: number, z: number): boolean {
    const k = `${Math.floor((x - this.grid.x0) / this.pageSize)}_${Math.floor((z - this.grid.z0) / this.pageSize)}`;
    return this.have.has(k) || !this.exists.has(k);
  }

  /** 矩形にかかる頁を読む */
  ensure(r: PageRect): Promise<void> {
    const g = this.grid;
    const S = this.pageSize;
    const wait: Promise<void>[] = [];
    for (let pz = Math.floor((r.z0 - g.z0) / S); pz <= Math.floor((r.z1 - g.z0) / S); pz++)
      for (let px = Math.floor((r.x0 - g.x0) / S); px <= Math.floor((r.x1 - g.x0) / S); px++) {
        const k = `${px}_${pz}`;
        if (this.have.has(k) || !this.exists.has(k)) continue;
        let l = this.loading.get(k);
        if (!l) {
          l = this.load(`pages/${this.kind}/${k}.bin`).then(
            (buf) => {
              this.loading.delete(k);
              if (!buf || this.have.has(k)) return;
              const { index, floats } = splitPage(buf);
              this.addPage(index, floats);
              this.have.add(k);
              this.version++;
            },
            () => {
              this.loading.delete(k);
            },
          );
          this.loading.set(k, l);
        }
        wait.push(l);
      }
    return Promise.all(wait).then(() => undefined);
  }

  /** 区画の鍵 "cx,cz" の並びを覆う矩形 */
  static rectOfCells(cells: string[], cell: number): PageRect {
    let x0 = Infinity;
    let z0 = Infinity;
    let x1 = -Infinity;
    let z1 = -Infinity;
    for (const k of cells) {
      const [cx, cz] = k.split(",").map(Number);
      x0 = Math.min(x0, cx * cell);
      z0 = Math.min(z0, cz * cell);
      x1 = Math.max(x1, (cx + 1) * cell);
      z1 = Math.max(z1, (cz + 1) * cell);
    }
    return { x0, z0, x1, z1 };
  }
}

export const rectOfCells = PagedStore.rectOfCells;

// ---- 建物（北海道の草案 15 章）。区画の順に並べた Float32 の記録 ----

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
export class HokkaidoBuildings extends PagedStore {
  readonly index: HokkaidoBuildingIndex;
  private readonly arena = new Arena();
  constructor(cell: number, grid: HokkaidoGrid, pages: HokkaidoPages, load: HokkaidoPageLoader) {
    super("buildings", grid, pages.size, pages.buildings, load);
    this.index = { cell, rec: BUILDING_REC, cells: {} };
  }
  /** 読んだ頁の記録（位置は index.cells の値） */
  get data(): Float32Array {
    return this.arena.data;
  }
  get count(): number {
    return this.arena.used / BUILDING_REC;
  }
  protected addPage(index: unknown, floats: Float32Array) {
    const at = this.arena.push(floats) / BUILDING_REC;
    for (const [k, [start, n]] of Object.entries((index as HokkaidoBuildingIndex).cells)) this.index.cells[k] = [start + at, n];
  }
  /** 区画 (cx, cz) の記録の範囲 */
  cell(cx: number, cz: number): [number, number] | null {
    return this.index.cells[`${cx},${cz}`] ?? null;
  }
}

// ---- 走らない道（見た目だけ。北海道の草案 17 章）。streets.bin は折れ線の [x, z] の並び（高さは描く側が地形から取る） ----

export const HOKKAIDO_STREET_KINDS = ["street", "path"] as const;

/** 走らない道の 1 本: [最初の点の番号, 点の数, 幅 × 10, 種類, 端の印（無ければ 0）] */
export type StreetPiece = [number, number, number, number, number?];

export interface HokkaidoStreetIndex {
  /** 区画の一辺 (m) */
  cell: number;
  kinds: string[];
  /** "cx,cz" → [最初の点の番号, 点の数, 幅 × 10, 種類] の並び */
  /** [最初の点の番号, 点の数, 幅 × 10, 種類, 端の印]。端の印は 1 = 始めの端、2 = 終わりの端が走る道に出る（描く時に端を伸ばさない。北海道の草案 31 章） */
  pieces: Record<string, StreetPiece[]>;
}

export class HokkaidoStreets extends PagedStore {
  readonly index: HokkaidoStreetIndex;
  private readonly arena = new Arena();
  constructor(cell: number, grid: HokkaidoGrid, pages: HokkaidoPages, load: HokkaidoPageLoader) {
    super("streets", grid, pages.size, pages.streets, load);
    this.index = { cell, kinds: [...HOKKAIDO_STREET_KINDS], pieces: {} };
  }
  get pts(): Float32Array {
    return this.arena.data;
  }
  protected addPage(index: unknown, floats: Float32Array) {
    const at = this.arena.push(floats) / 2;
    for (const [k, list] of Object.entries((index as HokkaidoStreetIndex).pieces)) this.index.pieces[k] = list.map(([o, n, w, kind, ends]) => (ends ? [o + at, n, w, kind, ends] : [o + at, n, w, kind]));
  }
  cell(cx: number, cz: number): StreetPiece[] | null {
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
  /** "cx,cz" → [最初の電柱・街灯の番号, 数] の並び（北海道の草案 26 章。並びの続く電柱を電線でつなぐ） */
  poles: Record<string, [number, number][]>;
  /** "cx,cz" → 道路標識の番号の並び（北海道の草案 27 章） */
  signs: Record<string, number[]>;
}

/** 道路標識の点 1 つの数: [x, y, z, 表の向き x, z, 種類, 値, 張り出し]。y が NaN なら地形の高さ */
export const SIGN_REC = 8;
/** 道路標識の種類 */
export const SIGN_TYPES = {
  stop: 1,
  crosswalk: 2,
  /** 一方通行（板は道に沿い、(fx, fz) は矢印の向き） */
  oneway: 3,
  noEntry: 4,
  /** 最高速度（値は km/h） */
  speed: 5,
  /** 案内標識（値は文字の番号、張り出しは柱から板の中心まで） */
  guide: 6,
  /** 矢羽根（固定式視線誘導柱）。(fx, fz) は道の方、張り出しは柱から矢印まで（北海道の草案 28 章） */
  yabane: 7,
  /** 防雪柵の 1 枚（(x, z) から (fx, fz) の向きに値 m。高さは地形） */
  fence: 8,
  /** 停止線（(x, z) は線の中心、(fx, fz) は進む向き、値は線の長さ（道の幅の向き）、張り出しは路面からの上げ（0 なら住宅街の道の上げ）） */
  stopLine: 9,
  /** 路面の「止まれ」の文字（(x, z) は文字の中心、(fx, fz) は進む向き、値は文字の幅、張り出しは路面からの上げ。北海道の草案 29 章） */
  roadText: 10,
} as const;

/** 電柱・街灯の点 1 つの数: [x, y, z, tx, tz, 印]。y が NaN なら地形の高さ */
export const POLE_REC = 6;
/** 電柱・街灯の印 */
export const POLE_FLAGS = {
  transformer: 1,
  /** 防犯灯（電柱に付ける小さい灯り） */
  lamp: 2,
  /** 電線の端だけ（次の区画の電柱。柱は描かない） */
  anchor: 4,
  /** 街灯（道路照明）。(tx, tz) は腕の向き */
  streetlight: 8,
} as const;

export class HokkaidoSidewalks extends PagedStore {
  readonly index: HokkaidoSidewalkIndex;
  private readonly ptsArena = new Arena();
  private readonly treeArena = new Arena();
  private readonly poleArena = new Arena();
  private readonly signArena = new Arena();
  /** 案内標識の文字 [左, 直進, 右]（頁を読んだ順に足す） */
  readonly guides: [string, string, string][] = [];
  constructor(cell: number, grid: HokkaidoGrid, pages: HokkaidoPages, load: HokkaidoPageLoader) {
    super("sidewalks", grid, pages.size, pages.sidewalks, load);
    this.index = { cell, rec: 5, sidewalks: {}, trees: {}, poles: {}, signs: {} };
  }
  get signs(): Float32Array {
    return this.signArena.data;
  }
  get poles(): Float32Array {
    return this.poleArena.data;
  }
  get pts(): Float32Array {
    return this.ptsArena.data;
  }
  get trees(): Float32Array {
    return this.treeArena.data;
  }
  protected addPage(index: unknown, floats: Float32Array) {
    const ix = index as HokkaidoSidewalkIndex & { ptsLength: number; treesLength?: number; polesLength?: number; guides?: [string, string, string][] };
    const at = this.ptsArena.push(floats.subarray(0, ix.ptsLength)) / ix.rec;
    // 電柱の無い前の版（treesLength なし）は、残り全部が木
    const tEnd = ix.treesLength === undefined ? floats.length : ix.ptsLength + ix.treesLength;
    const tat = this.treeArena.push(floats.subarray(ix.ptsLength, tEnd)) / 5;
    const pEnd = ix.polesLength === undefined ? floats.length : tEnd + ix.polesLength;
    const pat = this.poleArena.push(floats.subarray(tEnd, pEnd)) / POLE_REC;
    // 道路標識（案内標識の文字の番号は、この頁の並びから全体の並びへずらす）
    const sigs = floats.slice(pEnd);
    const g0 = this.guides.length;
    for (let o = 0; o < sigs.length; o += SIGN_REC) if (sigs[o + 5] === SIGN_TYPES.guide) sigs[o + 6] += g0;
    for (const g of ix.guides ?? []) this.guides.push(g);
    const sat = this.signArena.push(sigs) / SIGN_REC;
    for (const [k, list] of Object.entries(ix.signs ?? {})) this.index.signs[k] = list.map((t) => t + sat);
    for (const [k, list] of Object.entries(ix.poles ?? {})) this.index.poles[k] = list.map(([o, n]) => [o + pat, n]);
    for (const [k, list] of Object.entries(ix.sidewalks)) this.index.sidewalks[k] = list.map(([o, n]) => [o + at, n]);
    for (const [k, list] of Object.entries(ix.trees)) this.index.trees[k] = list.map((t) => t + tat);
  }
}
