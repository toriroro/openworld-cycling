// 標高タイルから、世界座標の格子（既定 5m）の高さを作る（北海道の草案 4.1）。
// 画素ごとに DEM5A → DEM5B → z14 の DEM10B の順に、欠けていない値を使う。

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
}

const Z15 = 2 ** 15 * 256;
const RAD = Math.PI / 180;

class DemSource {
  private primary = new Map<string, Float32Array>();
  private b5 = new Map<string, Float32Array>();
  private b10 = new Map<string, Float32Array>();

  constructor(manifestPath: string) {
    const m = JSON.parse(readFileSync(manifestPath, "utf8")) as { tiles: Entry[]; fill?: Entry[] };
    const load = (e: Entry) => demHeights(decodePng(readFileSync(e.path!)));
    for (const t of m.tiles) if (t.path && !t.missing) (t.z === 15 ? this.primary : this.b10).set(`${t.x},${t.y}`, load(t));
    for (const t of m.fill ?? []) {
      if (!t.path || t.missing) continue;
      (t.src === "dem5b_png" ? this.b5 : this.b10).set(`${t.x},${t.y}`, load(t));
    }
  }

  /** z15 の画素 (px, py) の高さ。どこにも無ければ NaN */
  pixel(px: number, py: number): number {
    const tx = px >> 8;
    const ty = py >> 8;
    const k = ((py & 255) << 8) | (px & 255);
    const key = `${tx},${ty}`;
    let v = this.primary.get(key)?.[k] ?? Number.NaN;
    if (Number.isNaN(v)) v = this.b5.get(key)?.[k] ?? Number.NaN;
    if (Number.isNaN(v)) {
      const qx = px >> 1;
      const qy = py >> 1;
      v = this.b10.get(`${qx >> 8},${qy >> 8}`)?.[((qy & 255) << 8) | (qx & 255)] ?? Number.NaN;
    }
    return v;
  }

  /** 緯度経度の高さ（画素の中心どうしの双一次補間） */
  at(lat: number, lon: number): number {
    const fx = ((lon + 180) / 360) * Z15 - 0.5;
    const fy = ((1 - Math.asinh(Math.tan(lat * RAD)) / Math.PI) / 2) * Z15 - 0.5;
    const i = Math.floor(fx);
    const j = Math.floor(fy);
    const u = fx - i;
    const v = fy - j;
    const a = this.pixel(i, j);
    const b = this.pixel(i + 1, j);
    const c = this.pixel(i, j + 1);
    const d = this.pixel(i + 1, j + 1);
    return (a * (1 - u) + b * u) * (1 - v) + (c * (1 - u) + d * u) * v;
  }
}

/**
 * 世界座標の矩形 [x0, x1] × [z0, z1] を step ごとに標本化する。
 * 緯度経度は 100m 格子でだけ逆変換し、その間は補間する（投影は滑らかなので 1mm 未満の差）。
 */
export function buildGrid(manifestPath: string, x0: number, z0: number, x1: number, z1: number, step: number): Grid {
  const src = new DemSource(manifestPath);
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
  const heights = new Float32Array(nx * nz);
  let missing = 0;
  for (let j = 0; j < nz; j++) {
    const fz = (j * step) / C;
    const jj = Math.min(cz - 2, Math.floor(fz));
    const v = fz - jj;
    for (let i = 0; i < nx; i++) {
      const fx = (i * step) / C;
      const ii = Math.min(cx - 2, Math.floor(fx));
      const u = fx - ii;
      const k = jj * cx + ii;
      const la = (lat[k] * (1 - u) + lat[k + 1] * u) * (1 - v) + (lat[k + cx] * (1 - u) + lat[k + cx + 1] * u) * v;
      const lo = (lon[k] * (1 - u) + lon[k + 1] * u) * (1 - v) + (lon[k + cx] * (1 - u) + lon[k + cx + 1] * u) * v;
      const h = src.at(la, lo);
      if (Number.isNaN(h)) missing++;
      heights[j * nx + i] = h;
    }
  }
  if (missing) throw new Error(`標高の欠け ${missing} 点（範囲の外まで取っているか、取得が足りない）`);
  return { x0, z0, step, nx, nz, heights };
}

/** 格子の双一次補間 */
export function gridAt(g: Grid, x: number, z: number): number {
  const fx = Math.max(0, Math.min(g.nx - 1.000001, (x - g.x0) / g.step));
  const fz = Math.max(0, Math.min(g.nz - 1.000001, (z - g.z0) / g.step));
  const i = Math.floor(fx);
  const j = Math.floor(fz);
  const u = fx - i;
  const v = fz - j;
  const k = j * g.nx + i;
  const h = g.heights;
  return (h[k] * (1 - u) + h[k + 1] * u) * (1 - v) + (h[k + g.nx] * (1 - u) + h[k + g.nx + 1] * u) * v;
}
