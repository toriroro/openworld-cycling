// 配達の範囲の建物（PLATEAU から作った物。配達の草案 20 章）の画面写真。作り直す前後で同じ場所・同じ向きを撮って並べる。
// 開発サーバーが動いている前提（MAP_BASE、既定 5180）。OUT で出力先（既定 artifacts/plateau/shots）。
// node scripts/plateau-shots.mjs

import { chromium } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";

const base = process.env.MAP_BASE || "http://localhost:5180";
const out = process.env.OUT || "artifacts/plateau/shots";
mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || "chrome", headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e.stack || e)));
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
await page.goto(`${base}/?world=hokkaido&fresh=1&notitle=1&time=10&weather=clear`);
const settle = () => page.waitForFunction(() => window.__dev?.state().ready && window.__dev.state().settled, null, { timeout: 240000, polling: 250 });
await settle();
const result = { places: {}, errors };
await page.evaluate(() => {
  const v = window.__dev.view;
  v._f = v.frame.bind(v);
  v.frame = (e, t, f, cb) => (v._cam ? v._f(v._cam.e, v._cam.t, v._cam.fov ?? 45, cb) : v._f(e, t, f, cb));
});
// 大通・札幌駅前・すすきの・西の住宅街・東の住宅街・範囲の東の端（PLATEAU と OSM の境）
const places = [
  ["odori", 240, 40],
  ["ekimae", 80, -700],
  ["susukino", 150, 900],
  ["west", -1600, 1200],
  ["east", 1400, 1500],
  ["edge", 1900, -300],
];
for (const [name, x, z] of places) {
  await page.evaluate(({ x, z }) => window.__dev.teleport(x, z), { x, z });
  await page.waitForFunction(() => window.__dev.state().ready, null, { timeout: 120000, polling: 250 });
  await settle();
  await page.evaluate(() => (window.__dev.game.camera = "chase"));
  await page.waitForTimeout(1000);
  await page.screenshot({ path: `${out}/${name}-chase.png` });
  const r = await page.evaluate(() => window.__dev.rideInfo());
  await page.evaluate(() => window.__dev.setPaused(true));
  // 固定の向き（走る向きによらない）で上から
  await page.evaluate((r) => (window.__dev.view._cam = { e: { x: r.x - 160, y: r.y + 110, z: r.z + 160 }, t: { x: r.x, y: r.y + 5, z: r.z }, fov: 50 }), r);
  await page.waitForTimeout(1000);
  await page.screenshot({ path: `${out}/${name}-above.png` });
  await page.evaluate((r) => (window.__dev.view._cam = { e: { x: r.x - 700, y: r.y + 420, z: r.z + 700 }, t: { x: r.x, y: r.y, z: r.z }, fov: 50 }), r);
  await page.waitForTimeout(1200);
  await page.screenshot({ path: `${out}/${name}-far.png` });
  const s = await page.evaluate(() => window.__dev.view.stats());
  await page.evaluate(() => {
    window.__dev.view._cam = null;
    window.__dev.setPaused(false);
  });
  result.places[name] = { pos: { x: Math.round(r.x), z: Math.round(r.z) }, triangles: s.triangles, calls: s.calls, real: s.realBuildings };
}
writeFileSync(`${out}/results.json`, JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 1));
await browser.close();
