// 建物の見た目の画面写真（起点 葛郷 の町並み、上から、喫茶店）。開発サーバー 5180 が動いている前提。結果は artifacts/buildings/。

import { chromium } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";

const base = process.env.MAP_BASE || "http://localhost:5180";
const out = "artifacts/buildings";
mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
await page.goto(`${base}/?fresh=1`);
await page.waitForFunction(() => window.__dev?.state().ready && window.__dev.state().settled, null, { timeout: 180000, polling: 250 });
await page.evaluate(() => {
  const d = window.__dev;
  d.setPaused(true);
  const v = d.view;
  v._f = v.frame.bind(v);
  v.frame = (e, t, f, cb) => (v._cam ? v._f(v._cam.e, v._cam.t, 50, cb) : v._f(e, t, f, cb));
  document.querySelector(".hud-root")?.classList.add("hidden");
});
const shot = async (name, setup) => {
  await page.evaluate(setup);
  await page.waitForTimeout(800);
  await page.waitForFunction(() => window.__dev.state().settled, null, { timeout: 120000, polling: 250 });
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${out}/${name}.png` });
};
// 道路に沿った視点（道路 id、視点の道のり、見る先の道のり、横へのずれ、高さ）
const along = (id, s0, s1, side, h) => `(() => {
  const d = window.__dev;
  const r = d.roads.net.roads.get(${JSON.stringify(id)});
  const P = r.points, ds = r.length / (P.length / 3 - 1);
  const pt = (s) => { const i = Math.max(0, Math.min(P.length / 3 - 1, Math.floor(s / ds))); return { x: P[i * 3] + r.origin[0], y: P[i * 3 + 1], z: P[i * 3 + 2] + r.origin[1] }; };
  const a = pt(${s0}), b = pt(${s1});
  const dx = b.x - a.x, dz = b.z - a.z, l = Math.hypot(dx, dz);
  d.view._cam = { e: { x: a.x - dz / l * ${side}, y: a.y + ${h}, z: a.z + dx / l * ${side} }, t: { x: b.x, y: b.y + ${h}, z: b.z } };
})()`;
await shot("street-1", along("n_-9_2~n_-9_3", 360, 250, 2, 2.5));
await shot("street-2", along("n_-9_2~n_-8_2", 60, 200, -1.5, 1.8));
await shot("street-3", along("n_-9_1~n_-9_2", 5400, 5250, 2, 2.2));
await shot("town-above", `(() => { const d = window.__dev; const n = d.roads.net.nodes.get("n_-9_2"); d.view._cam = { e: { x: n.x - 120, y: n.y + 140, z: n.z - 200 }, t: { x: n.x, y: n.y, z: n.z } }; })()`);
const stats = await page.evaluate(() => window.__dev.view.stats());
writeFileSync(`${out}/results.json`, JSON.stringify({ date: new Date().toISOString(), buildings: stats.buildings, triangles: stats.triangles, calls: stats.calls, errors }, null, 2));
console.log(JSON.stringify({ buildings: stats.buildings, errors }));
await browser.close();
