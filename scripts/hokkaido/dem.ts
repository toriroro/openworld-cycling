// 標高タイルから、世界座標の格子（既定 5m）の高さを作る（北海道の草案 4.1・18.1）。
// 画素ごとに DEM5A → DEM5B → z14 の DEM10B の順に、欠けていない値を使う。
// H2: 5m の値は H0 の範囲だけにあるので、範囲の縁（fine.blend m）で 10B だけの値へなめらかに移す。
// どのタイルにも値が無い所（海）は NaN のまま返し、呼ぶ側が海として扱う。

import { readFileSync } from "node:fs";
import { decodePng, demHeights } from "./png.ts";
import { unproject } from "./projection.ts";

interface Entry {
  z: number;
  x: number;
  y: number;
  src: string;
  path?: string;
  missing?: boolean;
}

/** 平面の格子。heights[j * nx + i] が (x0 + i·step, z0 + j·step) の高さ */
export interface Grid {
  x0: number;
  z0: number;
  step: number;
  nx: number;
  nz: number;
  heights: Float32Array;
  /** 細かい格子（H0 の 5m）。この範囲の中は fine を引く */
  fine?: Grid;
}

const Z15 = 2 ** 15 * 256;
const RAD = Math.PI / 180;

const key = (x: number, y: number) => x * 1048576 + y;

class DemSource {
  private primary = new Map<number, Float32Array>();
  private b5 = new Map<number, Float32Array>();
  private b10 = new Map<number, Float32Array>();

  constructor(manifestPaths: string[]) {
    const load = (e: Entry) => demHeights(decodePng(readFileSync(e.path!)));
    for (const p of manifestPaths) {
      const m = JSON.parse(readFileSync(p, "utf8")) as { tiles: Entry[]; fill?: Entry[] };
      for (const t of m.tiles) if (t.path && !t.missing) (t.z === 15 ? this.primary : this.b10).set(key(t.x, t.y), load(t));
      for (const t of m.fill ?? []) {
        if (!t.path || t.missing) continue;
        (t.src === "dem5b_png" ? this.b5 : this.b10).set(key(t.x, t.y), load(t));
      }
    }
  }

  /** z15 の画素 (px, py) の高さ。どこにも無ければ NaN。only10 なら DEM10B だけ */
  pixel(px: number, py: number, only10: boolean): number {
    let v = Number.NaN;
    if (!only10) {
      const k = ((py & 255) << 8) | (px & 255);
      const tk = key(px >> 8, py >> 8);
      v = this.primary.get(tk)?.[k] ?? Number.NaN;
      if (Number.isNaN(v)) v = this.b5.get(tk)?.[k] ?? Number.NaN;
    }
    if (Number.isNaN(v)) {
      const qx = px >> 1;
      const qy = py >> 1;
      v = this.b10.get(key(qx >> 8, qy >> 8))?.[((qy & 255) << 8) | (qx & 255)] ?? Number.NaN;
    }
    return v;
  }

  /** 緯度経度の高さ（画素の中心どうしの双一次補間）。4 点の一部が欠けていれば、欠けていない点だけで重みを付け直す */
  at(lat: number, lon: number, only10 = false): number {
    const fx = ((lon + 180) / 360) * Z15 - 0.5;
    const fy = ((1 - Math.asinh(Math.tan(lat * RAD)) / Math.PI) / 2) * Z15 - 0.5;
    const i = Math.floor(fx);
    const j = Math.floor(fy);
    const u = fx - i;
    const v = fy - j;
    const a = this.pixel(i, j, only10);
    const b = this.pixel(i + 1, j, only10);
    const c = this.pixel(i, j + 1, only10);
    const d = this.pixel(i + 1, j + 1, only10);
    const wa = (1 - u) * (1 - v);
    const wb = u * (1 - v);
    const wc = (1 - u) * v;
    const wd = u * v;
    if (!Number.isNaN(a) && !Number.isNaN(b) && !Number.isNaN(c) && !Number.isNaN(d)) return a * wa + b * wb + c * wc + d * wd;
    let sum = 0;
    let w = 0;
    if (!Number.isNaN(a)) (sum += a * wa), (w += wa);
    if (!Number.isNaN(b)) (sum += b * wb), (w += wb);
    if (!Number.isNaN(c)) (sum += c * wc), (w += wc);
    if (!Number.isNaN(d)) (sum += d * wd), (w += wd);
    // 半分以上が欠けていれば欠け（海岸線を太らせない）
    return w >= 0.5 ? sum / w : Number.NaN;
  }
}

