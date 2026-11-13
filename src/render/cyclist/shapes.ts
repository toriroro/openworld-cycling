// 自転車の部品を組む小さな形状の道具。どの形状も頂点ごとに「色の表の番号」(slot) を持ち、
// PartSet で1つの形状にまとめる（描画命令を部品の数だけ増やさないため）。

import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";

export type V3 = THREE.Vector3;
export const v3 = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

/** 頂点の配列から形状を作る（位置・法線・slot）。 */
function makeGeometry(pos: number[], nor: number[] | null, idx: number[], slot: number): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  if (nor) g.setAttribute("normal", new THREE.Float32BufferAttribute(nor, 3));
  else g.computeVertexNormals();
  g.setAttribute("slot", new THREE.Float32BufferAttribute(new Float32Array(pos.length / 3).fill(slot), 1));
  return g;
}

/** 断面の輪を並べて管にする。rings[i] は同じ点数の輪。closed なら断面は閉じた輪。 */
function ringsToGeometry(rings: V3[][], centers: V3[], slot: number, caps: boolean): THREE.BufferGeometry {
  const n = rings[0].length;
  const pos: number[] = [];
  const nor: number[] = [];
  const idx: number[] = [];
  for (let i = 0; i < rings.length; i++) {
    for (let j = 0; j < n; j++) {
      const p = rings[i][j];
      pos.push(p.x, p.y, p.z);
      const d = p.clone().sub(centers[i]).normalize();
      nor.push(d.x, d.y, d.z);
    }
  }
  for (let i = 0; i < rings.length - 1; i++)
    for (let j = 0; j < n; j++) {
      const a = i * n + j;
      const b = i * n + ((j + 1) % n);
      const c = a + n;
      const d = b + n;
      idx.push(a, b, c, b, d, c);
    }
  const g = makeGeometry(pos, nor, idx, slot);
  g.computeVertexNormals(); // 断面の形が楕円でも滑らかに
  if (!caps) return g;
  const parts = [g];
  for (const [ring, center, dir] of [
    [rings[0], centers[0], -1],
    [rings[rings.length - 1], centers[centers.length - 1], 1],
  ] as const) {
    const cp: number[] = [];
    const ci: number[] = [];
    const along = (dir > 0 ? centers[centers.length - 1].clone().sub(centers[centers.length - 2]) : centers[0].clone().sub(centers[1])).normalize();
    cp.push(center.x, center.y, center.z);
    for (const p of ring) cp.push(p.x, p.y, p.z);
    for (let j = 0; j < n; j++) {
      const a = 1 + j;
      const b = 1 + ((j + 1) % n);
      if (dir > 0) ci.push(0, a, b);
      else ci.push(0, b, a);
    }
    const nn: number[] = [];
    for (let k = 0; k <= n; k++) nn.push(along.x, along.y, along.z);
    parts.push(makeGeometry(cp, nn, ci, slot));
  }
  return mergeGeometries(parts)!;
}

export interface TubeOptions {
  /** 始点・終点の、横（side 方向）の半径 */
  r0: number;
  r1?: number;
  /** 断面の縦横比（side と直交する方向の半径 / 横の半径）。1 で円 */
  aspect?: number;
  aspect1?: number;
  /** 断面の横の向き（既定は自転車の左右 X） */
  side?: V3;
  seg?: number;
  caps?: boolean;
}

function frame(t: V3, side: V3): [V3, V3] {
  let u = side.clone().addScaledVector(t, -side.dot(t));
  if (u.lengthSq() < 1e-6) u = Math.abs(t.y) < 0.9 ? v3(0, 1, 0) : v3(1, 0, 0);
  u.normalize();
  const w = new THREE.Vector3().crossVectors(t, u).normalize();
  return [u, w];
}

/** 2点を結ぶ、楕円断面で先細りできる管。 */
export function tube(a: V3, b: V3, slot: number, o: TubeOptions): THREE.BufferGeometry {
  return sweep([a, b], slot, { ...o, samples: 1 });
}

export interface SweepOptions extends TubeOptions {
  /** 曲線の分割数 */
  samples?: number;
  /** t (0..1) ごとの半径の倍率 */
  scale?: (t: number) => number;
}

/** 点を通る曲線に沿った管（ハンドル、ステー、フォーク、チェーンなど）。 */
export function sweep(points: V3[], slot: number, o: SweepOptions): THREE.BufferGeometry {
  const seg = o.seg ?? 10;
  const side = o.side ?? v3(1, 0, 0);
  const samples = o.samples ?? Math.max(1, points.length * 6);
  const curve = points.length === 2 ? new THREE.LineCurve3(points[0], points[1]) : new THREE.CatmullRomCurve3(points, false, "centripetal");
  const rings: V3[][] = [];
  const centers: V3[] = [];
  for (let i = 0; i <= samples; i++) {
    const t = i / samples;
    const c = curve.getPointAt(t);
    const tan = curve.getTangentAt(t).normalize();
    const [u, w] = frame(tan, side);
    const r = (o.r0 + ((o.r1 ?? o.r0) - o.r0) * t) * (o.scale ? o.scale(t) : 1);
    const asp = (o.aspect ?? 1) + ((o.aspect1 ?? o.aspect ?? 1) - (o.aspect ?? 1)) * t;
    const ring: V3[] = [];
    for (let j = 0; j < seg; j++) {
      const ang = (j / seg) * Math.PI * 2;
      ring.push(c.clone().addScaledVector(u, Math.cos(ang) * r).addScaledVector(w, Math.sin(ang) * r * asp));
    }
    rings.push(ring);
    centers.push(c);
  }
  return ringsToGeometry(rings, centers, slot, o.caps ?? true);
}

