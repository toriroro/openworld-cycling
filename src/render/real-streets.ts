// 北海道の世界の走らない道（住宅街の道・敷地の道・歩道）。見た目だけ（北海道の草案 17・18 章）。
// 範囲（range）の区画の道を 1 つのメッシュにまとめる（車の道はアスファルトの材質、歩道は頂点色だけの材質。描画命令 2）。
// 形は city.worker.ts で作り、ここでは届いた配列を描画の形にして入れ替える（作っている間は古い組を出しておく）。
// 地形はこの道に合わせて平らにする（pack を地形タイルへ渡す。印 STREET_FLAG = 見た目だけの道、地形を下げる量が小さい）。

import * as THREE from "three";
import type { HokkaidoSidewalks, HokkaidoStreets } from "../shared/world/hokkaido.ts";
import type { TerrainLike } from "../shared/world/terrain.ts";
import type { Rect } from "../shared/world/world.ts";
import { type PackedRoads, STREET_FLAG } from "../workers/terrain-tile.ts";
import type { MeshArrays } from "./building/mesher.ts";
import { toGeometry } from "./building/to-geometry.ts";
import { resampleStreet } from "./city-build.ts";
import type { CityClient } from "./city-client.ts";

interface Layer {
  key: string;
  mesh: THREE.Mesh | null;
  ox: number;
  oz: number;
}

export class RealStreets {
  readonly group = new THREE.Group();
  range = 1300;
  /** 幹線の歩道を描く範囲と、街路樹を描く範囲 (m) */
  walkRange = 700;
  treeRange = 900;
  private layer: Layer | null = null;
  private lastT = 0;
  private key = "";
  private originX = 0;
  private originZ = 0;
  readonly cell: number;
  readonly buildMs: number[] = [];
  readonly workerMs: number[] = [];
  stats = { pieces: 0, triangles: 0 };

  constructor(
    private data: HokkaidoStreets,
    private heights: TerrainLike,
    private mats: { paved: THREE.Material; path: THREE.Material; walk: THREE.Material; tree: THREE.Material; treeGeo: THREE.BufferGeometry },
    private client: CityClient,
    /** 幹線の歩道と街路樹（北海道の草案 19 章。無ければ null） */
    private sidewalks: HokkaidoSidewalks | null = null,
  ) {
    this.group.name = "real-streets";
    this.cell = data.index.cell;
    client.on("streets", (key, r, ox, oz) => {
      if (r.type !== "streets") return;
      const t0 = performance.now();
      this.finish(key, r.mesh, r.groups, ox, oz);
      this.stats = { pieces: r.pieces, triangles: r.triangles };
      this.workerMs.push(r.ms);
      this.buildMs.push(performance.now() - t0);
      if (this.buildMs.length > 2000) {
        this.buildMs.splice(0, 1000);
        this.workerMs.splice(0, 1000);
      }
    });
  }

  setQuality(light: boolean) {
    this.range = light ? 650 : 1300;
    this.walkRange = light ? 400 : 700;
    this.treeRange = light ? 500 : 900;
    this.lastT = 0;
  }

  setOrigin(x: number, z: number) {
    this.originX = x;
    this.originZ = z;
    if (this.layer?.mesh) this.place(this.layer);
    if (this.trees) this.trees.position.set(this.treesAt.x - x, 0, this.treesAt.z - z);
  }

  get pending(): number {
    return this.client.busy("streets") ? 1 : 0;
  }

  private place(l: Layer) {
    l.mesh!.position.set(l.ox - this.originX, 0, l.oz - this.originZ);
    l.mesh!.updateMatrix();
  }

  private cellsWithin(cx: number, cz: number, range: number): string[] {
    const C = this.cell;
    const out: string[] = [];
    for (let i = Math.floor((cx - range) / C); i <= Math.floor((cx + range) / C); i++)
      for (let j = Math.floor((cz - range) / C); j <= Math.floor((cz + range) / C); j++) {
        const dx = Math.max(i * C - cx, 0, cx - (i + 1) * C);
        const dz = Math.max(j * C - cz, 0, cz - (j + 1) * C);
        if (dx * dx + dz * dz > range * range) continue;
        if (this.data.cell(i, j)) out.push(`${i},${j}`);
      }
    return out.sort();
  }

  update(cx: number, cz: number) {
    const now = performance.now();
    if (now - this.lastT < 300) return;
    this.lastT = now;
    const cells = this.cellsWithin(cx, cz, this.range);
    const walk = this.cellsWithin(cx, cz, this.walkRange);
    const key = `${cells.join("|")}#${walk.join("|")}`;
    if (key === this.key) return;
    this.key = key;
    const ox = Math.round(cx / 256) * 256;
    const oz = Math.round(cz / 256) * 256;
    this.client.request("streets", key, cells, ox, oz, walk);
    this.updateTrees(this.cellsWithin(cx, cz, this.treeRange), ox, oz);
  }

  private trees: THREE.InstancedMesh | null = null;
  private treesAt = { x: 0, z: 0 };

