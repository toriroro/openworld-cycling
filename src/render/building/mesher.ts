// 建物の形を組み立てる時の道具: 頂点の集まり（材質ごとに 1 つ）と、ベクトル・色・乱数の小さな関数。


export type Rgb = [number, number, number];
/** 絵の表（atlas）の中の四角: u0, v0, u1, v1（v0 が下） */
export type Rect = [number, number, number, number];

/** "#rrggbb"（sRGB）→ 線形の色。THREE.Color（色の管理が有効な時）と同じ値（Worker でも使えるよう Three.js を使わない） */
export const hex = (h: string): Rgb => {
  const n = Number.parseInt(h.slice(1), 16);
  const lin = (v: number) => {
    const c = v / 255;
    return c <= 0.04045 ? c * 0.0773993808 : Math.pow(c * 0.9478672986 + 0.0521327014, 2.4);
  };
  return [lin((n >> 16) & 255), lin((n >> 8) & 255), lin(n & 255)];
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

/** 頂点の配列（位置・法線・uv・頂点色・添字） */
export interface MeshArrays {
  pos: Float32Array;
  nor: Float32Array;
  uv: Float32Array;
  col: Float32Array;
  idx: Uint16Array | Uint32Array;
  /** 包む球（中心と半径）。Worker で求めておくと、メインスレッドで頂点をなめずに済む */
  sphere?: [number, number, number, number];
}

/** 頂点を包む球（箱の中心と、そこから一番遠い頂点まで） */
export function boundingSphere(pos: Float32Array): [number, number, number, number] {
  let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
  for (let i = 0; i < pos.length; i += 3) {
    const x = pos[i], y = pos[i + 1], z = pos[i + 2];
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (y < y0) y0 = y;
    if (y > y1) y1 = y;
    if (z < z0) z0 = z;
    if (z > z1) z1 = z;
  }
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, cz = (z0 + z1) / 2;
  let r2 = 0;
  for (let i = 0; i < pos.length; i += 3) {
    const dx = pos[i] - cx, dy = pos[i + 1] - cy, dz = pos[i + 2] - cz;
    const d = dx * dx + dy * dy + dz * dz;
    if (d > r2) r2 = d;
  }
  return [cx, cy, cz, Math.sqrt(r2)];
}

/** 材質ごとの頂点の集まり */
export class Mesher {
  /**
   * これより細い部品を作らない (m)。箱は 2 番目に長い辺、壁は短い辺で比べる（柱・脚・腕・庇の縁など）。
   * 0 なら全部作る。離れた建物の細部を省くのに使う（北海道の草案 24 章）
   */
  minPart = 0;
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
    if (this.minPart > 0 && Math.min(w, h) < this.minPart) return;
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
    if (this.minPart > 0 && w + h + d - Math.max(w, h, d) - Math.min(w, h, d) < this.minPart) return;
    const minPart = this.minPart;
    // 側面は箱として残すと決めたので、細い面も省かない
    this.minPart = 0;
    const hw = w / 2, hd = d / 2;
    const at = (a: number, b: number, y: number) => v3(c.x + X.x * a + Z.x * b, y, c.z + X.z * a + Z.z * b);
    const y0 = c.y - h / 2, y1 = c.y + h / 2;
    this.wall(at(-hw, hd, y0), Z, w, h, col, tex);
    this.wall(at(hw, -hd, y0), v3(-Z.x, 0, -Z.z), w, h, col, tex);
    this.wall(at(hw, hd, y0), X, d, h, col, tex);
    this.wall(at(-hw, -hd, y0), v3(-X.x, 0, -X.z), d, h, col, tex);
    this.quad([at(-hw, hd, y1), at(hw, hd, y1), at(hw, -hd, y1), at(-hw, -hd, y1)], [[0, 0], [w / tex, 0], [w / tex, d / tex], [0, d / tex]], col);
    if (bottom) this.quad([at(-hw, -hd, y0), at(hw, -hd, y0), at(hw, hd, y0), at(-hw, hd, y0)], [[0, 0], [w / tex, 0], [w / tex, d / tex], [0, d / tex]], col);
    this.minPart = minPart;
  }
  get triangles() {
    return this.idx.length / 3;
  }
  /** 型付きの配列にする（Worker から転送できる形。描画の形は to-geometry.ts の toGeometry） */
  arrays(): MeshArrays | null {
    if (!this.idx.length) return null;
    const V = this.pos.length / 3;
    const pos = Float32Array.from(this.pos);
    return {
      pos,
      sphere: boundingSphere(pos),
      nor: Float32Array.from(this.nor),
      uv: Float32Array.from(this.uv),
      col: Float32Array.from(this.col),
      idx: V > 65535 ? Uint32Array.from(this.idx) : Uint16Array.from(this.idx),
    };
  }
}
