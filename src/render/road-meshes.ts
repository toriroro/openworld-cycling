// 道路のメッシュ（モック仕様 5.3）。道路を 250m ごとに分け、近くのものだけ作る。
// 路面、中央線・外側線（等級による）、路肩、谷側のガードレール、橋（床版・欄干・橋脚）。
// 接続点: 道路は接続点の口で止め、口の内側を舗装面で埋める。隣り合う腕の路肩は曲線（隅切り）でつなぎ、外側線も曲線に沿って引く。

import * as THREE from "three";
import type { Terrain } from "../shared/world/terrain.ts";
import type { Road } from "../shared/world/types.ts";
import { hashString } from "../shared/world/hash.ts";
import { junctionShape, type JunctionShape, roadFrame, type Vec3 } from "../sim/junction-shape.ts";
import { rectDist, type RoadClient } from "../workers/road-client.ts";
import { buildAsphaltSurface } from "./asphalt-profile.ts";
import { buildGravelSurface } from "./gravel-profile.ts";

export const CHUNK_LENGTH = 250;

export interface RoadMaterials {
  paved: THREE.Material;
  gravel: THREE.Material;
  structure: THREE.Material;
  /** 補修跡（舗装の上に重ねる） */
  patch: THREE.Material;
}

interface Chunk {
  key: string;
  road: string;
  k: number;
  mesh: THREE.Mesh;
  ox: number;
  oz: number;
  /** 作った時の、この区間にかかる接続点の切れ目 */
  gapKey: string;
}

/** 道路の上で、接続点の舗装面に任せて路面を作らない区間 */
interface Gap {
  from: number;
  to: number;
}

/** [i0, i1] の点のうち切れ目の内側にない点の連続（2点以上） */
function runsOf(cut: boolean[]): [number, number][] {
  const out: [number, number][] = [];
  let a = -1;
  for (let j = 0; j <= cut.length; j++) {
    if (j < cut.length && !cut[j]) {
      if (a < 0) a = j;
    } else if (a >= 0) {
      if (j - 1 > a) out.push([a, j - 1]);
      a = -1;
    }
  }
  return out;
}

const C_LINE = [0.92, 0.92, 0.9];
const C_RAIL = [0.78, 0.8, 0.8];
const C_POST = [0.6, 0.62, 0.62];
const C_CONCRETE = [0.62, 0.61, 0.58];
const C_SHOULDER = [0.72, 0.7, 0.66];
/** 未舗装路の路肩（sRGB 0.42, 0.5, 0.28 を線形に） */
const C_GRAVEL_VERGE = [0.148, 0.218, 0.061];
/** 接続点の舗装面（道路の路面の平均に近い明るさ） */
const C_JUNCTION = [1, 1, 0.99];

class GeoBuilder {
  pos: number[] = [];
  col: number[] = [];
  uv: number[] = [];
  idx: number[] = [];
  /** 4 点の四角形（a,b,c,d の順に外周）。両面にするなら both */
  quad(a: number[], b: number[], c: number[], d: number[], color: number[], uvs?: number[][], both = false) {
    const base = this.pos.length / 3;
    for (const p of [a, b, c, d]) this.pos.push(p[0], p[1], p[2]);
    for (let i = 0; i < 4; i++) this.col.push(color[0], color[1], color[2]);
    if (uvs) for (const u of uvs) this.uv.push(u[0], u[1]);
    else for (let i = 0; i < 4; i++) this.uv.push(0, 0);
    this.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
    if (both) this.idx.push(base, base + 2, base + 1, base, base + 3, base + 2);
  }
  /** 断面の2点を道なりにつないだ帯。left/right は各断面の点 */
  strip(
    left: number[][],
    right: number[][],
    color: number[] | ((i: number, side: 0 | 1) => number[]),
    uv?: (i: number, side: 0 | 1) => [number, number],
  ) {
    const base = this.pos.length / 3;
    const n = left.length;
    for (let i = 0; i < n; i++) {
      for (const [side, p] of [[0, left[i]], [1, right[i]]] as const) {
        this.pos.push(p[0], p[1], p[2]);
        const c = typeof color === "function" ? color(i, side) : color;
        this.col.push(c[0], c[1], c[2]);
        const u = uv ? uv(i, side) : [0, 0];
        this.uv.push(u[0], u[1]);
      }
    }
    for (let i = 0; i < n - 1; i++) {
      const a = base + i * 2, b = a + 1, c = a + 2, d = a + 3;
      this.idx.push(a, b, c, b, d, c);
    }
  }
  get count() {
    return this.idx.length;
  }
}

