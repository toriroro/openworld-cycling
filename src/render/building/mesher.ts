// 建物の形を組み立てる時の道具: 頂点の集まり（材質ごとに 1 つ）と、ベクトル・色・乱数の小さな関数。

import * as THREE from "three";

export type Rgb = [number, number, number];
/** 絵の表（atlas）の中の四角: u0, v0, u1, v1（v0 が下） */
export type Rect = [number, number, number, number];

export const hex = (h: string): Rgb => {
  const c = new THREE.Color(h);
  return [c.r, c.g, c.b];
};
export const WHITE: Rgb = [1, 1, 1];
export const shade = (c: Rgb, k: number): Rgb => [c[0] * k, c[1] * k, c[2] * k];

export interface V3 {
  x: number;
  y: number;
  z: number;
}
export const v3 = (x: number, y: number, z: number): V3 => ({ x, y, z });
export const add = (a: V3, b: V3, k = 1): V3 => ({ x: a.x + b.x * k, y: a.y + b.y * k, z: a.z + b.z * k });
export const neg = (a: V3): V3 => ({ x: -a.x, y: -a.y, z: -a.z });
export const UP = v3(0, 1, 0);

/** 種と番号から 0〜1 */
export const unit = (seed: number, k: number) => {
  let x = (seed ^ Math.imul(k + 1, 0x9e3779b1)) >>> 0;
  x = Math.imul(x ^ (x >>> 15), 0x2c1b3c6d) >>> 0;
  x = Math.imul(x ^ (x >>> 12), 0x297a2d39) >>> 0;
  return ((x ^ (x >>> 15)) >>> 0) / 4294967296;
};

/** 材質ごとの頂点の集まり */
export class Mesher {
  pos: number[] = [];
  nor: number[] = [];
  uv: number[] = [];
  col: number[] = [];
  idx: number[] = [];
  /** p0→p1→p2→p3 が外から見て反時計回りの四角形。uv は各頂点 */
  quad(p: V3[], uv: [number, number][], c: Rgb) {
    this.poly(p, uv, c);
  }
  tri(p: V3[], uv: [number, number][], c: Rgb) {
    this.poly(p, uv, c);
  }
  /** 両面から見える四角形（裏は逆回りで足す） */
  quad2(p: V3[], uv: [number, number][], c: Rgb) {
    this.poly(p, uv, c);
    this.poly([p[3], p[2], p[1], p[0]], [uv[3], uv[2], uv[1], uv[0]], c);
  }
  private poly(p: V3[], uv: [number, number][], c: Rgb) {
    const a = p[0], b = p[1], d = p[p.length - 1];
    const ux = b.x - a.x, uy = b.y - a.y, uz = b.z - a.z;
    const vx = d.x - a.x, vy = d.y - a.y, vz = d.z - a.z;
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const l = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
    nx /= l;
    ny /= l;
    nz /= l;
    const base = this.pos.length / 3;
    for (let i = 0; i < p.length; i++) {
      const q = p[i];
      this.pos.push(q.x, q.y, q.z);
      this.nor.push(nx, ny, nz);
      this.uv.push(uv[i][0], uv[i][1]);
      this.col.push(c[0], c[1], c[2]);
    }
    for (let i = 1; i < p.length - 1; i++) this.idx.push(base, base + i, base + i + 1);
  }
  /** 外向き n の鉛直の面。左下 p0、幅 w（u 軸 = UP × n、外から見て右）、高さ h。uv は m を tex で割る */
  wall(p0: V3, n: V3, w: number, h: number, c: Rgb, tex: number, u0 = 0, v0 = 0) {
    const u = v3(n.z, 0, -n.x);
    const p1 = add(p0, u, w);
    this.quad([p0, p1, add(p1, UP, h), add(p0, UP, h)], [
      [u0 / tex, v0 / tex],
      [(u0 + w) / tex, v0 / tex],
      [(u0 + w) / tex, (v0 + h) / tex],
      [u0 / tex, (v0 + h) / tex],
    ], c);
  }
  /** 外向き n の鉛直の面に、絵の表の四角 r を貼る。左下 p0、幅 w、高さ h。flip で左右を返す */
  panel(p0: V3, n: V3, w: number, h: number, r: Rect, c: Rgb = WHITE, flip = false) {
    const u = v3(n.z, 0, -n.x);
    const p1 = add(p0, u, w);
    const ua = flip ? r[2] : r[0], ub = flip ? r[0] : r[2];
    this.quad([p0, p1, add(p1, UP, h), add(p0, UP, h)], [[ua, r[1]], [ub, r[1]], [ub, r[3]], [ua, r[3]]], c);
  }
  /** 中心 c、軸 X・Z（Z = X × UP）、寸法の直方体（側面 4 と上面。bottom で下面も）、頂点色 */
  box(c: V3, X: V3, Z: V3, w: number, h: number, d: number, col: Rgb, tex = 1, bottom = false) {
    const hw = w / 2, hd = d / 2;
    const at = (a: number, b: number, y: number) => v3(c.x + X.x * a + Z.x * b, y, c.z + X.z * a + Z.z * b);
    const y0 = c.y - h / 2, y1 = c.y + h / 2;
    this.wall(at(-hw, hd, y0), Z, w, h, col, tex);
    this.wall(at(hw, -hd, y0), v3(-Z.x, 0, -Z.z), w, h, col, tex);
    this.wall(at(hw, hd, y0), X, d, h, col, tex);
    this.wall(at(-hw, -hd, y0), v3(-X.x, 0, -X.z), d, h, col, tex);
    this.quad([at(-hw, hd, y1), at(hw, hd, y1), at(hw, -hd, y1), at(-hw, -hd, y1)], [[0, 0], [w / tex, 0], [w / tex, d / tex], [0, d / tex]], col);
    if (bottom) this.quad([at(-hw, -hd, y0), at(hw, -hd, y0), at(hw, hd, y0), at(-hw, hd, y0)], [[0, 0], [w / tex, 0], [w / tex, d / tex], [0, d / tex]], col);
  }
  get triangles() {
    return this.idx.length / 3;
  }
  geometry(): THREE.BufferGeometry | null {
    if (!this.idx.length) return null;
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute("normal", new THREE.Float32BufferAttribute(this.nor, 3));
    g.setAttribute("uv", new THREE.Float32BufferAttribute(this.uv, 2));
    g.setAttribute("color", new THREE.Float32BufferAttribute(this.col, 3));
    g.setIndex(this.pos.length / 3 > 65535 ? new THREE.Uint32BufferAttribute(this.idx, 1) : new THREE.Uint16BufferAttribute(this.idx, 1));
    g.computeBoundingSphere();
    return g;
  }
}
