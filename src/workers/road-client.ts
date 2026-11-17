// 道路生成 Worker の窓口（メインスレッド側）。カメラの周りの区画を読み込み、遠くを捨てる。
// Worker が使えない時は同じ World をメインスレッドで動かす（downhill-3D の streamed-world と同じ作法）。

import type { Poi, Road } from "../shared/world/types.ts";
import { type Rect, World } from "../shared/world/world.ts";
import type { HokkaidoWorld } from "../shared/world/hokkaido.ts";
import { type WorldChoice, workerInit } from "../world-choice.ts";
import { RoadNetwork } from "../sim/road-network.ts";
import type { PackedRoads } from "./terrain-tile.ts";
import type { RegionPayload, WorldRequest, WorldResponse } from "./world-protocol.ts";

export const ROAD_BLOCK = 4000;

interface RoadEntry {
  road: Road;
  bounds: Rect;
  blocks: Set<string>;
  /** 橋の上の点の印 */
  bridge: Uint8Array;
}

export class RoadClient {
  readonly net = new RoadNetwork();
  readonly pois = new Map<string, Poi>();
  private entries = new Map<string, RoadEntry>();
  private loaded = new Set<string>();
  private queue: string[] = [];
  private inFlight: string | null = null;
  private worker: Worker | null = null;
  private fallback: World | HokkaidoWorld | null = null;
  private reqId = 1;
  /** 読み込んだ区画で変わった範囲（地形タイルの作り直しには使わない。読み込み前のタイルは作らないため） */
  version = 0;
  readonly roadMs: number[] = [];
  workerError: string | null = null;
  radius: number;

  constructor(
    readonly seed: number,
    radius = 10000,
    /** 北海道の世界（省くと生成の世界） */
    readonly world?: WorldChoice,
  ) {
    this.radius = radius;
    try {
      this.worker = new Worker(new URL("./world.worker.ts", import.meta.url), { type: "module" });
      this.worker.onmessage = (ev: MessageEvent<WorldResponse>) => this.onMessage(ev.data);
      this.worker.onerror = (e) => {
        e.preventDefault();
        this.failWorker(e.message);
      };
      this.worker.postMessage({ type: "init", seed, ...workerInit(world) } satisfies WorldRequest);
    } catch (e) {
      this.failWorker(String(e));
    }
  }

  private failWorker(message: string) {
    this.workerError = message;
    this.worker?.terminate();
    this.worker = null;
    this.fallback = this.world?.local ?? new World(this.seed);
    if (this.inFlight) {
      this.queue.unshift(this.inFlight);
      this.inFlight = null;
    }
  }

  destroy() {
    this.worker?.terminate();
  }

  get pending(): number {
    return this.queue.length + (this.inFlight ? 1 : 0);
  }

  /** 区画がすべて読み込み済みか */
  ready(r: Rect): boolean {
    for (let bz = Math.floor(r.z0 / ROAD_BLOCK); bz <= Math.floor(r.z1 / ROAD_BLOCK); bz++)
      for (let bx = Math.floor(r.x0 / ROAD_BLOCK); bx <= Math.floor(r.x1 / ROAD_BLOCK); bx++)
        if (!this.loaded.has(`${bx},${bz}`)) return false;
    return true;
  }

  /** カメラの位置から読み込む区画と捨てる区画を決める */
  update(cx: number, cz: number) {
    const R = this.radius;
    const want: { key: string; d: number }[] = [];
    for (let bz = Math.floor((cz - R) / ROAD_BLOCK); bz <= Math.floor((cz + R) / ROAD_BLOCK); bz++)
      for (let bx = Math.floor((cx - R) / ROAD_BLOCK); bx <= Math.floor((cx + R) / ROAD_BLOCK); bx++) {
        const d = rectDist({ x0: bx * ROAD_BLOCK, z0: bz * ROAD_BLOCK, x1: (bx + 1) * ROAD_BLOCK, z1: (bz + 1) * ROAD_BLOCK }, cx, cz);
        if (d > R) continue;
        const key = `${bx},${bz}`;
        if (!this.loaded.has(key) && key !== this.inFlight) want.push({ key, d });
      }
    want.sort((a, b) => a.d - b.d);
    this.queue = want.map((w) => w.key);
    // 遠くの区画を捨てる
    const drop = R + ROAD_BLOCK * 1.5;
    let dropped = false;
    for (const key of this.loaded) {
      const [bx, bz] = key.split(",").map(Number);
      const d = rectDist({ x0: bx * ROAD_BLOCK, z0: bz * ROAD_BLOCK, x1: (bx + 1) * ROAD_BLOCK, z1: (bz + 1) * ROAD_BLOCK }, cx, cz);
      if (d <= drop) continue;
      this.loaded.delete(key);
      dropped = true;
      for (const [id, e] of this.entries) {
        e.blocks.delete(key);
        if (!e.blocks.size) {
          this.entries.delete(id);
          this.net.removeRoad(id);
          for (const [pid, p] of this.pois) if (p.road === id) this.pois.delete(pid);
        }
      }
    }
    if (dropped) {
      this.net.pruneJunctions();
      // 結節点（地名）も捨てる（走り続けても増えないように）
      for (const [id, n] of this.net.nodes) if (Math.abs(n.x - cx) > drop + ROAD_BLOCK || Math.abs(n.z - cz) > drop + ROAD_BLOCK) this.net.nodes.delete(id);
      const keep = drop + ROAD_BLOCK * 2;
      const msg: WorldRequest = { type: "prune", keep: { x0: cx - keep, z0: cz - keep, x1: cx + keep, z1: cz + keep } };
      if (this.worker) this.worker.postMessage(msg);
      else this.fallback?.prune(msg.keep);
      this.version++;
    }
    this.pump();
  }

