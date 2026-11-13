// 同じ範囲を生成して、道路の点列のハッシュを出す（端末間の一致の検査。モック仕様 4.10）。
import { riversHash, roadsHash } from "../src/shared/world/inspect.ts";
import { World } from "../src/shared/world/world.ts";

const q = new URLSearchParams(location.search);
const seed = Number(q.get("seed") ?? 6);
const x = Number(q.get("x") ?? -32500);
const z = Number(q.get("z") ?? 11250);
const size = Number(q.get("size") ?? 16000);
const t0 = performance.now();
const w = new World(seed);
const reg = w.region({ x0: x - size / 2, z0: z - size / 2, x1: x + size / 2, z1: z + size / 2 });
// 川の線は道路より広い範囲（64km 四方）で比べる
const rivers = () => {
  const r = w.terrain.rivers.inRect(x - 32000, z - 32000, x + 32000, z + 32000);
  return `${riversHash(r.segs, r.lakes)} ${r.segs.length}/${r.lakes.length}`;
};
const result = {
  hash: roadsHash(reg.roads),
  rivers: rivers(),
  roads: reg.roads.length,
  junctions: reg.junctions.length,
  pois: reg.pois.map((p) => p.id).sort().join(",").length,
  ms: Math.round(performance.now() - t0),
  userAgent: navigator.userAgent,
};
(window as unknown as { __result: typeof result }).__result = result;
document.getElementById("out")!.textContent = JSON.stringify(result, null, 2);
