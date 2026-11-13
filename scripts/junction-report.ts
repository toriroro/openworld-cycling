// 接続点の検査: 浅い角度で重なる道路、近すぎる接続点の集まり。
// npx tsx scripts/junction-report.ts --x -32500 --z 11250 --size 40000
import { WORLD_SEED } from "../src/shared/world/constants.ts";
import { pointAt, World } from "../src/shared/world/world.ts";

const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i].replace(/^--/, ""), process.argv[i + 1]);
const seed = Number(args.get("seed") ?? WORLD_SEED);
const cx = Number(args.get("x") ?? -32500);
const cz = Number(args.get("z") ?? 11250);
const half = Number(args.get("size") ?? 40000) / 2;
const w = new World(seed);
const reg = w.region({ x0: cx - half, z0: cz - half, x1: cx + half, z1: cz + half });
const byId = new Map(reg.roads.map((r) => [r.id, r]));
const kinds = (id: string) => (id.startsWith("n_") ? "node" : id.startsWith("j_") ? "merge" : "cross");
const count: Record<string, number> = { node: 0, merge: 0, cross: 0 };
for (const j of reg.junctions) count[kinds(j.id)]++;
console.log(`道路 ${reg.roads.length}  接続点 ${reg.junctions.length}`, count, `立体交差 ${reg.crossings.filter((c) => c.separated).length}`);
// 交差の角度
let shallow = 0, sameNode = 0;
const shallowList: string[] = [];
for (const c of reg.crossings) {
  if (c.separated) continue;
  const a = byId.get(c.a)!, b = byId.get(c.b)!;
  const dir = (r: typeof a, s: number) => {
    const p = pointAt(r, Math.max(0, s - 5)), q = pointAt(r, Math.min(r.length, s + 5));
    const l = Math.hypot(q.x - p.x, q.z - p.z);
    return [(q.x - p.x) / l, (q.z - p.z) / l];
  };
  const da = dir(a, c.sa), db = dir(b, c.sb);
  const ang = Math.acos(Math.min(1, Math.abs(da[0] * db[0] + da[1] * db[1]))) * 180 / Math.PI;
  const shared = [a.start, a.end].some((n) => n === b.start || n === b.end);
  if (ang < 30) {
    shallow++;
    if (shared) sameNode++;
    shallowList.push(`${c.id} ${ang.toFixed(0)}° 共有結節点=${shared}`);
  }
}
console.log(`平面交差 ${reg.crossings.filter((c) => !c.separated).length} のうち 30°未満 ${shallow}（端の結節点を共有 ${sameNode}）`);
console.log(shallowList.slice(0, 20).join("\n"));
// 近すぎる接続点（40m 以内に別の接続点）
let close = 0;
for (let i = 0; i < reg.junctions.length; i++)
  for (let k = i + 1; k < reg.junctions.length; k++) {
    const p = reg.junctions[i], q = reg.junctions[k];
    if (Math.hypot(p.x - q.x, p.z - q.z) < 40) close++;
  }
console.log(`40m 以内の接続点の組 ${close}`);
// 結節点から出る道路どうしの角度（20°未満の組）
let narrow = 0;
for (const j of reg.junctions) {
  const dirs = j.arms.map((a) => {
    const r = byId.get(a.road)!;
    const p = pointAt(r, a.s), q = pointAt(r, Math.max(0, Math.min(r.length, a.s + a.dir * 30)));
    const l = Math.hypot(q.x - p.x, q.z - p.z);
    return [(q.x - p.x) / l, (q.z - p.z) / l];
  });
  for (let a = 0; a < dirs.length; a++)
    for (let b = a + 1; b < dirs.length; b++) if (dirs[a][0] * dirs[b][0] + dirs[a][1] * dirs[b][1] > Math.cos((20 * Math.PI) / 180)) narrow++;
}
console.log(`腕どうしが 20° 未満の組 ${narrow}`);
if (args.get("list") === "1")
  for (const j of reg.junctions) {
    const arms = j.arms.map((a) => {
      const r = byId.get(a.road)!;
      const p = pointAt(r, a.s), q = pointAt(r, Math.max(0, Math.min(r.length, a.s + a.dir * 30)));
      const l = Math.hypot(q.x - p.x, q.z - p.z);
      return { a, d: [(q.x - p.x) / l, (q.z - p.z) / l] };
    });
    for (let a = 0; a < arms.length; a++)
      for (let b = a + 1; b < arms.length; b++) {
        const dot = arms[a].d[0] * arms[b].d[0] + arms[a].d[1] * arms[b].d[1];
        if (dot > Math.cos((20 * Math.PI) / 180))
          console.log(j.id, `${(Math.acos(Math.min(1, dot)) * 180 / Math.PI).toFixed(0)}°`, arms[a].a.road, arms[a].a.dir, arms[b].a.road, arms[b].a.dir, Math.round(j.x), Math.round(j.z));
      }
  }