  private pump() {
    if (this.inFlight || !this.queue.length) return;
    const key = this.queue.shift()!;
    this.inFlight = key;
    const [bx, bz] = key.split(",").map(Number);
    const rect = { x0: bx * ROAD_BLOCK, z0: bz * ROAD_BLOCK, x1: (bx + 1) * ROAD_BLOCK, z1: (bz + 1) * ROAD_BLOCK };
    if (this.worker) this.worker.postMessage({ type: "region", id: this.reqId++, rect } satisfies WorldRequest);
    else if (this.fallback) {
      // メインスレッドでは1フレームに1区画だけ
      const w = this.fallback;
      setTimeout(() => {
        const before = w.timings.length;
        const reg = w.region(rect);
        this.onMessage({
          type: "region",
          id: 0,
          data: { ...reg, timings: w.timings.slice(before).map((t) => ({ id: t.id, ms: t.ms })), ms: 0 },
        });
      }, 0);
    }
  }

  private onMessage(msg: WorldResponse) {
    if (msg.type === "error") {
      console.error("road worker", msg.message);
      if (this.inFlight) this.queue.push(this.inFlight);
      this.inFlight = null;
      return;
    }
    if (msg.type !== "region") return;
    const key = this.inFlight;
    this.inFlight = null;
    if (key) {
      this.add(key, msg.data);
      this.loaded.add(key);
    }
    this.version++;
    this.pump();
  }

  private add(block: string, d: RegionPayload) {
    for (const r of d.roads) {
      const e = this.entries.get(r.id);
      if (e) {
        e.blocks.add(block);
        continue;
      }
      const n = r.points.length / 3;
      const ds = r.length / (n - 1);
      // 点ごとの印: 1 = 橋、2 = トンネル（北海道の世界。地形を下げず、内壁と坑口を描く。北海道の草案 20 章）
      const bridge = new Uint8Array(n);
      for (const sp of r.spans) {
        const v = sp.kind === "tunnel" ? 2 : 1;
        const a = sp.kind === "tunnel" ? Math.ceil(sp.from / ds) : Math.floor(sp.from / ds);
        const b = sp.kind === "tunnel" ? Math.floor(sp.to / ds) : Math.ceil(sp.to / ds);
        for (let i = Math.max(0, a); i <= Math.min(n - 1, b); i++) bridge[i] = v;
      }
      this.entries.set(r.id, { road: r, bounds: roadBounds(r), blocks: new Set([block]), bridge });
      this.net.addRoad(r);
    }
    for (const j of d.junctions) this.net.addJunction(j);
    for (const n of d.nodes) this.net.nodes.set(n.id, n);
    for (const p of d.pois) if (this.entries.has(p.road)) this.pois.set(p.id, p);
    for (const t of d.timings) this.roadMs.push(t.ms);
    if (this.roadMs.length > 5000) this.roadMs.splice(0, this.roadMs.length - 5000);
  }

  roadEntries(): Iterable<RoadEntry> {
    return this.entries.values();
  }

  /** 点ごとの印（1 = 橋、2 = トンネル） */
  bridgeFlags(id: string): Uint8Array | undefined {
    return this.entries.get(id)?.bridge;
  }