export class RoadMeshes {
  readonly group = new THREE.Group();
  private chunks = new Map<string, Chunk>();
  private releaseQueue: THREE.Mesh[] = [];
  private discs: THREE.Mesh | null = null;
  private discKey = "";
  private gapCache = new Map<string, Gap[]>();
  private gapVersion = -1;
  range = 1600;
  buildPerFrame = 3;
  private originX = 0;
  private originZ = 0;
  readonly buildMs: number[] = [];
  private lastCx = NaN;
  private lastCz = NaN;
  private lastVersion = -1;
  private wanted: { key: string; road: Road; k: number; d: number }[] = [];

  constructor(
    private roads: RoadClient,
    private terrain: Terrain,
    private mats: RoadMaterials,
  ) {}

  setOrigin(x: number, z: number) {
    this.originX = x;
    this.originZ = z;
    for (const c of this.chunks.values()) {
      c.mesh.position.set(c.ox - x, 0, c.oz - z);
      c.mesh.updateMatrix();
    }
    if (this.discs) {
      this.discs.position.set(this.discs.userData.ox - x, 0, this.discs.userData.oz - z);
      this.discs.updateMatrix();
    }
  }

  update(cx: number, cz: number) {
    const moved = !(Math.abs(cx - this.lastCx) < 20 && Math.abs(cz - this.lastCz) < 20);
    if (moved || this.lastVersion !== this.roads.version) {
      this.lastCx = cx;
      this.lastCz = cz;
      this.lastVersion = this.roads.version;
      const wanted: typeof this.wanted = [];
      const keep = new Set<string>();
      for (const e of this.roads.roadEntries()) {
        if (rectDist(e.bounds, cx, cz) > this.range) continue;
        const road = e.road;
        const n = road.points.length / 3;
        const ds = road.length / (n - 1);
        const chunks = Math.ceil(road.length / CHUNK_LENGTH);
        for (let k = 0; k < chunks; k++) {
          const i0 = Math.floor((k * CHUNK_LENGTH) / ds);
          const i1 = Math.min(n - 1, Math.ceil(((k + 1) * CHUNK_LENGTH) / ds));
          let d = Infinity;
          for (let i = i0; i <= i1; i += 10) {
            const x = road.points[i * 3] + road.origin[0] - cx;
            const z = road.points[i * 3 + 2] + road.origin[1] - cz;
            d = Math.min(d, Math.sqrt(x * x + z * z));
          }
          if (d > this.range) continue;
          const key = `${road.id}#${k}`;
          const have = this.chunks.get(key);
          if (have && have.gapKey !== this.gapKey(road, k)) {
            // 接続点の形が変わった（腕の道路が読み込まれた）ので作り直す
            this.chunks.delete(key);
            this.releaseQueue.push(have.mesh);
          }
          keep.add(key);
          if (!this.chunks.has(key)) wanted.push({ key, road, k, d });
        }
      }
      wanted.sort((a, b) => a.d - b.d);
      this.wanted = wanted;
      for (const [key, c] of this.chunks)
        if (!keep.has(key)) {
          this.chunks.delete(key);
          this.releaseQueue.push(c.mesh);
        }
      this.updateDiscs(cx, cz);
    }
    for (let i = 0; i < this.buildPerFrame && this.wanted.length; i++) {
      const w = this.wanted.shift()!;
      if (this.chunks.has(w.key) || !this.roads.net.roads.has(w.road.id)) continue;
      const t0 = performance.now();
      const c = this.build(w.road, w.k);
      this.buildMs.push(performance.now() - t0);
      if (this.buildMs.length > 2000) this.buildMs.splice(0, 1000);
      this.chunks.set(w.key, c);
      this.group.add(c.mesh);
    }
    for (let i = 0; i < 6 && this.releaseQueue.length; i++) {
      const m = this.releaseQueue.shift()!;
      this.group.remove(m);
      m.geometry.dispose();
    }
  }

  get pendingBuild() {
    return this.wanted.length;
  }

  stats() {
    return { chunks: this.chunks.size, wanted: this.wanted.length, releasing: this.releaseQueue.length };
  }

