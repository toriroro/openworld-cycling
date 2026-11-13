// 立ち寄り地点（モック仕様 4.9）: 峠、展望地、喫茶店。道路ごとに決まる。

import { CAFE_SPACING, PASS_PROMINENCE } from "./constants.ts";
import { hash, hashString, hashUnit } from "./hash.ts";
import { cafeName, passName, viewpointName } from "./names.ts";
import type { Poi, Road } from "./types.ts";
import type { World } from "./world.ts";

const CAFE_STEP = 500;

export function roadHeights(road: Road): Float64Array {
  const n = road.points.length / 3;
  const y = new Float64Array(n);
  for (let i = 0; i < n; i++) y[i] = road.points[i * 3 + 1];
  return y;
}

/** 縦断の極大のうち、前後どちらにも PASS_PROMINENCE 以上下がる所（添字） */
export function findPasses(y: Float64Array): number[] {
  const n = y.length;
  const out: number[] = [];
  for (let i = 1; i < n - 1; i++) {
    if (!(y[i] >= y[i - 1] && y[i] > y[i + 1])) continue;
    let lmin = y[i];
    let ok = false;
    for (let j = i - 1; j >= 0; j--) {
      if (y[j] > y[i]) break;
      if (y[j] < lmin) lmin = y[j];
      if (y[i] - lmin >= PASS_PROMINENCE) {
        ok = true;
        break;
      }
    }
    if (!ok) continue;
    let rmin = y[i];
    ok = false;
    for (let j = i + 1; j < n; j++) {
      if (y[j] > y[i]) break;
      if (y[j] < rmin) rmin = y[j];
      if (y[i] - rmin >= PASS_PROMINENCE) {
        ok = true;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

export function pickPois(world: World, road: Road): Poi[] {
  const seed = world.seed;
  const rh = hashString(road.id);
  const n = road.points.length / 3;
  const ds = n > 1 ? road.length / (n - 1) : 1;
  const y = roadHeights(road);
  const pois: Poi[] = [];
  const at = (i: number) => ({ x: road.origin[0] + road.points[i * 3], z: road.origin[1] + road.points[i * 3 + 2] });

  const passes = findPasses(y);
  for (const i of passes) {
    pois.push({ id: `p_${road.id}_${i}`, kind: "pass", road: road.id, s: i * ds, side: 1, name: passName(seed, rh, i) });
    pois.push({
      id: `v_${road.id}_${i}`,
      kind: "viewpoint",
      road: road.id,
      s: i * ds,
      side: hash(seed, rh, i, 3) & 1 ? 1 : -1,
      name: viewpointName(seed, rh, i),
    });
  }

  // 海を見下ろす高所（400m ごとに見て、前後 ±600m の最高点で、近くに海がある所）
  const win = Math.round(600 / ds);
  const stride = Math.max(1, Math.round(400 / ds));
  let lastView = -1e9;
  for (let i = win; i < n - win; i += stride) {
    if (y[i] < 120) continue;
    let top = true;
    for (let j = i - win; j <= i + win && top; j += 4) if (y[j] > y[i]) top = false;
    if (!top) continue;
    if (i * ds - lastView < 3000) continue;
    if (passes.some((p) => Math.abs(p - i) * ds < 1500)) continue;
    const p = at(i);
    let sea = false;
    for (let k = 0; k < 8 && !sea; k++) {
      const dx = DIR8X[k];
      const dz = DIR8Z[k];
      for (const r of [1500, 3000]) if (world.terrain.routeHeight(p.x + dx * r, p.z + dz * r) < 0) sea = true;
    }
    if (!sea) continue;
    lastView = i * ds;
    pois.push({
      id: `v_${road.id}_${i}`,
      kind: "viewpoint",
      road: road.id,
      s: i * ds,
      side: hash(seed, rh, i, 5) & 1 ? 1 : -1,
      name: viewpointName(seed, rh, i),
    });
  }

  // 喫茶店: 500m ごとの候補に重みを付けて、道なり 15km に1軒程度
  const passS = passes.map((i) => i * ds);
  let lastCafe = -1e9;
  const nCand = Math.floor(road.length / CAFE_STEP);
  for (let k = 1; k < nCand; k++) {
    const s = k * CAFE_STEP;
    if (s - lastCafe < 2500) continue;
    let w = 0.6;
    // 町の外れ（結節点の端から 0.6〜2km）
    const fromEnd = Math.min(s, road.length - s);
    if (fromEnd > 600 && fromEnd < 2000) w += 1.2;
    // 峠の手前（峠の 300m〜1.5km 前後）
    if (passS.some((ps) => Math.abs(ps - s) > 300 && Math.abs(ps - s) < 1500)) w += 1.5;
    const i = Math.min(n - 1, Math.round(s / ds));
    const p = at(i);
    if (y[i] < 25) {
      const ls = world.terrain.landscape(p.x, p.z);
      if (ls.coast > 0.5) w += 1.5;
    }
    const prob = ((CAFE_STEP / CAFE_SPACING) * w) / 0.9;
    if (hashUnit(seed, rh, k, 21) >= prob) continue;
    lastCafe = s;
    pois.push({
      id: `c_${road.id}_${k}`,
      kind: "cafe",
      road: road.id,
      s,
      side: hash(seed, rh, k, 22) & 1 ? 1 : -1,
      name: cafeName(seed, rh, k),
    });
  }
  return pois;
}

const DIR8X = [1, 0.70711, 0, -0.70711, -1, -0.70711, 0, 0.70711];
const DIR8Z = [0, 0.70711, 1, 0.70711, 0, -0.70711, -1, -0.70711];
