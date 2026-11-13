// 指定範囲の世界を生成して統計を出す（モック仕様 4.10）。
// npx tsx scripts/world-report.ts --seed 1 --x 0 --z 0 --size 40000
// 結果は artifacts/world-report/ に JSON と Markdown で残す。

import { mkdirSync, writeFileSync } from "node:fs";
import { ROAD_CLASSES } from "../src/shared/world/constants.ts";
import {
  checkConnectivity,
  checkEarthwork,
  checkGrades,
  checkParallel,
  checkRadius,
  percentile,
  roadHash,
  roadsHash,
} from "../src/shared/world/inspect.ts";
import type { Road } from "../src/shared/world/types.ts";
import { type Rect, World } from "../src/shared/world/world.ts";

const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i].replace(/^--/, ""), process.argv[i + 1]);
const seed = Number(args.get("seed") ?? 1);
const cx = Number(args.get("x") ?? 0);
const cz = Number(args.get("z") ?? 0);
const size = Number(args.get("size") ?? 40000);
const skipRepro = args.get("repro") === "0";
const half = size / 2;
const rect: Rect = { x0: cx - half, z0: cz - half, x1: cx + half, z1: cz + half };

const log = (...a: unknown[]) => console.log(...a);
log(`seed ${seed}  center (${cx}, ${cz})  ${size / 1000}km 四方`);

const t0 = performance.now();
const A = new World(seed);
const reg = A.region(rect);
const genMs = performance.now() - t0;
log(`生成 ${(genMs / 1000).toFixed(1)}s  道路 ${reg.roads.length}  結節点 ${reg.nodes.length}`);

// 再現性: 別の順序（4分割を逆順）と別の起点（ずらした範囲を先に）で生成して比べる
let repro: { order: { same: number; diff: string[] }; origin: { same: number; diff: string[] } } | null = null;
if (!skipRepro) {
  const compare = (w: World) => {
    const roads = w.roadsInRect(rect);
    const byId = new Map(roads.map((r) => [r.id, r]));
    const diff: string[] = [];
    let same = 0;
    for (const r of reg.roads) {
      const o = byId.get(r.id);
      if (o && roadHash(o) === roadHash(r)) same++;
      else diff.push(r.id);
    }
    return { same, diff };
  };
  const B = new World(seed);
  const qs: Rect[] = [
    { x0: cx, z0: cz, x1: rect.x1, z1: rect.z1 },
    { x0: rect.x0, z0: cz, x1: cx, z1: rect.z1 },
    { x0: cx, z0: rect.z0, x1: rect.x1, z1: cz },
    { x0: rect.x0, z0: rect.z0, x1: cx, z1: cz },
  ];
  for (const q of qs) B.roadsInRect(q);
  const order = compare(B);
  const C = new World(seed);
  C.roadsInRect({ x0: rect.x0 + 13000, z0: rect.z0 - 9000, x1: rect.x1 + 13000, z1: rect.z1 - 9000 });
  const origin = compare(C);
  repro = { order, origin };
  log(`再現性: 順序 ${order.same}/${reg.roads.length} 一致、起点 ${origin.same}/${reg.roads.length} 一致`);
}

const roads = reg.roads;
const grades = checkGrades(roads);
const radius = checkRadius(roads);
const parallel = checkParallel(roads);
const earth = checkEarthwork(A, roads);
const conn = checkConnectivity(A, rect, roads);
const isolatedInfo = conn.isolated.map((id) => {
  const [, x, z] = id.split("_").map(Number);
  const n = A.node(x, z)!;
  const edges = A.edgesOfNode(n);
  return { id, edges: edges.length, failed: edges.filter((e) => A.failedEdges.has(e.id)).length };
});
const times = A.timings.map((t) => t.ms).sort((a, b) => a - b);
const crossings = reg.crossings;
const dys = crossings.filter((c) => !c.separated).map((c) => c.dy).sort((a, b) => a - b);

const byClass = ROAD_CLASSES.map((c, cls) => {
  const rs = roads.filter((r) => r.cls === cls);
  return { cls: c.name, roads: rs.length, km: rs.reduce((a, r) => a + r.length, 0) / 1000 };
});
const bridges = roads.flatMap((r) => r.spans);
const pois = { cafe: 0, pass: 0, viewpoint: 0 };
for (const p of reg.pois) pois[p.kind]++;
const totalKm = roads.reduce((a, r) => a + r.length, 0) / 1000;
const nodesByKind = { town: 0, village: 0, junction: 0 };
for (const n of reg.nodes) nodesByKind[n.kind]++;

const report = {
  date: new Date().toISOString(),
  seed,
  rect,
  generationSeconds: genMs / 1000,
  hash: roadsHash(roads),
  totals: {
    nodes: reg.nodes.length,
    nodesByKind,
    roads: roads.length,
    mainRoads: roads.filter((r) => r.kind === "main").length,
    branchPieces: roads.filter((r) => r.kind === "branch").length,
    cycleways: roads.filter((r) => r.kind === "cycleway").length,
    km: totalKm,
    byClass,
    junctions: reg.junctions.length,
    bridges: bridges.length,
    bridgeKm: bridges.reduce((a, s) => a + s.to - s.from, 0) / 1000,
    pois,
    kmPerCafe: totalKm / Math.max(1, pois.cafe),
    failedEdges: A.failedEdges.size,
  },
  reproducibility: repro,
  connectivity: { ...conn, isolatedInfo },
  grades,
  radius,
  parallel: { length: parallel.length, totalLength: parallel.totalLength, ratio: parallel.length / parallel.totalLength, runs: parallel.runs.length },
  earthwork: earth,
  crossings: {
    total: crossings.length,
    separated: crossings.filter((c) => c.separated).length,
    dyP50: percentile(dys, 0.5),
    dyP95: percentile(dys, 0.95),
    dyMax: dys[dys.length - 1] ?? 0,
  },
  timing: {
    roads: times.length,
    medianMs: percentile(times, 0.5),
    p95Ms: percentile(times, 0.95),
    maxMs: times[times.length - 1],
    slowest: [...A.timings].sort((a, b) => b.ms - a.ms).slice(0, 3),
  },
};

