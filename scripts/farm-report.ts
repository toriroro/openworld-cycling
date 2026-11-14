// 農地の分布の検査: 起点のまわり（既定 30km 四方）を 500m 格子で調べ、農地になる所の割合と、田・畑・牧草地の内訳、広い農地の場所を出す。
// npx tsx scripts/farm-report.ts [半径 km]
// 農地の大きな分布は terrain-tile.ts と同じ式（景観の重み・傾斜・標高）。林の切れ目・道路・街は入れていない概数。

import { ORIGIN, WORLD_SEED } from "../src/shared/world/constants.ts";
import { gradNoise } from "../src/shared/world/noise.ts";
import { Terrain } from "../src/shared/world/terrain.ts";

const R = Number(process.argv[2] || 15) * 1000;
const t = new Terrain(WORLD_SEED);
const smooth = (a: number, b: number, x: number) => {
  let k = (x - a) / (b - a);
  k = k < 0 ? 0 : k > 1 ? 1 : k;
  return k * k * (3 - 2 * k);
};
const seedK = WORLD_SEED * 31 + 911;
const step = 500;
let n = 0, farm = 0;
const zones = [0, 0, 0];
const spots: { x: number; z: number; f: number; kind: number; h: number }[] = [];
for (let z = ORIGIN.z - R; z <= ORIGIN.z + R; z += step)
  for (let x = ORIGIN.x - R; x <= ORIGIN.x + R; x += step) {
    const e = t.routeHeight(x, z);
    if (e < 0) continue;
    n++;
    const w = t.landscape(x, z);
    const sl = t.slope(x, z);
    const land = Math.min(1, w.plain * 1.25 + w.other * 0.5);
    const f = land * (1 - smooth(0.07, 0.13, sl)) * (1 - smooth(260, 380, e));
    if (f < 0.5) continue;
    farm++;
    const paddy = (1 - smooth(0.012, 0.03, sl)) * (1 - smooth(70, 130, e));
    const pasture = Math.max(smooth(0.045, 0.08, sl), w.other * 0.8);
    let kind = 0.5 - 0.5 * paddy + 0.45 * pasture + 0.25 * gradNoise(seedK, x / 2600, z / 2600);
    kind = kind < 0 ? 0 : kind > 1 ? 1 : kind;
    zones[kind < 0.33 ? 0 : kind < 0.66 ? 1 : 2]++;
    spots.push({ x, z, f, kind, h: e });
  }
console.log(`陸の標本 ${n}、農地（重み 0.5 以上） ${farm}（${((farm / n) * 100).toFixed(1)}%）。田 ${zones[0]}、畑 ${zones[1]}、牧草地 ${zones[2]}`);
// 帯ごとに、起点に近い所を 3 つ
for (const [name, lo, hi] of [["田", 0, 0.33], ["畑", 0.33, 0.66], ["牧草地", 0.66, 1.01]] as const) {
  const list = spots
    .filter((s) => s.kind >= lo && s.kind < hi && s.f > 0.9)
    // まわりも農地の所
    .filter((s) => spots.filter((q) => Math.abs(q.x - s.x) <= 1000 && Math.abs(q.z - s.z) <= 1000).length >= 20)
    .sort((a, b) => Math.hypot(a.x - ORIGIN.x, a.z - ORIGIN.z) - Math.hypot(b.x - ORIGIN.x, b.z - ORIGIN.z))
    .slice(0, 3);
  for (const s of list) console.log(`${name}: (${s.x}, ${s.z}) 標高 ${s.h.toFixed(0)}m 寄り ${s.kind.toFixed(2)} 起点から ${(Math.hypot(s.x - ORIGIN.x, s.z - ORIGIN.z) / 1000).toFixed(1)}km`);
}
