// 景観3種（海岸・平野・山岳）の撮影地点を起点の近くの道路から選ぶ。
// npx tsx scripts/find-scenes.ts [半径 m]  → artifacts/m2/scenes.json

import { mkdirSync, writeFileSync } from "node:fs";
import { ORIGIN, WORLD_SEED } from "../src/shared/world/constants.ts";
import { World } from "../src/shared/world/world.ts";

const R = Number(process.argv[2] ?? 14000);
const w = new World(WORLD_SEED);
const roads = w.roadsInRect({ x0: ORIGIN.x - R, z0: ORIGIN.z - R, x1: ORIGIN.x + R, z1: ORIGIN.z + R });
type Cand = { kind: string; road: string; s: number; x: number; z: number; y: number; score: number };
const best: Record<string, Cand | null> = { coast: null, plain: null, mountain: null, gravel: null };
for (const r of roads) {
  const n = r.points.length / 3;
  const ds = r.length / (n - 1);
  for (let i = 50; i < n - 50; i += 100) {
    const x = r.points[i * 3] + r.origin[0];
    const z = r.points[i * 3 + 2] + r.origin[1];
    const y = r.points[i * 3 + 1];
    if ((x - ORIGIN.x) ** 2 + (z - ORIGIN.z) ** 2 > R * R) continue;
    const l = w.terrain.landscape(x, z);
    const scores: Record<string, number> = {
      coast: l.coast * (1 + w.terrain.seaNearness(x, z)),
      plain: l.plain > 0.95 ? 1 + Math.min(1, Math.hypot(x - ORIGIN.x, z - ORIGIN.z) / 1e9) - w.terrain.slope(x, z, 300) * 10 : 0,
      mountain: l.mountain > 0.9 ? y / 1000 : 0,
    };
    for (const kind of ["coast", "plain", "mountain"]) {
      const sc = scores[kind];
      if (sc > 0 && (!best[kind] || sc > best[kind]!.score)) best[kind] = { kind, road: r.id, s: i * ds, x, z, y, score: sc };
    }
  }
}
// 海岸: 海にいちばん近い道路の点。海の方向も残す
let coast: (Cand & { seaX: number; seaZ: number; seaDist: number }) | null = null;
for (const r of roads) {
  const n = r.points.length / 3;
  const ds = r.length / (n - 1);
  for (let i = 25; i < n - 25; i += 25) {
    const x = r.points[i * 3] + r.origin[0];
    const z = r.points[i * 3 + 2] + r.origin[1];
    if ((x - ORIGIN.x) ** 2 + (z - ORIGIN.z) ** 2 > R * R) continue;
    for (let k = 0; k < 16; k++) {
      const a = (k / 16) * Math.PI * 2;
      for (let d = 100; d <= 3000; d += 100) {
        if (w.terrain.height(x + Math.cos(a) * d, z + Math.sin(a) * d) < 0) {
          if (!coast || d < coast.seaDist)
            coast = { kind: "coast", road: r.id, s: i * ds, x, z, y: r.points[i * 3 + 1], score: -d, seaX: x + Math.cos(a) * d, seaZ: z + Math.sin(a) * d, seaDist: d };
          break;
        }
      }
    }
  }
}
best.coast = coast;
// 林道: 起点にいちばん近い林道の中ほど
let gravel: Cand | null = null;
for (const r of roads) {
  if (r.surface !== "gravel" || r.length < 800) continue;
  const n = r.points.length / 3;
  const i = Math.floor(n / 2);
  const x = r.points[i * 3] + r.origin[0];
  const z = r.points[i * 3 + 2] + r.origin[1];
  const d = Math.hypot(x - ORIGIN.x, z - ORIGIN.z);
  if (!gravel || -d > gravel.score) gravel = { kind: "gravel", road: r.id, s: (i * r.length) / (n - 1), x, z, y: r.points[i * 3 + 1], score: -d };
}
best.gravel = gravel;
mkdirSync("artifacts/m2", { recursive: true });
writeFileSync("artifacts/m2/scenes.json", JSON.stringify(best, null, 2));
console.log(JSON.stringify(best, null, 2));
