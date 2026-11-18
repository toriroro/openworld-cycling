// 名所の模型を出す・しまう（名所の草案 docs/history/specs/2026-11-18-landmarks-draft.md）。
// 名所ごとの見える距離（view）に入ったら、その辺りの地形・走らない道の頁を読んでから模型を作る（1 度に 1 か所）。
// 出ている名所の模型は、材質ごとに 1 つのメッシュにまとめる（描画命令は材質 4 と木 1）。

import * as THREE from "three";
import type { HokkaidoWorld } from "../../shared/world/hokkaido.ts";
import { type LandmarkData, type LandmarkFile, polygonBounds } from "../../shared/world/landmarks.ts";
import type { TerrainLike } from "../../shared/world/terrain.ts";
import type { MeshArrays } from "../building/mesher.ts";
import { toGeometry } from "../building/to-geometry.ts";
import { buildLandmark, type LandmarkParts, type TreeInst } from "./models.ts";

const MATS = ["solid", "shiny", "ground", "glow"] as const;
/** 1 フレームに名所の芝・林を作る時間の目安 (ms)。建物の Worker の受け取りと同じく 4ms に収める（北海道の草案 18 章） */
const JOB_MS = 3;
type MatName = (typeof MATS)[number];

interface Built {
  lm: LandmarkData;
  ox: number;
  oz: number;
  arrays: Record<MatName, MeshArrays | null>;
  trees: TreeInst[];
  triangles: number;
  ms: number;
  /** 芝・舗装（名所ごとの 1 つのメッシュ。大きいので、ほかの名所が出入りしてもまとめ直さない） */
  ground?: THREE.Mesh;
}

/** 道路・走らない道の線分の格子（芝を道路の上に張らないため） */
class RoadMask {
  private cell = 8;
  private grid = new Map<number, number[]>();
  private seg: number[] = [];
  add(ax: number, az: number, bx: number, bz: number, hw: number) {
    const k = this.seg.length / 5;
    this.seg.push(ax, az, bx, bz, hw);
    const C = this.cell;
    for (let i = Math.floor((Math.min(ax, bx) - hw) / C); i <= Math.floor((Math.max(ax, bx) + hw) / C); i++)
      for (let j = Math.floor((Math.min(az, bz) - hw) / C); j <= Math.floor((Math.max(az, bz) + hw) / C); j++) {
        const key = i * 73856093 + j;
        let l = this.grid.get(key);
        if (!l) this.grid.set(key, (l = []));
        l.push(k);
      }
  }
  near(x: number, z: number, pad: number): boolean {
    const C = this.cell;
    const r = Math.ceil(pad / C);
    const ci = Math.floor(x / C), cj = Math.floor(z / C);
    for (let i = ci - r; i <= ci + r; i++)
      for (let j = cj - r; j <= cj + r; j++) {
        const l = this.grid.get(i * 73856093 + j);
        if (!l) continue;
        for (const k of l) {
          const S = this.seg;
          const ax = S[k * 5], az = S[k * 5 + 1], dx = S[k * 5 + 2] - ax, dz = S[k * 5 + 3] - az, hw = S[k * 5 + 4] + pad;
          const l2 = dx * dx + dz * dz || 1;
          const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / l2));
          const ex = ax + dx * t - x, ez = az + dz * t - z;
          if (ex * ex + ez * ez <= hw * hw) return true;
        }
      }
    return false;
  }
}

export class LandmarkView {
  readonly group = new THREE.Group();
  readonly list: LandmarkData[];
  private built = new Map<string, Built>();
  private busy: string | null = null;
  /** 作りかけの名所（後の仕事を 1 フレームに JOB_MS ずつ進める） */
  private job: { lm: LandmarkData; ox: number; oz: number; parts: LandmarkParts; i: number; ms: number; arrays: Partial<Record<MatName, MeshArrays | null>> } | null = null;
  private dirty = false;
  private lastT = 0;
  private originX = 0;
  private originZ = 0;
  private light = false;
  private meshes: THREE.Object3D[] = [];
  private mats: Record<MatName, THREE.Material>;
  /** 作った時間 (ms) の記録 */
  readonly buildMs: number[] = [];
  /** 1 フレームに名所を作るのに使った時間 (ms) の記録（作る・まとめる） */
  readonly sliceMs: number[] = [];
  /** 名所の骨組み（建物・塔。読み込みの後に 1 度に作る）の時間 (ms) */
  readonly skeletonMs: number[] = [];
  stats = { shown: 0, triangles: 0, trees: 0 };

