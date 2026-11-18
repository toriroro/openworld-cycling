// 北海道: 3D で走る確認（北海道の草案 7 章 H1・H2）。起点・いくつかの場所の画面写真、路面への地形の突き抜け、自動走行、喫茶店。
// 開発サーバーが動いている前提（MAP_BASE、既定 5180）。先に npx tsx scripts/hokkaido/build.ts で変換データを作る。
// node scripts/hokkaido-ride-shots.mjs。SET=h2 で札幌圏の場所（定山渓・小樽・石狩の海岸・江別・H0 の縁）。
// 結果は OUT（既定 artifacts/hokkaido/h1、SET=h2 なら artifacts/hokkaido/h2/ride）。ONLY=名前,名前 で場所を絞る。SKIP_RIDE=1 で自動走行・喫茶店・起動画面を省く。

import { chromium } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";

const base = process.env.MAP_BASE || "http://localhost:5180";
const SET = process.env.SET || "h1";
const out = process.env.OUT || (SET === "h2" ? "artifacts/hokkaido/h2/ride" : "artifacts/hokkaido/h1");
mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || "chrome", headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
const t0 = Date.now();
await page.goto(`${base}/?world=hokkaido&fresh=1&notitle=1&time=10&weather=clear`);
const settle = () => page.waitForFunction(() => window.__dev?.state().ready && window.__dev.state().settled, null, { timeout: 240000, polling: 250 });
await settle();
const loadSec = (Date.now() - t0) / 1000;
const result = { loadSec, places: {}, ride: null, cafe: null, errors };

const snap = async (name) => {
  await page.waitForTimeout(800);
  await page.screenshot({ path: `${out}/${name}.png` });
};
const info = () => page.evaluate(() => ({ r: window.__dev.rideInfo(), s: window.__dev.view.stats(), world: window.__dev.view.world.id }));

// 場所ごと: 飛んで、落ち着いたら追う視点・上からの視点、突き抜けの検査
const H2_PLACES = [
  ["start-odori", 240, 40],
  // H0 の縁（5m から 10B へ移る所）
  ["h0-edge-east", 10330, -2000],
  ["ishikari-coast", -2805, -12365],
  ["ebetsu", 15166, -4861],
  ["otaru", -28960, -15382],
  // 国道 230 号の八剣山トンネル（736m）
  ["hakkenzan-tunnel", -8822, 10850],
  ["jozankei", -15093, 10137],
  // 小樽定山渓線のトンネル（1.5km）
  ["otaru-jozankei-tunnel", -17022, 5257],
  ["nakayama-toge", -20556, 22888],
  // 川・湖の水面（豊平川の河川敷、豊平峡ダムの湖）
  ["toyohira-river", 420, 3870],
  ["hoheikyo-lake", -19341, 15215],
  // 市街地の外の山道・林道（北海道の草案 22 章）
  ["farm-road", 9752, -11952],
  ["kannonzawa-rindo", -7432, 9339],
  ["mayoisawa-rindo", -16484, 2094],
];
const ALL = SET === "h2" ? H2_PLACES : [
  ["start-odori", 240, 40],
  ["sosei", 300, -2600],
  ["toyohira-cr", 420, 3870],
  ["moiwa", -2300, 4200],
  ["tunnel", -3729, 5181],
  // 小林峠の下の長いトンネル（1.6km）の中ほど。H2 まで切り通しとして描く
  ["tunnel-mid", -4261, 4342],
  ["teine-side", -8400, -3800],
];
const only = process.env.ONLY ? new Set(process.env.ONLY.split(",")) : null;
const places = only ? ALL.filter(([n]) => only.has(n)) : ALL;
for (const [name, x, z] of places) {
  await page.evaluate(({ x, z }) => window.__dev.teleport(x, z), { x, z });
  await page.waitForFunction(() => window.__dev.state().ready, null, { timeout: 120000, polling: 250 });
  await settle();
  await page.evaluate(() => (window.__dev.game.camera = "chase"));
  await snap(`${name}-chase`);
  const i = await info();
  const ray = await page.evaluate(() => {
    const r = window.__dev.rayCheck(400);
    return { rays: r.rays, poke: r.poke, missed: r.missed, worst: r.worst };
  });
  // 上から（止めて視点を外から決める）
  await page.evaluate(() => {
    const d = window.__dev;
    d.setPaused(true);
    const v = d.view;
    if (!v._f) {
      v._f = v.frame.bind(v);
      v.frame = (e, t, f, cb) => (v._cam ? v._f(v._cam.e, v._cam.t, v._cam.fov ?? 45, cb) : v._f(e, t, f, cb));
    }
  });
  await page.evaluate((r) => (window.__dev.view._cam = { e: { x: r.x - 160, y: r.y + 120, z: r.z + 160 }, t: { x: r.x, y: r.y, z: r.z }, fov: 50 }), i.r);
  await snap(`${name}-above`);
  await page.evaluate(() => {
    window.__dev.view._cam = null;
    window.__dev.setPaused(false);
  });
  result.places[name] = { pos: { x: Math.round(i.r.x), y: Math.round(i.r.y), z: Math.round(i.r.z) }, landscape: i.r.landscape, triangles: i.s.triangles, calls: i.s.calls, ray };
}

