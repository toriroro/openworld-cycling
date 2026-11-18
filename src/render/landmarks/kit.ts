// 名所の模型を組む道具（名所の草案 docs/history/specs/2026-11-18-landmarks-draft.md）。building/mesher.ts の Mesher に、梁・角柱・円柱・屋根・地面に沿う面を足す。
// 座標は名所ごとの原点からの相対（x, z）と、世界の高さ（y）。描画の側（Three.js を使わない）。

import { add, hex, Mesher, type Rgb, shade, UP, v3, type V3 } from "../building/mesher.ts";

export { add, hex, Mesher, shade, UP, v3 };
export type { Rgb, V3 };

const sub = (a: V3, b: V3): V3 => v3(a.x - b.x, a.y - b.y, a.z - b.z);
const len = (a: V3) => Math.hypot(a.x, a.y, a.z);
const scale = (a: V3, k: number): V3 => v3(a.x * k, a.y * k, a.z * k);
const cross = (a: V3, b: V3): V3 => v3(a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x);
const norm = (a: V3): V3 => scale(a, 1 / (len(a) || 1));
export const lerp3 = (a: V3, b: V3, t: number): V3 => v3(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t, a.z + (b.z - a.z) * t);

/** a から b への角材（断面 w × w の四角柱。端の面は付けない） */
export function beam(m: Mesher, a: V3, b: V3, w: number, c: Rgb, d = w) {
  const ax = norm(sub(b, a));
  const ref = Math.abs(ax.y) > 0.9 ? v3(1, 0, 0) : UP;
  const s = scale(norm(cross(ax, ref)), w / 2);
  const t = scale(norm(cross(s, ax)), d / 2);
  const corners = [add(s, t), add(scale(s, -1), t), add(scale(s, -1), scale(t, -1)), add(s, scale(t, -1))];
  for (let i = 0; i < 4; i++) {
    const p = corners[i], q = corners[(i + 1) % 4];
    m.quad([add(a, p), add(b, p), add(b, q), add(a, q)], [[0, 0], [1, 0], [1, 1], [0, 1]], c);
  }
}

/** 四角形（または多角形）を上向き（up）・下向きにそろえて張る */
export function quadUp(m: Mesher, p: V3[], c: Rgb, up = true) {
  const nrm = cross(sub(p[1], p[0]), sub(p[p.length - 1], p[0]));
  const q = (nrm.y >= 0) === up ? p : [...p].reverse();
  m.quad(q, q.map((v) => [v.x / 4, v.z / 4] as [number, number]), c);
}

/** 中心 c、向き X（水平の単位ベクトル）の直方体。y は底面の高さ */
export function block(m: Mesher, c: V3, X: V3, w: number, h: number, d: number, col: Rgb, bottom = false) {
  const Z = v3(-X.z, 0, X.x);
  m.box(v3(c.x, c.y + h / 2, c.z), X, Z, w, h, d, col, 1, bottom);
}

/** 多角形（[x, z] の並び、反時計回りでも時計回りでもよい）を y0 から y1 まで立ち上げる。上面も張る */
export function prism(m: Mesher, poly: [number, number][], y0: number, y1: number, wall: Rgb, top: Rgb | null = wall) {
  const ccw = signedArea(poly) > 0;
  const n = poly.length;
  for (let i = 0; i < n; i++) {
    const a = poly[i], b = poly[(i + 1) % n];
    const [p, q] = ccw ? [b, a] : [a, b];
    m.quad([v3(p[0], y0, p[1]), v3(q[0], y0, q[1]), v3(q[0], y1, q[1]), v3(p[0], y1, p[1])], [[0, 0], [1, 0], [1, 1], [0, 1]], wall);
  }
  if (top) fillPolygon(m, poly, () => y1, top);
}

/** [x, z] の多角形の符号つき面積（z を下向きの y とみた時の反時計回りが正） */
export function signedArea(poly: [number, number][]): number {
  let a = 0;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) a += poly[j][0] * poly[i][1] - poly[i][0] * poly[j][1];
  return a / 2;
}

/** 多角形を三角形に分けて上向きの面を張る（耳の切り取り）。高さは y(x, z) */
export function fillPolygon(m: Mesher, poly: [number, number][], y: (x: number, z: number) => number, c: Rgb | ((x: number, z: number) => Rgb)) {
  const tris = earcut(poly);
  const col = typeof c === "function" ? c : () => c;
  for (const [i, j, k] of tris) {
    const P = [poly[i], poly[j], poly[k]].map((p) => v3(p[0], y(p[0], p[1]), p[1]));
    // 上向きにそろえる
    const nrm = cross(sub(P[1], P[0]), sub(P[2], P[0]));
    const ord = nrm.y >= 0 ? P : [P[0], P[2], P[1]];
    const cc = col((ord[0].x + ord[1].x + ord[2].x) / 3, (ord[0].z + ord[1].z + ord[2].z) / 3);
    m.tri(ord, [[ord[0].x / 4, ord[0].z / 4], [ord[1].x / 4, ord[1].z / 4], [ord[2].x / 4, ord[2].z / 4]], cc);
  }
}

