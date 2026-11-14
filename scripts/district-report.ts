// 起点の周りの町すべてで街区を作り、数と時間を出す（破綻の検査）。npx tsx scripts/district-report.ts [半径 km]
import { ORIGIN, WORLD_SEED } from "../src/shared/world/constants.ts";
import { World } from "../src/shared/world/world.ts";
import { layoutDistrict } from "../src/render/district/layout.ts";
import { planTown } from "../src/render/district/plan.ts";
import { buildSurface } from "../src/render/district/surface.ts";
import { signedArea } from "../src/render/district/geom.ts";

const R = Number(process.argv[2] || 24) * 1000;
const w = new World(WORLD_SEED);
const reg = w.region({ x0: ORIGIN.x - R, z0: ORIGIN.z - R, x1: ORIGIN.x + R, z1: ORIGIN.z + R });
const towns = reg.nodes.filter((n) => n.kind === "town");
console.log(`町 ${towns.length}（半径 ${R / 1000}km、道路 ${reg.roads.length}）`);
let fail = 0;
for (const node of towns) {
  const roads = reg.roads.filter((r) => {
    for (let i = 0; i < r.points.length; i += 30) if (Math.hypot(r.points[i] + r.origin[0] - node.x, r.points[i + 2] + r.origin[1] - node.z) < 760) return true;
    return false;
  });
  try {
    const t0 = performance.now();
    const plan = planTown(WORLD_SEED, node, roads);
    const surf = buildSurface(plan.boundary, roads, (x, z) => w.terrain.height(x, z));
    const t1 = performance.now();
    const L = layoutDistrict(plan, surf, [], () => performance.now());
    const uses: Record<string, number> = {};
    for (const l of L.lots) uses[l.use] = (uses[l.use] || 0) + 1;
    // 面の高低差と、水面より下の敷地、重なる建物
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < surf.h.length; i++) if (surf.m[i] >= 1) {
      lo = Math.min(lo, surf.h[i]);
      hi = Math.max(hi, surf.h[i]);
    }
    const wet = L.buildings.filter((b) => b.base < 0.5).length;
    const badLots = L.lots.filter((l) => !(signedArea(l.lot.poly) > 0) || l.lot.poly.some((p) => !Number.isFinite(p[0] + p[1]))).length;
    const arterials = plan.streets.filter((s) => s.kind === "arterial").length;
    console.log(
      `${node.id} ${node.name} (${node.x.toFixed(0)},${node.z.toFixed(0)}) 重要度 ${node.importance.toFixed(2)} 幹線 ${arterials} 街区 ${L.stats.blocks}（空 ${L.stats.voidBlocks}） 敷地 ${L.stats.lots} 建物 ${L.stats.buildings} 店 ${uses.shop ?? 0} 電柱 ${L.poles.length} 高低差 ${(hi - lo).toFixed(0)}m 最低 ${lo.toFixed(0)}m 水際の建物 ${wet} 不正な敷地 ${badLots} 面 ${(t1 - t0).toFixed(0)}ms 配置 ${L.stats.ms.toFixed(0)}ms`,
    );
  } catch (e) {
    fail++;
    console.log(`${node.id} ${node.name} 失敗: ${String(e)}`);
  }
}
console.log(`失敗 ${fail}`);