  /** 街路樹（範囲の区画の木を 1 つの InstancedMesh に。描画命令 1） */
  private updateTrees(cells: string[], ox: number, oz: number) {
    const S = this.sidewalks;
    if (!S) return;
    if (this.trees) {
      this.group.remove(this.trees);
      this.trees.dispose();
      this.trees = null;
    }
    const list: number[] = [];
    for (const k of cells) for (const t of S.index.trees[k] ?? []) list.push(t);
    if (!list.length) return;
    const inst = new THREE.InstancedMesh(this.mats.treeGeo, this.mats.tree, list.length);
    inst.name = "real-streets:trees";
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), up = new THREE.Vector3(0, 1, 0), p = new THREE.Vector3(), sc = new THREE.Vector3();
    const T = S.trees;
    list.forEach((t, i) => {
      const o = t * 5;
      q.setFromAxisAngle(up, T[o + 4]);
      p.set(T[o] - ox, T[o + 1] - 0.1, T[o + 2] - oz);
      sc.setScalar(T[o + 3]);
      m.compose(p, q, sc);
      inst.setMatrixAt(i, m);
    });
    inst.castShadow = true;
    inst.frustumCulled = false;
    this.trees = inst;
    this.treesAt = { x: ox, z: oz };
    inst.position.set(ox - this.originX, 0, oz - this.originZ);
    this.group.add(inst);
    this.treeCount = list.length;
  }
  treeCount = 0;

  /** Worker で 1 つにまとめた車の道と歩道（材質 2 つ）を出す */
  private finish(key: string, arrays: MeshArrays | null, groups: [number, number, number][], ox: number, oz: number) {
    if (this.layer?.mesh) {
      this.group.remove(this.layer.mesh);
      this.layer.mesh.geometry.dispose();
    }
    let mesh: THREE.Mesh | null = null;
    if (arrays) {
      const g = toGeometry(arrays);
      for (const [s, c, m] of groups) g.addGroup(s, c, m);
      mesh = new THREE.Mesh(g, [this.mats.paved, this.mats.path, this.mats.walk]);
      mesh.name = "real-streets";
      mesh.receiveShadow = true;
      mesh.matrixAutoUpdate = false;
      this.group.add(mesh);
    }
    this.layer = { key, mesh, ox, oz };
    if (mesh) this.place(this.layer);
  }

  /** 地形タイルへ渡す折れ線（rect の左上からの相対。terrain-tile の PackedRoads の形。印は STREET_FLAG） */
  pack(r: Rect, margin: number, stride: number): PackedRoads | null {
    const C = this.cell;
    const x0 = r.x0 - margin, z0 = r.z0 - margin, x1 = r.x1 + margin, z1 = r.z1 + margin;
    const pts: number[] = [];
    const starts: number[] = [];
    for (let i = Math.floor(x0 / C); i <= Math.floor(x1 / C); i++)
      for (let j = Math.floor(z0 / C); j <= Math.floor(z1 / C); j++) {
        const list = this.data.cell(i, j);
        if (!list) continue;
        for (const [off, count, w10] of list) {
          const p = resampleStreet(this.data, this.heights, off, count, 4 * stride);
          if (p.length < 6) continue;
          starts.push(pts.length / 5);
          for (let k = 0; k < p.length; k += 3) pts.push(p[k] - r.x0, p[k + 2] - r.z0, p[k + 1], w10 / 20, STREET_FLAG);
        }
      }
    // 幹線の歩道（中心の線、半幅、歩道の高さ）。地形は歩道の下まで下げる
    const S = this.sidewalks;
    if (S)
      for (let i = Math.floor(x0 / C); i <= Math.floor(x1 / C); i++)
        for (let j = Math.floor(z0 / C); j <= Math.floor(z1 / C); j++)
          for (const [off, count] of S.index.sidewalks[`${i},${j}`] ?? []) {
            if (count < 2) continue;
            starts.push(pts.length / 5);
            for (let k = 0; k < count; k += stride === 1 ? 1 : 2) {
              const o = (off + k) * 5;
              const P = S.pts;
              pts.push((P[o] + P[o + 2]) / 2 - r.x0, (P[o + 1] + P[o + 3]) / 2 - r.z0, P[o + 4], Math.hypot(P[o + 2] - P[o], P[o + 3] - P[o + 1]) / 2, STREET_FLAG);
            }
          }
    if (!starts.length) return null;
    starts.push(pts.length / 5);
    // 1 点だけの折れ線を除く
    const outPts: number[] = [];
    const outStarts: number[] = [];
    for (let k = 0; k < starts.length - 1; k++) {
      if (starts[k + 1] - starts[k] < 2) continue;
      outStarts.push(outPts.length / 5);
      for (let q = starts[k] * 5; q < starts[k + 1] * 5; q++) outPts.push(pts[q]);
    }
    if (!outStarts.length) return null;
    outStarts.push(outPts.length / 5);
    return { pts: Float32Array.from(outPts), starts: Int32Array.from(outStarts) };
  }
}
