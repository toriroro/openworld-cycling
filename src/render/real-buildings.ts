// 北海道の世界の建物（OSM の外形から変換したもの。北海道の草案 15〜18 章）。
// 近く（nearRange 以内の区画）は生成の世界と同じ 8 つの型で細部まで、遠く（farRange 以内）は色の付いた箱で描く。敷地の地面も一緒に描く。
// 形は city.worker.ts で作り（city-build.ts）、ここでは届いた配列を描画の形にして入れ替えるだけ（1 フレームに作る時間を目安の 4ms に収めるため）。
// どちらも 1 組のメッシュ（近くは材質の数、遠くは 1 つの描画命令）。作っている間は古い組を出しておく。

import * as THREE from "three";
import { BUILDING_REC, type HokkaidoBuildings } from "../shared/world/hokkaido.ts";
import type { Rect } from "../shared/world/world.ts";
import { toGeometry } from "./building/to-geometry.ts";
import type { BuildingMeshes } from "./buildings.ts";
import { BUILDING_KINDS } from "./city-build.ts";
import type { CityClient } from "./city-client.ts";

interface Layer {
  key: string;
  meshes: THREE.Mesh[];
  ox: number;
  oz: number;
  triangles: number;
  buildings: number;
}

export class RealBuildings {
  readonly group = new THREE.Group();
  nearRange = 260;
  farRange = 1300;
  private near: Layer | null = null;
  private far: Layer | null = null;
  private lastT = 0;
  private originX = 0;
  private originZ = 0;
  private nearKey = "";
  private farKey = "";
  /** Worker で作るのにかかった時間 (ms) と、届いた配列を描画の形にした時間 (ms) */
  readonly workerMs: number[] = [];
  readonly buildMs: number[] = [];
  readonly cell: number;

  constructor(
    private data: HokkaidoBuildings,
    private kit: BuildingMeshes,
    private client: CityClient,
  ) {
    this.group.name = "real-buildings";
    this.cell = data.index.cell;
    client.on("near", (key, r, ox, oz) => {
      if (r.type !== "near") return;
      const t0 = performance.now();
      const meshes: THREE.Mesh[] = [];
      r.kinds.forEach((a, i) => {
        if (a) meshes.push(this.kit.meshFor(BUILDING_KINDS[i], toGeometry(a)));
      });
      this.swap("near", { key, meshes, ox, oz, triangles: r.triangles, buildings: r.buildings });
      this.note(r.ms, t0);
    });
    client.on("far", (key, r, ox, oz) => {
      if (r.type !== "far") return;
      const t0 = performance.now();
      const meshes: THREE.Mesh[] = [];
      if (r.mesh) {
        const m = new THREE.Mesh(toGeometry(r.mesh), this.kit.boxMaterial);
        m.name = "real-buildings:far";
        m.castShadow = false;
        m.receiveShadow = true;
        m.matrixAutoUpdate = false;
        meshes.push(m);
      }
      this.swap("far", { key, meshes, ox, oz, triangles: r.triangles, buildings: r.buildings });
      this.note(r.ms, t0);
    });
  }

  private note(workerMs: number, t0: number) {
    this.workerMs.push(workerMs);
    this.buildMs.push(performance.now() - t0);
    if (this.buildMs.length > 2000) {
      this.buildMs.splice(0, 1000);
      this.workerMs.splice(0, 1000);
    }
  }

  setQuality(light: boolean) {
    this.nearRange = light ? 160 : 260;
    this.farRange = light ? 650 : 1300;
    this.lastT = 0;
  }

  setOrigin(x: number, z: number) {
    this.originX = x;
    this.originZ = z;
    for (const l of [this.near, this.far]) if (l) this.place(l);
  }

  private place(l: Layer) {
    for (const m of l.meshes) {
      m.position.set(l.ox - this.originX, 0, l.oz - this.originZ);
      m.updateMatrix();
    }
  }

  get pending(): number {
    return (this.client.busy("near") ? 1 : 0) + (this.client.busy("far") ? 1 : 0);
  }

