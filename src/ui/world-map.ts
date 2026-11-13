// 2D 地図（モック仕様 4.10）。移動と拡大縮小、標高の陰影・景観の色・海・結節点・道路（等級で太さ、勾配で色）・
// 橋・立ち寄り地点。道路を選ぶと縦断図と数値を出す。後でゲーム内の世界地図の土台にする。

import { ROAD_CLASSES } from "../shared/world/constants.ts";
import type { Junction, Poi, Road, WorldNode } from "../shared/world/types.ts";
import type { CrossingInfo, Rect } from "../shared/world/world.ts";
import { TILE_PX } from "../workers/map-tile.ts";
import type { RegionPayload, WorldRequest, WorldResponse } from "../workers/world-protocol.ts";

export const GRADE_STEPS = [0.03, 0.05, 0.07, 0.09, 0.11];
export const GRADE_COLORS = ["#2f6fd0", "#1f9a52", "#d9b416", "#ee7a1a", "#d42424", "#7a1fa2"];
const CLASS_PX = [4.2, 3.2, 2.4, 1.8];
const BLOCK = 8000;
const ROADS_VISIBLE_MPP = 80;

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
  x: number;
  z: number;
  mpp: number;
  /** 起点候補などの印（中心と半径 m） */
  mark?: { x: number; z: number; r: number };
  onSelect?: (road: Road | null) => void;
  onStatus?: (s: MapStatus) => void;
}

export interface MapStatus {
  x: number;
  z: number;
  mpp: number;
  roads: number;
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
  private pathsDirty = false;
  private anchorX: number;
  private anchorZ: number;
  selected: Road | null = null;
  private opts: MapOptions;
  showRoads = true;
  showPois = true;

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
    const loop = () => {
      this.frame = requestAnimationFrame(loop);
      if (this.dirty) this.draw();
    };
    this.frame = requestAnimationFrame(loop);
  }

  private spawn(): Worker {
    const w = new Worker(new URL("../workers/world.worker.ts", import.meta.url), { type: "module" });
    w.onmessage = (ev: MessageEvent<WorldResponse>) => this.onWorker(ev.data);
    w.postMessage({ type: "init", seed: this.seed } satisfies WorldRequest);
    return w;
  }

  destroy() {
    cancelAnimationFrame(this.frame);
    for (const w of this.tileWorkers) w.terminate();
    this.roadWorker.terminate();
  }

  status(): MapStatus {
    let pendingTiles = 0;
    for (const t of this.tiles.values()) if (t.pending) pendingTiles++;
    return {
      x: this.cx,
      z: this.cz,
      mpp: this.mpp,
      roads: this.roads.size,
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

  /** 画面の点に最も近い道路を選ぶ（10px 以内） */
  private pick(px: number, py: number) {
    if (this.mpp > ROADS_VISIBLE_MPP) return;
    const p = this.toWorld(px, py);
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
    const groups = new Map<number, Path2D>();
    const bridge = new Path2D();
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
        bridge.moveTo(P[i0 * 3] + road.origin[0] - ax, P[i0 * 3 + 2] + road.origin[1] - az);
        for (let k = i0 + 1; k <= i1; k++) bridge.lineTo(P[k * 3] + road.origin[0] - ax, P[k * 3 + 2] + road.origin[1] - az);
      }
    }
    this.paths = [...groups.entries()]
      .map(([k, path]) => ({ cls: Math.floor(k / 10), bucket: k % 10, path }))
      .sort((a, b) => b.cls - a.cls);
    this.bridgePath = bridge;
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
      // 縁取り
      ctx.strokeStyle = "rgba(20,20,20,0.75)";
      for (const p of this.paths) {
        ctx.lineWidth = (CLASS_PX[p.cls] * zoomK + 1.6) * this.mpp;
        ctx.stroke(p.path);
      }
      for (const p of this.paths) {
        ctx.lineWidth = CLASS_PX[p.cls] * zoomK * this.mpp;
        ctx.strokeStyle = GRADE_COLORS[p.bucket];
        ctx.stroke(p.path);
      }
      // 橋は白い縁の二重線
      ctx.strokeStyle = "#ffffff";
      ctx.lineWidth = 2 * this.mpp;
      ctx.setLineDash([3 * this.mpp, 2 * this.mpp]);
      ctx.stroke(this.bridgePath);
      ctx.setLineDash([]);
      ctx.restore();
    }

    const toScreen = (x: number, zz: number) => [(x - v.x0) / this.mpp, (zz - v.z0) / this.mpp] as const;

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
        if (this.mpp <= 8) label(ctx, p.name, sx + 8, sy + 4, 11, "#1b1b1b");
      }
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

    this.opts.onStatus?.(this.status());
  }
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
