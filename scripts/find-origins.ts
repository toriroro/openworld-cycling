// 起点の候補を探す（モック仕様 4.10）。15km 以内に海岸・平野（傾斜 3% 未満が 20km² 以上）・山（600m 以上）がそろう町。
// npx tsx scripts/find-origins.ts --seeds 1-8 --range 120000
// 結果は artifacts/origins/candidates.json。

import { mkdirSync, writeFileSync } from "node:fs";
import { Terrain } from "../src/shared/world/terrain.ts";
import { World } from "../src/shared/world/world.ts";

const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i].replace(/^--/, ""), process.argv[i + 1]);
const [s0, s1] = (args.get("seeds") ?? "1-8").split("-").map(Number);
const range = Number(args.get("range") ?? 120000);
const R = 15000;

interface Metrics {
  plainKm2: number;
  seaKm2: number;
  coastKm: number;
  maxElev: number;
  mountainKm2: number;
}

function measure(t: Terrain, cx: number, cz: number, step: number): Metrics {
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
      // 海岸線: 隣（step 先）が海の陸の点
      if (t.routeHeight(px + step, pz) < 0 || t.routeHeight(px, pz + step) < 0) coast += step / 1000;
    }
  return { plainKm2: plain, seaKm2: sea, coastKm: coast, maxElev, mountainKm2: mountain };
}

const ok = (m: Metrics) => m.plainKm2 >= 20 && m.maxElev >= 600 && m.seaKm2 >= 15 && m.coastKm >= 8;
const score = (m: Metrics) =>
  Math.min(m.plainKm2, 120) / 40 + Math.min(m.maxElev, 1500) / 500 + Math.min(m.coastKm, 40) / 15 + Math.min(m.mountainKm2, 80) / 40;

interface Cand {
  seed: number;
  x: number;
  z: number;
  town: string;
  townName: string;
  metrics: Metrics;
  score: number;
}

const found: Cand[] = [];
const t0 = performance.now();
for (let seed = s0; seed <= s1; seed++) {
  const t = new Terrain(seed);
  const coarse: { x: number; z: number; m: Metrics; s: number }[] = [];
  for (let z = -range; z <= range; z += 8000)
    for (let x = -range; x <= range; x += 8000) {
      const m = measure(t, x, z, 1000);
      if (ok(m)) coarse.push({ x, z, m, s: score(m) });
    }
  coarse.sort((a, b) => b.s - a.s);
  // 上位を町に寄せて細かく測る
  const w = new World(seed);
  let kept = 0;
  for (const c of coarse.slice(0, 12)) {
    const towns = w
      .nodesInRect({ x0: c.x - 6000, z0: c.z - 6000, x1: c.x + 6000, z1: c.z + 6000 })
      .filter((n) => n.kind === "town")
      .sort((a, b) => (a.x - c.x) ** 2 + (a.z - c.z) ** 2 - ((b.x - c.x) ** 2 + (b.z - c.z) ** 2));
    const town = towns[0];
    if (!town) continue;
    const m = measure(t, town.x, town.z, 250);
    if (!ok(m)) continue;
    if (found.some((f) => f.seed === seed && Math.hypot(f.x - town.x, f.z - town.z) < 30000)) continue;
    found.push({ seed, x: town.x, z: town.z, town: town.id, townName: town.name, metrics: m, score: score(m) });
    if (++kept >= 3) break;
  }
  console.log(`seed ${seed}: 粗い候補 ${coarse.length}、採用 ${kept}（${((performance.now() - t0) / 1000).toFixed(0)}s）`);
}
found.sort((a, b) => b.score - a.score);
mkdirSync("artifacts/origins", { recursive: true });
writeFileSync("artifacts/origins/candidates.json", JSON.stringify(found, null, 2));
for (const f of found.slice(0, 12))
  console.log(
    `seed ${f.seed} ${f.townName} (${f.x}, ${f.z}) 平野 ${f.metrics.plainKm2.toFixed(0)}km² 海 ${f.metrics.seaKm2.toFixed(0)}km² 海岸線 ${f.metrics.coastKm.toFixed(0)}km 最高 ${f.metrics.maxElev.toFixed(0)}m 600m以上 ${f.metrics.mountainKm2.toFixed(0)}km² score ${f.score.toFixed(2)}`,
  );