/** 細かい値（5A・5B）を使う範囲と、縁で 10B へ移す幅 */
export interface FineArea {
  x0: number;
  z0: number;
  x1: number;
  z1: number;
  blend: number;
}

/**
 * 世界座標の矩形 [x0, x1] × [z0, z1] を step ごとに標本化する。
 * 緯度経度は 100m 格子でだけ逆変換し、その間は補間する（投影は滑らかなので 1mm 未満の差）。
 * fine を渡すと、その範囲の中だけ 5A・5B を使い、縁の blend m で 10B だけの値へ移す（外は 10B だけ）。
 * 欠け（海）は NaN のまま。allowMissing でなければ例外にする。
 */
export function buildGrid(
  manifestPaths: string | string[],
  x0: number,
  z0: number,
  x1: number,
  z1: number,
  step: number,
  opt: { fine?: FineArea; allowMissing?: boolean } = {},
): Grid & { missing: number } {
  const src = new DemSource(typeof manifestPaths === "string" ? [manifestPaths] : manifestPaths);
  const nx = Math.round((x1 - x0) / step) + 1;
  const nz = Math.round((z1 - z0) / step) + 1;
  const C = 100;
  const cx = Math.ceil((x1 - x0) / C) + 1;
  const cz = Math.ceil((z1 - z0) / C) + 1;
  const lat = new Float64Array(cx * cz);
  const lon = new Float64Array(cx * cz);
  for (let j = 0; j < cz; j++)
    for (let i = 0; i < cx; i++) {
      const ll = unproject(x0 + i * C, z0 + j * C);
      lat[j * cx + i] = ll.lat;
      lon[j * cx + i] = ll.lon;
    }
  const f = opt.fine;
  const heights = new Float32Array(nx * nz);
  let missing = 0;
  for (let j = 0; j < nz; j++) {
    const fz = (j * step) / C;
    const jj = Math.min(cz - 2, Math.floor(fz));
    const v = fz - jj;
    const z = z0 + j * step;
    for (let i = 0; i < nx; i++) {
      const fx = (i * step) / C;
      const ii = Math.min(cx - 2, Math.floor(fx));
      const u = fx - ii;
      const k = jj * cx + ii;
      const la = (lat[k] * (1 - u) + lat[k + 1] * u) * (1 - v) + (lat[k + cx] * (1 - u) + lat[k + cx + 1] * u) * v;
      const lo = (lon[k] * (1 - u) + lon[k + 1] * u) * (1 - v) + (lon[k + cx] * (1 - u) + lon[k + cx + 1] * u) * v;
      let h: number;
      if (!f) h = src.at(la, lo);
      else {
        const x = x0 + i * step;
        const edge = Math.min(x - f.x0, f.x1 - x, z - f.z0, f.z1 - z);
        const w = Math.max(0, Math.min(1, edge / f.blend));
        if (w >= 1) h = src.at(la, lo);
        else {
          const h10 = src.at(la, lo, true);
          if (w <= 0) h = h10;
          else {
            const h5 = src.at(la, lo);
            h = Number.isNaN(h5) ? h10 : Number.isNaN(h10) ? h5 : h10 + (h5 - h10) * w * w * (3 - 2 * w);
          }
        }
      }
      if (Number.isNaN(h)) missing++;
      heights[j * nx + i] = h;
    }
  }
  if (missing && !opt.allowMissing) throw new Error(`標高の欠け ${missing} 点（範囲の外まで取っているか、取得が足りない）`);
  return { x0, z0, step, nx, nz, heights, missing };
}

/** 格子の双一次補間。fine があり、その範囲の中なら fine を引く。欠け（NaN）は 0（海面）とする */
export function gridAt(g: Grid, x: number, z: number): number {
  const fg = g.fine;
  if (fg && x >= fg.x0 && z >= fg.z0 && x <= fg.x0 + (fg.nx - 1) * fg.step && z <= fg.z0 + (fg.nz - 1) * fg.step) return gridAt(fg, x, z);
  const fx = Math.max(0, Math.min(g.nx - 1.000001, (x - g.x0) / g.step));
  const fz = Math.max(0, Math.min(g.nz - 1.000001, (z - g.z0) / g.step));
  const i = Math.floor(fx);
  const j = Math.floor(fz);
  const u = fx - i;
  const v = fz - j;
  const k = j * g.nx + i;
  const h = g.heights;
  const a = h[k] || 0;
  const b = h[k + 1] || 0;
  const c = h[k + g.nx] || 0;
  const d = h[k + g.nx + 1] || 0;
  return (a * (1 - u) + b * u) * (1 - v) + (c * (1 - u) + d * u) * v;
}
