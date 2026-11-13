// tools/world-hash.ts と同じ計算を Node で行い、結果を JSON で出す
import { riversHash, roadsHash } from "../src/shared/world/inspect.ts";
import { World } from "../src/shared/world/world.ts";

const q = new URLSearchParams(process.argv[2] ?? "");
const seed = Number(q.get("seed") ?? 6);
const x = Number(q.get("x") ?? -32500);
const z = Number(q.get("z") ?? 11250);
const size = Number(q.get("size") ?? 16000);
const t0 = performance.now();
const w = new World(seed);
const reg = w.region({ x0: x - size / 2, z0: z - size / 2, x1: x + size / 2, z1: z + size / 2 });
const rv = w.terrain.rivers.inRect(x - 32000, z - 32000, x + 32000, z + 32000);
console.log(JSON.stringify({
  hash: roadsHash(reg.roads),
  rivers: `${riversHash(rv.segs, rv.lakes)} ${rv.segs.length}/${rv.lakes.length}`,
  roads: reg.roads.length,
  junctions: reg.junctions.length,
  pois: reg.pois.map((p) => p.id).sort().join(",").length,
  ms: Math.round(performance.now() - t0),
}));
