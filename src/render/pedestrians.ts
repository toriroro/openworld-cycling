// 歩く人・頼み事の印・家の旗の描画（配達の草案 16 章、D2）。外部の素材は使わず、箱を組んだ簡単な人形をインスタンス描画する。
// 人の位置は src/sim/pedestrians.ts（歩く人）と src/shared/work-places.ts（頼み事の人・旗の家）が決め、ここは描くだけ。
// 冬の町に合わせて、上着は落ち着いた色にする。

import * as THREE from "three";
import type { Walker } from "../sim/pedestrians.ts";
import { type RealPerson, RealPedestrians } from "./pedestrian-real.ts";

const CAPACITY = 280;
const CARRIED = 16;
const MARKS = 24;
const FLAGS = 24;
/** リアルな形で描く距離 (m)・人数（標準の画質だけ。町の見た目の草案 3 章）【初期値】 */
const REAL_RANGE = 40;
const REAL_MAX = 32;

/** 上着・ズボンの色（冬の上着の落ち着いた色） */
const COATS = ["#2b3442", "#3b3b3e", "#5b4a3a", "#2f4a3c", "#5a2a30", "#6b6f74", "#8a7a62", "#1f2226", "#40506a", "#7a3e2a", "#9a9488", "#2a2f3a"];
const PANTS = ["#24262b", "#2c3240", "#3a3a3a", "#4a4236", "#1c1d20"];
const HAIR = ["#1c1714", "#2a211b", "#3b2d22", "#56565a"];
/** 印・旗の色（行き先の印と同じ橙） */
const MARK = "#ff8a1f";

function colored(g: THREE.BufferGeometry, color: string): THREE.BufferGeometry {
  const c = new THREE.Color(color);
  const n = g.getAttribute("position").count;
  const col = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) col.set([c.r, c.g, c.b], i * 3);
  g.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
  g.deleteAttribute("uv");
  return g;
}

function box(sx: number, sy: number, sz: number, x: number, y: number, z: number, color = "#ffffff"): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(sx, sy, sz).toNonIndexed();
  g.translate(x, y, z);
  return colored(g, color);
}