  constructor(
    file: LandmarkFile,
    private world: HokkaidoWorld,
    private heights: TerrainLike,
    private tree: { geometry: THREE.BufferGeometry; material: THREE.Material },
  ) {
    this.group.name = "landmarks";
    this.list = file.landmarks;
    this.mats = {
      solid: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.78 }),
      shiny: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.14, metalness: 0.25 }),
      ground: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4 }),
      glow: new THREE.MeshBasicMaterial({ vertexColors: true }),
    };
  }

  get materials(): THREE.Material[] {
    return Object.values(this.mats);
  }

  /** 模型で置き換える OSM の建物の外形（世界座標の [x, z, ...]） */
  replacedOutlines(): number[][] {
    return this.list.flatMap((lm) => lm.features.filter((f) => f.t === "building" && f.replace).map((f) => f.pts));
  }

  setQuality(light: boolean) {
    if (light === this.light) return;
    this.light = light;
    // 作りかけの名所は捨てる（作り終わる前に画質が変わった時）
    if (this.job) {
      this.job = null;
      this.busy = null;
    }
    // 芝の格子の細かさが変わるので作り直す
    for (const b of this.built.values()) this.dropGround(b);
    this.built.clear();
    this.dirty = true;
  }

  setOrigin(x: number, z: number) {
    this.originX = x;
    this.originZ = z;
    for (const m of this.meshes) m.position.set(-x, 0, -z);
    for (const b of this.built.values()) b.ground?.position.set(-x, 0, -z);
  }

  private dropGround(b: Built) {
    if (!b.ground) return;
    this.group.remove(b.ground);
    b.ground.geometry.dispose();
    b.ground = undefined;
  }

  get pending(): number {
    return this.busy ? 1 : 0;
  }

  /** 模型を出す距離。軽量の画質では、低い名所（公園など）は半分にする（高い塔・山の上は遠くから見えるのでそのまま） */
  private range(lm: LandmarkData) {
    return this.light && lm.view < 5000 ? lm.view * 0.5 : lm.view;
  }

  /** 名所の区域までの距離 */
  private distance(lm: LandmarkData, x: number, z: number) {
    const b = polygonBounds(lm.zone);
    const dx = Math.max(b.x0 - x, 0, x - b.x1), dz = Math.max(b.z0 - z, 0, z - b.z1);
    return Math.hypot(dx, dz);
  }

  update(x: number, z: number) {
    const t0 = performance.now();
    if (this.job) this.runJob();
    if (this.dirty && !this.job) this.merge();
    const used = performance.now() - t0;
    if (used > 0.05) {
      this.sliceMs.push(used);
      if (this.sliceMs.length > 2000) this.sliceMs.splice(0, 1000);
    }
    const now = performance.now();
    if (now - this.lastT < 400) return;
    this.lastT = now;
    for (const [id, b] of this.built)
      if (this.distance(b.lm, x, z) > this.range(b.lm) * 1.25) {
        this.dropGround(b);
        this.built.delete(id);
        this.dirty = true;
      }
    if (!this.busy) {
      const next = this.list
        .filter((lm) => !this.built.has(lm.id) && this.distance(lm, x, z) <= this.range(lm))
        .sort((a, b) => this.distance(a, x, z) - this.distance(b, x, z))[0];
      if (next) void this.build(next);
    }
  }

  /** 作りかけの名所の仕事を JOB_MS まで進める。終わったら配列にして出す組に入れる */
  private runJob() {
    const j = this.job!;
    const t0 = performance.now();
    const jobs = j.parts.jobs;
    while (j.i < jobs.length && performance.now() - t0 < JOB_MS) jobs[j.i++]();
    j.ms += performance.now() - t0;
    if (j.i < jobs.length) return;
    // 配列にするのは 1 フレームに 1 つの材質まで（大きな芝で 5ms ほどかかる）
    const t1 = performance.now();
    const next = MATS.find((k) => !(k in j.arrays));
    if (next) {
      const a = j.parts[next].arrays();
      // 位置を世界座標にしておく（まとめる時に足し算をしないで済むように）
      if (a) {
        for (let i = 0; i < a.pos.length; i += 3) {
          a.pos[i] += j.ox;
          a.pos[i + 2] += j.oz;
        }
        if (a.sphere) a.sphere = [a.sphere[0] + j.ox, a.sphere[1], a.sphere[2] + j.oz, a.sphere[3]];
      }
      j.arrays[next] = a;
      this.arraysMs.push(performance.now() - t1);
      j.ms += performance.now() - t1;
      return;
    }
    const arrays = j.arrays as Record<MatName, MeshArrays | null>;
    let triangles = 0;
    for (const k of MATS) triangles += j.parts[k].triangles;
    this.buildMs.push(j.ms);
    this.built.set(j.lm.id, { lm: j.lm, ox: j.ox, oz: j.oz, arrays, trees: j.parts.trees, triangles, ms: j.ms });
    this.job = null;
    this.busy = null;
    this.dirty = true;
  }

  private async build(lm: LandmarkData) {
    this.busy = lm.id;
    try {
      const b = polygonBounds(lm.zone);
      const r = { x0: b.x0 - 120, z0: b.z0 - 120, x1: b.x1 + 120, z1: b.z1 + 120 };
      await Promise.all([this.world.terrain.ensure(r), this.world.streets?.ensure(r)]);
      const t0 = performance.now();
      const mask = this.mask(r);
      const ox = Math.round(lm.x), oz = Math.round(lm.z);
      const parts: LandmarkParts = buildLandmark(lm, ox, oz, {
        ground: (x, z) => this.heights.height(x, z),
        onRoad: (x, z, pad) => mask.near(x, z, pad),
        light: this.light,
      });
      // 形の骨組み（建物・塔）はここで作り、芝・林は次のフレームから少しずつ
      const skel = performance.now() - t0;
      this.skeletonMs.push(skel);
      this.job = { lm, ox, oz, parts, i: 0, ms: skel, arrays: {} };
    } catch (e) {
      console.error("landmark", lm.id, e);
      // 作れなかった名所は、空のまま出したことにする（何度も作り直さない）
      this.built.set(lm.id, { lm, ox: 0, oz: 0, arrays: { solid: null, shiny: null, ground: null, glow: null }, trees: [], triangles: 0, ms: 0 });
      this.busy = null;
    }
  }

  /** 範囲の道路（走る道は歩道の分も）と走らない道 */
  private mask(r: { x0: number; z0: number; x1: number; z1: number }): RoadMask {
    const m = new RoadMask();
    for (const road of this.world.roadsInRect(r)) {
      const P = road.points;
      const [ox, oz] = road.origin;
      const hw = road.width / 2 + (road.width >= 5 ? 2.4 : 0.4);
      for (let i = 0; i + 1 < P.length / 3; i++) m.add(P[i * 3] + ox, P[i * 3 + 2] + oz, P[i * 3 + 3] + ox, P[i * 3 + 5] + oz, hw);
    }
    const S = this.world.streets;
    if (S) {
      const C = S.index.cell;
      const seen = new Set<number>();
      for (let i = Math.floor(r.x0 / C); i <= Math.floor(r.x1 / C); i++)
        for (let j = Math.floor(r.z0 / C); j <= Math.floor(r.z1 / C); j++)
          for (const [off, count, w10] of S.cell(i, j) ?? []) {
            if (seen.has(off)) continue;
            seen.add(off);
            const P = S.pts;
            for (let k = 0; k + 1 < count; k++) m.add(P[(off + k) * 2], P[(off + k) * 2 + 1], P[(off + k + 1) * 2], P[(off + k + 1) * 2 + 1], w10 / 20 + 0.2);
          }
    }
    return m;
  }

  /** 出ている名所の模型を、材質ごとに 1 つにまとめる */
  /** まとめ直しにかかった時間 (ms) と、配列にする時間 (ms) の記録 */
  readonly mergeMs: number[] = [];
  readonly arraysMs: number[] = [];

  private merge() {
    const tm = performance.now();
    this.dirty = false;
    for (const m of this.meshes) {
      this.group.remove(m);
      if (m instanceof THREE.InstancedMesh) m.dispose();
      else if (m instanceof THREE.Mesh) m.geometry.dispose();
    }
    this.meshes = [];
    let triangles = 0;
    for (const b of this.built.values()) {
      const a = b.arrays.ground;
      if (!a) continue;
      triangles += a.idx.length / 3;
      if (b.ground) continue;
      const mesh = new THREE.Mesh(toGeometry(a), this.mats.ground);
      mesh.name = `landmarks:ground:${b.lm.id}`;
      mesh.receiveShadow = true;
      mesh.position.set(-this.originX, 0, -this.originZ);
      this.group.add(mesh);
      b.ground = mesh;
    }
    for (const k of MATS) {
      if (k === "ground") continue;
      const list = [...this.built.values()].filter((b) => b.arrays[k]);
      if (!list.length) continue;
      const a = concat(list.map((b) => b.arrays[k]!));
      const mesh = new THREE.Mesh(toGeometry(a), this.mats[k]);
      mesh.name = `landmarks:${k}`;
      mesh.castShadow = k === "solid" || k === "shiny";
      mesh.receiveShadow = k !== "glow";
      mesh.position.set(-this.originX, 0, -this.originZ);
      mesh.matrixAutoUpdate = true;
      this.group.add(mesh);
      this.meshes.push(mesh);
      triangles += a.idx.length / 3;
    }
    const trees = [...this.built.values()].flatMap((b) => b.trees.map((t) => ({ t, ox: b.ox, oz: b.oz })));
    if (trees.length) {
      const inst = new THREE.InstancedMesh(this.tree.geometry, this.tree.material, trees.length);
      inst.name = "landmarks:trees";
      const m = new THREE.Matrix4(), q = new THREE.Quaternion(), up = new THREE.Vector3(0, 1, 0), p = new THREE.Vector3(), sc = new THREE.Vector3(), col = new THREE.Color();
      trees.forEach(({ t, ox, oz }, i) => {
        q.setFromAxisAngle(up, t.rot);
        p.set(t.x + ox, t.y, t.z + oz);
        sc.set(t.s, t.sy, t.s);
        m.compose(p, q, sc);
        inst.setMatrixAt(i, m);
        inst.setColorAt(i, col.setRGB(t.c[0], t.c[1], t.c[2]));
      });
      inst.castShadow = true;
      inst.frustumCulled = false;
      inst.position.set(-this.originX, 0, -this.originZ);
      this.group.add(inst);
      this.meshes.push(inst);
    }
    this.stats = { shown: this.built.size, triangles, trees: trees.length };
    this.mergeMs.push(performance.now() - tm);
  }
}