  private build(road: Road, k: number): Chunk {
    const P = road.points;
    const n = P.length / 3;
    const ds = road.length / (n - 1);
    const i0 = Math.floor((k * CHUNK_LENGTH) / ds);
    const i1 = Math.min(n - 1, Math.ceil(((k + 1) * CHUNK_LENGTH) / ds));
    const ox = Math.round(road.origin[0] + P[i0 * 3]);
    const oz = Math.round(road.origin[1] + P[i0 * 3 + 2]);
    const bridge = this.roads.bridgeFlags(road.id)!;
    const hw = road.width / 2;
    const surf = new GeoBuilder();
    const str = new GeoBuilder();
    const pat = new GeoBuilder();

    // 断面の基準: 各点の位置と右向きのベクトル
    const cnt = i1 - i0 + 1;
    const px: number[] = [], py: number[] = [], pz: number[] = [], rx: number[] = [], rz: number[] = [];
    for (let i = i0; i <= i1; i++) {
      const a = Math.max(0, i - 1), b = Math.min(n - 1, i + 1);
      let tx = P[b * 3] - P[a * 3];
      let tz = P[b * 3 + 2] - P[a * 3 + 2];
      const l = Math.sqrt(tx * tx + tz * tz) || 1;
      tx /= l;
      tz /= l;
      px.push(P[i * 3] + road.origin[0] - ox);
      py.push(P[i * 3 + 1]);
      pz.push(P[i * 3 + 2] + road.origin[1] - oz);
      rx.push(-tz);
      rz.push(tx);
    }
    const at = (j: number, off: number, dy: number) => [px[j] + rx[j] * off, py[j] + dy, pz[j] + rz[j] * off];
    const sOf = (j: number) => (i0 + j) * ds;
    const isBridge = (j: number) => bridge[i0 + j] === 1;
    // 接続点の口の内側の点（路面・路肩・区画線・ガードレールを作らない）
    const gaps = this.gapsOf(road);
    const cut: boolean[] = [];
    for (let j = 0; j < cnt; j++) {
      const s = sOf(j);
      cut.push(gaps.some((g) => s > g.from + 1e-3 && s < g.to - 1e-3));
    }
    const runs = runsOf(cut);

    // 路面
    const gravel = road.surface === "gravel";
    for (const [r0, r1] of runs) {
      const at2 = (j: number, off: number, dy: number) => at(r0 + j, off, dy);
      const s2 = (j: number) => sOf(r0 + j);
      if (gravel) buildGravelSurface(surf, at2, r1 - r0 + 1, s2, hw, hashString(road.id));
      else buildAsphaltSurface(surf, pat, at2, r1 - r0 + 1, s2, hw, road.cls <= 1, hashString(road.id), (j) => (isBridge(r0 + j) ? 0.3 : 0));
    }

    // 路肩（土の部分）: 端から 0.7m は少し下げて平ら、そこから 0.7m で地面の下へ
    for (const sign of [-1, 1])
      for (const [r0, r1] of runs) {
      const a: number[][] = [], b: number[][] = [], c: number[][] = [];
      for (let j = r0; j <= r1; j++) {
        const br = isBridge(j);
        a.push(at(j, sign * hw, gravel ? -0.03 : 0));
        b.push(at(j, sign * (hw + 0.7), br ? 0 : gravel ? -0.08 : -0.04));
        c.push(at(j, sign * (hw + 1.4), br ? 0 : -0.45));
      }
      const uvf = (j: number, side: 0 | 1) => [side * 0.2, sOf(j) / 4] as [number, number];
      // 未舗装路の路肩は草に溶ける色
      const sh = gravel ? C_GRAVEL_VERGE : C_SHOULDER;
      if (sign < 0) {
        surf.strip(b, a, sh, uvf);
        surf.strip(c, b, sh, uvf);
      } else {
        surf.strip(a, b, sh, uvf);
        surf.strip(b, c, sh, uvf);
      }
    }

    // 区画線
    const line = (off: number, w: number, dashed: boolean) => {
      let run: number[] = [];
      const flush = () => {
        if (run.length >= 2) {
          const l: number[][] = [], r: number[][] = [];
          for (const j of run) {
            l.push(at(j, off - w / 2, 0.012));
            r.push(at(j, off + w / 2, 0.012));
          }
          str.strip(l, r, C_LINE);
        }
        run = [];
      };
      for (let j = 0; j < cnt; j++) {
        const on = !cut[j] && (!dashed || Math.floor(sOf(j) / 5) % 2 === 0);
        if (on) run.push(j);
        else flush();
      }
      flush();
    };
    if (road.surface === "paved") {
      if (road.cls <= 1) line(0, 0.15, road.cls === 1);
      if (road.cls <= 2) {
        line(-hw + 0.3, 0.15, false);
        line(hw - 0.3, 0.15, false);
      }
    }

    // 谷側のガードレール（橋は欄干があるので除く）
    for (const sign of [-1, 1]) {
      const valley: boolean[] = [];
      for (let j = 0; j < cnt; j++) {
        if (isBridge(j) || cut[j]) {
          valley.push(false);
          continue;
        }
        const g = this.terrain.height(px[j] + ox + rx[j] * sign * (hw + 4), pz[j] + oz + rz[j] * sign * (hw + 4));
        valley.push(g < py[j] - 2.2);
      }
      // 短い切れ目を埋め、短い区間を捨てる
      const minRun = Math.ceil(16 / ds);
      let j = 0;
      while (j < cnt) {
        if (!valley[j]) {
          j++;
          continue;
        }
        let e = j;
        while (e < cnt && valley[e]) e++;
        if (e - j >= minRun || ((j === 0 || e === cnt) && e - j >= 2)) this.rail(str, at, j, e - 1, sign * (hw + 0.6), sOf);
        j = e;
      }
    }

    // 橋: 床版の側面と底面、欄干、橋脚
    let j = 0;
    while (j < cnt) {
      if (!isBridge(j)) {
        j++;
        continue;
      }
      let e = j;
      while (e < cnt && isBridge(e)) e++;
      const run = Array.from({ length: e - j }, (_, q) => j + q);
      if (run.length >= 2) this.bridge(str, at, run, hw, sOf, px, pz, ox, oz);
      j = e;
    }

    const g = new THREE.BufferGeometry();
    const all = new GeoBuilder();
    all.pos = [...surf.pos, ...str.pos, ...pat.pos];
    all.col = [...surf.col, ...str.col, ...pat.col];
    all.uv = [...surf.uv, ...str.uv, ...pat.uv];
    const off = surf.pos.length / 3;
    const off2 = off + str.pos.length / 3;
    all.idx = [...surf.idx, ...str.idx.map((v) => v + off), ...pat.idx.map((v) => v + off2)];
    g.setAttribute("position", new THREE.Float32BufferAttribute(all.pos, 3));
    g.setAttribute("color", new THREE.Float32BufferAttribute(all.col, 3));
    g.setAttribute("uv", new THREE.Float32BufferAttribute(all.uv, 2));
    g.setIndex(all.pos.length / 3 > 65535 ? new THREE.Uint32BufferAttribute(all.idx, 1) : new THREE.Uint16BufferAttribute(all.idx, 1));
    g.addGroup(0, surf.idx.length, 0);
    g.addGroup(surf.idx.length, str.idx.length, 1);
    if (pat.idx.length) g.addGroup(surf.idx.length + str.idx.length, pat.idx.length, 2);
    g.computeVertexNormals();
    g.computeBoundingSphere();
    const mesh = new THREE.Mesh(g, [road.surface === "paved" ? this.mats.paved : this.mats.gravel, this.mats.structure, this.mats.patch]);
    mesh.name = "road";
    mesh.userData.road = road.id;
    mesh.receiveShadow = true;
    mesh.castShadow = false;
    mesh.matrixAutoUpdate = false;
    mesh.position.set(ox - this.originX, 0, oz - this.originZ);
    mesh.updateMatrix();
    return { key: `${road.id}#${k}`, road: road.id, k, mesh, ox, oz, gapKey: this.gapKey(road, k) };
  }