const md = renderMarkdown(report, roads);
const stamp = report.date.replace(/[:.]/g, "-");
mkdirSync("artifacts/world-report", { recursive: true });
const base = `artifacts/world-report/${stamp}-seed${seed}-${cx}_${cz}`;
writeFileSync(`${base}.json`, JSON.stringify(report, null, 2));
writeFileSync(`${base}.md`, md);
log(md);
log(`保存: ${base}.json / .md`);

function renderMarkdown(r: typeof report, rs: Road[]): string {
  const f1 = (v: number) => v.toFixed(1);
  const lines: string[] = [];
  lines.push(`# 世界の検査 seed ${r.seed}（${size / 1000}km 四方、中心 ${cx}, ${cz}）`, "");
  lines.push(`${r.date}。生成 ${f1(r.generationSeconds)} 秒（Node.js ${process.version}、1スレッド）。道路の点列のハッシュ ${r.hash}。`, "");
  lines.push("| 検査 | 結果 |", "|---|---|");
  if (r.reproducibility) {
    const o = r.reproducibility.order;
    const g = r.reproducibility.origin;
    lines.push(`| 再現性 | 4分割を逆順で生成: ${o.same}/${rs.length} 一致。13km・−9km ずらした範囲から生成: ${g.same}/${rs.length} 一致 |`);
  }
  lines.push(
    `| 連結 | 結節点 ${r.connectivity.nodes}、最大の連結成分 ${r.connectivity.largest}、成分 ${r.connectivity.components}。道路が来ない結節点 ${r.connectivity.isolated.length}（${r.connectivity.isolatedInfo.map((i) => `${i.id}: 辺 ${i.edges}・失敗 ${i.failed}`).join("、") || "なし"}）。最大成分から離れた結節点 ${r.connectivity.detached.length} |`,
  );
  lines.push(
    `| 勾配 | 等級の最大勾配を超えた点 ${r.grades.over}。最大は上限の ${(r.grades.maxRatio * 100).toFixed(1)}% |`,
  );
  lines.push(
    `| 曲線 | 最小曲線半径の 95% を下回った点 ${r.radius.under} / ${r.radius.points}（前後 6m の3点で測定）。${r.radius.byClass.map((c) => `${ROAD_CLASSES[c.cls].name} ${c.under}/${c.points}`).join("、")} |`,
  );
  lines.push(
    `| 並走 | 40m 以内で 200m 以上並ぶ区間 ${f1(r.parallel.length / 1000)} km（全 ${f1(r.parallel.totalLength / 1000)} km の ${(r.parallel.ratio * 100).toFixed(1)}%、${r.parallel.runs} 区間） |`,
  );
  const e = r.earthwork;
  lines.push(
    `| 切土・盛土 | 路面−地面: 1% ${f1(e.p01)}m、5% ${f1(e.p05)}m、中央 ${f1(e.p50)}m、95% ${f1(e.p95)}m、99% ${f1(e.p99)}m、最小 ${f1(e.min)}m、最大 ${f1(e.max)}m。30m 超 ${e.extreme} 点（約 ${f1(e.extremeLength)} m） |`,
  );
  lines.push(
    `| 生成時間 | 道路 ${r.timing.roads} 本: 中央値 ${f1(r.timing.medianMs)} ms、95% ${f1(r.timing.p95Ms)} ms、最大 ${f1(r.timing.maxMs)} ms |`,
  );
  lines.push("", "| 数量 | 値 |", "|---|---|");
  const t = r.totals;
  lines.push(`| 結節点 | ${t.nodes}（町 ${t.nodesByKind.town}、集落 ${t.nodesByKind.village}、分岐のみ ${t.nodesByKind.junction}） |`);
  lines.push(`| 道路 | ${t.roads} 本（主要道 ${t.mainRoads}、枝道の断片 ${t.branchPieces}、自転車道 ${t.cycleways}）、${f1(t.km)} km、経路が見つからない辺 ${t.failedEdges} |`);
  lines.push(`| 等級別 | ${t.byClass.map((c) => `${c.cls} ${c.roads} 本 ${f1(c.km)} km`).join("、")} |`);
  lines.push(`| 接続点 | ${t.junctions} |`);
  lines.push(
    `| 交差 | ${r.crossings.total}（橋で立体交差 ${r.crossings.separated}）。平面交差の路面の高さの差: 中央 ${f1(r.crossings.dyP50)}m、95% ${f1(r.crossings.dyP95)}m、最大 ${f1(r.crossings.dyMax)}m |`,
  );
  lines.push(`| 橋 | ${t.bridges} か所、${f1(t.bridgeKm * 1000)} m |`);
  lines.push(`| 立ち寄り地点 | 喫茶店 ${t.pois.cafe}（道なり ${f1(t.kmPerCafe)} km に1軒）、峠 ${t.pois.pass}、展望地 ${t.pois.viewpoint} |`);
  lines.push("", "切土・盛土の分布（橋を除く、5 点ごと）:", "", "| 範囲 (m) | 点 |", "|---|---|");
  for (const b of e.histogram) lines.push(`| ${b.from} 〜 ${b.to} | ${b.count} |`);
  return lines.join("\n") + "\n";
}
