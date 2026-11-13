// 地形タイルの出し入れ（モック仕様 5.1）。近景 256m・中景 1,024m・遠景 4,096m の3段。
// 4 分木のように、近いタイルを 4×4 の子に分ける。子がそろうまでは親を表示して穴を作らない。
// 頂点計算は Worker。1フレームに取り付ける数・破棄する数に上限を置き、古い依頼の結果は捨てる。

import type { Towns } from "./towns.ts";
import * as THREE from "three";
import { Terrain } from "../shared/world/terrain.ts";
import { rectDist, type RoadClient } from "../workers/road-client.ts";
import { buildTile, ROAD_BLEND, ROAD_FLAT, type TileInput, type TileOutput } from "../workers/terrain-tile.ts";
import type { TerrainRequest, TerrainResponse } from "../workers/terrain.worker.ts";

export interface LevelSpec {
  size: number;
  cells: number;
  skirt: number;
  /** 道路に合わせるか（合わせる段は道路の読み込みを待つ） */
  conform: boolean;
}

export const LEVELS: LevelSpec[] = [
  { size: 256, cells: 32, skirt: 6, conform: true },
  { size: 1024, cells: 32, skirt: 30, conform: true },
  { size: 4096, cells: 32, skirt: 120, conform: false },
];

export interface TerrainRanges {
  /** 遠景を描く範囲 */
  far: number;
  /** 遠景タイルを中景に分ける距離 */
  splitFar: number;
  /** 中景タイルを近景に分ける距離 */
  splitMid: number;
}

export const RANGES_STANDARD: TerrainRanges = { far: 24000, splitFar: 2600, splitMid: 600 };
export const RANGES_LIGHT: TerrainRanges = { far: 12000, splitFar: 1800, splitMid: 380 };

interface Tile {
  key: string;
  level: number;
  tx: number;
  tz: number;
  mesh: THREE.Mesh | null;
  pending: boolean;
  /** 依頼の番号（古い結果を捨てるため） */
  req: number;
}

const keyOf = (l: number, tx: number, tz: number) => `${l}:${tx}:${tz}`;

export class TerrainStreamer {
  readonly group = new THREE.Group();
  private tiles = new Map<string, Tile>();
  private workers: Worker[] = [];
  private busy: number[] = [];
  private queue: Tile[] = [];
  private ready: { tile: Tile; out: TileOutput; req: number }[] = [];
  private releaseQueue: THREE.Mesh[] = [];
  private reqSeq = 1;
  private reqTile = new Map<number, Tile>();
  private fallback: Terrain | null = null;
  ranges: TerrainRanges = RANGES_STANDARD;
  /** 植生の密度の倍率（軽量で半分） */
  vegDensity = 1;
  /** 町・喫茶店の敷地（あれば植生を避ける） */
  towns: Towns | null = null;
  /** 1フレームに取り付ける数・破棄する数 */
  attachPerFrame = 4;
  releasePerFrame = 6;
  readonly buildMs: number[] = [];
  workerError: string | null = null;
  private lastCx = NaN;
  private lastCz = NaN;
  private visibleKeys = new Set<string>();
  private originX = 0;
  private originZ = 0;

  constructor(
    private seed: number,
    private material: THREE.Material,
    private roads: RoadClient,
  ) {
    const n = Math.max(1, Math.min(3, (navigator.hardwareConcurrency || 4) - 2));
    try {
      for (let i = 0; i < n; i++) {
        const w = new Worker(new URL("../workers/terrain.worker.ts", import.meta.url), { type: "module" });
        w.onmessage = (ev: MessageEvent<TerrainResponse>) => this.onMessage(i, ev.data);
        w.onerror = (e) => {
          e.preventDefault();
          this.failWorkers(e.message);
        };
        w.postMessage({ type: "init", seed } satisfies TerrainRequest);
        this.workers.push(w);
        this.busy.push(0);
      }
    } catch (e) {
      this.failWorkers(String(e));
    }
    if (!this.workers.length) this.fallback = new Terrain(seed);
  }

  private failWorkers(message: string) {
    this.workerError = message;
    for (const w of this.workers) w.terminate();
    this.workers = [];
    this.busy = [];
    this.fallback = new Terrain(this.seed);
    this.lastCx = NaN;
    // 依頼中のものは依頼し直す
    for (const t of this.reqTile.values()) {
      t.pending = false;
    }
    this.reqTile.clear();
  }

