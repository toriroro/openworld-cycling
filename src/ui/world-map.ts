// 2D 地図（モック仕様 4.10）。移動と拡大縮小、標高の陰影・景観の色・海・結節点・道路（等級で太さ、勾配で色）・
// 橋・立ち寄り地点。道路を選ぶと縦断図と数値を出す。
// ゲーム内の世界地図（モック仕様 7.4）にも使う: game を渡すと、走った道を太く・未走行の道を細く描き、現在地・行き先・立ち寄った店を出し、
// 地図を押すと行き先の指定になる。

import { ROAD_CLASSES } from "../shared/world/constants.ts";
import type { Junction, Poi, RailLine, Road, WorldNode } from "../shared/world/types.ts";
import type { CrossingInfo, Rect } from "../shared/world/world.ts";
import type { RiddenLog } from "../sim/ridden.ts";
import { type AddressBook, shortAddress } from "../shared/world/address.ts";
import { TILE_PX } from "../workers/map-tile.ts";
import type { RegionPayload, WorldRequest, WorldResponse } from "../workers/world-protocol.ts";

export const GRADE_STEPS = [0.03, 0.05, 0.07, 0.09, 0.11];
export const GRADE_COLORS = ["#2f6fd0", "#1f9a52", "#d9b416", "#ee7a1a", "#d42424", "#7a1fa2"];
const CLASS_PX = [4.2, 3.2, 2.4, 1.8, 1.6];
const BLOCK = 8000;
const ROADS_VISIBLE_MPP = 80;
/** 鉄道を描く縮尺の上限と、鉄道を頼む区画の一辺 (m) */
const RAILS_VISIBLE_MPP = 300;
const RAIL_BLOCK = 24000;

interface RoadDraw {
  road: Road;
  bounds: Rect;
}

interface TileEntry {
  bmp: ImageBitmap | null;
  pending: boolean;
  used: number;
}

export interface MapOptions {
  seed: number;
  /** 北海道の世界（北海道の草案 2.2）。省くと生成の世界 */
  world?: "hokkaido";
  x: number;
  z: number;
  mpp: number;
  /** 起点候補などの印（中心と半径 m） */
  mark?: { x: number; z: number; r: number };
  onSelect?: (road: Road | null) => void;
  onStatus?: (s: MapStatus) => void;
  game?: GameMapLayer;
}

/** ゲーム内の世界地図に重ねるもの */
export interface GameMapLayer {
  ridden: RiddenLog;
  player: () => { x: number; z: number; dx: number; dz: number } | null;
  goal: () => { x: number; z: number } | null;
  /** 立ち寄った店（立ち寄り地点の識別子） */
  stamped: () => Set<string>;
  /** 地図を押した所（世界座標） */
  onTap: (x: number, z: number) => void;
  /** 名所の印（北海道の世界。名所の草案） */
  landmarks?: () => { x: number; z: number; name: string; visited: boolean; goal: boolean }[];
  /** 冒険の地図: 走った道と現在地からこの距離 (m) だけ未走行の道を描く。null なら全部（冒険の草案 2 章） */
  reveal?: () => number | null;
  /** 住所（丁目の名前を拡大した時に描く。配達の草案 13 章） */
  addresses?: AddressBook;
  /** 配達の行き先の印（配達の草案 3.3 の案内）。kind があれば受け取り・届け先の色の目立つ印（26 章） */
  marks?: () => { x: number; z: number; name: string; kind?: "pickup" | "dropoff"; active?: boolean; id?: number }[];
  /** 体力を戻す所（配達の草案 28 章）。拡大した時に名前 */
  rests?: () => { x: number; z: number; kind: "vending" | "gyudon" | "teishoku" | "bike" | "car"; name: string }[];
  /** 受け取り・届け先の印を押した時（id は marks の id）。押した所が印でなければ onTap（配達の草案 27 章） */
  onMark?: (id: number) => void;
  /** 行き先までの経路の線（世界座標 x, z の交互の並び。配達の草案 26 章） */
  route?: () => number[] | null;
  /** 縄張り: 丁目ごとに持ち主の業者の色を塗った画像と、それが覆う世界の範囲（配達の草案 18 章） */
  territory?: () => { image: CanvasImageSource; x0: number; z0: number; x1: number; z1: number } | null;
  /** 業者の営業所 */
  depots?: () => { x: number; z: number; color: string; company: string }[];
  /** 縄張りの凡例（商圏の広い順） */
  legend?: () => { name: string; color: string }[];
  /** 長距離の便: 経路（世界座標 x, z の並び）・業者の色・行き先・トラックの位置（配達の草案 22 章） */
  freight?: () => { path: number[]; color: string; town: string; trucks: { x: number; z: number; back: boolean }[] }[];
}

/** 体力を戻す所の色（小地図と世界地図。配達の草案 28 章） */
export const REST_COLORS = { vending: "#4cc3ff", shop: "#e2771e", bike: "#2a9d5a", car: "#5c6670" };
/** 世界地図の丸の中の字（自販機は字なし） */
const REST_MARK: Record<string, string> = { gyudon: "食", teishoku: "食", bike: "自", car: "車" };

/** 経路の線と、受け取り・届け先の色（3D の光の柱・円と同じ。配達の草案 26 章） */
export const ROUTE_COLOR = "#2fd0ff";
export const TARGET_COLORS = { pickup: "#ff4fa3", dropoff: "#35e08a" } as const;
const TARGET_LABELS = { pickup: "受け取り", dropoff: "届け先" } as const;

/** 縄張りを塗る縮尺の上限 (m/px) */
const TERRITORY_MPP = 40;

/** 丁目の名前を描く縮尺の上限 (m/px): 短い形（北3西4）と、正式の形（北3条西4丁目） */
const ADDRESS_SHORT_MPP = 2.6;
const ADDRESS_FULL_MPP = 1.3;

/** 丁目の短い名前（北3西4、大通西6）。碁盤の住所でなければそのまま */
export { shortAddress };

export interface MapStatus {
  x: number;
  z: number;
  mpp: number;
  roads: number;
  /** 鉄道の線の数（地図だけ） */
  rails?: number;
  /** 鉄道を生成中の区画の数 */
  railPending?: number;
  pendingTiles: number;
  pendingBlocks: number;
  roadMs: number[];
}

export class WorldMap {
  readonly canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private dpr = 1;
  cx: number;
  cz: number;
  mpp: number;
  private seed: number;
  private tileWorkers: Worker[] = [];
  private roadWorker: Worker;
  private nextTileWorker = 0;
  private tiles = new Map<string, TileEntry>();
  private tileReq = new Map<number, string>();
  private reqId = 1;
  private frame = 0;
  private dirty = true;
  readonly roads = new Map<string, RoadDraw>();
  readonly junctions = new Map<string, Junction>();
  readonly pois = new Map<string, Poi>();
  readonly nodes = new Map<string, WorldNode>();
  readonly crossings = new Map<string, CrossingInfo>();
  readonly roadMs: number[] = [];
  private blocksDone = new Set<string>();
  private blockQueue: string[] = [];
  private blockInFlight: string | null = null;
  private paths: { cls: number; bucket: number; path: Path2D }[] = [];
  private bridgePath = new Path2D();
  /** トンネル（北海道の世界の道路だけ） */
  private tunnelPath = new Path2D();
  private pathsDirty = false;
  private anchorX: number;
  private anchorZ: number;
  selected: Road | null = null;
  private opts: MapOptions;
  showRoads = true;
  showPois = true;
  private riddenPath: Path2D | null = null;
  /** 鉄道（鉄道の草案 L1）。地図だけで、ゲームの中の地図には出さない */
  readonly rails = new Map<string, RailLine>();
  showRails = true;
  private railWorker: Worker | null = null;
  private railDone = new Set<string>();
  private railQueue: string[] = [];
  private railInFlight: string | null = null;
  private railPaths: { open: Path2D; abandoned: Path2D; tunnel: Path2D; bridge: Path2D } | null = null;
  private riddenVersion = -1;