  private rail(
    b: GeoBuilder,
    at: (j: number, off: number, dy: number) => number[],
    j0: number,
    j1: number,
    off: number,
    sOf: (j: number) => number,
  ) {
    const top: number[][] = [], bot: number[][] = [];
    for (let j = j0; j <= j1; j++) {
      top.push(at(j, off, 0.78));
      bot.push(at(j, off, 0.52));
    }
    b.strip(top, bot, C_RAIL);
    b.strip(bot, top, C_RAIL);
    // 支柱は 4m ごと
    let next = Math.ceil(sOf(j0) / 4) * 4;
    for (let j = j0; j <= j1; j++) {
      if (sOf(j) < next) continue;
      next += 4;
      const p = at(j, off, 0);
      const s = 0.06;
      const y0 = p[1] - 0.4, y1 = p[1] + 0.8;
      const c = [
        [p[0] - s, p[2] - s],
        [p[0] + s, p[2] - s],
        [p[0] + s, p[2] + s],
        [p[0] - s, p[2] + s],
      ];
      for (let q = 0; q < 4; q++) {
        const u = c[q], v = c[(q + 1) % 4];
        b.quad([u[0], y1, u[1]], [v[0], y1, v[1]], [v[0], y0, v[1]], [u[0], y0, u[1]], C_POST, undefined, true);
      }
    }
  }