  destroy() {
    for (const w of this.workers) w.terminate();
    for (const t of this.tiles.values()) if (t.mesh) this.disposeMesh(t.mesh);
    for (const m of this.releaseQueue) this.disposeMesh(m);
  }

  setOrigin(x: number, z: number) {
    this.originX = x;
    this.originZ = z;
    for (const t of this.tiles.values()) if (t.mesh) this.place(t);
  }

  private place(t: Tile) {
    const size = LEVELS[t.level].size;
    t.mesh!.position.set(t.tx * size - this.originX, 0, t.tz * size - this.originZ);
    t.mesh!.updateMatrix();
  }

  /** 表示するタイルの葉と、その祖先（予備として読み込む）を決める */
  private desired(cx: number, cz: number): { leaves: string[]; all: Map<string, number> } {
    const r = this.ranges;
    const leaves: string[] = [];
    const all = new Map<string, number>();
    const F = LEVELS[2].size;
    const M = LEVELS[1].size;
    const Nn = LEVELS[0].size;
    for (let tz = Math.floor((cz - r.far) / F); tz <= Math.floor((cz + r.far) / F); tz++)
      for (let tx = Math.floor((cx - r.far) / F); tx <= Math.floor((cx + r.far) / F); tx++) {
        const rect = { x0: tx * F, z0: tz * F, x1: (tx + 1) * F, z1: (tz + 1) * F };
        const d = rectDist(rect, cx, cz);
        if (d > r.far) continue;
        all.set(keyOf(2, tx, tz), d);
        if (d > r.splitFar) {
          leaves.push(keyOf(2, tx, tz));
          continue;
        }
        for (let mz = tz * 4; mz < tz * 4 + 4; mz++)
          for (let mx = tx * 4; mx < tx * 4 + 4; mx++) {
            const mr = { x0: mx * M, z0: mz * M, x1: (mx + 1) * M, z1: (mz + 1) * M };
            const md = rectDist(mr, cx, cz);
            all.set(keyOf(1, mx, mz), md);
            if (md > r.splitMid) {
              leaves.push(keyOf(1, mx, mz));
              continue;
            }
            for (let nz = mz * 4; nz < mz * 4 + 4; nz++)
              for (let nx = mx * 4; nx < mx * 4 + 4; nx++) {
                const nd = rectDist({ x0: nx * Nn, z0: nz * Nn, x1: (nx + 1) * Nn, z1: (nz + 1) * Nn }, cx, cz);
                all.set(keyOf(0, nx, nz), nd);
                leaves.push(keyOf(0, nx, nz));
              }
          }
      }
    return { leaves, all };
  }

  /** 毎フレーム呼ぶ。カメラの世界座標 (cx, cz) */
  update(cx: number, cz: number) {
    const moved = !(Math.abs(cx - this.lastCx) < 16 && Math.abs(cz - this.lastCz) < 16);
    if (moved) {
      this.lastCx = cx;
      this.lastCz = cz;
      const { all } = this.desired(cx, cz);
      // 要らなくなったタイルを破棄の列へ
      for (const [key, t] of this.tiles) {
        if (all.has(key)) continue;
        if (t.mesh) this.releaseQueue.push(t.mesh);
        t.mesh = null;
        if (t.pending) this.reqTile.delete(t.req);
        this.tiles.delete(key);
      }
      // 新しく要るタイルを作る（遠い段から、近い順）
      const order = [...all.entries()].sort((a, b) => a[1] - b[1]);
      for (const [key] of order) {
        if (this.tiles.has(key)) continue;
        const [l, tx, tz] = key.split(":").map(Number);
        this.tiles.set(key, { key, level: l, tx, tz, mesh: null, pending: false, req: 0 });
      }
      this.queue = [...this.tiles.values()]
        .filter((t) => !t.mesh && !t.pending)
        .sort((a, b) => (all.get(a.key)! - all.get(b.key)!) || a.level - b.level);
    }
    this.dispatch();
    this.attach();
    this.release();
    if (moved || this.dirtyVisible) this.updateVisibility(cx, cz);
  }

  private dirtyVisible = true;

