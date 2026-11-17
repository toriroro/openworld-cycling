// 面と線を格子（格子点で判定）に塗る。

import type { Ring } from "./osm.ts";

export interface Raster {
  x0: number;
  z0: number;
  step: number;
  nx: number;
  nz: number;
  data: Uint8Array;
}

/** 輪の集まりを偶奇の規則で塗る（穴は内側の輪で抜ける） */
export function fillRings(r: Raster, rings: Ring[], value: number) {
  let zMin = Infinity;
  let zMax = -Infinity;
  for (const ring of rings)
    for (let i = 1; i < ring.length; i += 2) {
      if (ring[i] < zMin) zMin = ring[i];
      if (ring[i] > zMax) zMax = ring[i];
    }
  const j0 = Math.max(0, Math.ceil((zMin - r.z0) / r.step));
  const j1 = Math.min(r.nz - 1, Math.floor((zMax - r.z0) / r.step));
  const xs: number[] = [];
  for (let j = j0; j <= j1; j++) {
    const z = r.z0 + j * r.step;
    xs.length = 0;
    for (const ring of rings) {
      const n = ring.length / 2;
      for (let a = 0, b = n - 1; a < n; b = a++) {
        const za = ring[a * 2 + 1];
        const zb = ring[b * 2 + 1];
        if (za > z !== zb > z) {
          const xa = ring[a * 2];
          const xb = ring[b * 2];
          xs.push(xa + ((z - za) / (zb - za)) * (xb - xa));
        }
      }
    }
    xs.sort((p, q) => p - q);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const i0 = Math.max(0, Math.ceil((xs[k] - r.x0) / r.step));
      const i1 = Math.min(r.nx - 1, Math.floor((xs[k + 1] - r.x0) / r.step));
      for (let i = i0; i <= i1; i++) r.data[j * r.nx + i] = value;
    }
  }
}

/** 折れ線から half (m) 以内の格子点を塗る。half は格子の間隔の半分より細くしない */
export function strokeLine(r: Raster, line: Float64Array, half: number, value: number, onlyEmpty = false) {
  const h = Math.max(half, r.step * 0.5);
  for (let s = 0; s + 3 < line.length; s += 2) {
    const ax = line[s];
    const az = line[s + 1];
    const bx = line[s + 2];
    const bz = line[s + 3];
    const i0 = Math.max(0, Math.floor((Math.min(ax, bx) - h - r.x0) / r.step));
    const i1 = Math.min(r.nx - 1, Math.ceil((Math.max(ax, bx) + h - r.x0) / r.step));
    const j0 = Math.max(0, Math.floor((Math.min(az, bz) - h - r.z0) / r.step));
    const j1 = Math.min(r.nz - 1, Math.ceil((Math.max(az, bz) + h - r.z0) / r.step));
    const dx = bx - ax;
    const dz = bz - az;
    const l2 = dx * dx + dz * dz || 1;
    for (let j = j0; j <= j1; j++)
      for (let i = i0; i <= i1; i++) {
        const px = r.x0 + i * r.step;
        const pz = r.z0 + j * r.step;
        const t = Math.max(0, Math.min(1, ((px - ax) * dx + (pz - az) * dz) / l2));
        const ex = ax + t * dx - px;
        const ez = az + t * dz - pz;
        if (ex * ex + ez * ez <= h * h) {
          const k = j * r.nx + i;
          if (!onlyEmpty || r.data[k] === 0) r.data[k] = value;
        }
      }
  }
}