  private bridge(
    b: GeoBuilder,
    at: (j: number, off: number, dy: number) => number[],
    run: number[],
    hw: number,
    sOf: (j: number) => number,
    px: number[],
    pz: number[],
    ox: number,
    oz: number,
  ) {
    const deck = 1.2;
    const edge = hw + 0.55;
    for (const sign of [-1, 1]) {
      const inTop: number[][] = [], inBot: number[][] = [], outTop: number[][] = [], outBot: number[][] = [], wallTopIn: number[][] = [];
      for (const j of run) {
        inBot.push(at(j, sign * (hw + 0.3), 0));
        wallTopIn.push(at(j, sign * (hw + 0.3), 0.95));
        inTop.push(at(j, sign * edge, 0.95));
        outTop.push(at(j, sign * edge, 0.95));
        outBot.push(at(j, sign * edge, -deck));
      }
      // 欄干の内側の面・上面・外側の面（床版の側面まで続ける）
      if (sign < 0) {
        b.strip(inBot, wallTopIn, C_CONCRETE);
        b.strip(wallTopIn, inTop, C_CONCRETE);
        b.strip(outTop, outBot, C_CONCRETE);
      } else {
        b.strip(wallTopIn, inBot, C_CONCRETE);
        b.strip(inTop, wallTopIn, C_CONCRETE);
        b.strip(outBot, outTop, C_CONCRETE);
      }
    }
    // 底面
    const lb: number[][] = [], rb: number[][] = [];
    for (const j of run) {
      lb.push(at(j, -edge, -deck));
      rb.push(at(j, edge, -deck));
    }
    b.strip(rb, lb, C_CONCRETE);
    // 橋脚（30m ごと。両端の 12m 以内は除く）
    const s0 = sOf(run[0]);
    const s1 = sOf(run[run.length - 1]);
    let next = Math.ceil((s0 + 12) / 30) * 30;
    for (const j of run) {
      const s = sOf(j);
      if (s < next || s > s1 - 12) continue;
      next += 30;
      const top = at(j, 0, -deck);
      const g = this.terrain.height(px[j] + ox, pz[j] + oz);
      const y0 = Math.min(g, 0) - 2;
      if (top[1] - y0 < 2) continue;
      const half = Math.min(hw, 2.2);
      const cs = [at(j, -half, 0), at(j, half, 0)];
      const along = 0.6;
      const tx = (cs[1][2] - cs[0][2]) / (2 * half);
      const tz = -(cs[1][0] - cs[0][0]) / (2 * half);
      const corners = [
        [cs[0][0] - tx * along, cs[0][2] - tz * along],
        [cs[1][0] - tx * along, cs[1][2] - tz * along],
        [cs[1][0] + tx * along, cs[1][2] + tz * along],
        [cs[0][0] + tx * along, cs[0][2] + tz * along],
      ];
      for (let q = 0; q < 4; q++) {
        const u = corners[q], v = corners[(q + 1) % 4];
        b.quad([u[0], top[1], u[1]], [v[0], top[1], v[1]], [v[0], y0, v[1]], [u[0], y0, u[1]], C_CONCRETE, undefined, true);
      }
    }
  }

  /** 道路の上の接続点の切れ目（口の内側）。道路網が変わるたびに求め直す */
  private gapsOf(road: Road): Gap[] {
    const net = this.roads.net;
    if (this.gapVersion !== net.version) {
      this.gapCache.clear();
      this.gapVersion = net.version;
    }
    let gaps = this.gapCache.get(road.id);
    if (gaps) return gaps;
    gaps = [];
    for (const { junction } of net.junctionsOn(road.id)) {
      const shape = junctionShape(net, junction);
      if (shape.arms.length < 2) continue;
      for (const a of shape.arms) {
        if (a.arm.road !== road.id) continue;
        gaps.push({ from: Math.min(a.arm.s, a.mouthS), to: Math.max(a.arm.s, a.mouthS) });
      }
    }
    gaps.sort((p, q) => p.from - q.from);
    this.gapCache.set(road.id, gaps);
    return gaps;
  }