  private dispatch() {
    if (this.fallback) {
      // Worker が使えない時は1フレームに1枚だけメインスレッドで作る
      const t = this.nextReady();
      if (!t) return;
      const req = this.reqSeq++;
      const t0 = performance.now();
      const out = buildTile(this.fallback, this.input(t));
      this.buildMs.push(performance.now() - t0);
      this.ready.push({ tile: t, out, req });
      t.req = req;
      t.pending = true;
      return;
    }
    for (let w = 0; w < this.workers.length; w++) {
      while (this.busy[w] < 2) {
        const t = this.nextReady();
        if (!t) return;
        const req = this.reqSeq++;
        t.req = req;
        t.pending = true;
        this.reqTile.set(req, t);
        this.busy[w]++;
        this.workers[w].postMessage({ type: "tile", id: req, input: this.input(t) } satisfies TerrainRequest);
      }
    }
  }

  /** 列の先頭から、道路の読み込みを待たずに作れるタイル */
  private nextReady(): Tile | null {
    for (let i = 0; i < this.queue.length; i++) {
      const t = this.queue[i];
      if (t.mesh || t.pending || !this.tiles.has(t.key)) {
        this.queue.splice(i--, 1);
        continue;
      }
      const spec = LEVELS[t.level];
      if (spec.conform && !this.roads.ready(this.tileRect(t, ROAD_FLAT + ROAD_BLEND + spec.size / spec.cells + 8))) continue;
      // 建物の敷地が決まるまで待つ（植生を敷地に置かないため）
      if (t.level < 2 && this.towns && !this.towns.ready(this.tileRect(t))) continue;
      this.queue.splice(i, 1);
      return t;
    }
    return null;
  }

  private tileRect(t: Tile, margin = 0) {
    const s = LEVELS[t.level].size;
    return { x0: t.tx * s - margin, z0: t.tz * s - margin, x1: (t.tx + 1) * s + margin, z1: (t.tz + 1) * s + margin };
  }

  private input(t: Tile): TileInput {
    const spec = LEVELS[t.level];
    const step = spec.size / spec.cells;
    return {
      x0: t.tx * spec.size,
      z0: t.tz * spec.size,
      size: spec.size,
      cells: spec.cells,
      skirt: spec.skirt,
      roads: spec.conform ? this.roads.pack(this.tileRect(t), ROAD_FLAT + ROAD_BLEND + step + 8, t.level === 0 ? 1 : 2) : null,
      uvRepeat: 16,
      lots: t.level < 2 && this.towns ? this.towns.lotsIn(this.tileRect(t)) : null,
      vegDetail: t.level === 0 ? 2 : t.level === 1 ? 1 : 0,
      vegDensity: this.vegDensity,
    };
  }

  private onMessage(w: number, msg: TerrainResponse) {
    this.busy[w] = Math.max(0, this.busy[w] - 1);
    const t = this.reqTile.get(msg.id);
    this.reqTile.delete(msg.id);
    if (msg.type === "error") {
      console.error("terrain worker", msg.message);
      if (t) t.pending = false;
      return;
    }
    this.buildMs.push(msg.ms);
    if (this.buildMs.length > 2000) this.buildMs.splice(0, 1000);
    // 古い依頼（もう要らないタイル）の結果は捨てる
    if (!t || t.req !== msg.id || !this.tiles.has(t.key)) return;
    this.ready.push({ tile: t, out: msg.out, req: msg.id });
  }

