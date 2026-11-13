// 起点の葛郷（格子 n_-9_2）が R1 の後も起点の条件を満たすか（河川の草案 8章）。
// npx tsx scripts/r1-origin.ts
// M1 の起点選びと同じ数値（15km 以内の海・海岸線・平野・山）と、近くの大きな川を出す。

import { mkdirSync, writeFileSync } from "node:fs";
import { ORIGIN, WORLD_SEED } from "../src/shared/world/constants.ts";
import { RIVER_MIN_ACC } from "../src/shared/world/rivers.ts";
import type { Terrain } from "../src/shared/world/terrain.ts";
import { World } from "../src/shared/world/world.ts";

const R = 15000;

function measure(t: Terrain, cx: number, cz: number, step: number) {
  let plain = 0;
  let sea = 0;
  let coast = 0;
  let mountain = 0;
  let maxElev = -1e9;
  const cell = (step * step) / 1e6;
  for (let z = -R; z <= R; z += step)
    for (let x = -R; x <= R; x += step) {
      if (x * x + z * z > R * R) continue;
      const px = cx + x;
      const pz = cz + z;
      const h = t.routeHeight(px, pz);
      if (h < 0) {
        sea += cell;
        continue;
      }
      if (h > maxElev) maxElev = h;
      if (h >= 600) mountain += cell;
      const r = step / 2;
      const gx = (t.routeHeight(px + r, pz) - t.routeHeight(px - r, pz)) / (2 * r);
      const gz = (t.routeHeight(px, pz + r) - t.routeHeight(px, pz - r)) / (2 * r);
      const sl = Math.sqrt(gx * gx + gz * gz);
      if (sl < 0.03 && h < 150) plain += cell;
      if (t.routeHeight(px + step, pz) < 0 || t.routeHeight(px, pz + step) < 0) coast += step / 1000;
    }
  return { plainKm2: plain, seaKm2: sea, coastKm: coast, maxElev, mountainKm2: mountain };
}

const w = new World(WORLD_SEED);
const [, cxs, czs] = ORIGIN.node.split("_");
const n = w.node(Number(cxs), Number(czs));
if (!n) throw new Error("起点の格子に結節点がない");
const m = measure(w.terrain, n.x, n.z, 250);
const ok = m.plainKm2 >= 20 && m.maxElev >= 600 && m.seaKm2 >= 15 && m.coastKm >= 8;
// 15km 以内の大きな川（流域の大きい順）
const { segs, lakes } = w.terrain.rivers.inRect(n.x - R, n.z - R, n.x + R, n.z + R);
const near = segs
  .map((s) => {
    let d = Infinity;
    for (let p = 0; p < s.n; p++) d = Math.min(d, Math.hypot(s.x[p] - n.x, s.z[p] - n.z));
    return { id: `${s.i}_${s.j}`, acc: s.acc, areaKm2: s.acc * 4, d, toSea: s.toSea };
  })
  .filter((r) => r.d <= R && r.acc >= RIVER_MIN_ACC)
  .sort((a, b) => b.acc - a.acc);
const nearest = [...near].sort((a, b) => a.d - b.d)[0];
const out = {
  node: { id: n.id, name: n.name, kind: n.kind, x: n.x, y: n.y, z: n.z, importance: n.importance },
  originConst: ORIGIN,
  moved: Math.hypot(n.x - ORIGIN.x, n.z - ORIGIN.z),
  metrics: m,
  ok,
  rivers15km: { count: near.length, largestKm2: near[0]?.areaKm2 ?? 0, nearestM: nearest?.d ?? null, nearestKm2: nearest?.areaKm2 ?? 0, lakes: lakes.length },
};
console.log(JSON.stringify(out, null, 2));
mkdirSync("artifacts/r1", { recursive: true });
writeFileSync("artifacts/r1/origin.json", JSON.stringify(out, null, 2));