  /** 区画 k にかかる切れ目を文字列にしたもの（変わったら区画を作り直す） */
  private gapKey(road: Road, k: number): string {
    const s0 = k * CHUNK_LENGTH - 4;
    const s1 = (k + 1) * CHUNK_LENGTH + 4;
    return this.gapsOf(road)
      .filter((g) => g.to >= s0 && g.from <= s1)
      .map((g) => `${g.from.toFixed(2)}-${g.to.toFixed(2)}`)
      .join(",");
  }

  /** 範囲内の接続点の舗装面・路肩・外側線を1つのメッシュにまとめる */
  private updateDiscs(cx: number, cz: number) {
    const shapes: JunctionShape[] = [];
    for (const j of this.roads.net.junctions.values()) {
      const dx = j.x - cx, dz = j.z - cz;
      if (dx * dx + dz * dz > this.range * this.range) continue;
      const shape = junctionShape(this.roads.net, j);
      if (shape.arms.length < 2) continue;
      shapes.push(shape);
    }
    const key = shapes.map((s) => `${s.junction.id}=${s.key}`).join("|");
    if (key === this.discKey) return;
    this.discKey = key;
    if (this.discs) this.releaseQueue.push(this.discs);
    this.discs = null;
    if (!shapes.length) return;
    const ox = Math.round(cx), oz = Math.round(cz);
    const paved = new GeoBuilder();
    const gravel = new GeoBuilder();
    const lines = new GeoBuilder();
    for (const sh of shapes) this.junctionPatch(sh, ox, oz, paved, gravel, lines);
    const all = new GeoBuilder();
    const parts = [paved, gravel, lines];
    const g = new THREE.BufferGeometry();
    let start = 0;
    let vbase = 0;
    parts.forEach((p, mi) => {
      all.pos.push(...p.pos);
      all.col.push(...p.col);
      all.uv.push(...p.uv);
      for (const v of p.idx) all.idx.push(v + vbase);
      if (p.idx.length) g.addGroup(start, p.idx.length, mi);
      start += p.idx.length;
      vbase += p.pos.length / 3;
    });
    g.setAttribute("position", new THREE.Float32BufferAttribute(all.pos, 3));
    g.setAttribute("color", new THREE.Float32BufferAttribute(all.col, 3));
    g.setAttribute("uv", new THREE.Float32BufferAttribute(all.uv, 2));
    g.setIndex(all.pos.length / 3 > 65535 ? new THREE.Uint32BufferAttribute(all.idx, 1) : new THREE.Uint16BufferAttribute(all.idx, 1));
    g.computeVertexNormals();
    g.computeBoundingSphere();
    const m = new THREE.Mesh(g, [this.mats.paved, this.mats.gravel, this.mats.structure]);
    m.name = "road";
    m.userData.ox = ox;
    m.userData.oz = oz;
    m.receiveShadow = true;
    m.matrixAutoUpdate = false;
    m.position.set(ox - this.originX, 0, oz - this.originZ);
    m.updateMatrix();
    this.discs = m;
    this.group.add(m);
  }