function merge(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  let n = 0;
  for (const p of parts) n += p.getAttribute("position").count;
  const pos = new Float32Array(n * 3);
  const nor = new Float32Array(n * 3);
  const col = new Float32Array(n * 3);
  let o = 0;
  for (const p of parts) {
    const c = p.getAttribute("position").count;
    pos.set(p.getAttribute("position").array as Float32Array, o * 3);
    nor.set(p.getAttribute("normal").array as Float32Array, o * 3);
    col.set(p.getAttribute("color").array as Float32Array, o * 3);
    o += c;
    p.dispose();
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  g.setAttribute("normal", new THREE.BufferAttribute(nor, 3));
  g.setAttribute("color", new THREE.BufferAttribute(col, 3));
  return g;
}

/** 胴と腕（上着の色はインスタンスの色。白で作る）。原点は足元、+z が前 */
function torso(): THREE.BufferGeometry {
  return merge([box(0.4, 0.62, 0.24, 0, 1.2, 0), box(0.1, 0.56, 0.12, 0.25, 1.2, 0.01), box(0.1, 0.56, 0.12, -0.25, 1.2, 0.01), box(0.16, 0.08, 0.16, 0, 1.53, 0)]);
}

/** 脚 1 本（色はインスタンスの色）。原点は股の付け根 */
function leg(): THREE.BufferGeometry {
  return merge([box(0.15, 0.82, 0.16, 0, -0.41, 0), box(0.15, 0.08, 0.26, 0, -0.86, 0.04, "#2a2522")]);
}

/** 頭（肌と髪の色は頂点の色。髪の色ごとに別のメッシュにする）。原点は足元 */
function head(hair: string): THREE.BufferGeometry {
  return merge([box(0.2, 0.22, 0.21, 0, 1.68, 0.01, "#d9b49a"), box(0.22, 0.09, 0.23, 0, 1.81, -0.005, hair), box(0.22, 0.14, 0.06, 0, 1.73, -0.1, hair)]);
}

/** 頼み事の印: 頭の上の菱形 */
function marker(): THREE.BufferGeometry {
  const g = new THREE.OctahedronGeometry(0.26, 0).toNonIndexed();
  g.scale(1, 1.5, 1);
  return colored(g, MARK);
}

/** 旗: 柱と布。原点は柱の根元、布は +x へ出る */
function flag(): THREE.BufferGeometry {
  const pole = new THREE.CylinderGeometry(0.025, 0.03, 2.3, 6).toNonIndexed();
  pole.translate(0, 1.15, 0);
  return merge([colored(pole, "#d8d8d4"), box(0.62, 0.42, 0.02, 0.33, 2.05, 0, MARK)]);
}

export interface WorkMark {
  x: number;
  y: number;
  z: number;
}

export interface HouseFlag {
  x: number;
  y: number;
  z: number;
  /** 布の向き（描く時だけ使う角度） */
  yaw: number;
}

export class PedestrianView {
  readonly group = new THREE.Group();
  private bodies: THREE.InstancedMesh;
  private legs: THREE.InstancedMesh;
  private heads: THREE.InstancedMesh[];
  private marks: THREE.InstancedMesh;
  private flags: THREE.InstancedMesh;
  private boxes: THREE.InstancedMesh;
  private m = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private e = new THREE.Euler(0, 0, 0, "YXZ");
  private p = new THREE.Vector3();
  private one = new THREE.Vector3(1, 1, 1);
  private c = new THREE.Color();
  private hip = new THREE.Vector3();
  readonly stats = { walkers: 0, marks: 0, flags: 0, real: 0 };
  /** リアルな人（読み終えるまでは箱の人形だけ） */
  readonly real = new RealPedestrians(REAL_MAX);
  private light = false;
  /** 視点（世界座標）。近い人をリアルな形にする。WorldView.frame が入れる */
  eye = { x: 0, z: 0 };
  private realList: RealPerson[] = [];

  constructor() {
    this.group.name = "pedestrians";
    const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85, metalness: 0 });
    const glow = new THREE.MeshBasicMaterial({ vertexColors: true });
    const make = (g: THREE.BufferGeometry, m: THREE.Material, n: number, name: string, shadow = true) => {
      const im = new THREE.InstancedMesh(g, m, n);
      im.count = 0;
      im.castShadow = shadow;
      im.receiveShadow = false;
      im.frustumCulled = false;
      im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      im.name = name;
      this.group.add(im);
      return im;
    };
    this.bodies = make(torso(), mat, CAPACITY, "pedestrian-body");
    this.legs = make(leg(), mat, CAPACITY * 2, "pedestrian-legs");
    this.heads = HAIR.map((h, i) => make(head(h), mat, CAPACITY, `pedestrian-head-${i}`));
    this.marks = make(marker(), glow, MARKS, "work-marks", false);
    this.flags = make(flag(), mat, FLAGS, "house-flags");
    // 運転手が持つ荷（段ボールの箱。胸の前）
    this.boxes = make(merge([box(0.46, 0.34, 0.36, 0, 1.12, 0.32, "#b8894f"), box(0.47, 0.05, 0.37, 0, 1.2, 0.32, "#d8c9a6")]), mat, CARRIED, "carried-boxes");
    this.bodies.setColorAt(0, this.c.set("#ffffff"));
    this.legs.setColorAt(0, this.c.set("#ffffff"));
    this.group.add(this.real.group);
    void this.real.load(import.meta.env?.BASE_URL ?? "/");
  }

  setQuality(light: boolean) {
    for (const im of [this.bodies, this.legs, ...this.heads, this.flags]) im.castShadow = !light;
    this.real.setShadows(!light);
    this.light = light;
  }

  /**
   * 描く。people は歩く人と頼み事の人、marks は頭の上の印（頼み事の人・頼んだ人）、flags は旗のある家。
   * originX, originZ は描画の原点、t は秒（印の上下の動き）
   */
  update(people: Walker[], marks: WorkMark[], flags: HouseFlag[], originX: number, originZ: number, t: number) {
    // 標準の画質では、視点の近くの人（箱を持つ運転手を除く）をリアルな形で描く。残りは箱の人形
    const real = this.realList;
    real.length = 0;
    let boxes = people;
    if (this.real.ready && !this.light) {
      const r2 = REAL_RANGE * REAL_RANGE;
      const near: { w: Walker; d: number }[] = [];
      for (const w of people) {
        if (w.carry) continue;
        const d = (w.x - this.eye.x) ** 2 + (w.z - this.eye.z) ** 2;
        if (d < r2) near.push({ w, d });
      }
      near.sort((a, b) => a.d - b.d);
      const chosen = new Set<Walker>();
      for (const { w } of near.slice(0, REAL_MAX)) {
        chosen.add(w);
        real.push({ x: w.x, y: w.y, z: w.z, yaw: Math.atan2(w.dx, w.dz), gait: w.gait, still: w.still, seed: w.seed });
      }
      if (chosen.size) boxes = people.filter((w) => !chosen.has(w));
    }
    this.real.update(real, originX, originZ);
    this.stats.real = real.length;
    const n = Math.min(CAPACITY, boxes.length);
    const headCount = this.heads.map(() => 0);
    let nb = 0;
    for (let i = 0; i < n; i++) {
      const w = boxes[i];
      const yaw = Math.atan2(w.dx, w.dz);
      const swing = w.still ? 0 : Math.sin(w.gait * Math.PI * 2) * 0.42;
      const bob = w.still ? 0 : Math.abs(Math.cos(w.gait * Math.PI * 2)) * 0.03;
      this.e.set(0, yaw, 0);
      this.q.setFromEuler(this.e);
      this.p.set(w.x - originX, w.y + bob, w.z - originZ);
      this.m.compose(this.p, this.q, this.one);
      this.bodies.setMatrixAt(i, this.m);
      this.bodies.setColorAt(i, this.c.set(w.coat ?? COATS[w.seed % COATS.length]));
      if (w.carry && nb < CARRIED) this.boxes.setMatrixAt(nb++, this.m);
      const hk = (w.seed >>> 4) % HAIR.length;
      this.heads[hk].setMatrixAt(headCount[hk]++, this.m);
      const pc = PANTS[(w.seed >>> 8) % PANTS.length];
      // 脚は股の付け根を軸に前後へ振る（左右で逆）
      for (const side of [1, -1]) {
        this.e.set(swing * side, yaw, 0);
        this.q.setFromEuler(this.e);
        const cy = Math.cos(yaw);
        const sy = Math.sin(yaw);
        this.hip.set(w.x - originX + 0.1 * side * cy, w.y + bob + 0.9, w.z - originZ - 0.1 * side * sy);
        this.m.compose(this.hip, this.q, this.one);
        const k = i * 2 + (side > 0 ? 0 : 1);
        this.legs.setMatrixAt(k, this.m);
        this.legs.setColorAt(k, this.c.set(pc));
      }
    }
    this.boxes.count = nb;
    this.boxes.visible = nb > 0;
    this.boxes.instanceMatrix.needsUpdate = true;
    this.bodies.count = n;
    this.legs.count = n * 2;
    this.heads.forEach((h, i) => {
      h.count = headCount[i];
      h.visible = headCount[i] > 0;
      h.instanceMatrix.needsUpdate = true;
    });
    for (const im of [this.bodies, this.legs]) {
      im.visible = n > 0;
      im.instanceMatrix.needsUpdate = true;
      if (im.instanceColor) im.instanceColor.needsUpdate = true;
    }
    // 頭の上の印（ゆっくり回って上下する）
    const nm = Math.min(MARKS, marks.length);
    for (let i = 0; i < nm; i++) {
      const k = marks[i];
      this.e.set(0, t * 1.5 + i, 0);
      this.q.setFromEuler(this.e);
      this.p.set(k.x - originX, k.y + 2.45 + Math.sin(t * 2 + i) * 0.08, k.z - originZ);
      this.m.compose(this.p, this.q, this.one);
      this.marks.setMatrixAt(i, this.m);
    }
    this.marks.count = nm;
    this.marks.visible = nm > 0;
    this.marks.instanceMatrix.needsUpdate = true;
    const nf = Math.min(FLAGS, flags.length);
    for (let i = 0; i < nf; i++) {
      const f = flags[i];
      this.e.set(0, f.yaw, 0);
      this.q.setFromEuler(this.e);
      this.p.set(f.x - originX, f.y, f.z - originZ);
      this.m.compose(this.p, this.q, this.one);
      this.flags.setMatrixAt(i, this.m);
    }
    this.flags.count = nf;
    this.flags.visible = nf > 0;
    this.flags.instanceMatrix.needsUpdate = true;
    this.stats.walkers = n + real.length;
    this.stats.marks = nm;
    this.stats.flags = nf;
  }
}