  stats() {
    return {
      near: this.near ? { buildings: this.near.buildings, triangles: this.near.triangles, meshes: this.near.meshes.length } : null,
      far: this.far ? { buildings: this.far.buildings, triangles: this.far.triangles } : null,
      pending: this.pending,
    };
  }

  /** 区画の組（中心からの距離が range 以内の区画）。exclude の区画は除く */
  private cellsWithin(cx: number, cz: number, range: number, exclude?: Set<string>): string[] {
    const C = this.cell;
    const out: string[] = [];
    for (let i = Math.floor((cx - range) / C); i <= Math.floor((cx + range) / C); i++)
      for (let j = Math.floor((cz - range) / C); j <= Math.floor((cz + range) / C); j++) {
        const dx = Math.max(i * C - cx, 0, cx - (i + 1) * C);
        const dz = Math.max(j * C - cz, 0, cz - (j + 1) * C);
        if (dx * dx + dz * dz > range * range) continue;
        const k = `${i},${j}`;
        if (exclude?.has(k) || !this.data.index.cells[k]) continue;
        out.push(k);
      }
    return out.sort();
  }

  update(cx: number, cz: number) {
    const now = performance.now();
    if (now - this.lastT < 300) return;
    this.lastT = now;
    const nearCells = this.cellsWithin(cx, cz, this.nearRange);
    const nearKey = nearCells.join("|");
    const farCells = this.cellsWithin(cx, cz, this.farRange, new Set(nearCells));
    const farKey = `${farCells.join("|")}#${nearKey}`;
    const ox = Math.round(cx / 256) * 256;
    const oz = Math.round(cz / 256) * 256;
    // 近くを先に頼む
    if (nearKey !== this.nearKey) {
      this.nearKey = nearKey;
      this.client.request("near", nearKey, nearCells, ox, oz);
    }
    if (farKey !== this.farKey) {
      this.farKey = farKey;
      this.client.request("far", farKey, farCells, ox, oz);
    }
  }

  private swap(kind: "near" | "far", l: Layer) {
    this.place(l);
    const old = kind === "near" ? this.near : this.far;
    if (old)
      for (const m of old.meshes) {
        this.group.remove(m);
        m.geometry.dispose();
      }
    if (kind === "near") this.near = l;
    else this.far = l;
    for (const m of l.meshes) this.group.add(m);
  }

  /** 矩形にかかる建物の敷地（植生を置かない円）を、矩形の左上からの相対で [x, z, r, ...] */
  lotsIn(r: Rect): number[] {
    const C = this.cell;
    const out: number[] = [];
    const D = this.data.data;
    for (let i = Math.floor(r.x0 / C) - 1; i <= Math.floor(r.x1 / C); i++)
      for (let j = Math.floor(r.z0 / C) - 1; j <= Math.floor(r.z1 / C); j++) {
        const c = this.data.cell(i, j);
        if (!c) continue;
        for (let k = c[0]; k < c[0] + c[1]; k++) {
          const o = k * BUILDING_REC;
          const rad = Math.hypot(D[o + 2], D[o + 3]) / 2 + 1;
          if (D[o] + rad < r.x0 || D[o] - rad > r.x1 || D[o + 1] + rad < r.z0 || D[o + 1] - rad > r.z1) continue;
          out.push(D[o] - r.x0, D[o + 1] - r.z0, rad);
          // 正面の駐車場（city-build.ts の pad と同じ範囲）にも木を置かない
          const front = Math.max(0, Math.min(D[o + 9] - 0.6, 9));
          if (front > 1) {
            const a = D[o + 5];
            const zs = D[o + 10] > 0 ? 1 : -1;
            const fx = -Math.sin(a) * zs;
            const fz = Math.cos(a) * zs;
            const d = D[o + 3] / 2 + front / 2;
            out.push(D[o] + fx * d - r.x0, D[o + 1] + fz * d - r.z0, Math.max(D[o + 2] / 2 + 1.5, front / 2 + 0.5));
          }
        }
      }
    return out;
  }
}
