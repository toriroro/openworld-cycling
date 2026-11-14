// 街区の見た目の画面写真（起点 葛郷: 上から、幹線の通り、路地の入口、区画道路）。開発サーバーが動いている前提（MAP_BASE で指定、既定は 5180）。
// 結果は artifacts/district/。node scripts/district-shots.mjs [名前の一部で絞る]
// ほかの町を上から見る時: AT=x,z（町の結節点の世界座標）を付ける。写真の名前は at-<x>_<z>-…

import { chromium } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";

const base = process.env.MAP_BASE || "http://localhost:5180";
const only = process.argv[2];
const out = "artifacts/district";
mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
const at = process.env.AT ? process.env.AT.split(",").map(Number) : null;
await page.goto(`${base}/?fresh=1&notitle=1${at ? `&x=${at[0]}&z=${at[1]}` : ""}`);
await page.waitForFunction(() => window.__dev?.state().ready && window.__dev.state().settled, null, { timeout: 180000, polling: 250 });
await page.evaluate(() => {
  const d = window.__dev;
  d.setPaused(true);
  const v = d.view;
  v._f = v.frame.bind(v);
  v.frame = (e, t, f, cb) => (v._cam ? v._f(v._cam.e, v._cam.t, v._cam.fov ?? 50, cb) : v._f(e, t, f, cb));
  document.querySelector(".hud-root")?.classList.add("hidden");
});
const stats = {};
const shot = async (name, setup) => {
  if (only && !name.includes(only)) return;
  await page.evaluate(setup);
  await page.waitForTimeout(800);
  await page.waitForFunction(() => window.__dev.state().settled, null, { timeout: 120000, polling: 250 });
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${out}/${name}.png` });
  const s = await page.evaluate(() => window.__dev.view.stats());
  stats[name] = { triangles: s.triangles, calls: s.calls };
};
// 結節点からの相対で視点と見る先を置く
const rel = (e, t, fov = 50) => `(() => {
  const d = window.__dev;
  const at = ${JSON.stringify(at)};
  const n = at ? [...d.roads.net.nodes.values()].filter((q) => q.kind === "town").sort((p, q) => Math.hypot(p.x - at[0], p.z - at[1]) - Math.hypot(q.x - at[0], q.z - at[1]))[0] : d.roads.net.nodes.get("n_-9_2");
  d.view._cam = { e: { x: n.x + ${e[0]}, y: n.y + ${e[1]}, z: n.z + ${e[2]} }, t: { x: n.x + ${t[0]}, y: n.y + ${t[1]}, z: n.z + ${t[2]} }, fov: ${fov} };
})()`;
// 道路に沿った視点（道路 id、視点の道のり、見る先の道のり、横へのずれ、高さ）
const along = (id, s0, s1, side, h, fov = 60) => `(() => {
  const d = window.__dev;
  const r = d.roads.net.roads.get(${JSON.stringify(id)});
  const P = r.points, ds = r.length / (P.length / 3 - 1);
  const pt = (s) => { const i = Math.max(0, Math.min(P.length / 3 - 1, Math.floor(s / ds))); return { x: P[i * 3] + r.origin[0], y: P[i * 3 + 1], z: P[i * 3 + 2] + r.origin[1] }; };
  const a = pt(${s0}), b = pt(${s1});
  const dx = b.x - a.x, dz = b.z - a.z, l = Math.hypot(dx, dz);
  d.view._cam = { e: { x: a.x - dz / l * ${side}, y: a.y + ${h}, z: a.z + dx / l * ${side} }, t: { x: b.x, y: b.y + ${h} * 0.8, z: b.z }, fov: ${fov} };
})()`;
if (at) {
  const tag = `at-${Math.round(at[0])}_${Math.round(at[1])}`;
  await shot(`${tag}-above`, rel([-160, 260, 340], [0, 0, 0]));
  await shot(`${tag}-close`, rel([60, 70, 130], [10, 0, 0]));
  await shot(`${tag}-low`, rel([-200, 25, 60], [0, 5, 0]));
  console.log(JSON.stringify({ shots: stats, errors }));
  await browser.close();
  process.exit(0);
}
await shot("above", rel([-160, 260, 340], [0, 0, 0]));
await shot("above-close", rel([60, 90, 150], [20, 0, 10]));
await shot("main-1", along("n_-9_2~n_-8_2", 150, 40, -1.5, 1.6));
await shot("main-2", along("n_-9_2~n_-9_3", 30, 160, -1.5, 1.6));
await shot("main-3", along("n_-9_1~n_-9_2", 5100, 5230, -1.5, 1.6));
await shot("alley", along("n_-9_2~n_-8_2", 96, 110, -1.5, 1.6, 75));
await shot("enter", along("n_-9_2~n_-9_3", 420, 300, -1.5, 1.6));
await shot("junction", rel([26, 11, 30], [0, 0, 0], 60));
await shot("corner", along("n_-9_2~n_-9_3", 78, 100, -9, 5, 70));
await shot("backstreet", rel([70, 3.2, 52], [-60, 0, 50], 65));
const ray = only ? null : await page.evaluate(() => { window.__dev.view._cam = null; return window.__dev.rayCheck(600); });
const s = await page.evaluate(() => window.__dev.view.stats());
writeFileSync(`${out}/results.json`, JSON.stringify({ date: new Date().toISOString(), districts: s.districts, buildings: s.buildings, shots: stats, ray, errors }, null, 2));
console.log(JSON.stringify({ districts: s.districts, buildings: s.buildings, shots: stats, ray, errors }));
await browser.close();