  /** (x, z) がトンネルの中（道路の端から margin m 以内）なら路面の高さ、でなければ null（視点を山の上へ押し上げないため） */
  tunnelAt(x: number, z: number, margin: number): number | null {
    for (const e of this.entries.values()) {
      const b = e.bounds;
      const road = e.road;
      if (!road.spans.some((s) => s.kind === "tunnel")) continue;
      const hw = road.width / 2 + margin;
      if (x < b.x0 - hw || x > b.x1 + hw || z < b.z0 - hw || z > b.z1 + hw) continue;
      const P = road.points;
      const n = P.length / 3;
      const ox = road.origin[0];
      const oz = road.origin[1];
      for (let i = 0; i + 1 < n; i++) {
        if (e.bridge[i] !== 2 || e.bridge[i + 1] !== 2) continue;
        const ax = P[i * 3] + ox, az = P[i * 3 + 2] + oz;
        if (Math.abs(ax - x) > hw + 3 || Math.abs(az - z) > hw + 3) continue;
        const bx = P[i * 3 + 3] + ox, bz = P[i * 3 + 5] + oz;
        const dx = bx - ax, dz = bz - az;
        const l2 = dx * dx + dz * dz || 1;
        const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / l2));
        const ex = ax + dx * t - x, ez = az + dz * t - z;
        if (ex * ex + ez * ez <= hw * hw) return P[i * 3 + 1] + (P[i * 3 + 4] - P[i * 3 + 1]) * t;
      }
    }
    return null;
  }

  /**
   * (x, z) の路面の高さ（路面の上でなければ null）。道路の中心線と幅から求める（描いたメッシュに光線を当てない。
   * 交差点の多い市街地では、メッシュへの光線が 1 フレームに数十 ms かかったため）。
   */
  surfaceAt(x: number, z: number): number | null {
    let best: number | null = null;
    for (const e of this.entries.values()) {
      const b = e.bounds;
      const road = e.road;
      const hw = road.width / 2 + 0.3;
      if (x < b.x0 - hw || x > b.x1 + hw || z < b.z0 - hw || z > b.z1 + hw) continue;
      const P = road.points;
      const n = P.length / 3;
      const ox = road.origin[0];
      const oz = road.origin[1];
      for (let i = 0; i + 1 < n; i++) {
        const ax = P[i * 3] + ox, az = P[i * 3 + 2] + oz;
        const bx = P[i * 3 + 3] + ox, bz = P[i * 3 + 5] + oz;
        // 粗い除外（点の間隔は 2m 以下）
        if (Math.abs(ax - x) > hw + 3 || Math.abs(az - z) > hw + 3) continue;
        const dx = bx - ax, dz = bz - az;
        const l2 = dx * dx + dz * dz || 1;
        const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / l2));
        const ex = ax + dx * t - x, ez = az + dz * t - z;
        if (ex * ex + ez * ez > hw * hw) continue;
        const y = P[i * 3 + 1] + (P[i * 3 + 4] - P[i * 3 + 1]) * t;
        if (best === null || y > best) best = y;
      }
    }
    return best;
  }

  /** rect（とその外 margin）にかかる道路の点列を、rect の左上からの相対で詰める。stride 点ごとに間引く */
  pack(r: Rect, margin: number, stride: number): PackedRoads {
    const x0 = r.x0 - margin, z0 = r.z0 - margin, x1 = r.x1 + margin, z1 = r.z1 + margin;
    const pts: number[] = [];
    const starts: number[] = [];
    for (const e of this.entries.values()) {
      const b = e.bounds;
      if (b.x1 < x0 || b.x0 > x1 || b.z1 < z0 || b.z0 > z1) continue;
      const road = e.road;
      const P = road.points;
      const n = P.length / 3;
      const hw = road.width / 2;
      let open = false;
      let last = -1;
      const push = (i: number) => {
        if (i === last) return;
        last = i;
        pts.push(P[i * 3] + road.origin[0] - r.x0, P[i * 3 + 2] + road.origin[1] - r.z0, P[i * 3 + 1], hw, e.bridge[i]);
      };
      for (let i = 0; i < n; i += stride) {
        const x = P[i * 3] + road.origin[0];
        const z = P[i * 3 + 2] + road.origin[1];
        const inside = x >= x0 && x <= x1 && z >= z0 && z <= z1;
        if (inside) {
          if (!open) {
            starts.push(pts.length / 5);
            open = true;
            if (i > 0) push(Math.max(0, i - stride));
          }
          push(i);
        } else if (open) {
          push(i);
          open = false;
        }
      }
      if (open) push(n - 1);
    }
    starts.push(pts.length / 5);
    // 1点だけの折れ線は捨てる
    const outPts: number[] = [];
    const outStarts: number[] = [];
    for (let k = 0; k < starts.length - 1; k++) {
      if (starts[k + 1] - starts[k] < 2) continue;
      outStarts.push(outPts.length / 5);
      for (let i = starts[k] * 5; i < starts[k + 1] * 5; i++) outPts.push(pts[i]);
    }
    outStarts.push(outPts.length / 5);
    return { pts: Float32Array.from(outPts), starts: Int32Array.from(outStarts) };
  }
}

export function rectDist(r: Rect, x: number, z: number): number {
  const dx = Math.max(r.x0 - x, 0, x - r.x1);
  const dz = Math.max(r.z0 - z, 0, z - r.z1);
  return Math.sqrt(dx * dx + dz * dz);
}

function roadBounds(r: Road): Rect {
  let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
  for (let i = 0; i < r.points.length; i += 3) {
    const x = r.points[i] + r.origin[0];
    const z = r.points[i + 2] + r.origin[1];
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (z < z0) z0 = z;
    if (z > z1) z1 = z;
  }
  return { x0, z0, x1, z1 };
}
