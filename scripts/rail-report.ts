// 鉄道の検査（鉄道の草案 10 章 L1、13 章）。起点の周り R km 四方の線路を生成して数える。
// npx tsx scripts/rail-report.ts [半辺 km = 50]

import { ORIGIN, WORLD_SEED } from "../src/shared/world/constants.ts";
import { RAIL_MAX_GRADE, RAIL_CELL } from "../src/shared/world/rail.ts";
import { circumradius } from "../src/shared/world/shape.ts";
import { World } from "../src/shared/world/world.ts";

const half = Number(process.argv[2] ?? 50) * 1000;
const rect = { x0: ORIGIN.x - half, z0: ORIGIN.z - half, x1: ORIGIN.x + half, z1: ORIGIN.z + half };
const w = new World(WORLD_SEED);
const t0 = performance.now();
const edges = w.rail.edgesNear(rect);
const lines = w.rail.inRect(rect);
const ms = performance.now() - t0;

const hubs = new Set<string>();
for (let cz = Math.floor(rect.z0 / RAIL_CELL); cz <= Math.floor(rect.z1 / RAIL_CELL); cz++)
  for (let cx = Math.floor(rect.x0 / RAIL_CELL); cx <= Math.floor(rect.x1 / RAIL_CELL); cx++) {
    const h = w.rail.hub(cx, cz);
    if (h) hubs.add(h.id);
  }
const km = (m: number) => Math.round(m / 100) / 10;
const sum = (f: (l: (typeof lines)[number]) => number, pred: (l: (typeof lines)[number]) => boolean = () => true) => lines.filter(pred).reduce((a, l) => a + f(l), 0);
const crossings = lines.flatMap((l) => l.crossings);
const byKind = (k: string) => crossings.filter((c) => c.kind === k).length;
let maxGrade = 0;
let minR = Infinity;
/** 最小曲線半径に対する、測った半径のいちばん小さい割合（幹線 300m・支線 200m） */
let minRatio = Infinity;
let gradeViol = 0;
for (const l of lines) {
  const P = l.points;
  const n = P.length / 3;
  const ds = l.length / (n - 1);
  for (let i = 1; i < n; i++) {
    const g = Math.abs(P[i * 3 + 1] - P[i * 3 - 2]) / ds;
    if (g > maxGrade) maxGrade = g;
    if (g > RAIL_MAX_GRADE + 1e-4) gradeViol++;
  }
  const k = 6;
  for (let i = k; i < n - k; i++) {
    const r = circumradius(P[(i - k) * 3], P[(i - k) * 3 + 2], P[i * 3], P[i * 3 + 2], P[(i + k) * 3], P[(i + k) * 3 + 2]);
    if (r < minR) minR = r;
    const ratio = r / (l.kind === "trunk" ? 300 : 200);
    if (ratio < minRatio) minRatio = ratio;
  }
}
// 道路の上を走る長さ: 線路の 20m ごとの点が、道路の中心から 半幅＋4m 以内にある（橋・トンネルの区間と、交わりの前後 40m は除く）
let onRoad = 0;
const onRoadBy: Record<string, number> = {};
for (const l of lines) {
  const n = l.points.length / 3;
  const ds = l.length / (n - 1);
  const step = Math.max(1, Math.round(20 / ds));
  for (let i = 0; i < n; i += step) {
    const s = i * ds;
    if (l.spans.some((sp) => s >= sp.from && s <= sp.to)) continue;
    // 交わり（踏切など）の前後 40m は道路を横切っているだけなので数えない
    if (l.crossings.some((c) => Math.abs(c.s - s) < 40)) continue;
    const x = l.points[i * 3] + l.origin[0];
    const z = l.points[i * 3 + 2] + l.origin[1];
    let hit = false;
    for (const r of w.roadsInRect({ x0: x - 20, z0: z - 20, x1: x + 20, z1: z + 20 })) {
      const P = r.points;
      const lim = (r.width / 2 + 4) ** 2;
      for (let j = 0; j < P.length && !hit; j += 3) {
        const dx = P[j] + r.origin[0] - x;
        const dz = P[j + 2] + r.origin[1] - z;
        if (dx * dx + dz * dz < lim) hit = true;
      }
      if (hit) break;
    }
    if (hit) {
      onRoad += step * ds;
      onRoadBy[l.name] = (onRoadBy[l.name] ?? 0) + step * ds;
    }
  }
}
const spanLen = (k: string) => sum((l) => l.spans.filter((s) => s.kind === k).reduce((a, s) => a + s.to - s.from, 0));
const open = (l: (typeof lines)[number]) => l.status === "open";
const report = {
  rectKm: (half * 2) / 1000,
  hubsInRect: hubs.size,
  originIsHub: hubs.has(ORIGIN.node),
  edges: { trunk: edges.filter((e) => e.kind === "trunk").length, branch: edges.filter((e) => e.kind === "branch").length, abandoned: edges.filter((e) => e.abandoned).length },
  lines: lines.length,
  failed: [...w.rail.failed],
  lengthKm: { trunk: km(sum((l) => l.length, (l) => l.kind === "trunk")), branchOpen: km(sum((l) => l.length, (l) => l.kind === "branch" && open(l))), abandoned: km(sum((l) => l.length, (l) => !open(l))) },
  stations: sum((l) => l.stations.length - 2) + hubs.size,
  stationKinds: Object.fromEntries(["hub", "passing", "small", "terminus"].map((k) => [k, lines.flatMap((l) => l.stations).filter((s) => s.kind === k).length])),
  crossings: { level: byKind("level"), over: byKind("over"), under: byKind("under"), unresolved: crossings.filter((c) => c.unresolved).length, per10kmOpen: Math.round((crossings.filter((c) => lines.find((l) => l.id === c.line)!.status === "open").length / Math.max(1, sum((l) => l.length, open) / 10000)) * 10) / 10 },
  onRoadM: Math.round(onRoad),
  onRoadBy: Object.fromEntries(Object.entries(onRoadBy).map(([k, v]) => [k, Math.round(v)])),
  tunnelsKm: km(spanLen("tunnel")),
  bridgesKm: km(spanLen("bridge")),
  maxGrade: Math.round(maxGrade * 10000) / 100 + "%",
  gradeViolations: gradeViol,
  minRadius: Math.round(minR),
  minRadiusRatio: Math.round(minRatio * 100) / 100,
  points: sum((l) => l.points.length / 3),
  bytes: sum((l) => l.points.byteLength),
  ms: Math.round(ms),
  lineMs: w.rail.timings.map((t) => t.ms).sort((a, b) => a - b).map(Math.round),
  names: lines.map((l) => `${l.name}(${l.kind}${l.status === "abandoned" ? "・廃線" : ""} ${km(l.length)}km 駅${l.stations.length})`),
};
console.log(JSON.stringify(report, null, 1));
