// 配達 D2 の人と車の密度の確認（配達の草案 16.4）: 札幌の中心を走りながら、標準・軽量の画質で
// 車の台数・歩く人の数・フレーム間隔を測り、画面を撮る。縦画面のペースと脚・体力の棒も撮る。
// 開発サーバーが動いている前提（MAP_BASE、既定 5180）。node scripts/delivery-d2-crowd.mjs。結果は artifacts/delivery/d2-crowd。

import { chromium } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";

const base = process.env.MAP_BASE || "http://localhost:5180";
const out = process.env.OUT || "artifacts/delivery/d2-crowd";
mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || "chrome", headless: true });
const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
const g = (fn, arg) => page.evaluate(fn, arg);
const result = { errors };

await page.goto(`${base}/?world=hokkaido&fresh=1&notitle=1&time=11&weather=clear`);
await page.waitForFunction(() => window.__dev?.state().ready && window.__dev.state().settled && window.__dev.game.streetWork && window.__dev.game.ride?.road, null, { timeout: 240000, polling: 250 });
await g(() => {
  const gm = window.__dev.game;
  gm.appOn = false;
  // 大通の西の方へ（幹線と住宅街の道を通る）
  const p = gm.addresses.byName.get("北1条西12丁目");
  gm.ride.setGoal(p.x, p.z);
  gm.setPace(2);
});

async function measure(name, seconds) {
  await g(() => (window.__dev.game.frameDt.length = 0));
  const counts = [];
  for (let i = 0; i < seconds; i++) {
    await page.waitForTimeout(1000);
    counts.push(await g(() => ({ cars: window.__dev.game.traffic.vehicles.length, walkers: window.__dev.game.view.pedestrians.stats.walkers, speed: window.__dev.game.ride.speed })));
    if (i === Math.floor(seconds / 2)) await page.screenshot({ path: `${out}/${name}.png` });
  }
  const f = await g(() => [...window.__dev.game.frameDt].sort((a, b) => a - b));
  const avg = (k) => Math.round(counts.reduce((s, c) => s + c[k], 0) / counts.length);
  return { cars: avg("cars"), maxCars: Math.max(...counts.map((c) => c.cars)), walkers: avg("walkers"), frames: f.length, p50: f[Math.floor(f.length * 0.5)], p95: f[Math.floor(f.length * 0.95)], p99: f[Math.floor(f.length * 0.99)] };
}

result.standard = await measure("1-standard", 30);
await g(() => window.__dev.game.applySettings({ quality: "light" }, false));
result.light = await measure("2-light", 20);
await g(() => window.__dev.game.applySettings({ quality: "standard" }, false));
await page.setViewportSize({ width: 390, height: 844 });
await page.waitForTimeout(2000);
await page.screenshot({ path: `${out}/3-portrait.png` });
writeFileSync(`${out}/result.json`, JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
await browser.close();
