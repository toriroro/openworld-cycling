// 街区づくりに使う平面（x, z）の幾何。Three.js に依存しない。
// 多角形は「x を右、z を上」と見た時の反時計回り（符号付き面積が正）にそろえて扱う。

export type P2 = [number, number];

export function signedArea(p: P2[]): number {
  let a = 0;
  for (let i = 0; i < p.length; i++) {
    const [x0, z0] = p[i];
    const [x1, z1] = p[(i + 1) % p.length];
    a += x0 * z1 - x1 * z0;
  }
  return a / 2;
}

export function centroid(p: P2[]): P2 {
  let x = 0, z = 0;
  for (const q of p) {
    x += q[0];
    z += q[1];
  }
  return [x / p.length, z / p.length];
}

export function pointInPoly(p: P2[], x: number, z: number): boolean {
  let inside = false;
  for (let i = 0, j = p.length - 1; i < p.length; j = i++) {
    const [xi, zi] = p[i];
    const [xj, zj] = p[j];
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

/** 点から線分までの距離と、線分上の位置 t */
export function segDist(x: number, z: number, ax: number, az: number, bx: number, bz: number): { d: number; t: number } {
  const vx = bx - ax, vz = bz - az;
  const vv = vx * vx + vz * vz;
  let t = vv > 0 ? ((x - ax) * vx + (z - az) * vz) / vv : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const dx = ax + vx * t - x, dz = az + vz * t - z;
  return { d: Math.sqrt(dx * dx + dz * dz), t };
}

/** 多角形の外周までの距離（内側なら負） */
export function polySignedDist(p: P2[], x: number, z: number): number {
  let best = Infinity;
  for (let i = 0; i < p.length; i++) {
    const a = p[i], b = p[(i + 1) % p.length];
    const d = segDist(x, z, a[0], a[1], b[0], b[1]).d;
    if (d < best) best = d;
  }
  return pointInPoly(p, x, z) ? -best : best;
}

/** 線分 a-b と c-d の交点（それぞれの上の位置 t, u）。平行なら null */
export function segIntersect(a: P2, b: P2, c: P2, d: P2): { t: number; u: number } | null {
  const rx = b[0] - a[0], rz = b[1] - a[1];
  const sx = d[0] - c[0], sz = d[1] - c[1];
  const den = rx * sz - rz * sx;
  if (Math.abs(den) < 1e-9) return null;
  const qx = c[0] - a[0], qz = c[1] - a[1];
  const t = (qx * sz - qz * sx) / den;
  const u = (qx * rz - qz * rx) / den;
  if (t < -1e-9 || t > 1 + 1e-9 || u < -1e-9 || u > 1 + 1e-9) return null;
  return { t: Math.min(1, Math.max(0, t)), u: Math.min(1, Math.max(0, u)) };
}

/** 近すぎる頂点と、ほぼ一直線の頂点を除く（辺の印 tags は残った辺の始点のものを引き継ぐ） */
export function cleanPoly<T>(p: P2[], tags: T[], minEdge = 0.05): { poly: P2[]; tags: T[] } {
  const poly: P2[] = [];
  const out: T[] = [];
  for (let i = 0; i < p.length; i++) {
    const q = p[i];
    const last = poly[poly.length - 1];
    if (last && Math.hypot(q[0] - last[0], q[1] - last[1]) < minEdge) continue;
    poly.push(q);
    out.push(tags[i]);
  }
  while (poly.length > 1 && Math.hypot(poly[0][0] - poly[poly.length - 1][0], poly[0][1] - poly[poly.length - 1][1]) < minEdge) {
    poly.pop();
    out.pop();
  }
  return { poly, tags: out };
}

/** 内側へ寄せた多角形。edges[k] は、頂点 k から出る辺がもとの多角形のどの辺か */
export interface Inset {
  poly: P2[];
  edges: number[];
}

/**
 * 辺ごとの距離だけ内側へ寄せた多角形（反時計回りの多角形が前提）。
 * 寄せると向きが裏返る短い辺は消す（角のそばの短い辺など）。面積が無くなる時は null（細すぎる街区）。
 */
export function insetPoly(p: P2[], dist: number[]): Inset | null {
  const n = p.length;
  if (n < 3) return null;
  const dx: number[] = [], dz: number[] = [], off: number[] = [];
  for (let i = 0; i < n; i++) {
    const a = p[i], b = p[(i + 1) % n];
    let ex = b[0] - a[0], ez = b[1] - a[1];
    const l = Math.hypot(ex, ez) || 1;
    ex /= l;
    ez /= l;
    dx.push(ex);
    dz.push(ez);
    // 反時計回りなら内側は進行方向の左 (−dz, dx)
    off.push(-ez * a[0] + ex * a[1] + dist[i]);
  }
  let active = p.map((_, i) => i);
  let verts: P2[] = [];
  for (let iter = 0; iter < n; iter++) {
    const m = active.length;
    if (m < 3) return null;
    verts = [];
    for (let k = 0; k < m; k++) {
      const i = active[k], j = active[(k + m - 1) % m]; // j が前の辺
      const nxi = -dz[i], nzi = dx[i], nxj = -dz[j], nzj = dx[j];
      const den = nxj * nzi - nzj * nxi;
      const adjacent = (j + 1) % n === i;
      const v = p[i];
      if (Math.abs(den) < 0.03) {
        // ほぼ平行: 前の辺の終点と今の辺の始点を、それぞれの法線の向きへ寄せた点の中点
        const e = p[(j + 1) % n];
        verts.push([(e[0] + nxj * dist[j] + v[0] + nxi * dist[i]) / 2, (e[1] + nzj * dist[j] + v[1] + nzi * dist[i]) / 2]);
        continue;
      }
      let x = (off[j] * nzi - off[i] * nzj) / den;
      let z = (nxj * off[i] - nxi * off[j]) / den;
      if (adjacent) {
        // 鋭い角で遠くへ飛ぶのを抑える
        const lim = Math.max(dist[j], dist[i]) * 4 + 1;
        const ex = x - v[0], ez = z - v[1];
        const el = Math.hypot(ex, ez);
        if (el > lim) {
          x = v[0] + (ex / el) * lim;
          z = v[1] + (ez / el) * lim;
        }
      }
      verts.push([x, z]);
    }
    // 裏返った辺のうち、いちばんひどいものを消してやり直す
    let worst = -1, worstDot = -1e-6;
    for (let k = 0; k < m; k++) {
      const i = active[k];
      const c = verts[k], d = verts[(k + 1) % m];
      const dot = dx[i] * (d[0] - c[0]) + dz[i] * (d[1] - c[1]);
      if (dot < worstDot) {
        worstDot = dot;
        worst = k;
      }
    }
    if (worst < 0) break;
    active = active.filter((_, k) => k !== worst);
    if (iter === n - 1) return null;
  }
  if (signedArea(verts) < 1) return null;
  return { poly: verts, edges: active };
}

/**
 * 半平面 nx·x + nz·z ≤ c の側を残す（凸に近い多角形が前提）。切り口の辺の印は cutTag。
 * tags[i] は頂点 i から i+1 への辺の印。
 */
export function clipHalfPlane<T>(p: P2[], tags: T[], nx: number, nz: number, c: number, cutTag: T): { poly: P2[]; tags: T[] } {
  const poly: P2[] = [];
  const out: T[] = [];
  const n = p.length;
  for (let i = 0; i < n; i++) {
    const a = p[i], b = p[(i + 1) % n];
    const da = nx * a[0] + nz * a[1] - c;
    const db = nx * b[0] + nz * b[1] - c;
    const ina = da <= 0, inb = db <= 0;
    if (ina) {
      poly.push(a);
      out.push(inb ? tags[i] : tags[i]);
    }
    if (ina !== inb) {
      const t = da / (da - db);
      poly.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
      // 外へ出る交点からは切り口、内へ入る交点からは元の辺
      out.push(ina ? cutTag : tags[i]);
    }
  }
  return cleanPoly(poly, out);
}

/** 単位ベクトル (ax, az) とその左向きを軸にした外接の箱 */
export function boundsAlong(p: P2[], ax: number, az: number): { a0: number; a1: number; b0: number; b1: number } {
  let a0 = Infinity, a1 = -Infinity, b0 = Infinity, b1 = -Infinity;
  for (const [x, z] of p) {
    const a = x * ax + z * az;
    const b = -x * az + z * ax;
    if (a < a0) a0 = a;
    if (a > a1) a1 = a;
    if (b < b0) b0 = b;
    if (b > b1) b1 = b;
  }
  return { a0, a1, b0, b1 };
}

/** 凸に近い多角形の三角形分割（扇形）。添字の並び */
export function fan(n: number): number[] {
  const out: number[] = [];
  for (let i = 1; i < n - 1; i++) out.push(0, i, i + 1);
  return out;
}
