// 道路のメッシュ（モック仕様 5.3）。道路を 250m ごとに分け、近くのものだけ作る。
// 路面、中央線・外側線（等級による）、路肩、谷側のガードレール、橋（床版・欄干・橋脚）、
// トンネル（北海道の世界。内壁・照明・坑口。中は暗くする。北海道の草案 20 章）。
// 接続点: 道路は接続点の口で止め、口の内側を舗装面で埋める。隣り合う腕の路肩は曲線（隅切り）でつなぎ、外側線も曲線に沿って引く。

import * as THREE from "three";
import type { TerrainLike } from "../shared/world/terrain.ts";
import type { Junction, Road } from "../shared/world/types.ts";
import { hashString } from "../shared/world/hash.ts";
import { junctionShape, type JunctionShape, roadFrame, type Vec3 } from "../sim/junction-shape.ts";
import { sampleRoad } from "../sim/road-network.ts";
import { rectDist, type RoadClient } from "../workers/road-client.ts";
import { buildAsphaltSurface } from "./asphalt-profile.ts";
import { buildGravelSurface } from "./gravel-profile.ts";
import { TUNNEL_CROWN } from "../workers/terrain-tile.ts";

export const CHUNK_LENGTH = 250;

export interface RoadMaterials {
  paved: THREE.Material;
  gravel: THREE.Material;
  structure: THREE.Material;
  /** 補修跡（舗装の上に重ねる） */
  patch: THREE.Material;
  /** トンネルの照明（光の当たり方によらない明るさ） */
  lamp: THREE.Material;
}

interface Chunk {
  key: string;
  road: string;
  k: number;
  /** この区間の形（画面には出さず、区画ごとにまとめてから出す） */
  geo: THREE.BufferGeometry;
  /** 路面の材質: 0 = 舗装、1 = 砂利 */
  surface: 0 | 1;
  ox: number;
  oz: number;
  /** まとめる区画 */
  cell: string;
  /** 作った時の、この区間にかかる接続点の切れ目 */
  gapKey: string;
  /** トンネルの影だけを落とす箱（三角形の頂点の並び。区間の原点から） */
  caster: Float32Array | null;
  /** 遠くの段（簡単な形）で作ったか */
  far: boolean;
  /** 作った時の道路網の版（変わっていなければ接続点の切れ目を調べ直さない） */
  net: number;
}

/** 遠くの段で、点を何個おきに使うか（2m の点を 4 個おき = 8m） */
const FAR_STRIDE = 4;
/** 段を切り替える距離の遊び (m)。境目で行ったり来たりしないように */
const LOD_HYSTERESIS = 50;


/**
 * 道路の区間を区画（CELL m 四方）ごとに 1 つのメッシュにまとめる。区間ごとにメッシュを作ると、
 * 交差点の多い市街地（北海道の世界の札幌）で描画命令が 500 を超えたため（北海道の草案 14.1 #10）。
 */
const CELL = 250;

interface Cell {
  key: string;
  ox: number;
  oz: number;
  chunks: Set<string>;
  mesh: THREE.Mesh | null;
  /** トンネルの影だけを落とす箱 */
  caster: THREE.Mesh | null;
  dirty: boolean;
}

/** 道路の上で、接続点の舗装面に任せて路面を作らない区間 */
interface Gap {
  from: number;
  to: number;
  /** 区画線だけを切る（横断歩道の上。北海道の草案 26 章） */
  linesOnly?: boolean;
}

/** 横断歩道の口からの位置 (m)。口の外 CROSSWALK_FROM〜CROSSWALK_TO に帯を引き、その間の区画線を切る */
const CROSSWALK_FROM = 0.8;
const CROSSWALK_TO = CROSSWALK_FROM + 4;

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
/** トンネルの内壁（下の腰壁は明るいタイル、上は吹付けのコンクリート）と坑口 */
const C_TUNNEL_WALL = [0.7, 0.69, 0.64];
const C_TUNNEL_ARCH = [0.42, 0.41, 0.39];
const C_PORTAL = [0.66, 0.65, 0.61];
/** トンネルの照明（ナトリウム灯の色） */
const C_LAMP = [1, 0.72, 0.4];
/**
 * トンネルの中の色の掛け率（坑口から奥へ 30m で下げる）。中は影だけの箱（caster）で日が当たらないので、
 * 色は少しだけ下げ、照明の色（暖色）に寄せる
 */
