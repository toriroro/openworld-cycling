// R1 の 3D 画面写真の地点: 大きな川の橋、堤防の上の自転車道、河口で終わる自転車道、起点の近くの小さな川の橋。
// npx tsx scripts/r1-scenes.ts  → artifacts/r1/scenes.json（scripts/r1-shots.mjs が読む）
import { mkdirSync, writeFileSync } from "node:fs";
import { ORIGIN, WORLD_SEED } from "../src/shared/world/constants.ts";
import { pointAt, World } from "../src/shared/world/world.ts";

const w = new World(WORLD_SEED);
type V3 = { x: number; y: number; z: number };
const scenes: Record<string, { road: string; s: number; dir: 1 | -1; x: number; z: number; note: string; eye?: V3; target?: V3 }> = {};
/** 橋の中央を、川に沿って横（道路に直角）へ off m・高さ up m の所から見る */
const sideView = (key: string, roadId: string, sMid: number, off: number, up: number) => {
  const r = all.get(roadId)!;
  const p = pointAt(r, sMid);
  const q = pointAt(r, Math.min(r.length, sMid + 5));
  const tx = q.x - p.x;
  const tz = q.z - p.z;
  const l = Math.hypot(tx, tz) || 1;
  scenes[key].eye = { x: p.x - (tz / l) * off, y: p.y + up, z: p.z + (tx / l) * off };
  scenes[key].target = { x: p.x, y: p.y - 4, z: p.z };
};
const at = (key: string, road: { id: string }, s: number, dir: 1 | -1, note: string, r = w.roadsInRect({ x0: 0, z0: 0, x1: 0, z1: 0 })) => {
  void r;
  const rr = all.get(road.id)!;
  const p = pointAt(rr, s);
  scenes[key] = { road: road.id, s, dir, x: p.x, z: p.z, note };
};
const all = new Map<string, ReturnType<World["roadsInRect"]>[number]>();
/** 橋の区間に川の水面の上の点があれば、その点の道のり */
const overRiver = (r: ReturnType<World["roadsInRect"]>[number], from: number, to: number): number | null => {
  for (let s = from; s <= to; s += 4) {
    const p = pointAt(r, s);
    if (w.terrain.sample(p.x, p.z, false).water === 3) return s;
  }
  return null;
};
// 大きな川（菱畑川）の下流
const big = w.roadsInRect({ x0: -68000, z0: 42500, x1: -52000, z1: 58500 });
for (const r of big) all.set(r.id, r);
// 川の水面を渡る最も長い橋
let best: { road: (typeof big)[number]; from: number; to: number; sw: number } | null = null;
for (const r of big) {
  if (r.kind === "cycleway") continue;
  for (const sp of r.spans) {
    const sw = overRiver(r, sp.from, sp.to);
    if (sw === null) continue;
    if (!best || sp.to - sp.from > best.to - best.from) best = { road: r, from: sp.from, to: sp.to, sw };
  }
}
if (best) {
  at("bigBridge", best.road, Math.max(5, best.from - 120), 1, `大きな川の橋 ${(best.to - best.from).toFixed(0)}m を川の上から見る`);
  sideView("bigBridge", best.road.id, best.sw, 260, 40);
}
const cy = big.filter((r) => r.kind === "cycleway").sort((a, b) => b.length - a.length);
if (cy[0]) at("cycleway", cy[0], Math.min(1500, cy[0].length / 2), 1, `${cy[0].name} ${(cy[0].length / 1000).toFixed(1)}km`);
const mouth = cy.find((r) => r.id.endsWith("~mouth"));
if (mouth) {
  at("mouth", mouth, Math.max(5, mouth.length - 400), 1, `${mouth.name}（河口で終わる） 終点の 400m 手前`);
  const p = pointAt(mouth, Math.max(5, mouth.length - 700));
  const e = pointAt(mouth, mouth.length);
  scenes.mouth.eye = { x: p.x, y: p.y + 30, z: p.z };
  scenes.mouth.target = { x: e.x + (e.x - p.x) * 0.6, y: 0, z: e.z + (e.z - p.z) * 0.6 };
}
// 起点の近く（8km 以内）で川の水面を渡る橋
const near = w.roadsInRect({ x0: ORIGIN.x - 8000, z0: ORIGIN.z - 8000, x1: ORIGIN.x + 8000, z1: ORIGIN.z + 8000 });
for (const r of near) all.set(r.id, r);
let nb: { road: (typeof near)[number]; from: number; d: number; sw: number } | null = null;
for (const r of near) {
  for (const sp of r.spans) {
    const sw = overRiver(r, sp.from, sp.to);
    if (sw === null) continue;
    const mid = pointAt(r, sw);
    const d = Math.hypot(mid.x - ORIGIN.x, mid.z - ORIGIN.z);
    if (!nb || d < nb.d) nb = { road: r, from: sp.from, d, sw };
  }
}
if (nb) {
  const sp = nb.road.spans.find((x) => x.from === nb!.from)!;
  at("originBridge", nb.road, Math.max(5, nb.from - 80), 1, `起点から ${(nb.d / 1000).toFixed(1)}km の川の橋 ${(sp.to - sp.from).toFixed(0)}m を川の上から見る`);
  sideView("originBridge", nb.road.id, nb.sw, 120, 25);
}
mkdirSync("artifacts/r1", { recursive: true });
writeFileSync("artifacts/r1/scenes.json", JSON.stringify(scenes, null, 2));
console.log(JSON.stringify(scenes, null, 2));