if (process.env.SKIP_RIDE) {
  writeFileSync(`${out}/results.json`, JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
  await browser.close();
  process.exit(0);
}
// 起点に戻って、自動で 60 秒（時間 4 倍）走る
await page.evaluate(() => window.__dev.teleport(240, 40));
await page.waitForFunction(() => window.__dev.state().ready, null, { timeout: 120000, polling: 250 });
await settle();
const before = await page.evaluate(() => window.__dev.rideInfo().odometer);
await page.evaluate(() => {
  window.__dev.game.setWatching(true);
  window.__dev.setTimeScale(4);
  window.__dev.frames(true);
});
await page.waitForTimeout(60000);
const after = await page.evaluate(() => {
  const d = window.__dev;
  d.setTimeScale(1);
  const f = d.frames(true).sort((a, b) => a - b);
  return { odometer: d.rideInfo().odometer, p95: f[Math.floor(f.length * 0.95)] ?? null, frames: f.length };
});
await page.evaluate(() => (window.__dev.game.camera = "chase"));
await snap("watch-after-60s");
result.ride = { meters: Math.round(after.odometer - before), frameP95ms: after.p95, frames: after.frames };
await page.evaluate(() => window.__dev.game.setWatching(false));

// 喫茶店: 一番近い店の前へ飛んで、上から
const cafes = await page.evaluate(() => window.__dev.cafes(6000));
if (cafes.length) {
  const c = cafes.sort((a, b) => a.d - b.d)[0];
  await page.evaluate((c) => window.__dev.teleport(c.x, c.z), c);
  await page.waitForFunction(() => window.__dev.state().ready, null, { timeout: 120000, polling: 250 });
  await settle();
  await page.evaluate(() => {
    const d = window.__dev;
    d.setPaused(true);
    const v = d.view;
    if (!v._f) {
      v._f = v.frame.bind(v);
      v.frame = (e, t, f, cb) => (v._cam ? v._f(v._cam.e, v._cam.t, v._cam.fov ?? 45, cb) : v._f(e, t, f, cb));
    }
  });
  const y = await page.evaluate((c) => window.__dev.view.heights.height(c.x, c.z), c);
  await page.evaluate(({ c, y }) => (window.__dev.view._cam = { e: { x: c.x + 30, y: y + 18, z: c.z + 30 }, t: { x: c.x, y: y + 2, z: c.z }, fov: 50 }), { c, y });
  await snap("cafe");
  result.cafe = { name: c.name, nearCount: cafes.length };
}

// 起動画面（世界の選択と出典）
await page.goto(`${base}/?world=hokkaido&title=1`);
await page.waitForSelector(".title-screen:not(.hidden)", { timeout: 120000 }).catch(() => {});
await page.waitForTimeout(1500);
await page.screenshot({ path: `${out}/title.png` });

writeFileSync(`${out}/results.json`, JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
await browser.close();