  private attach() {
    let n = 0;
    while (this.ready.length && n < this.attachPerFrame) {
      const { tile, out, req } = this.ready.shift()!;
      if (tile.req !== req || !this.tiles.has(tile.key)) continue;
      tile.pending = false;
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.BufferAttribute(out.position, 3));
      g.setAttribute("normal", new THREE.BufferAttribute(out.normal, 3));
      g.setAttribute("color", new THREE.BufferAttribute(out.color, 3));
      g.setAttribute("uv", new THREE.BufferAttribute(out.uv, 2));
      g.setIndex(new THREE.BufferAttribute(out.index, 1));
      const s = LEVELS[tile.level].size;
      g.boundingBox = new THREE.Box3(new THREE.Vector3(0, out.minY - LEVELS[tile.level].skirt, 0), new THREE.Vector3(s, out.maxY, s));
      g.boundingSphere = g.boundingBox.getBoundingSphere(new THREE.Sphere());
      const mesh = new THREE.Mesh(g, this.material);
      mesh.name = "terrain";
      mesh.userData.tile = tile.key;
      mesh.userData.level = tile.level;
      mesh.userData.veg = out.veg;
      mesh.receiveShadow = true;
      mesh.matrixAutoUpdate = false;
      tile.mesh = mesh;
      this.place(tile);
      mesh.updateMatrix();
      mesh.visible = false;
      this.group.add(mesh);
      this.dirtyVisible = true;
      n++;
    }
  }

  private release() {
    for (let i = 0; i < this.releasePerFrame && this.releaseQueue.length; i++) this.disposeMesh(this.releaseQueue.shift()!);
  }

  private disposeMesh(m: THREE.Mesh) {
    this.group.remove(m);
    m.geometry.dispose();
  }

  /** 表示: 子がすべてそろっている所は子、そうでなければ親（親もなければそろっている子だけ） */
  private updateVisibility(cx: number, cz: number) {
    this.dirtyVisible = false;
    const { leaves } = this.desired(cx, cz);
    const leafSet = new Set(leaves);
    const show = new Set<string>();
    const readyMesh = (k: string) => !!this.tiles.get(k)?.mesh;
    // 遠景タイルごとに決める
    const farKeys = new Set<string>();
    for (const k of leaves) {
      const [l, tx, tz] = k.split(":").map(Number);
      const fx = Math.floor(tx / 4 ** (2 - l));
      const fz = Math.floor(tz / 4 ** (2 - l));
      farKeys.add(keyOf(2, fx, fz));
    }
    const cover = (l: number, tx: number, tz: number): string[] | null => {
      const k = keyOf(l, tx, tz);
      if (leafSet.has(k)) return readyMesh(k) ? [k] : null;
      if (l === 0) return null;
      const out: string[] = [];
      let complete = true;
      for (let z = tz * 4; z < tz * 4 + 4; z++)
        for (let x = tx * 4; x < tx * 4 + 4; x++) {
          const c = cover(l - 1, x, z);
          if (c) out.push(...c);
          else complete = false;
        }
      if (complete) return out;
      if (readyMesh(k)) return [k];
      // 親もない時は、そろっている子だけを出す（起動直後）
      return out.length ? out : null;
    };
    for (const fk of farKeys) {
      const [, fx, fz] = fk.split(":").map(Number);
      cover(2, fx, fz)?.forEach((k) => show.add(k));
    }
    for (const t of this.tiles.values()) if (t.mesh) t.mesh.visible = show.has(t.key);
    this.visibleKeys = show;
  }

  /** 表示している近景・中景のタイルの植生（世界座標の左上つき） */
  vegetationTiles(): { key: string; level: number; ox: number; oz: number; veg: Float32Array }[] {
    const out: { key: string; level: number; ox: number; oz: number; veg: Float32Array }[] = [];
    for (const t of this.tiles.values()) {
      if (!t.mesh || !t.mesh.visible || t.level > 1) continue;
      const veg = t.mesh.userData.veg as Float32Array | undefined;
      if (!veg || !veg.length) continue;
      const size = LEVELS[t.level].size;
      out.push({ key: t.key, level: t.level, ox: t.tx * size, oz: t.tz * size, veg });
    }
    return out;
  }

  /** 計測用 */
  stats() {
    let meshes = 0;
    let pending = 0;
    let waitingRoads = 0;
    for (const t of this.tiles.values()) {
      if (t.mesh) meshes++;
      if (t.pending) pending++;
    }
    for (const t of this.queue) if (LEVELS[t.level].conform) waitingRoads++;
    return {
      tiles: this.tiles.size,
      meshes,
      visible: this.visibleKeys.size,
      pending,
      queued: this.queue.length,
      waitingRoads,
      ready: this.ready.length,
      releasing: this.releaseQueue.length,
      byLevel: [0, 1, 2].map((l) => [...this.visibleKeys].filter((k) => k.startsWith(`${l}:`)).length),
    };
  }

  /** 近くのタイルがすべて表示されているか（起動・検査の待ち合わせ用） */
  settled(): boolean {
    const s = this.stats();
    return s.pending === 0 && s.queued === 0 && s.ready === 0 && this.visibleKeys.size > 0 && [...this.tiles.values()].every((t) => !!t.mesh);
  }
}