  /** 接続点1つ: 中心から外周への扇形の舗装面、隅切りの曲線に沿った路肩と外側線 */
  private junctionPatch(sh: JunctionShape, ox: number, oz: number, paved: GeoBuilder, gravel: GeoBuilder, lines: GeoBuilder) {
    const allGravel = sh.arms.every((a) => a.road.surface === "gravel");
    const b = allGravel ? gravel : paved;
    // 外周: 腕ごとに −r の点、+r の点、そこから次の腕までの曲線
    const ring: Vec3[] = [];
    sh.arms.forEach((a, i) => {
      ring.push(a.minus, a.plus);
      const e = sh.edges[i];
      for (let q = 1; q < e.length - 1; q++) ring.push(e[q]);
    });
    const c = sh.center;
    const base = b.pos.length / 3;
    const surfCol = allGravel ? [1, 1, 1] : C_JUNCTION;
    b.pos.push(c.x - ox, c.y, c.z - oz);
    b.col.push(...surfCol);
    b.uv.push(c.x / 4, c.z / 4);
    for (const p of ring) {
      b.pos.push(p.x - ox, p.y, p.z - oz);
      b.col.push(...surfCol);
      b.uv.push(p.x / 4, p.z / 4);
    }
    const n = ring.length;
    for (let k = 0; k < n; k++) b.idx.push(base, base + 1 + ((k + 1) % n), base + 1 + k);

    // 優先の道路（接続点を通り抜け、等級がいちばん高い）の中央線は接続点の中も引く
    for (const a of sh.arms) {
      if (a.arm.dir !== 1) continue;
      const other = sh.arms.find((o) => o.arm.road === a.arm.road && o.arm.dir === -1 && Math.abs(o.arm.s - a.arm.s) < 0.5);
      const r = a.road;
      if (!other || r.surface !== "paved" || r.cls > 1) continue;
      if (sh.arms.some((o) => o.road !== r && o.road.cls <= r.cls)) continue;
      const ds = r.length / (r.points.length / 3 - 1);
      const i0 = Math.round(other.mouthS / ds);
      const i1 = Math.round(a.mouthS / ds);
      let run: number[][][] = [];
      const flush = () => {
        if (run.length >= 2) lines.strip(run.map((q) => q[0]), run.map((q) => q[1]), C_LINE);
        run = [];
      };
      for (let i = i0; i <= i1; i++) {
        if (r.cls === 1 && Math.floor((i * ds) / 5) % 2 !== 0) {
          flush();
          continue;
        }
        const f = roadFrame(r, i);
        const rx = -f.tz, rz = f.tx;
        run.push([
          [f.x - rx * 0.075 - ox, f.y + 0.012, f.z - rz * 0.075 - oz],
          [f.x + rx * 0.075 - ox, f.y + 0.012, f.z + rz * 0.075 - oz],
        ]);
      }
      flush();
    }

    // 曲線に沿って路肩（道路の路肩と同じ断面）と外側線
    const sh2 = allGravel ? C_GRAVEL_VERGE : C_SHOULDER;
    sh.edges.forEach((e, i) => {
      const a = sh.arms[i];
      const nb = sh.arms[(i + 1) % sh.arms.length];
      // 進む向きの左が外（接続点の外側）
      const outN = e.map((_, q) => {
        const p0 = e[Math.max(0, q - 1)];
        const p1 = e[Math.min(e.length - 1, q + 1)];
        let tx = p1.x - p0.x;
        let tz = p1.z - p0.z;
        const l = Math.sqrt(tx * tx + tz * tz) || 1;
        tx /= l;
        tz /= l;
        return [tz, -tx];
      });
      // 両端は道路の断面の向きにそろえる（道路の路肩とすき間なくつなぐ）
      outN[0] = [-a.oz, a.ox];
      outN[e.length - 1] = [nb.oz, -nb.ox];
      const off = (q: number, d: number, dy: number) => [e[q].x + outN[q][0] * d - ox, e[q].y + dy, e[q].z + outN[q][1] * d - oz];
      const A: number[][] = [], B: number[][] = [], C: number[][] = [];
      for (let q = 0; q < e.length; q++) {
        A.push(off(q, 0, allGravel ? -0.03 : 0));
        B.push(off(q, 0.7, allGravel ? -0.08 : -0.04));
        C.push(off(q, 1.4, -0.45));
      }
      let acc = 0;
      const sAt: number[] = [0];
      for (let q = 1; q < e.length; q++) {
        acc += Math.sqrt((e[q].x - e[q - 1].x) ** 2 + (e[q].z - e[q - 1].z) ** 2);
        sAt.push(acc);
      }
      const uvf = (q: number, side: 0 | 1) => [side * 0.2, sAt[q] / 4] as [number, number];
      b.strip(B, A, sh2, uvf);
      b.strip(C, B, sh2, uvf);
      // 外側線: 両側の道路に外側線がある時（舗装の一般道以上）
      const edgeLine = (r: Road) => r.surface === "paved" && r.cls <= 2;
      if (edgeLine(a.road) && edgeLine(nb.road)) {
        const l1: number[][] = [], l2: number[][] = [];
        for (let q = 0; q < e.length; q++) {
          l1.push(off(q, -0.3 - 0.075, 0.012));
          l2.push(off(q, -0.3 + 0.075, 0.012));
        }
        lines.strip(l2, l1, C_LINE);
      }
    });
  }
}