/**
 * 回転体。profile は [半径, 軸方向の位置] の折れ線。軸は X（車輪の軸）。
 * slots を区間ごとに与えると、区間の境で色をはっきり分ける。
 */
export function revolve(profile: [number, number][], slots: number | number[], radial: number, center = v3(0, 0, 0)): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  for (let k = 0; k < profile.length - 1; k++) {
    const slot = Array.isArray(slots) ? slots[Math.min(k, slots.length - 1)] : slots;
    const [r0, x0] = profile[k];
    const [r1, x1] = profile[k + 1];
    // 区間の法線（断面内）
    const dr = r1 - r0;
    const dx = x1 - x0;
    const len = Math.hypot(dr, dx) || 1;
    const nr = dx / len;
    const nx = -dr / len;
    const pos: number[] = [];
    const nor: number[] = [];
    const idx: number[] = [];
    for (let j = 0; j <= radial; j++) {
      const a = (j / radial) * Math.PI * 2;
      const c = Math.cos(a);
      const s = Math.sin(a);
      pos.push(center.x + x0, center.y + r0 * s, center.z + r0 * c, center.x + x1, center.y + r1 * s, center.z + r1 * c);
      nor.push(nx, nr * s, nr * c, nx, nr * s, nr * c);
    }
    for (let j = 0; j < radial; j++) {
      const a = j * 2;
      idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
    parts.push(makeGeometry(pos, nor, idx, slot));
  }
  return mergeGeometries(parts)!;
}

/**
 * 断面（閉じた輪、同じ点数）を順に並べた立体。サドル、ブラケット、靴の底など。
 * 端は中心の点で閉じる。
 */
export function loft(sections: V3[][], slot: number): THREE.BufferGeometry {
  const centers = sections.map((s) => s.reduce((acc, p) => acc.add(p), v3(0, 0, 0)).multiplyScalar(1 / s.length));
  return ringsToGeometry(sections, centers, slot, true);
}

/** 角を丸めない箱（中心・大きさ・回転）。 */
export function box(center: V3, size: V3, slot: number, rot?: THREE.Euler): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(size.x, size.y, size.z);
  g.deleteAttribute("uv");
  if (rot) g.applyMatrix4(new THREE.Matrix4().makeRotationFromEuler(rot));
  g.translate(center.x, center.y, center.z);
  g.setAttribute("slot", new THREE.Float32BufferAttribute(new Float32Array(g.getAttribute("position").count).fill(slot), 1));
  return g;
}

/** 平らな輪に歯をつけた板（チェーンリング・スプロケット）。X 方向に厚み。 */
export function toothedRing(rOuter: number, rInner: number, teeth: number, thickness: number, slot: number, x: number, tooth = 0.0028): THREE.BufferGeometry {
  const shape = new THREE.Shape();
  const n = teeth * 2;
  for (let i = 0; i <= n; i++) {
    const a = (i / n) * Math.PI * 2;
    const r = i % 2 === 0 ? rOuter : rOuter - tooth;
    if (i === 0) shape.moveTo(Math.cos(a) * r, Math.sin(a) * r);
    else shape.lineTo(Math.cos(a) * r, Math.sin(a) * r);
  }
  const hole = new THREE.Path();
  hole.absarc(0, 0, rInner, 0, Math.PI * 2, true);
  shape.holes.push(hole);
  const g = new THREE.ExtrudeGeometry(shape, { depth: thickness, bevelEnabled: false, curveSegments: 6 });
  g.deleteAttribute("uv");
  // 押し出し方向 Z を X に。形の面は YZ 平面へ
  g.applyMatrix4(new THREE.Matrix4().makeRotationY(Math.PI / 2));
  g.translate(x - thickness / 2, 0, 0);
  g.setAttribute("slot", new THREE.Float32BufferAttribute(new Float32Array(g.getAttribute("position").count).fill(slot), 1));
  return g;
}

/** 部品の形状を集めて1つにまとめる。 */
export class PartSet {
  private list: THREE.BufferGeometry[] = [];
  add(...g: THREE.BufferGeometry[]) {
    this.list.push(...g);
    return this;
  }
  /** 直前に足した形状をまとめて変換する。 */
  transformLast(count: number, m: THREE.Matrix4) {
    for (const g of this.list.slice(-count)) g.applyMatrix4(m);
    return this;
  }
  build(): THREE.BufferGeometry {
    const geos = this.list.map((g) => {
      for (const name of Object.keys(g.attributes)) if (!["position", "normal", "slot"].includes(name)) g.deleteAttribute(name);
      if (!g.getAttribute("normal")) g.computeVertexNormals();
      return g.index ? g : indexOf(g);
    });
    const one = mergeGeometries(geos) ?? new THREE.BufferGeometry();
    one.computeBoundingSphere();
    for (const g of this.list) g.dispose();
    this.list = [];
    return one;
  }
}

function indexOf(g: THREE.BufferGeometry) {
  const n = g.getAttribute("position").count;
  g.setIndex([...Array(n).keys()]);
  return g;
}

export function triangles(g: THREE.BufferGeometry) {
  return g.index ? g.index.count / 3 : g.getAttribute("position").count / 3;
}
