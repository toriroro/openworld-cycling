// M3 の完了条件「起点から3つの景観を自分の操作で走れる」の確認。
// 手動の入力元で Space を押し続け（出力は既定の 180W）、行き先を指定して分岐は経路に沿って選ぶ。時間は速める。
// node scripts/m3-ride.mjs [時間の倍率]   （開発サーバー 5180 が動いている前提）。結果は artifacts/m3/ride/。

import { chromium } from "@playwright/test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

const scale = Number(process.argv[2] ?? 30);
const base = process.env.MAP_BASE || "http://localhost:5180";
const scenes = JSON.parse(readFileSync("artifacts/m2/scenes.json", "utf8"));
const out = "artifacts/m3/ride";
mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
await page.goto(`${base}/`);
await page.waitForFunction(() => window.__dev?.state().ready && window.__dev.state().settled, null, { timeout: 180000, polling: 250 });
await page.screenshot({ path: `${out}/0-start.png` });
await page.keyboard.down("Space");
const legs = [];
for (const kind of ["coast", "plain", "mountain"]) {
  const s = scenes[kind];
  const t0 = Date.now();
  const ok = await page.evaluate(([x, z]) => window.__dev.setGoal(x, z), [s.x, s.z]);
  await page.evaluate((k) => window.__dev.setTimeScale(k), scale);
  await page.waitForFunction(() => window.__dev.rideInfo()?.goalReached, null, { timeout: 1800000, polling: 500 });
  await page.evaluate(() => window.__dev.setTimeScale(1));
  // 着いたら止まって画面がそろうのを待つ
  await page.keyboard.up("Space");
  await page.keyboard.down("Shift");
  await page.waitForFunction(() => window.__dev.state().speed < 0.1 && window.__dev.state().settled, null, { timeout: 180000, polling: 250 });
  await page.waitForTimeout(1500);
  const info = await page.evaluate(() => window.__dev.rideInfo());
  await page.screenshot({ path: `${out}/${legs.length + 1}-${kind}.png` });
  legs.push({ kind, planned: ok, seconds: (Date.now() - t0) / 1000, ...info });
  console.log(`${kind}: 距離 ${(info.odometer / 1000).toFixed(1)}km 獲得標高 ${info.climb.toFixed(0)}m 走行時間 ${(info.time / 60).toFixed(0)}分 標高 ${info.y.toFixed(0)}m 景観 海岸 ${info.landscape.coast.toFixed(2)} 平野 ${info.landscape.plain.toFixed(2)} 山岳 ${info.landscape.mountain.toFixed(2)}`);
  await page.keyboard.up("Shift");
  await page.keyboard.down("Space");
}
writeFileSync(`${out}/results.json`, JSON.stringify({ date: new Date().toISOString(), timeScale: scale, power: 180, legs, errors }, null, 2));
console.log("エラー", errors.length ? errors : "なし");
await browser.close();