/** 単純な耳の切り取り（穴なし）。添字の三つ組 */
export function earcut(poly: [number, number][]): [number, number, number][] {
  const n = poly.length;
  if (n < 3) return [];
  const idx = [...Array(n).keys()];
  if (signedArea(poly) < 0) idx.reverse();
  const out: [number, number, number][] = [];
  const cross2 = (a: [number, number], b: [number, number], c: [number, number]) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  const inTri = (p: [number, number], a: [number, number], b: [number, number], c: [number, number]) =>
    cross2(a, b, p) >= 0 && cross2(b, c, p) >= 0 && cross2(c, a, p) >= 0;
  let guard = 0;
  while (idx.length > 3 && guard++ < n * n) {
    let cut = false;
    for (let i = 0; i < idx.length; i++) {
      const a = poly[idx[(i + idx.length - 1) % idx.length]], b = poly[idx[i]], c = poly[idx[(i + 1) % idx.length]];
      if (cross2(a, b, c) <= 1e-9) continue;
      let ok = true;
      for (const k of idx) {
        const p = poly[k];
        if (p === a || p === b || p === c) continue;
        if (inTri(p, a, b, c)) {
          ok = false;
          break;
        }
      }
      if (!ok) continue;
      out.push([idx[(i + idx.length - 1) % idx.length], idx[i], idx[(i + 1) % idx.length]]);
      idx.splice(i, 1);
      cut = true;
      break;
    }
    if (!cut) break;
  }
  if (idx.length === 3) out.push([idx[0], idx[1], idx[2]]);
  return out;
}

/** 円柱（側面と上面）。c は底の中心 */
export function cylinder(m: Mesher, c: V3, r: number, h: number, col: Rgb, seg = 10, r1 = r, top: Rgb | null = col) {
  const ring = (rr: number, y: number) => [...Array(seg).keys()].map((i) => v3(c.x + Math.cos((i / seg) * Math.PI * 2) * rr, y, c.z + Math.sin((i / seg) * Math.PI * 2) * rr));
  const a = ring(r, c.y), b = ring(r1, c.y + h);
  for (let i = 0; i < seg; i++) {
    const j = (i + 1) % seg;
    m.quad([a[j], a[i], b[i], b[j]], [[0, 0], [1, 0], [1, 1], [0, 1]], col);
  }
  if (top && r1 > 0.001) for (let i = 1; i < seg - 1; i++) m.tri([b[0], b[i + 1], b[i]], [[0, 0], [1, 0], [1, 1]], top);
}

/** 正多角形の平らな円盤（上向き） */
export function disc(m: Mesher, c: V3, r: number, col: Rgb, seg = 16) {
  const p = [...Array(seg).keys()].map((i) => v3(c.x + Math.cos((i / seg) * Math.PI * 2) * r, c.y, c.z + Math.sin((i / seg) * Math.PI * 2) * r));
  for (let i = 1; i < seg - 1; i++) m.tri([p[0], p[i + 1], p[i]], [[0, 0], [1, 0], [1, 1]], col);
}

/** 角錐（底の多角形 → 頂点）。側面だけ */
export function pyramid(m: Mesher, base: V3[], apex: V3, col: Rgb | ((i: number) => Rgb)) {
  const n = base.length;
  const ccw = signedArea(base.map((p) => [p.x, p.z])) > 0;
  for (let i = 0; i < n; i++) {
    const a = base[i], b = base[(i + 1) % n];
    const c = typeof col === "function" ? col(i) : col;
    m.tri(ccw ? [b, a, apex] : [a, b, apex], [[0, 0], [1, 0], [0.5, 1]], c);
  }
}

/**
 * 切妻屋根。中心 c（軒の高さ）、棟の向き X、棟方向の長さ w、奥行き d、棟の高さ rise、軒の出 o。
 * 屋根面 2 枚（裏も見えるように厚み 0.2m）と妻壁 2 枚（色 gable）。
 */
