// 北海道の世界の建物（OSM の外形。北海道の草案 15 章）の画面写真と描画量。
// 開発サーバーが動いている前提（MAP_BASE、既定 5180）。先に extract-buildings.ts と build-h0.ts を実行する。
// node scripts/hokkaido-buildings-shots.mjs。QUALITY=light で軽量画質。結果は artifacts/hokkaido/buildings/。

import { chromium } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";

const base = process.env.MAP_BASE || "http://localhost:5180";
const quality = process.env.QUALITY || "standard";
const suffix = quality === "light" ? "-light" : "";
const out = "artifacts/hokkaido/buildings";
mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || "chrome", headless: true });
const vp = quality === "light" ? { width: 844, height: 390 } : { width: 1440, height: 900 };
const page = await browser.newPage({ viewport: vp });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e.stack || e)));
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
await page.goto(`${base}/?world=hokkaido&fresh=1&notitle=1&time=10&weather=clear&quality=${quality}`);
const settle = () => page.waitForFunction(() => window.__dev?.state().ready && window.__dev.state().settled, null, { timeout: 240000, polling: 250 });
await settle();
const result = { quality, places: {}, ride: null, errors };
const stat = () =>
  page.evaluate(() => {
    const s = window.__dev.view.stats();
    const ms = window.__dev.view.realBuildings.buildMs.slice().sort((a, b) => a - b);
    return { triangles: s.triangles, calls: s.calls, real: s.realBuildings, buildMsP95: ms[Math.floor(ms.length * 0.95)] ?? null, buildMsMax: ms[ms.length - 1] ?? null };
  });
const hook = () =>
  page.evaluate(() => {
    const v = window.__dev.view;
    if (!v._f) {
      v._f = v.frame.bind(v);
      v.frame = (e, t, f, cb) => (v._cam ? v._f(v._cam.e, v._cam.t, v._cam.fov ?? 45, cb) : v._f(e, t, f, cb));
    }
  });
const places = [
  ["odori", 240, 40],
  ["ekimae", 80, -700],
  ["susukino", 150, 900],
  ["maruyama", -2600, 300],
  ["toyohira", 2600, 2800],
  ["kotoni", -4300, -2300],
];
for (const [name, x, z] of places) {
  await page.evaluate(({ x, z }) => window.__dev.teleport(x, z), { x, z });
  await page.waitForFunction(() => window.__dev.state().ready, null, { timeout: 120000, polling: 250 });
  await settle();
  await page.evaluate(() => (window.__dev.game.camera = "chase"));
  await page.waitForTimeout(800);
  await page.screenshot({ path: `${out}/${name}-chase${suffix}.png` });
  const s = await stat();
  await hook();
  const r = await page.evaluate(() => window.__dev.rideInfo());
  await page.evaluate(() => window.__dev.setPaused(true));
  await page.evaluate((r) => (window.__dev.view._cam = { e: { x: r.x - 140, y: r.y + 90, z: r.z + 140 }, t: { x: r.x, y: r.y + 5, z: r.z }, fov: 50 }), r);
  await page.waitForTimeout(800);
  await page.screenshot({ path: `${out}/${name}-above${suffix}.png` });
  await page.evaluate((r) => (window.__dev.view._cam = { e: { x: r.x - 700, y: r.y + 420, z: r.z + 700 }, t: { x: r.x, y: r.y, z: r.z }, fov: 50 }), r);
  await page.waitForTimeout(800);
  await page.screenshot({ path: `${out}/${name}-far${suffix}.png` });
  await page.evaluate(() => {
    window.__dev.view._cam = null;
    window.__dev.setPaused(false);
  });
  result.places[name] = { pos: { x: Math.round(r.x), z: Math.round(r.z) }, ...s };
}
// 大通から自動で 60 秒（時間 4 倍）。フレーム間隔と建物を作る時間
await page.evaluate(() => window.__dev.teleport(240, 40));
await page.waitForFunction(() => window.__dev.state().ready, null, { timeout: 120000, polling: 250 });
await settle();
await page.evaluate(() => {
  const d = window.__dev;
  d.view.realBuildings.buildMs.length = 0;
  d.game.setWatching(true);
  d.setTimeScale(4);
  d.frames(true);
});
await page.waitForTimeout(60000);
result.ride = await page.evaluate(() => {
  const d = window.__dev;
  d.setTimeScale(1);
  const f = d.frames(true).sort((a, b) => a - b);
  const ms = d.view.realBuildings.buildMs.slice().sort((a, b) => a - b);
  return { frames: f.length, frameP50: f[Math.floor(f.length * 0.5)], frameP95: f[Math.floor(f.length * 0.95)], frameMax: f[f.length - 1], buildMsP95: ms[Math.floor(ms.length * 0.95)] ?? null, buildMsMax: ms[ms.length - 1] ?? null, heapMB: d.view.stats().heapMB };
});
writeFileSync(`${out}/results${suffix}.json`, JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 1));
await browser.close();
