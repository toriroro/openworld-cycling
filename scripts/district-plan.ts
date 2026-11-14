// 街区の計画図（街路・街区・敷地・建物・電柱・街路樹）を SVG に描く。結果は artifacts/district/plan-<結節点>.svg。
// npx tsx scripts/district-plan.ts [結節点の識別子]（省略すると起点の葛郷）

import { mkdirSync, writeFileSync } from "node:fs";

const { WORLD_SEED } = await import("../src/shared/world/constants.ts");
const { World } = await import("../src/shared/world/world.ts");
const { planTown } = await import("../src/render/district/plan.ts");
const { buildSurface } = await import("../src/render/district/surface.ts");
const { layoutDistrict } = await import("../src/render/district/layout.ts");
const id = process.argv[2] || "n_-9_2";
const w = new World(WORLD_SEED);
const [, gx, gz] = id.split("_").map(Number);
const cx = gx * 4000, cz = gz * 4000;
const all = w.region({ x0: cx - 4000, z0: cz - 4000, x1: cx + 8000, z1: cz + 8000 } as any);
const node = all.nodes.find((n) => n.id === id)!;
const roads = all.roads.filter((r: any) => { for (let i = 0; i < r.points.length; i += 3) if (Math.hypot(r.points[i] + r.origin[0] - node.x, r.points[i+2] + r.origin[1] - node.z) < 700) return true; return false; });
const t0 = performance.now();
const plan = planTown(WORLD_SEED, node, roads);
const t1 = performance.now();
const surf = buildSurface(plan.boundary, roads, (x: number, z: number) => w.terrain.height(x, z));
const t2 = performance.now();
const L = layoutDistrict(plan, surf, [], () => performance.now());
console.log(id, node.name, "plan ms", (t1 - t0).toFixed(1), "surface ms", (t2 - t1).toFixed(1), "grid", surf.nx, surf.nz, JSON.stringify(L.stats));
const uses: Record<string, number> = {};
for (const l of L.lots) uses[l.use] = (uses[l.use] || 0) + 1;
console.log("uses", JSON.stringify(uses), "poles", L.poles.length, "trees", L.trees.length, "streets", plan.streets.length, "graph", L.graph.nodes.length, L.graph.edges.length, "runs", L.runs.length);
const S = Number(process.argv[3] || 1.15), H = 340;
const X = (x: number) => ((x - node.x + H) * S).toFixed(1), Z = (z: number) => ((z - node.z + H) * S).toFixed(1);
const poly = (p: number[][], fill: string, stroke = "none", sw = 0.5) => `<polygon points="${p.map((q) => X(q[0]) + "," + Z(q[1])).join(" ")}" fill="${fill}" stroke="${stroke}" stroke-width="${sw}"/>`;
let s = `<svg xmlns="http://www.w3.org/2000/svg" width="${2 * H * S}" height="${2 * H * S}" style="background:#9bb07a">`;
s += poly(plan.boundary, "#b9b4a6");
for (const b of L.blocks) { if (b.curb) s += poly(b.curb.poly, "#c9c9c9"); else s += poly(b.poly, "#d66", "#900"); if (b.lotLine) s += poly(b.lotLine.poly, "#a59f90"); }
const C: Record<string, string> = { shop: "#e9c98a", house: "#dfe6c8", apartment: "#c8d6e6", parking: "#8d8d8d", vacant: "#b7ab8f", field: "#8fae6a", green: "#4f8a3c", reserved: "#f0f" };
for (const l of L.lots) { s += poly(l.lot.poly, C[l.use], "#555", 0.4); if (l.lot.front >= 0) { const a = l.lot.poly[l.lot.front], b = l.lot.poly[(l.lot.front + 1) % l.lot.poly.length]; s += `<line x1="${X(a[0])}" y1="${Z(a[1])}" x2="${X(b[0])}" y2="${Z(b[1])}" stroke="#c00" stroke-width="1"/>`; } }
for (const b of L.buildings) { const c = Math.cos(b.angle), sn = Math.sin(b.angle); const pts = [[-1,-1],[1,-1],[1,1],[-1,1]].map(([a, d]) => [b.x + c * a * b.w / 2 - sn * d * b.d / 2, b.z + sn * a * b.w / 2 + c * d * b.d / 2]); s += poly(pts, b.shop ? "#a8642c" : b.floors >= 3 ? "#3c5f8c" : "#6b4d3a"); }
for (const r of L.runs) { const st = plan.streets[r.street]; s += `<polyline points="${r.pts.map((q: number[]) => X(q[0]) + "," + Z(q[1])).join(" ")}" fill="none" stroke="${st.kind === "arterial" ? "#222" : "#fff"}" stroke-width="${st.kind === "arterial" ? 1.6 : 0.8}" stroke-dasharray="${st.kind === "alley" ? "3 2" : ""}"/>`; }
for (const p of L.poles) s += `<circle cx="${X(p.x)}" cy="${Z(p.z)}" r="1.6" fill="#000"/>`;
for (const t of L.trees) s += `<circle cx="${X(t.x)}" cy="${Z(t.z)}" r="2.6" fill="#1a7a2a"/>`;
s += "</svg>";
mkdirSync("artifacts/district", { recursive: true });
writeFileSync(`artifacts/district/plan-${id}.svg`, s);
{
  const main: Record<string, number> = {};
  for (const l of L.lots) if (l.lot.mainStreet) main[l.use] = (main[l.use] || 0) + 1;
  console.log("幹線に面した敷地", JSON.stringify(main));
}