export function gableRoof(m: Mesher, c: V3, X: V3, w: number, d: number, rise: number, o: number, roof: Rgb, gable: Rgb | null) {
  const Z = v3(-X.z, 0, X.x);
  const P = (a: number, b: number, y: number) => v3(c.x + X.x * a + Z.x * b, c.y + y, c.z + X.z * a + Z.z * b);
  const hw = w / 2 + o, hd = d / 2 + o;
  const drop = (o / (d / 2)) * rise;
  const r0 = P(-hw, 0, rise), r1 = P(hw, 0, rise);
  for (const s of [1, -1]) {
    const e0 = P(-hw, s * hd, -drop), e1 = P(hw, s * hd, -drop);
    const quad = s > 0 ? [e0, e1, r1, r0] : [e1, e0, r0, r1];
    m.quad(quad, [[0, 0], [1, 0], [1, 1], [0, 1]], roof);
    m.quad([quad[1], quad[0], quad[3], quad[2]].map((p) => v3(p.x, p.y - 0.18, p.z)), [[0, 0], [1, 0], [1, 1], [0, 1]], shade(roof, 0.6));
    m.quad([e0, e1, v3(e1.x, e1.y - 0.18, e1.z), v3(e0.x, e0.y - 0.18, e0.z)].reverse(), [[0, 0], [1, 0], [1, 1], [0, 1]], shade(roof, 0.7));
  }
  if (gable)
    for (const s of [1, -1]) {
      const a = P((s * w) / 2, -d / 2, 0), b = P((s * w) / 2, d / 2, 0), t = P((s * w) / 2, 0, rise);
      m.tri(s > 0 ? [a, t, b] : [b, t, a], [[0, 0], [0.5, 1], [1, 0]], gable);
    }
}

/** 寄棟屋根（棟は X 方向）。中心 c（軒の高さ）、w × d、棟の高さ rise、軒の出 o */
export function hipRoof(m: Mesher, c: V3, X: V3, w: number, d: number, rise: number, o: number, roof: Rgb) {
  const Z = v3(-X.z, 0, X.x);
  const P = (a: number, b: number, y: number) => v3(c.x + X.x * a + Z.x * b, c.y + y, c.z + X.z * a + Z.z * b);
  const hw = w / 2 + o, hd = d / 2 + o;
  const ridge = Math.max(0, hw - hd);
  const drop = (o / (d / 2)) * rise;
  const a = P(-hw, -hd, -drop), b = P(hw, -hd, -drop), cc = P(hw, hd, -drop), dd = P(-hw, hd, -drop);
  const r0 = P(-ridge, 0, rise), r1 = P(ridge, 0, rise);
  m.quad([dd, cc, r1, r0], [[0, 0], [1, 0], [1, 1], [0, 1]], roof);
  m.quad([b, a, r0, r1], [[0, 0], [1, 0], [1, 1], [0, 1]], roof);
  m.tri([a, dd, r0], [[0, 0], [1, 0], [0.5, 1]], shade(roof, 0.92));
  m.tri([cc, b, r1], [[0, 0], [1, 0], [0.5, 1]], shade(roof, 0.92));
  // 裏
  m.quad([a, b, cc, dd].map((p) => v3(p.x, p.y - 0.1, p.z)), [[0, 0], [1, 0], [1, 1], [0, 1]], shade(roof, 0.5));
}

/** 窓の並び: 外向き n の壁（左下 p0、幅 w）の y0 から、高さ h の窓を間隔 step で。枠は frame、硝子は glass */
export function windows(m: Mesher, p0: V3, n: V3, w: number, y0: number, h: number, ww: number, step: number, glass: Rgb, frame: Rgb | null = null) {
  const u = v3(n.z, 0, -n.x);
  const count = Math.max(1, Math.floor(w / step));
  const margin = (w - count * step) / 2 + (step - ww) / 2;
  for (let i = 0; i < count; i++) {
    const s = margin + i * step;
    const base = add(add(v3(p0.x, y0, p0.z), u, s), n, 0.04);
    if (frame) m.wall(add(add(base, u, -0.12), n, -0.01), n, ww + 0.24, h + 0.24, frame, 1);
    m.wall(add(base, UP, frame ? 0.12 : 0), n, ww, h, glass, 1);
  }
}

/** 最小の外接長方形（辺の向きから選ぶ）。中心・長辺の向き X・長辺 w・短辺 d */
export function minRect(poly: [number, number][]): { cx: number; cz: number; X: V3; w: number; d: number } {
  let best = { area: Infinity, cx: 0, cz: 0, X: v3(1, 0, 0), w: 0, d: 0 };
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    const l = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (l < 1e-6) continue;
    const ux = (b[0] - a[0]) / l, uz = (b[1] - a[1]) / l;
    let u0 = Infinity, u1 = -Infinity, w0 = Infinity, w1 = -Infinity;
    for (const p of poly) {
      const u = p[0] * ux + p[1] * uz, w = -p[0] * uz + p[1] * ux;
      u0 = Math.min(u0, u);
      u1 = Math.max(u1, u);
      w0 = Math.min(w0, w);
      w1 = Math.max(w1, w);
    }
    const area = (u1 - u0) * (w1 - w0);
    if (area < best.area) {
      const cu = (u0 + u1) / 2, cw = (w0 + w1) / 2;
      const cx = cu * ux - cw * uz, cz = cu * uz + cw * ux;
      const long = u1 - u0 >= w1 - w0;
      best = { area, cx, cz, X: long ? v3(ux, 0, uz) : v3(-uz, 0, ux), w: Math.max(u1 - u0, w1 - w0), d: Math.min(u1 - u0, w1 - w0) };
    }
  }
  return { cx: best.cx, cz: best.cz, X: best.X, w: best.w, d: best.d };
}