  constructor(canvas: HTMLCanvasElement, opts: MapOptions) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d")!;
    this.opts = opts;
    this.seed = opts.seed;
    this.cx = opts.x;
    this.cz = opts.z;
    this.mpp = opts.mpp;
    this.anchorX = Math.round(opts.x / 10000) * 10000;
    this.anchorZ = Math.round(opts.z / 10000) * 10000;
    const nTile = Math.max(1, Math.min(3, (navigator.hardwareConcurrency || 4) - 2));
    for (let i = 0; i < nTile; i++) this.tileWorkers.push(this.spawn());
    this.roadWorker = this.spawn();
    this.bindInput();
    new ResizeObserver(() => this.resize()).observe(canvas);
    this.resize();
    let last = 0;
    const loop = (t: number) => {
      this.frame = requestAnimationFrame(loop);
      // ゲーム内では現在地が動くので 4 回／秒は描き直す
      if (opts.game && t - last > 250) this.dirty = true;
      if (this.dirty) {
        last = t;
        this.draw();
      }
    };
    this.frame = requestAnimationFrame(loop);
  }

  private spawn(): Worker {
    const w = new Worker(new URL("../workers/world.worker.ts", import.meta.url), { type: "module" });
    w.onmessage = (ev: MessageEvent<WorldResponse>) => this.onWorker(ev.data);
    w.postMessage({ type: "init", seed: this.seed, world: this.opts.world } satisfies WorldRequest);
    return w;
  }

  destroy() {
    cancelAnimationFrame(this.frame);
    for (const w of this.tileWorkers) w.terminate();
    this.roadWorker.terminate();
    this.railWorker?.terminate();
  }

  status(): MapStatus {
    let pendingTiles = 0;
    for (const t of this.tiles.values()) if (t.pending) pendingTiles++;
    return {
      x: this.cx,
      z: this.cz,
      mpp: this.mpp,
      roads: this.roads.size,
      rails: this.rails.size,
      railPending: this.railQueue.length + (this.railInFlight ? 1 : 0),
      pendingTiles,
      pendingBlocks: this.blockQueue.length + (this.blockInFlight ? 1 : 0),
      roadMs: this.roadMs,
    };
  }

  setView(x: number, z: number, mpp: number) {
    this.cx = x;
    this.cz = z;
    this.mpp = Math.max(0.5, Math.min(1500, mpp));
    this.dirty = true;
  }

  select(road: Road | null) {
    this.selected = road;
    this.dirty = true;
    this.opts.onSelect?.(road);
  }

  private resize() {
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
    const r = this.canvas.getBoundingClientRect();
    this.canvas.width = Math.max(1, Math.round(r.width * this.dpr));
    this.canvas.height = Math.max(1, Math.round(r.height * this.dpr));
    this.dirty = true;
  }

  private get cssW() {
    return this.canvas.width / this.dpr;
  }
  private get cssH() {
    return this.canvas.height / this.dpr;
  }

  /** 画面の点 → 世界座標 */
  toWorld(px: number, py: number): { x: number; z: number } {
    return { x: this.cx + (px - this.cssW / 2) * this.mpp, z: this.cz + (py - this.cssH / 2) * this.mpp };
  }

  private viewRect(): Rect {
    const hw = (this.cssW / 2) * this.mpp;
    const hh = (this.cssH / 2) * this.mpp;
    return { x0: this.cx - hw, z0: this.cz - hh, x1: this.cx + hw, z1: this.cz + hh };
  }

  private bindInput() {
    const c = this.canvas;
    const pts = new Map<number, { x: number; y: number }>();
    let moved = 0;
    let pinch: { d: number; mpp: number } | null = null;
    c.addEventListener("pointerdown", (e) => {
      c.setPointerCapture(e.pointerId);
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      moved = 0;
      if (pts.size === 2) {
        const [a, b] = [...pts.values()];
        pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), mpp: this.mpp };
      }
    });
    c.addEventListener("pointermove", (e) => {
      const p = pts.get(e.pointerId);
      if (!p) return;
      const dx = e.clientX - p.x;
      const dy = e.clientY - p.y;
      moved += Math.abs(dx) + Math.abs(dy);
      p.x = e.clientX;
      p.y = e.clientY;
      if (pts.size === 1) {
        this.cx -= dx * this.mpp;
        this.cz -= dy * this.mpp;
      } else if (pts.size === 2 && pinch) {
        const [a, b] = [...pts.values()];
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        if (d > 0) this.mpp = Math.max(0.5, Math.min(1500, (pinch.mpp * pinch.d) / d));
      }
      this.dirty = true;
    });
    const up = (e: PointerEvent) => {
      const had = pts.delete(e.pointerId);
      if (pts.size < 2) pinch = null;
      if (had && pts.size === 0 && moved < 6 && e.type === "pointerup") {
        const r = c.getBoundingClientRect();
        this.pick(e.clientX - r.left, e.clientY - r.top);
      }
    };
    c.addEventListener("pointerup", up);
    c.addEventListener("pointercancel", up);
    c.addEventListener(
      "wheel",
      (e) => {
        e.preventDefault();
        const r = c.getBoundingClientRect();
        const px = e.clientX - r.left;
        const py = e.clientY - r.top;
        const before = this.toWorld(px, py);
        const f = Math.pow(1.0015, e.deltaY);
        this.mpp = Math.max(0.5, Math.min(1500, this.mpp * f));
        const after = this.toWorld(px, py);
        this.cx += before.x - after.x;
        this.cz += before.z - after.z;
        this.dirty = true;
      },
      { passive: false },
    );
  }

  /** 受け取り・届け先の印の押せる所（画面の点。描く時に覚える） */
  private markHits: { id: number; x0: number; y0: number; x1: number; y1: number }[] = [];

  /** 画面の点に最も近い道路を選ぶ（10px 以内） */
  private pick(px: number, py: number) {
    const p = this.toWorld(px, py);
    if (this.opts.game) {
      // 受け取り・届け先の印（針・札・縁の三角）を押したら、その行き先へ
      const hit = this.opts.game.onMark ? [...this.markHits].reverse().find((h) => px >= h.x0 && px <= h.x1 && py >= h.y0 && py <= h.y1) : undefined;
      if (hit) this.opts.game.onMark!(hit.id);
      else this.opts.game.onTap(p.x, p.z);
      this.dirty = true;
      return;
    }
    if (this.mpp > ROADS_VISIBLE_MPP) return;
    const tol = 10 * this.mpp;
    let best: Road | null = null;
    let bestD = tol * tol;
    for (const { road, bounds } of this.roads.values()) {
      if (p.x < bounds.x0 - tol || p.x > bounds.x1 + tol || p.z < bounds.z0 - tol || p.z > bounds.z1 + tol) continue;
      const P = road.points;
      for (let i = 0; i < P.length - 3; i += 6) {
        const ax = P[i] + road.origin[0];
        const az = P[i + 2] + road.origin[1];
        const j = Math.min(P.length - 3, i + 6);
        const bx = P[j] + road.origin[0];
        const bz = P[j + 2] + road.origin[1];
        const d = segDist2(p.x, p.z, ax, az, bx, bz);
        if (d < bestD) {
          bestD = d;
          best = road;
        }
      }
    }
    this.select(best);
  }

  private onWorker(msg: WorldResponse) {
    if (msg.type === "tile") {
      const key = this.tileReq.get(msg.id);
      this.tileReq.delete(msg.id);
      if (!key) return;
      const ent = this.tiles.get(key);
      if (!ent) return;
      const img = new ImageData(msg.pixels as Uint8ClampedArray<ArrayBuffer>, TILE_PX, TILE_PX);
      createImageBitmap(img).then((bmp) => {
        ent.bmp = bmp;
        ent.pending = false;
        this.dirty = true;
      });
    } else if (msg.type === "rail") {
      for (const l of msg.lines) this.rails.set(l.id, l);
      if (this.railInFlight) this.railDone.add(this.railInFlight);
      this.railInFlight = null;
      this.railPaths = null;
      this.pumpRail();
      this.dirty = true;
    } else if (msg.type === "region") {
      this.addRegion(msg.data);
      if (this.blockInFlight) this.blocksDone.add(this.blockInFlight);
      this.blockInFlight = null;
      this.pumpBlocks();
      this.dirty = true;
    } else if (msg.type === "error") {
      console.error("world worker", msg.message);
      this.blockInFlight = null;
    }
  }

  private addRegion(d: RegionPayload) {
    for (const r of d.roads) {
      if (this.roads.has(r.id)) continue;
      this.roads.set(r.id, { road: r, bounds: bounds(r) });
      this.pathsDirty = true;
    }
    for (const j of d.junctions) {
      const old = this.junctions.get(j.id);
      if (!old) this.junctions.set(j.id, j);
      else for (const a of j.arms) if (!old.arms.some((b) => b.road === a.road && b.s === a.s && b.dir === a.dir)) old.arms.push(a);
    }
    for (const p of d.pois) this.pois.set(p.id, p);
    for (const n of d.nodes) this.nodes.set(n.id, n);
    for (const c of d.crossings) this.crossings.set(c.id, c);
    for (const t of d.timings) this.roadMs.push(t.ms);
  }

  private wantRail() {
    const v = this.viewRect();
    const want: { key: string; d: number }[] = [];
    for (let bz = Math.floor(v.z0 / RAIL_BLOCK); bz <= Math.floor(v.z1 / RAIL_BLOCK); bz++)
      for (let bx = Math.floor(v.x0 / RAIL_BLOCK); bx <= Math.floor(v.x1 / RAIL_BLOCK); bx++) {
        const key = `${bx},${bz}`;
        if (this.railDone.has(key) || key === this.railInFlight || this.railQueue.includes(key)) continue;
        want.push({ key, d: Math.hypot((bx + 0.5) * RAIL_BLOCK - this.cx, (bz + 0.5) * RAIL_BLOCK - this.cz) });
      }
    want.sort((a, b) => a.d - b.d);
    for (const w of want) this.railQueue.push(w.key);
    this.pumpRail();
  }

  private pumpRail() {
    if (this.railInFlight || !this.railQueue.length) return;
    if (!this.railWorker) this.railWorker = this.spawn();
    const key = this.railQueue.shift()!;
    const [bx, bz] = key.split(",").map(Number);
    this.railInFlight = key;
    const rect = { x0: bx * RAIL_BLOCK, z0: bz * RAIL_BLOCK, x1: (bx + 1) * RAIL_BLOCK, z1: (bz + 1) * RAIL_BLOCK };
    this.railWorker.postMessage({ type: "rail", id: this.reqId++, rect } satisfies WorldRequest);
  }

  private rebuildRailPaths() {
    const open = new Path2D();
    const abandoned = new Path2D();
    const tunnel = new Path2D();
    const bridge = new Path2D();
    for (const l of this.rails.values()) {
      const P = l.points;
      const n = P.length / 3;
      const ds = l.length / (n - 1);
      const target = l.status === "open" ? open : abandoned;
      const ox = l.origin[0] - this.anchorX;
      const oz = l.origin[1] - this.anchorZ;
      for (let i = 0; i < n; i++) {
        const x = P[i * 3] + ox;
        const z = P[i * 3 + 2] + oz;
        if (i === 0) target.moveTo(x, z);
        else target.lineTo(x, z);
      }
      for (const sp of l.spans) {
        const t = sp.kind === "tunnel" ? tunnel : bridge;
        const i0 = Math.max(0, Math.floor(sp.from / ds));
        const i1 = Math.min(n - 1, Math.ceil(sp.to / ds));
        for (let i = i0; i <= i1; i++) {
          const x = P[i * 3] + ox;
          const z = P[i * 3 + 2] + oz;
          if (i === i0) t.moveTo(x, z);
          else t.lineTo(x, z);
        }
      }
    }
    this.railPaths = { open, abandoned, tunnel, bridge };
  }

  private pumpBlocks() {
    if (this.blockInFlight || !this.blockQueue.length) return;
    const key = this.blockQueue.shift()!;
    const [bx, bz] = key.split(",").map(Number);
    this.blockInFlight = key;
    const rect = { x0: bx * BLOCK, z0: bz * BLOCK, x1: (bx + 1) * BLOCK, z1: (bz + 1) * BLOCK };
    this.roadWorker.postMessage({ type: "region", id: this.reqId++, rect } satisfies WorldRequest);
  }

  private wantBlocks() {
    if (!this.showRoads || this.mpp > ROADS_VISIBLE_MPP) return;
    const v = this.viewRect();
    const want: { key: string; d: number }[] = [];
    for (let bz = Math.floor(v.z0 / BLOCK); bz <= Math.floor(v.z1 / BLOCK); bz++)
      for (let bx = Math.floor(v.x0 / BLOCK); bx <= Math.floor(v.x1 / BLOCK); bx++) {
        const key = `${bx},${bz}`;
        if (this.blocksDone.has(key) || key === this.blockInFlight) continue;
        const d = Math.hypot((bx + 0.5) * BLOCK - this.cx, (bz + 0.5) * BLOCK - this.cz);
        want.push({ key, d });
      }
    want.sort((a, b) => a.d - b.d);
    this.blockQueue = want.map((w) => w.key);
    this.pumpBlocks();
  }

  private rebuildPaths() {
    this.riddenPath = null;
    const groups = new Map<number, Path2D>();
    const bridge = new Path2D();
    const tunnel = new Path2D();
    const ax = this.anchorX;
    const az = this.anchorZ;
    for (const { road } of this.roads.values()) {
      const P = road.points;
      const n = P.length / 3;
      const ds = road.length / (n - 1);
      const CH = 10; // 20m ごとに色を決める
      for (let i = 0; i < n - 1; i += CH) {
        const j = Math.min(n - 1, i + CH);
        const g = Math.abs(P[j * 3 + 1] - P[i * 3 + 1]) / ((j - i) * ds);
        let bucket = 0;
        while (bucket < GRADE_STEPS.length && g > GRADE_STEPS[bucket]) bucket++;
        const key = road.cls * 10 + bucket;
        let path = groups.get(key);
        if (!path) groups.set(key, (path = new Path2D()));
        path.moveTo(P[i * 3] + road.origin[0] - ax, P[i * 3 + 2] + road.origin[1] - az);
        for (let k = i + 1; k <= j; k++) path.lineTo(P[k * 3] + road.origin[0] - ax, P[k * 3 + 2] + road.origin[1] - az);
      }
      for (const sp of road.spans) {
        const i0 = Math.floor(sp.from / ds);
        const i1 = Math.min(n - 1, Math.ceil(sp.to / ds));
        const path = sp.kind === "tunnel" ? tunnel : bridge;
        path.moveTo(P[i0 * 3] + road.origin[0] - ax, P[i0 * 3 + 2] + road.origin[1] - az);
        for (let k = i0 + 1; k <= i1; k++) path.lineTo(P[k * 3] + road.origin[0] - ax, P[k * 3 + 2] + road.origin[1] - az);
      }
    }
    this.paths = [...groups.entries()]
      .map(([k, path]) => ({ cls: Math.floor(k / 10), bucket: k % 10, path }))
      .sort((a, b) => b.cls - a.cls);
    this.bridgePath = bridge;
    this.tunnelPath = tunnel;
    this.pathsDirty = false;
  }

  private tileLevel(): number {
    const dev = this.mpp / this.dpr;
    return Math.max(-1, Math.min(10, Math.round(Math.log2(dev))));
  }

  private getTile(z: number, tx: number, tz: number, request: boolean): TileEntry | undefined {
    const key = `${z}/${tx}/${tz}`;
    let t = this.tiles.get(key);
    if (!t && request) {
      t = { bmp: null, pending: true, used: performance.now() };
      this.tiles.set(key, t);
      const mppT = Math.pow(2, z);
      const id = this.reqId++;
      this.tileReq.set(id, key);
      const w = this.tileWorkers[this.nextTileWorker++ % this.tileWorkers.length];
      w.postMessage({ type: "tile", id, x0: tx * TILE_PX * mppT, z0: tz * TILE_PX * mppT, mpp: mppT } satisfies WorldRequest);
    }
    if (t) t.used = performance.now();
    return t;
  }

  private evictTiles() {
    if (this.tiles.size < 400) return;
    const list = [...this.tiles.entries()].filter(([, t]) => !t.pending).sort((a, b) => a[1].used - b[1].used);
    for (let i = 0; i < list.length - 300; i++) {
      list[i][1].bmp?.close();
      this.tiles.delete(list[i][0]);
    }
  }

  private draw() {
    this.dirty = false;
    const ctx = this.ctx;
    const W = this.cssW;
    const H = this.cssH;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.fillStyle = "#3e6ca0";
    ctx.fillRect(0, 0, W, H);
    const v = this.viewRect();

    // 地形タイル（読み込み中は1段粗いタイルで埋める）
    const z = this.tileLevel();
    const tileWorld = TILE_PX * Math.pow(2, z);
    const tx0 = Math.floor(v.x0 / tileWorld);
    const tx1 = Math.floor(v.x1 / tileWorld);
    const tz0 = Math.floor(v.z0 / tileWorld);
    const tz1 = Math.floor(v.z1 / tileWorld);
    ctx.imageSmoothingEnabled = true;
    for (let tz = tz0; tz <= tz1; tz++)
      for (let tx = tx0; tx <= tx1; tx++) {
        const t = this.getTile(z, tx, tz, true)!;
        const sx = (tx * tileWorld - v.x0) / this.mpp;
        const sy = (tz * tileWorld - v.z0) / this.mpp;
        const size = tileWorld / this.mpp;
        if (t.bmp) ctx.drawImage(t.bmp, sx, sy, size + 0.5, size + 0.5);
        else {
          const pz = z + 1;
          const ptx = Math.floor(tx / 2);
          const ptz = Math.floor(tz / 2);
          const p = this.getTile(pz, ptx, ptz, false);
          if (p?.bmp) {
            const half = TILE_PX / 2;
            ctx.drawImage(p.bmp, (tx - ptx * 2) * half, (tz - ptz * 2) * half, half, half, sx, sy, size + 0.5, size + 0.5);
          }
        }
      }
    this.evictTiles();

    // 縄張り（業者の色で丁目を塗る。配達の草案 18 章）
    const terr = this.mpp <= TERRITORY_MPP ? this.opts.game?.territory?.() : null;
    if (terr) {
      const [ax, ay] = [(terr.x0 - v.x0) / this.mpp, (terr.z0 - v.z0) / this.mpp];
      ctx.save();
      ctx.globalAlpha = 0.42;
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(terr.image, ax, ay, (terr.x1 - terr.x0) / this.mpp, (terr.z1 - terr.z0) / this.mpp);
      ctx.restore();
    }

    // 道路
    this.wantBlocks();
    if (this.showRoads && this.mpp <= ROADS_VISIBLE_MPP) {
      if (this.pathsDirty) this.rebuildPaths();
      ctx.save();
      ctx.translate(W / 2, H / 2);
      ctx.scale(1 / this.mpp, 1 / this.mpp);
      ctx.translate(this.anchorX - this.cx, this.anchorZ - this.cz);
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      const zoomK = Math.max(0.6, Math.min(2.2, 6 / Math.sqrt(this.mpp)));
      if (this.selected) {
        const r = this.selected;
        const path = new Path2D();
        for (let i = 0; i < r.points.length; i += 3) {
          const x = r.points[i] + r.origin[0] - this.anchorX;
          const zz = r.points[i + 2] + r.origin[1] - this.anchorZ;
          if (i === 0) path.moveTo(x, zz);
          else path.lineTo(x, zz);
        }
        ctx.strokeStyle = "rgba(0,240,255,0.9)";
        ctx.lineWidth = (CLASS_PX[r.cls] * zoomK + 8) * this.mpp;
        ctx.stroke(path);
      }
      const game = this.opts.game;
      if (game) {
        // 未走行の道は細く、走った道は太く
        const unridden = (c: CanvasRenderingContext2D) => {
          c.strokeStyle = "rgba(20,20,20,0.6)";
          for (const p of this.paths) {
            c.lineWidth = (CLASS_PX[p.cls] * zoomK * 0.55 + 1.2) * this.mpp;
            c.stroke(p.path);
          }
          c.strokeStyle = "rgba(250,250,245,0.95)";
          for (const p of this.paths) {
            c.lineWidth = CLASS_PX[p.cls] * zoomK * 0.55 * this.mpp;
            c.stroke(p.path);
          }
        };
        if (this.riddenVersion !== game.ridden.version || !this.riddenPath) this.rebuildRidden(game.ridden);
        const reveal = game.reveal?.() ?? null;
        if (reveal === null) unridden(ctx);
        else this.drawRevealed(ctx, unridden, reveal, game.player());
        ctx.strokeStyle = "rgba(30,14,0,0.8)";
        ctx.lineWidth = (5.5 * zoomK + 2) * this.mpp;
        ctx.stroke(this.riddenPath!);
        ctx.strokeStyle = "#ff8a1f";
        ctx.lineWidth = 5.5 * zoomK * this.mpp;
        ctx.stroke(this.riddenPath!);
      } else {
        // 縁取り（自転車道は緑）
        for (const p of this.paths) {
          ctx.strokeStyle = p.cls === 4 ? "rgba(0,120,60,0.95)" : "rgba(20,20,20,0.75)";
          ctx.lineWidth = (CLASS_PX[p.cls] * zoomK + (p.cls === 4 ? 2.4 : 1.6)) * this.mpp;
          ctx.stroke(p.path);
        }
        for (const p of this.paths) {
          ctx.lineWidth = CLASS_PX[p.cls] * zoomK * this.mpp;
          ctx.strokeStyle = GRADE_COLORS[p.bucket];
          ctx.stroke(p.path);
        }
      }
      // 橋は白い縁の二重線、トンネルは灰色の破線（冒険では、走っていない所に出さないので描かない）
      if (game?.reveal?.() == null) {
        ctx.strokeStyle = "#ffffff";
        ctx.lineWidth = 2 * this.mpp;
        ctx.setLineDash([3 * this.mpp, 2 * this.mpp]);
        ctx.stroke(this.bridgePath);
        ctx.strokeStyle = "#6a6a6a";
        ctx.lineWidth = 3 * this.mpp;
        ctx.setLineDash([4 * this.mpp, 3 * this.mpp]);
        ctx.stroke(this.tunnelPath);
        ctx.setLineDash([]);
      }
      ctx.restore();
    }

    const toScreen = (x: number, zz: number) => [(x - v.x0) / this.mpp, (zz - v.z0) / this.mpp] as const;

    // 鉄道: 黒と白の破線（日本の地図の慣習に近い）、トンネルは細い破線、廃線は点線。駅は四角
    if (this.showRails && !this.opts.game && this.mpp <= RAILS_VISIBLE_MPP) {
      this.wantRail();
      if (!this.railPaths) this.rebuildRailPaths();
      const rp = this.railPaths!;
      ctx.save();
      ctx.translate(W / 2, H / 2);
      ctx.scale(1 / this.mpp, 1 / this.mpp);
      ctx.translate(this.anchorX - this.cx, this.anchorZ - this.cz);
      const px = this.mpp;
      ctx.lineCap = "butt";
      ctx.strokeStyle = "rgba(90,70,50,0.85)";
      ctx.lineWidth = 2 * px;
      ctx.setLineDash([2 * px, 3 * px]);
      ctx.stroke(rp.abandoned);
      ctx.setLineDash([]);
      ctx.strokeStyle = "#1a1a1a";
      ctx.lineWidth = 5 * px;
      ctx.stroke(rp.open);
      ctx.strokeStyle = "#ffffff";
      ctx.lineWidth = 3 * px;
      ctx.setLineDash([10 * px, 10 * px]);
      ctx.stroke(rp.open);
      ctx.setLineDash([]);
      // トンネルは地図の色を透かした破線にする
      ctx.strokeStyle = "rgba(255,255,255,0.75)";
      ctx.lineWidth = 6 * px;
      ctx.stroke(rp.tunnel);
      ctx.strokeStyle = "#1a1a1a";
      ctx.lineWidth = 1.5 * px;
      ctx.setLineDash([4 * px, 3 * px]);
      ctx.stroke(rp.tunnel);
      ctx.setLineDash([]);
      ctx.restore();
      // 駅
      const seen = new Set<string>();
      ctx.font = "11px sans-serif";
      for (const l of this.rails.values()) {
        if (l.status !== "open") continue;
        for (const st of l.stations) {
          const key = st.node ?? st.id;
          if (seen.has(key)) continue;
          seen.add(key);
          const p = railPoint(l, st.s);
          if (p.x < v.x0 || p.x > v.x1 || p.z < v.z0 || p.z > v.z1) continue;
          const [sx, sy] = toScreen(p.x, p.z);
          const big = st.kind === "hub" || st.kind === "terminus";
          const r = big ? 5 : 3.5;
          ctx.fillStyle = st.kind === "passing" ? "#f2c230" : "#ffffff";
          ctx.strokeStyle = "#111";
          ctx.lineWidth = 1.5;
          ctx.fillRect(sx - r, sy - r, r * 2, r * 2);
          ctx.strokeRect(sx - r, sy - r, r * 2, r * 2);
          if (this.mpp <= (big ? 60 : 15)) {
            ctx.fillStyle = "#111";
            ctx.strokeStyle = "rgba(255,255,255,0.85)";
            ctx.lineWidth = 3;
            ctx.strokeText(`${st.name}駅`, sx + r + 3, sy + 4);
            ctx.fillText(`${st.name}駅`, sx + r + 3, sy + 4);
          }
        }
      }
    }

    // 接続点（拡大時）
    if (this.showRoads && this.mpp <= 6) {
      ctx.fillStyle = "#ffffff";
      ctx.strokeStyle = "#222";
      ctx.lineWidth = 1;
      for (const j of this.junctions.values()) {
        if (j.x < v.x0 || j.x > v.x1 || j.z < v.z0 || j.z > v.z1) continue;
        const [sx, sy] = toScreen(j.x, j.z);
        ctx.beginPath();
        ctx.arc(sx, sy, 3, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      }
    }

    // 立ち寄り地点
    if (this.showPois && this.mpp <= ROADS_VISIBLE_MPP) {
      const byId = this.roads;
      const order = { viewpoint: 0, cafe: 1, pass: 2 } as const;
      const list = [...this.pois.values()].sort((a, b) => order[a.kind] - order[b.kind]);
      for (const p of list) {
        const rd = byId.get(p.road)?.road;
        if (!rd) continue;
        const pos = roadPoint(rd, p.s);
        if (pos.x < v.x0 || pos.x > v.x1 || pos.z < v.z0 || pos.z > v.z1) continue;
        const [sx, sy] = toScreen(pos.x, pos.z);
        drawPoi(ctx, p.kind, sx, sy);
        if (this.opts.game?.stamped().has(p.id)) {
          // 立ち寄った店は印を足す
          ctx.beginPath();
          ctx.arc(sx, sy, 9, 0, Math.PI * 2);
          ctx.strokeStyle = "#ff8a1f";
          ctx.lineWidth = 2.5;
          ctx.stroke();
        }
        if (this.mpp <= 8) label(ctx, p.name, sx + 8, sy + 4, 11, "#1b1b1b");
      }
    }

    // 立ち寄る所（店は「食」、自転車店は「自」、燃料店は「車」の丸。自販機は水色の点）
    for (const r of this.opts.game?.rests?.() ?? []) {
      if (r.x < v.x0 || r.x > v.x1 || r.z < v.z0 || r.z > v.z1) continue;
      // 引いた縮尺では出さない（多くて地図が見えなくなる）。自販機はさらに寄った時だけ
      if (this.mpp > (r.kind === "vending" ? 3 : 7)) continue;
      const [sx, sy] = toScreen(r.x, r.z);
      ctx.beginPath();
      ctx.arc(sx, sy, r.kind === "vending" ? 4 : 8, 0, Math.PI * 2);
      ctx.fillStyle = r.kind === "vending" ? REST_COLORS.vending : r.kind === "bike" ? REST_COLORS.bike : r.kind === "car" ? REST_COLORS.car : REST_COLORS.shop;
      ctx.fill();
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = "#ffffff";
      ctx.stroke();
      if (r.kind !== "vending") {
        ctx.fillStyle = "#ffffff";
        ctx.font = "bold 10px sans-serif";
        ctx.textAlign = "center";
        ctx.fillText(REST_MARK[r.kind] ?? "", sx, sy + 3.5);
        ctx.textAlign = "start";
      }
      if (this.mpp <= 3) label(ctx, r.name, sx + 10, sy + 4, 11, "#1b1b1b");
    }

    // 名所（どの縮尺でも出す。行った名所は塗る）
    for (const lm of this.opts.game?.landmarks?.() ?? []) {
      if (lm.x < v.x0 || lm.x > v.x1 || lm.z < v.z0 || lm.z > v.z1) continue;
      const [sx, sy] = toScreen(lm.x, lm.z);
      drawLandmark(ctx, sx, sy, lm.visited, lm.goal, 1);
      if (this.mpp <= 40) label(ctx, lm.name, sx + 10, sy + 4, 12, "#1b1b1b");
    }

    // 結節点
    for (const n of this.nodes.values()) {
      if (n.x < v.x0 || n.x > v.x1 || n.z < v.z0 || n.z > v.z1) continue;
      const [sx, sy] = toScreen(n.x, n.z);
      const r = n.kind === "town" ? 6 : n.kind === "village" ? 4 : 2.5;
      ctx.beginPath();
      ctx.arc(sx, sy, r, 0, Math.PI * 2);
      ctx.fillStyle = n.kind === "town" ? "#c0262d" : n.kind === "village" ? "#f2f2f2" : "#888";
      ctx.fill();
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = "#202020";
      ctx.stroke();
      if ((n.kind === "town" && this.mpp <= 60) || (n.kind === "village" && this.mpp <= 20))
        label(ctx, n.name, sx + r + 3, sy - r - 1, n.kind === "town" ? 14 : 12, "#111");
    }

    // 丁目の名前（拡大時。配達の草案 13 章）
    const book = this.opts.game?.addresses;
    if (book && this.mpp <= ADDRESS_SHORT_MPP) {
      const full = this.mpp <= ADDRESS_FULL_MPP;
      // 行き先の印を付けた丁目は印の横に名前を出すので、ここでは描かない
      const marked = new Set((this.opts.game?.marks?.() ?? []).map((m) => m.name));
      ctx.textAlign = "center";
      for (const p of book.points) {
        if (p.x < v.x0 || p.x > v.x1 || p.z < v.z0 || p.z > v.z1 || marked.has(p.name)) continue;
        const [sx, sy] = toScreen(p.x, p.z);
        label(ctx, full ? p.name : shortAddress(p), sx, sy + 4, full ? 12 : 11, "#3a3a52");
      }
      ctx.textAlign = "start";
    }
    // 業者の営業所（色の四角。拡大時は業者の名前）
    if (terr)
      for (const d of this.opts.game?.depots?.() ?? []) {
        if (d.x < v.x0 || d.x > v.x1 || d.z < v.z0 || d.z > v.z1) continue;
        const [sx, sy] = toScreen(d.x, d.z);
        ctx.fillStyle = d.color;
        ctx.fillRect(sx - 6, sy - 6, 12, 12);
        ctx.lineWidth = 2;
        ctx.strokeStyle = "#ffffff";
        ctx.strokeRect(sx - 6, sy - 6, 12, 12);
        if (this.mpp <= 2.6) label(ctx, `${d.company} 営業所`, sx + 9, sy + 4, 12, "#202020");
      }
    // 長距離の便: 経路の線、行き先の名前、トラック（向かう = 塗り、戻る = 白抜き）
    for (const f of this.opts.game?.freight?.() ?? []) {
      ctx.beginPath();
      for (let i = 0; i < f.path.length; i += 2) {
        const [sx, sy] = toScreen(f.path[i], f.path[i + 1]);
        if (i === 0) ctx.moveTo(sx, sy);
        else ctx.lineTo(sx, sy);
      }
      ctx.lineWidth = 5;
      ctx.strokeStyle = "rgba(255,255,255,0.8)";
      ctx.stroke();
      ctx.lineWidth = 2.5;
      ctx.strokeStyle = f.color;
      ctx.setLineDash([10, 6]);
      ctx.stroke();
      ctx.setLineDash([]);
      const n = f.path.length;
      const [ex, ey] = toScreen(f.path[n - 2], f.path[n - 1]);
      label(ctx, `便 ${f.town}`, ex + 8, ey - 6, 13, "#202020");
      for (const t of f.trucks) {
        const [sx, sy] = toScreen(t.x, t.z);
        ctx.fillStyle = t.back ? "#ffffff" : f.color;
        ctx.strokeStyle = t.back ? f.color : "#ffffff";
        ctx.lineWidth = 2;
        ctx.fillRect(sx - 7, sy - 5, 14, 10);
        ctx.strokeRect(sx - 7, sy - 5, 14, 10);
      }
    }
    // 縄張りの凡例（左下。下の帯の上）
    const leg = terr ? (this.opts.game?.legend?.() ?? []) : [];
    if (leg.length) {
      const rows = leg.slice(0, 8);
      const x = 10;
      let y = H - 62 - rows.length * 18;
      ctx.fillStyle = "rgba(20,24,30,0.72)";
      ctx.fillRect(x - 4, y - 14, 170, rows.length * 18 + 8);
      for (const r of rows) {
        ctx.fillStyle = r.color;
        ctx.fillRect(x + 2, y - 9, 11, 11);
        ctx.fillStyle = "#f2f2f2";
        ctx.font = "12px sans-serif";
        ctx.fillText(r.name, x + 19, y + 1);
        y += 18;
      }
    }
    // 行き先までの経路の線
    const route = this.opts.game?.route?.();
    if (route && route.length >= 4) {
      ctx.save();
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.beginPath();
      for (let i = 0; i < route.length; i += 2) {
        const [sx, sy] = toScreen(route[i], route[i + 1]);
        if (i === 0) ctx.moveTo(sx, sy);
        else ctx.lineTo(sx, sy);
      }
      ctx.strokeStyle = "rgba(4,24,32,0.9)";
      ctx.lineWidth = 9;
      ctx.stroke();
      ctx.strokeStyle = ROUTE_COLOR;
      ctx.lineWidth = 5;
      ctx.stroke();
      ctx.restore();
    }
    // 配達の行き先の印。受け取り・届け先は色の付いた大きな針と名前の札。画面の外なら縁に向きの印
    const pulse = (performance.now() % 1400) / 1400;
    const all = this.opts.game?.marks?.() ?? [];
    this.markHits = [];
    for (const m of [...all].sort((a, b) => Number(!!a.active) - Number(!!b.active))) {
      const [sx, sy] = toScreen(m.x, m.z);
      if (!m.kind) {
        if (m.x < v.x0 || m.x > v.x1 || m.z < v.z0 || m.z > v.z1) continue;
        ctx.beginPath();
        ctx.arc(sx, sy, 11, 0, Math.PI * 2);
        ctx.fillStyle = "rgba(255,138,31,0.35)";
        ctx.fill();
        ctx.lineWidth = 3;
        ctx.strokeStyle = "#ff8a1f";
        ctx.stroke();
        label(ctx, m.name, sx + 14, sy + 4, 13, "#7a3600");
        continue;
      }
      const color = TARGET_COLORS[m.kind];
      const W = this.cssW;
      const H = this.cssH;
      const pad = 26;
      if (sx < pad || sx > W - pad || sy < pad || sy > H - pad) {
        // 画面の外: 中心から行き先へ向かう線が縁と交わる所に、向きの三角
        const cx = W / 2, cy = H / 2;
        const ddx = sx - cx, ddy = sy - cy;
        const t = Math.min((W / 2 - pad) / Math.abs(ddx || 1e-6), (H / 2 - pad) / Math.abs(ddy || 1e-6));
        const ex = cx + ddx * t, ey = cy + ddy * t;
        const l = Math.hypot(ddx, ddy) || 1;
        const ux = ddx / l, uy = ddy / l;
        ctx.beginPath();
        ctx.moveTo(ex + ux * 14, ey + uy * 14);
        ctx.lineTo(ex - ux * 6 - uy * 11, ey - uy * 6 + ux * 11);
        ctx.lineTo(ex - ux * 6 + uy * 11, ey - uy * 6 - ux * 11);
        ctx.closePath();
        ctx.fillStyle = color;
        ctx.fill();
        ctx.lineWidth = 2;
        ctx.strokeStyle = "#ffffff";
        ctx.stroke();
        if (m.id !== undefined) this.markHits.push({ id: m.id, x0: ex - 22, y0: ey - 22, x1: ex + 22, y1: ey + 22 });
        continue;
      }
      // 広がる輪
      ctx.beginPath();
      ctx.arc(sx, sy, 8 + pulse * 26, 0, Math.PI * 2);
      ctx.strokeStyle = color;
      ctx.globalAlpha = 1 - pulse;
      ctx.lineWidth = 3;
      ctx.stroke();
      ctx.globalAlpha = 1;
      // 針（先が行き先）
      const hgt = m.active ? 40 : 32;
      const rad = m.active ? 13 : 10;
      ctx.beginPath();
      ctx.moveTo(sx, sy);
      ctx.bezierCurveTo(sx - rad * 0.4, sy - hgt * 0.45, sx - rad * 1.05, sy - hgt + rad * 0.9, sx - rad, sy - hgt + rad);
      ctx.arc(sx, sy - hgt + rad, rad, Math.PI, 0);
      ctx.bezierCurveTo(sx + rad * 1.05, sy - hgt + rad * 0.9, sx + rad * 0.4, sy - hgt * 0.45, sx, sy);
      ctx.closePath();
      ctx.fillStyle = color;
      ctx.fill();
      ctx.lineWidth = 2.5;
      ctx.strokeStyle = "#ffffff";
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(sx, sy - hgt + rad, rad * 0.42, 0, Math.PI * 2);
      ctx.fillStyle = "#ffffff";
      ctx.fill();
      // 名前の札
      const text = `${TARGET_LABELS[m.kind]}　${m.name}`;
      ctx.font = "bold 13px sans-serif";
      const tw = ctx.measureText(text).width;
      // 右に入らなければ針の左に出す
      const bx = sx + rad + 6 + tw + 14 <= W - 4 ? sx + rad + 6 : sx - rad - 6 - tw - 14;
      const by = sy - hgt + rad - 11;
      ctx.fillStyle = "rgba(14,18,24,0.88)";
      ctx.beginPath();
      ctx.roundRect(bx, by, tw + 14, 22, 6);
      ctx.fill();
      ctx.fillStyle = color;
      ctx.fillRect(bx, by, 4, 22);
      ctx.fillStyle = "#ffffff";
      ctx.fillText(text, bx + 9, by + 16);
      if (m.id !== undefined) {
        // 針と札（指で押しやすいよう少し広く）
        this.markHits.push({ id: m.id, x0: sx - rad - 10, y0: sy - hgt - 10, x1: sx + rad + 10, y1: sy + 8 });
        this.markHits.push({ id: m.id, x0: bx - 4, y0: by - 6, x1: bx + tw + 18, y1: by + 28 });
      }
    }

    // 印（起点候補の 15km 円）
    const mk = this.opts.mark;
    if (mk) {
      const [sx, sy] = toScreen(mk.x, mk.z);
      ctx.strokeStyle = "rgba(255,255,255,0.95)";
      ctx.lineWidth = 2;
      ctx.setLineDash([8, 6]);
      ctx.beginPath();
      ctx.arc(sx, sy, mk.r / this.mpp, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = "#ffffff";
      ctx.beginPath();
      ctx.arc(sx, sy, 5, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = "#000";
      ctx.stroke();
    }

    // 行き先と現在地
    const game = this.opts.game;
    if (game) {
      const g = game.goal();
      if (g) {
        const [sx, sy] = toScreen(g.x, g.z);
        ctx.beginPath();
        ctx.moveTo(sx, sy);
        ctx.lineTo(sx, sy - 22);
        ctx.strokeStyle = "#08202a";
        ctx.lineWidth = 2.5;
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(sx, sy - 22);
        ctx.lineTo(sx + 14, sy - 17);
        ctx.lineTo(sx, sy - 12);
        ctx.closePath();
        ctx.fillStyle = "#2fd0ff";
        ctx.fill();
        ctx.stroke();
      }
      const me = game.player();
      if (me) {
        const [sx, sy] = toScreen(me.x, me.z);
        const fx = me.dx, fz = me.dz;
        const px = -fz, pz = fx;
        ctx.beginPath();
        ctx.moveTo(sx + fx * 12, sy + fz * 12);
        ctx.lineTo(sx - fx * 7 + px * 8, sy - fz * 7 + pz * 8);
        ctx.lineTo(sx - fx * 3, sy - fz * 3);
        ctx.lineTo(sx - fx * 7 - px * 8, sy - fz * 7 - pz * 8);
        ctx.closePath();
        ctx.fillStyle = "#ffffff";
        ctx.fill();
        ctx.strokeStyle = "#111";
        ctx.lineWidth = 2;
        ctx.stroke();
      }
    }

    this.opts.onStatus?.(this.status());
  }

  private fogCanvas: HTMLCanvasElement | null = null;
  private maskCanvas: HTMLCanvasElement | null = null;

  /**
   * 冒険の地図（冒険の草案 2 章）: 未走行の道を、走った道と現在地から reveal m 以内だけ描く。
   * 別の画面に描いてから、走った道を太く引いた形と現在地の円で切り抜いて重ねる
   */
  private drawRevealed(ctx: CanvasRenderingContext2D, draw: (c: CanvasRenderingContext2D) => void, reveal: number, me: { x: number; z: number } | null) {
    const W = this.canvas.width;
    const H = this.canvas.height;
    const fit = (c: HTMLCanvasElement | null) => {
      const cv = c ?? document.createElement("canvas");
      if (cv.width !== W || cv.height !== H) {
        cv.width = W;
        cv.height = H;
      }
      return cv;
    };
    const fog = (this.fogCanvas = fit(this.fogCanvas));
    const mask = (this.maskCanvas = fit(this.maskCanvas));
    const t = ctx.getTransform();
    const f = fog.getContext("2d")!;
    const m = mask.getContext("2d")!;
    for (const c of [f, m]) {
      c.setTransform(1, 0, 0, 1, 0, 0);
      c.clearRect(0, 0, W, H);
      c.setTransform(t);
      c.lineCap = "round";
      c.lineJoin = "round";
    }
    draw(f);
    m.strokeStyle = "#000";
    m.lineWidth = reveal * 2;
    m.stroke(this.riddenPath!);
    if (me) {
      m.beginPath();
      m.arc(me.x - this.anchorX, me.z - this.anchorZ, reveal, 0, Math.PI * 2);
      m.fillStyle = "#000";
      m.fill();
    }
    f.setTransform(1, 0, 0, 1, 0, 0);
    f.globalCompositeOperation = "destination-in";
    f.drawImage(mask, 0, 0);
    f.globalCompositeOperation = "source-over";
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(fog, 0, 0);
    ctx.restore();
  }

  /** 走った区間が (x, z) から r m 以内にあるか（この地図に読み込んである道路で調べる。冒険のワープ） */
  nearRidden(ridden: RiddenLog, x: number, z: number, r: number): boolean {
    const r2 = r * r;
    for (const id of ridden.roads()) {
      const rd = this.roads.get(id)?.road;
      if (!rd) continue;
      const P = rd.points;
      const n = P.length / 3;
      const ds = rd.length / (n - 1);
      for (const [s0, s1] of ridden.runs(id)) {
        for (let i = Math.max(0, Math.floor(s0 / ds)); i <= Math.min(n - 1, Math.ceil(s1 / ds)); i++) {
          const dx = P[i * 3] + rd.origin[0] - x;
          const dz = P[i * 3 + 2] + rd.origin[1] - z;
          if (dx * dx + dz * dz <= r2) return true;
        }
      }
    }
    return false;
  }

  /** 走った区間の線（世界座標から anchor を引いた座標） */
  private rebuildRidden(ridden: RiddenLog) {
    this.riddenVersion = ridden.version;
    const path = new Path2D();
    for (const id of ridden.roads()) {
      const r = this.roads.get(id)?.road;
      if (!r) continue;
      const P = r.points;
      const n = P.length / 3;
      const ds = r.length / (n - 1);
      for (const [s0, s1] of ridden.runs(id)) {
        const i0 = Math.max(0, Math.floor(s0 / ds));
        const i1 = Math.min(n - 1, Math.ceil(s1 / ds));
        for (let i = i0; i <= i1; i += 2) {
          const x = P[i * 3] + r.origin[0] - this.anchorX;
          const z = P[i * 3 + 2] + r.origin[1] - this.anchorZ;
          if (i === i0) path.moveTo(x, z);
          else path.lineTo(x, z);
        }
      }
    }
    this.riddenPath = path;
  }
}

/** 線路の道のり s の位置（道路と同じ点列の形） */
export function railPoint(l: RailLine, s: number): { x: number; y: number; z: number } {
  return roadPoint(l as unknown as Road, s);
}

export function roadPoint(r: Road, s: number): { x: number; y: number; z: number } {
  const n = r.points.length / 3;
  const ds = r.length / (n - 1);
  let f = s / ds;
  f = Math.max(0, Math.min(n - 1, f));
  const i = Math.min(n - 2, Math.floor(f));
  const t = f - i;
  const P = r.points;
  return {
    x: r.origin[0] + P[i * 3] + (P[i * 3 + 3] - P[i * 3]) * t,
    y: P[i * 3 + 1] + (P[i * 3 + 4] - P[i * 3 + 1]) * t,
    z: r.origin[1] + P[i * 3 + 2] + (P[i * 3 + 5] - P[i * 3 + 2]) * t,
  };
}

function bounds(r: Road): Rect {
  let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
  for (let i = 0; i < r.points.length; i += 3) {
    const x = r.points[i] + r.origin[0];
    const z = r.points[i + 2] + r.origin[1];
    x0 = Math.min(x0, x);
    x1 = Math.max(x1, x);
    z0 = Math.min(z0, z);
    z1 = Math.max(z1, z);
  }
  return { x0, z0, x1, z1 };
}

function segDist2(px: number, pz: number, ax: number, az: number, bx: number, bz: number): number {
  const vx = bx - ax;
  const vz = bz - az;
  const vv = vx * vx + vz * vz;
  let t = vv > 0 ? ((px - ax) * vx + (pz - az) * vz) / vv : 0;
  t = Math.max(0, Math.min(1, t));
  const dx = ax + vx * t - px;
  const dz = az + vz * t - pz;
  return dx * dx + dz * dz;
}

function label(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, size: number, color: string) {
  ctx.font = `600 ${size}px system-ui, "Hiragino Sans", "Yu Gothic UI", sans-serif`;
  ctx.lineWidth = 3;
  ctx.strokeStyle = "rgba(255,255,255,0.9)";
  ctx.strokeText(text, x, y);
  ctx.fillStyle = color;
  ctx.fillText(text, x, y);
}

export const POI_COLORS = { cafe: "#8a4b16", pass: "#3b2f8f", viewpoint: "#0a7f86" } as const;

/** 名所の印: 星（行った名所は金色、まだは白、行き先は水色の縁） */
export function drawLandmark(ctx: CanvasRenderingContext2D, x: number, y: number, visited: boolean, goal: boolean, k: number) {
  ctx.beginPath();
  for (let i = 0; i < 10; i++) {
    const a = -Math.PI / 2 + (i * Math.PI) / 5;
    const r = (i % 2 ? 3.6 : 8.5) * k;
    if (i === 0) ctx.moveTo(x + Math.cos(a) * r, y + Math.sin(a) * r);
    else ctx.lineTo(x + Math.cos(a) * r, y + Math.sin(a) * r);
  }
  ctx.closePath();
  ctx.fillStyle = visited ? "#f2b632" : "#ffffff";
  ctx.fill();
  ctx.lineWidth = (goal ? 2.6 : 1.6) * k;
  ctx.strokeStyle = goal ? "#2fd0ff" : "#7a4a00";
  ctx.stroke();
}

export function drawPoi(ctx: CanvasRenderingContext2D, kind: Poi["kind"], x: number, y: number) {
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = "#fff";
  ctx.fillStyle = POI_COLORS[kind];
  ctx.beginPath();
  if (kind === "cafe") ctx.rect(x - 5, y - 5, 10, 10);
  else if (kind === "pass") {
    ctx.moveTo(x, y - 7);
    ctx.lineTo(x + 6, y + 4);
    ctx.lineTo(x - 6, y + 4);
    ctx.closePath();
  } else {
    ctx.moveTo(x, y - 6);
    ctx.lineTo(x + 6, y);
    ctx.lineTo(x, y + 6);
    ctx.lineTo(x - 6, y);
    ctx.closePath();
  }
  ctx.fill();
  ctx.stroke();
}

export { ROAD_CLASSES };