/** 名所ごとの配列（位置は世界座標）を 1 つにする */
function concat(list: MeshArrays[]): MeshArrays {
  if (list.length === 1) return list[0];
  let V = 0, I = 0;
  for (const a of list) {
    V += a.pos.length / 3;
    I += a.idx.length;
  }
  const pos = new Float32Array(V * 3), nor = new Float32Array(V * 3), uv = new Float32Array(V * 2), col = new Float32Array(V * 3);
  const idx = V > 65535 ? new Uint32Array(I) : new Uint16Array(I);
  let v = 0, i = 0;
  for (const a of list) {
    const n = a.pos.length / 3;
    pos.set(a.pos, v * 3);
    nor.set(a.nor, v * 3);
    uv.set(a.uv, v * 2);
    col.set(a.col, v * 3);
    if (v === 0) idx.set(a.idx, i);
    else for (let k = 0; k < a.idx.length; k++) idx[i + k] = a.idx[k] + v;
    v += n;
    i += a.idx.length;
  }
  // 包む球: 名所ごとの球をまとめる（頂点をなめない）
  let sphere: [number, number, number, number] | undefined;
  if (list.every((a) => a.sphere)) {
    let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
    for (const a of list) {
      const [x, y, z, r] = a.sphere!;
      x0 = Math.min(x0, x - r);
      x1 = Math.max(x1, x + r);
      y0 = Math.min(y0, y - r);
      y1 = Math.max(y1, y + r);
      z0 = Math.min(z0, z - r);
      z1 = Math.max(z1, z + r);
    }
    const c = [(x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2];
    let r = 0;
    for (const a of list) r = Math.max(r, Math.hypot(a.sphere![0] - c[0], a.sphere![1] - c[1], a.sphere![2] - c[2]) + a.sphere![3]);
    sphere = [c[0], c[1], c[2], r];
  }
  return { pos, nor, uv, col, idx, sphere };
}