const TUNNEL_DARK = 0.8;
const TUNNEL_TINT = [1.15, 1.02, 0.82];
const TUNNEL_RAMP = 30;
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
  private cells = new Map<string, Cell>();
  /** 1 フレームにまとめ直す区画の数 */
  mergePerFrame = 2;
  private releaseQueue: THREE.Mesh[] = [];
  private gapCache = new Map<string, Gap[]>();
  private gapVersion = -1;
  range = 1600;
  /**
   * この距離より遠い区間は簡単な形（断面 2 点・8m ごと、区画線・補修跡・ガードレールなし）で作る。
   * 半径 1.6km の道路を全部細かく作ると、札幌で三角形の 7 割（122万）を道路が占めたため（北海道の草案 23 章）
   */
  detailRange = 400;
  buildPerFrame = 3;
  private originX = 0;
  private originZ = 0;
  readonly buildMs: number[] = [];
  private lastCx = NaN;
  private lastCz = NaN;
  private lastVersion = -1;
  private wanted: { key: string; road: Road | null; junction?: Junction; k: number; d: number; far: boolean }[] = [];
  /** トンネルの影だけを落とす箱の材質（画面には色も深さも書かない。影の描画は材質の色を使わないので影だけ落ちる） */
  private readonly casterMat = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide, colorWrite: false, depthWrite: false });

  constructor(
    private roads: RoadClient,
    private terrain: TerrainLike,
    private mats: RoadMaterials,
  ) {}

  setOrigin(x: number, z: number) {
    this.originX = x;
    this.originZ = z;
    for (const c of this.cells.values()) {
      for (const m of [c.mesh, c.caster]) {
        if (!m) continue;
        m.position.set(c.ox - x, 0, c.oz - z);
        m.updateMatrix();
      }
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
          let have = this.chunks.get(key);
          if (have && have.net !== this.roads.net.version) {
            if (have.gapKey !== this.gapKey(road, k)) {
              // 接続点の形が変わった（腕の道路が読み込まれた）ので作り直す
              this.removeChunk(have);
              have = undefined;
            } else have.net = this.roads.net.version;
          }
          keep.add(key);
          const far = have ? (have.far ? d > this.detailRange - LOD_HYSTERESIS : d > this.detailRange + LOD_HYSTERESIS) : d > this.detailRange;
          // 段が変わる区間は、新しい形ができるまで古い形を出しておく（作った所で入れ替える）
          if (!have || have.far !== far) wanted.push({ key, road, k, d, far });
        }
      }
      // 接続点の舗装面も道路の区間と同じく区画のメッシュに入れる。範囲の全部の接続点を 1 つのメッシュに作り直すと、
      // 札幌で動くたびに 50〜90ms 止まったため（北海道の草案 23 章）
      for (const j of this.roads.net.junctions.values()) {
        const d = Math.hypot(j.x - cx, j.z - cz);
        if (d > this.range) continue;
        const key = `J#${j.id}`;
        let have = this.chunks.get(key);
        if (have && have.net !== this.roads.net.version) {
          const shape = junctionShape(this.roads.net, j);
          if (shape.arms.length < 2 || have.gapKey !== shape.key) {
            this.removeChunk(have);
            have = undefined;
          } else have.net = this.roads.net.version;
        }
        if (!have && junctionShape(this.roads.net, j).arms.length < 2) continue;
        keep.add(key);
        if (!have) wanted.push({ key, road: null, junction: j, k: 0, d, far: false });
      }
      wanted.sort((a, b) => a.d - b.d);
      this.wanted = wanted;
      for (const [key, c] of this.chunks) if (!keep.has(key)) this.removeChunk(c);
    }
    // 1 フレームに buildPerFrame 個、または 2ms まで作る（接続点は小さいので数が多くても早く埋める）
    const buildStart = performance.now();
    for (let i = 0; this.wanted.length && (i < this.buildPerFrame || performance.now() - buildStart < 2); i++) {
      const w = this.wanted.shift()!;
      const old = this.chunks.get(w.key);
      if (w.junction) {
        if (old || !this.roads.net.junctions.has(w.junction.id)) continue;
      } else if ((old && old.far === w.far) || !w.road || !this.roads.net.roads.has(w.road.id)) continue;
      const t0 = performance.now();
      const c = w.junction ? this.buildJunction(w.junction) : this.build(w.road!, w.k, w.far);
      if (old) this.removeChunk(old);
      this.buildMs.push(performance.now() - t0);
      if (this.buildMs.length > 2000) this.buildMs.splice(0, 1000);
      this.chunks.set(w.key, c);
      const cell = this.cellOf(c.cell, c.ox, c.oz);
      cell.chunks.add(c.key);
      cell.dirty = true;
    }
    // まとめ直す（近い区画から）
    const dirty = [...this.cells.values()].filter((c) => c.dirty);
    if (dirty.length) {
      dirty.sort((a, b) => Math.hypot(a.ox - cx, a.oz - cz) - Math.hypot(b.ox - cx, b.oz - cz));
      for (let i = 0; i < this.mergePerFrame && i < dirty.length; i++) {
        const t0 = performance.now();
        this.merge(dirty[i]);
        this.buildMs.push(performance.now() - t0);
      }
    }
    for (let i = 0; i < 6 && this.releaseQueue.length; i++) {
      const m = this.releaseQueue.shift()!;
      this.group.remove(m);
      m.geometry.dispose();
    }
  }

  get pendingBuild() {
    let dirty = 0;
    for (const c of this.cells.values()) if (c.dirty) dirty++;
    return this.wanted.length + dirty;
  }

  stats() {
    let meshes = 0;
    for (const c of this.cells.values()) if (c.mesh) meshes++;
    return { chunks: this.chunks.size, cells: meshes, wanted: this.wanted.length, releasing: this.releaseQueue.length };
  }

  private cellOf(key: string, x: number, z: number): Cell {
    let c = this.cells.get(key);
    if (!c) {
      c = { key, ox: Math.floor(x / CELL) * CELL, oz: Math.floor(z / CELL) * CELL, chunks: new Set(), mesh: null, caster: null, dirty: false };
      this.cells.set(key, c);
    }
    return c;
  }

  private removeChunk(c: Chunk) {
    this.chunks.delete(c.key);
    c.geo.dispose();
    const cell = this.cells.get(c.cell);
    if (!cell) return;
    cell.chunks.delete(c.key);
    cell.dirty = true;
  }

  /** 区画の区間を 1 つのメッシュにまとめる（材質ごとに 1 つの描画命令: 舗装・砂利・構造物・補修跡） */
  private merge(cell: Cell) {
    cell.dirty = false;
    if (cell.mesh) {
      this.releaseQueue.push(cell.mesh);
      cell.mesh = null;
    }
    if (cell.caster) {
      this.releaseQueue.push(cell.caster);
      cell.caster = null;
    }
    const list: Chunk[] = [];
    for (const k of cell.chunks) {
      const c = this.chunks.get(k);
      if (c) list.push(c);
    }
    if (!list.length) {
      this.cells.delete(cell.key);
      return;
    }
    let V = 0;
    const slotLen = [0, 0, 0, 0, 0];
    const slotOf = (c: Chunk, mi: number) => (mi === 0 ? c.surface : mi + 1);
    for (const c of list) {
      V += c.geo.getAttribute("position").count;
      for (const g of c.geo.groups) slotLen[slotOf(c, g.materialIndex ?? 0)] += g.count;
    }
    const pos = new Float32Array(V * 3);
    const nor = new Float32Array(V * 3);
    const col = new Float32Array(V * 3);
    const uv = new Float32Array(V * 2);
    const total = slotLen[0] + slotLen[1] + slotLen[2] + slotLen[3] + slotLen[4];
    const index = V > 65535 ? new Uint32Array(total) : new Uint16Array(total);
    const slotAt = [0];
    for (let k = 1; k < 5; k++) slotAt.push(slotAt[k - 1] + slotLen[k - 1]);
    const fill = slotAt.slice();
    let vbase = 0;
    for (const c of list) {
      const g = c.geo;
      const p = g.getAttribute("position").array as Float32Array;
      const n = g.getAttribute("normal").array as Float32Array;
      const co = g.getAttribute("color").array as Float32Array;
      const u = g.getAttribute("uv").array as Float32Array;
      const cnt = p.length / 3;
      const dx = c.ox - cell.ox;
      const dz = c.oz - cell.oz;
      for (let i = 0; i < cnt; i++) {
        pos[(vbase + i) * 3] = p[i * 3] + dx;
        pos[(vbase + i) * 3 + 1] = p[i * 3 + 1];
        pos[(vbase + i) * 3 + 2] = p[i * 3 + 2] + dz;
      }
      nor.set(n, vbase * 3);
      col.set(co, vbase * 3);
      uv.set(u, vbase * 2);
      const idx = g.index!.array;
      for (const gr of g.groups) {
        const slot = slotOf(c, gr.materialIndex ?? 0);
        for (let i = gr.start; i < gr.start + gr.count; i++) index[fill[slot]++] = idx[i] + vbase;
      }
      vbase += cnt;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    geo.setAttribute("normal", new THREE.BufferAttribute(nor, 3));
    geo.setAttribute("color", new THREE.BufferAttribute(col, 3));
    geo.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
    geo.setIndex(new THREE.BufferAttribute(index, 1));
    for (let k = 0; k < 5; k++) if (slotLen[k]) geo.addGroup(slotAt[k], slotLen[k], k);
    geo.computeBoundingSphere();
    const mesh = new THREE.Mesh(geo, [this.mats.paved, this.mats.gravel, this.mats.structure, this.mats.patch, this.mats.lamp]);
    mesh.name = "road";
    mesh.receiveShadow = true;
    mesh.castShadow = false;
    mesh.matrixAutoUpdate = false;
    mesh.position.set(cell.ox - this.originX, 0, cell.oz - this.originZ);
    mesh.updateMatrix();
    cell.mesh = mesh;
    this.group.add(mesh);
    // トンネルの影だけを落とす箱（中を太陽の光から隠す）
    let cv = 0;
    for (const c of list) cv += c.caster?.length ?? 0;
    if (cv) {
      const cp = new Float32Array(cv);
      let o = 0;
      for (const c of list) {
        if (!c.caster) continue;
        const dx = c.ox - cell.ox;
        const dz = c.oz - cell.oz;
        for (let i = 0; i < c.caster.length; i += 3) {
          cp[o + i] = c.caster[i] + dx;
          cp[o + i + 1] = c.caster[i + 1];
          cp[o + i + 2] = c.caster[i + 2] + dz;
        }
        o += c.caster.length;
      }
      const cg = new THREE.BufferGeometry();
      cg.setAttribute("position", new THREE.BufferAttribute(cp, 3));
      cg.computeBoundingSphere();
      const cm = new THREE.Mesh(cg, this.casterMat);
      cm.name = "road:tunnel-shadow";
      cm.castShadow = true;
      cm.receiveShadow = false;
      cm.matrixAutoUpdate = false;
      cm.position.copy(mesh.position);
      cm.updateMatrix();
      cell.caster = cm;
      this.group.add(cm);
    }
  }

  private build(road: Road, k: number, wantFar = false): Chunk {
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
    const isTunnel = (j: number) => bridge[i0 + j] === 2;
    // 接続点の口の内側の点（路面・路肩・区画線・ガードレールを作らない）
    const gaps = this.gapsOf(road);
    const cut: boolean[] = [];
    for (let j = 0; j < cnt; j++) {
      const s = sOf(j);
      cut.push(gaps.some((g) => !g.linesOnly && s > g.from + 1e-3 && s < g.to - 1e-3));
    }
    // 区画線は横断歩道の上でも切る
    const lineCut = cut.map((c, j) => c || gaps.some((g) => g.linesOnly && sOf(j) > g.from - 1e-3 && sOf(j) < g.to + 1e-3));
    const runs = runsOf(cut);
    // 遠くの段: 橋・トンネルの無い区間だけ（橋・トンネルは形が崩れないよう細かいまま）
    let structure = false;
    for (let j = 0; j < cnt && !structure; j++) if (bridge[i0 + j]) structure = true;
    const far = wantFar && !structure;
    /** 続く点 r0..r1 のうち使う点（遠くの段は FAR_STRIDE 個おきと最後の点） */
    const pick = (r0: number, r1: number): number[] => {
      const out: number[] = [];
      for (let j = r0; j < r1; j += far ? FAR_STRIDE : 1) out.push(j);
      out.push(r1);
      return out;
    };

    // 路面
    const gravel = road.surface === "gravel";
    for (const [r0, r1] of runs) {
      const sel = pick(r0, r1);
      const at2 = (j: number, off: number, dy: number) => at(sel[j], off, dy);
      const s2 = (j: number) => sOf(sel[j]);
      if (gravel) buildGravelSurface(surf, at2, sel.length, s2, hw, hashString(road.id), far);
      else buildAsphaltSurface(surf, pat, at2, sel.length, s2, hw, road.cls <= 1, hashString(road.id), (j) => (isBridge(sel[j]) ? 0.3 : 0), far);
    }

    // 路肩（土の部分）: 端から 0.7m は少し下げて平ら、そこから 0.7m で地面の下へ
    for (const sign of [-1, 1])
      for (const [r0, r1] of runs) {
      const a: number[][] = [], b: number[][] = [], c: number[][] = [];
      for (const j of pick(r0, r1)) {
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
        const on = !lineCut[j] && (!dashed || Math.floor(sOf(j) / 5) % 2 === 0);
        if (on) run.push(j);
        else flush();
      }
      flush();
    };
    if (road.surface === "paved" && !far) {
      if (road.cls <= 1) line(0, 0.15, road.cls === 1);
      if (road.cls <= 2) {
        line(-hw + 0.3, 0.15, false);
        line(hw - 0.3, 0.15, false);
      }
    }

    // 谷側のガードレール（橋は欄干があるので除く。遠くの段は作らない）
    for (const sign of far ? [] : [-1, 1]) {
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

    // トンネル: 内壁・照明・坑口。中の路面などの色を暗くする
    const lamp = new GeoBuilder();
    let caster: Float32Array | null = null;
    const tunnelRuns: number[][] = [];
    {
      let q = 0;
      while (q < cnt) {
        if (!isTunnel(q)) {
          q++;
          continue;
        }
        let e = q;
        while (e < cnt && isTunnel(e)) e++;
        const run = Array.from({ length: e - q }, (_, t) => q + t);
        if (run.length >= 2) tunnelRuns.push(run);
        q = e;
      }
    }
    if (tunnelRuns.length) {
      // 点 i がトンネルの外か。道路の端の外は、接続点の先の道路もトンネルでなければ外（坑口が道路の端にある）
      const startOut = bridge[0] === 2 && this.tunnelEndIsPortal(road, true);
      const endOut = bridge[n - 1] === 2 && this.tunnelEndIsPortal(road, false);
      const outside = (i: number) => (i < 0 ? startOut : i > n - 1 ? endOut : bridge[i] !== 2);
      // 坑口からの距離（TUNNEL_RAMP で打ち切る。トンネルの外は -1）
      const lim = Math.ceil(TUNNEL_RAMP / ds) + 1;
      const depth = (j: number) => {
        const i = i0 + j;
        if (bridge[i] !== 2) return -1;
        let d = lim;
        for (let q = 1; q <= lim; q++) {
          if (outside(i - q) || outside(i + q)) {
            d = q - 1;
            break;
          }
        }
        return Math.min(TUNNEL_RAMP, d * ds);
      };
      const dim: number[] = [];
      for (let q = 0; q < cnt; q++) {
        const d = depth(q);
        dim.push(d < 0 ? 1 : 1 - (1 - TUNNEL_DARK) * Math.min(1, d / TUNNEL_RAMP));
      }
      for (const run of tunnelRuns)
        this.tunnel(
          str,
          lamp,
          at,
          run,
          hw,
          sOf,
          dim,
          (q) => outside(i0 + q - 1),
          (q) => outside(i0 + q + 1),
        );
      // 中の路面・路肩・区画線を暗くする（坑口から 30m で TUNNEL_DARK まで）
      for (const gb of [surf, pat]) darkenNear(gb, px, pz, dim);
      // 影だけを落とす箱: 内壁の外側の左右の壁と屋根
      const side = hw + 1.4;
      const top = TUNNEL_CROWN + 0.6;
      const cb = new GeoBuilder();
      for (const run of tunnelRuns) {
        const col = (off: number, y: number) => run.map((q) => at(q, off, y));
        cb.strip(col(-side, -0.5), col(-side, top), [0, 0, 0]);
        cb.strip(col(-side, top), col(side, top), [0, 0, 0]);
        cb.strip(col(side, top), col(side, -0.5), [0, 0, 0]);
      }
      caster = new Float32Array(cb.idx.length * 3);
      cb.idx.forEach((v, i) => caster!.set(cb.pos.slice(v * 3, v * 3 + 3), i * 3));
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
    all.pos = [...surf.pos, ...str.pos, ...pat.pos, ...lamp.pos];
    all.col = [...surf.col, ...str.col, ...pat.col, ...lamp.col];
    all.uv = [...surf.uv, ...str.uv, ...pat.uv, ...lamp.uv];
    const off = surf.pos.length / 3;
    const off2 = off + str.pos.length / 3;
    const off3 = off2 + pat.pos.length / 3;
    all.idx = [...surf.idx, ...str.idx.map((v) => v + off), ...pat.idx.map((v) => v + off2), ...lamp.idx.map((v) => v + off3)];
    g.setAttribute("position", new THREE.Float32BufferAttribute(all.pos, 3));
    g.setAttribute("color", new THREE.Float32BufferAttribute(all.col, 3));
    g.setAttribute("uv", new THREE.Float32BufferAttribute(all.uv, 2));
    g.setIndex(all.pos.length / 3 > 65535 ? new THREE.Uint32BufferAttribute(all.idx, 1) : new THREE.Uint16BufferAttribute(all.idx, 1));
    g.addGroup(0, surf.idx.length, 0);
    g.addGroup(surf.idx.length, str.idx.length, 1);
    if (pat.idx.length) g.addGroup(surf.idx.length + str.idx.length, pat.idx.length, 2);
    if (lamp.idx.length) g.addGroup(surf.idx.length + str.idx.length + pat.idx.length, lamp.idx.length, 3);
    g.computeVertexNormals();
    const cell = `${Math.floor(ox / CELL)},${Math.floor(oz / CELL)}`;
    return { key: `${road.id}#${k}`, road: road.id, k, geo: g, surface: road.surface === "paved" ? 0 : 1, ox, oz, cell, gapKey: this.gapKey(road, k), caster, far, net: this.roads.net.version };
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

  /** トンネルのまま終わる道路の端が坑口か（接続点の先の道路の端がトンネルでなければ坑口） */
  private tunnelEndIsPortal(road: Road, atStart: boolean): boolean {
    const jid = atStart ? road.start : road.end;
    const jn = this.roads.net.junctions.get(jid);
    if (!jn) return true;
    for (const a of jn.arms) {
      if (a.road === road.id) continue;
      const f = this.roads.bridgeFlags(a.road);
      if (!f) continue;
      const other = this.roads.net.roads.get(a.road);
      const atOtherStart = other ? a.s < other.length / 2 : a.s < 1;
      if (f[atOtherStart ? 0 : f.length - 1] === 2) return false;
    }
    return true;
  }

  /**
   * トンネルの内壁（断面: 監査路の縁石 → 監査路 → 側壁 → 天井の弧）、天井の照明、坑口の面壁（区間の中に坑口がある時）。
   * 構造物の材質は両面なので、内壁は 1 枚。坑口の面壁は内壁の断面と外の長方形の間を埋める。
   */
  private tunnel(
    b: GeoBuilder,
    lamp: GeoBuilder,
    at: (j: number, off: number, dy: number) => number[],
    run: number[],
    hw: number,
    sOf: (j: number) => number,
    dim: number[],
    portalBefore: (j: number) => boolean,
    portalAfter: (j: number) => boolean,
  ) {
    const side = hw + 1.0;
    // 断面（左端から右端へ）: [横の位置, 高さ]
    const prof: [number, number][] = [
      [-(hw + 0.3), 0],
      [-(hw + 0.3), 0.25],
      [-side, 0.25],
      [-side, 2.6],
      [-side, 4.2],
      [-side * 0.72, 5.7],
      [-side * 0.38, TUNNEL_CROWN - 0.15],
      [0, TUNNEL_CROWN],
    ];
    for (let k = prof.length - 2; k >= 0; k--) prof.push([-prof[k][0], prof[k][1]]);
    for (let k = 0; k + 1 < prof.length; k++) {
      const l: number[][] = [], r: number[][] = [];
      for (const j of run) {
        l.push(at(j, prof[k][0], prof[k][1]));
        r.push(at(j, prof[k + 1][0], prof[k + 1][1]));
      }
      // 腰壁（高さ 2.6m まで）は明るいタイル、その上は暗い。坑口から奥へ暗く
      const c = prof[k + 1][1] <= 2.6 && prof[k][1] <= 2.6 ? C_TUNNEL_WALL : C_TUNNEL_ARCH;
      b.strip(l, r, (i) => {
        const k = dim[run[i]];
        // 坑口（k = 1）は元の色、奥ほど照明の色に寄せる
        const w = (1 - k) / (1 - TUNNEL_DARK);
        return [0, 1, 2].map((q) => c[q] * k * (1 + (TUNNEL_TINT[q] - 1) * w));
      });
    }
    // 照明: 天井の左右に 0.4m × 1.2m、12m ごと
    const ds = run.length > 1 ? sOf(run[1]) - sOf(run[0]) : 2;
    for (let q = 0; q + 1 < run.length; q++) {
      const j = run[q];
      const s = sOf(j);
      if (Math.floor(s / 12) === Math.floor((s - ds) / 12)) continue;
      const j2 = run[q + 1];
      const t = Math.min(1, 1.2 / Math.max(0.5, sOf(j2) - s));
      for (const o of [-side * 0.5, side * 0.5]) {
        const y = 5.9;
        const a1 = at(j, o - 0.2, y), a2 = at(j, o + 0.2, y);
        const b1 = at(j2, o - 0.2, y), b2 = at(j2, o + 0.2, y);
        const m = (p: number[], r: number[]) => [p[0] + (r[0] - p[0]) * t, p[1] + (r[1] - p[1]) * t, p[2] + (r[2] - p[2]) * t];
        lamp.quad(a1, a2, m(a2, b2), m(a1, b1), C_LAMP, undefined, true);
      }
    }
    // 坑口: 面壁（幅は内壁の外へ 3m、高さは天井の上 2.4m）
    const ends: [number, number][] = [];
    if (portalBefore(run[0])) ends.push([run[0], 1]);
    if (portalAfter(run[run.length - 1])) ends.push([run[run.length - 1], -1]);
    const W = side + 3;
    const H = TUNNEL_CROWN + 2.4;
    const C = 3;
    // 断面の各点を、中心 (0, C) から外の長方形へ伸ばした点（下の端は地面）
    const outer = prof.map(([x, y]) => {
      const dy = y - C;
      const tx = x === 0 ? Infinity : W / Math.abs(x);
      const ty = dy <= 0 ? Infinity : (H - C) / dy;
      const t = Math.min(tx, ty);
      return [x * t, C + dy * t] as [number, number];
    });
    outer[0] = [-W, 0];
    outer[outer.length - 1] = [W, 0];
    for (const [j, inward] of ends) {
      for (let k = 0; k + 1 < prof.length; k++) {
        const p0 = at(j, prof[k][0], prof[k][1]);
        const p1 = at(j, prof[k + 1][0], prof[k + 1][1]);
        const q1 = at(j, outer[k + 1][0], outer[k + 1][1]);
        const q0 = at(j, outer[k][0], outer[k][1]);
        b.quad(p0, p1, q1, q0, C_PORTAL);
      }
      // 長方形の上の角（伸ばした点が角を通らない分）
      for (let k = 0; k + 1 < outer.length; k++) {
        const [ax, ay] = outer[k];
        const [bx, by] = outer[k + 1];
        const aSide = Math.abs(Math.abs(ax) - W) < 1e-6 && ay > C;
        const bSide = Math.abs(Math.abs(bx) - W) < 1e-6 && by > C;
        const aTop = Math.abs(ay - H) < 1e-6;
        const bTop = Math.abs(by - H) < 1e-6;
        if ((aSide && bTop && !aTop) || (aTop && bSide && !bTop)) {
          const cx = aSide ? Math.sign(ax) * W : Math.sign(bx) * W;
          b.quad(at(j, ax, ay), at(j, cx, H), at(j, bx, by), at(j, bx, by), C_PORTAL);
        }
      }
      // 面壁の上の笠（奥へ 2 点分）
      const back = run[Math.max(0, Math.min(run.length - 1, run.indexOf(j) + inward))];
      if (back !== j) b.quad(at(j, -W, H), at(j, W, H), at(back, W, H), at(back, -W, H), C_PORTAL);
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
        if (junction.cross?.[junction.arms.indexOf(a.arm)]) {
          const far = a.mouthS + a.arm.dir * CROSSWALK_TO;
          gaps.push({ from: Math.min(a.mouthS, far), to: Math.max(a.mouthS, far), linesOnly: true });
        }
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
      .map((g) => `${g.from.toFixed(2)}-${g.to.toFixed(2)}${g.linesOnly ? "L" : ""}`)
      .join(",");
  }

  /** 接続点 1 つの舗装面・路肩・外側線を、区画にまとめる区間として作る */
  private buildJunction(j: Junction): Chunk {
    const shape = junctionShape(this.roads.net, j);
    const ox = Math.round(j.x);
    const oz = Math.round(j.z);
    const paved = new GeoBuilder();
    const gravel = new GeoBuilder();
    const lines = new GeoBuilder();
    this.junctionPatch(shape, ox, oz, paved, gravel, lines);
    const isGravel = gravel.idx.length > 0 && paved.idx.length === 0;
    const surf = isGravel ? gravel : paved;
    const g = new THREE.BufferGeometry();
    const off = surf.pos.length / 3;
    g.setAttribute("position", new THREE.Float32BufferAttribute([...surf.pos, ...lines.pos], 3));
    g.setAttribute("color", new THREE.Float32BufferAttribute([...surf.col, ...lines.col], 3));
    g.setAttribute("uv", new THREE.Float32BufferAttribute([...surf.uv, ...lines.uv], 2));
    const idx = [...surf.idx, ...lines.idx.map((v) => v + off)];
    g.setIndex((surf.pos.length + lines.pos.length) / 3 > 65535 ? new THREE.Uint32BufferAttribute(idx, 1) : new THREE.Uint16BufferAttribute(idx, 1));
    g.addGroup(0, surf.idx.length, 0);
    if (lines.idx.length) g.addGroup(surf.idx.length, lines.idx.length, 1);
    g.computeVertexNormals();
    return {
      key: `J#${j.id}`,
      road: `J:${j.id}`,
      k: 0,
      geo: g,
      surface: isGravel ? 1 : 0,
      ox,
      oz,
      cell: `${Math.floor(ox / CELL)},${Math.floor(oz / CELL)}`,
      gapKey: shape.key,
      caster: null,
      far: false,
      net: this.roads.net.version,
    };
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

    // 横断歩道と停止線（北海道の世界。変換で印を付けた腕だけ。北海道の草案 26 章）
    const marks = sh.junction.cross;
    if (marks)
      for (const a of sh.arms) {
        const m = marks[sh.junction.arms.indexOf(a.arm)];
        if (!m) continue;
        this.crosswalk(a, m === 2, ox, oz, lines);
      }
  }

  /**
   * 腕の口の外に横断歩道（道に沿う向きの白い帯。幅 0.45m・間 0.45m、長さ 4m）、その外に停止線（幅 0.45m、接続点へ入る側の車線）。
   * 帯は区画線（0.012m）より少し上に置き、中央線の上にも重ねる
   */
  private crosswalk(a: JunctionShape["arms"][number], stop: boolean, ox: number, oz: number, lines: GeoBuilder) {
    const r = a.road;
    const dir = a.arm.dir;
    const hw = a.hw;
    // 道のり s の点と、道のりが増える向きに見て右 (−dz, dx)
    const at = (s: number, off: number, dy: number) => {
      const p = sampleRoad(r, s);
      return [p.x - p.dz * off - ox, p.y + dy, p.z + p.dx * off - oz];
    };
    // 口から外へ d0..d1 m の帯（lateral は道のりの向きに見て右への距離）。道のりの増える順に並べる
    const band = (d0: number, d1: number, l0: number, l1: number, dy: number) => {
      const s0 = a.mouthS + dir * d0;
      const s1 = a.mouthS + dir * d1;
      const lo = Math.min(s0, s1);
      const hi = Math.max(s0, s1);
      const L: number[][] = [], R: number[][] = [];
      for (let k = 0; k <= 2; k++) {
        const s = lo + ((hi - lo) * k) / 2;
        L.push(at(s, l0, dy));
        R.push(at(s, l1, dy));
      }
      lines.strip(L, R, C_LINE);
    };
    const CW0 = CROSSWALK_FROM;
    const CW1 = CROSSWALK_TO;
    const STRIPE = 0.45;
    const span = 2 * hw - 1;
    const count = Math.floor((span + STRIPE) / (2 * STRIPE));
    const first = -((count * 2 - 1) * STRIPE) / 2;
    for (let k = 0; k < count; k++) {
      const l = first + k * 2 * STRIPE;
      band(CW0, CW1, l, l + STRIPE, 0.016);
    }
    if (stop) {
      // 接続点へ入る車は口へ向かって左側を走る = 外向きに見て右（+r）= 道のりの向きに見て dir の側
      const l0 = dir > 0 ? 0.1 : -(hw - 0.3);
      const l1 = dir > 0 ? hw - 0.3 : -0.1;
      band(CW1 + 1.5, CW1 + 1.95, l0, l1, 0.016);
    }
  }
}

/** 頂点の色を、一番近い中心線の点の明るさ（dim）で掛ける（トンネルの中を暗くする） */
function darkenNear(b: GeoBuilder, px: number[], pz: number[], dim: number[]) {
  if (dim.every((d) => d === 1)) return;
  const n = b.pos.length / 3;
  for (let v = 0; v < n; v++) {
    const x = b.pos[v * 3];
    const z = b.pos[v * 3 + 2];
    let best = 0;
    let bd = Infinity;
    for (let j = 0; j < px.length; j++) {
      const d = (px[j] - x) * (px[j] - x) + (pz[j] - z) * (pz[j] - z);
      if (d < bd) {
        bd = d;
        best = j;
      }
    }
    const k = dim[best];
    if (k === 1) continue;
    b.col[v * 3] *= k;
    b.col[v * 3 + 1] *= k;
    b.col[v * 3 + 2] *= k;
  }
}
