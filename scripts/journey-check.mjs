// 閉じている間の旅 A2 の確認（冒険の草案 4.2・7 章）: 冒険で旅に出て保存し、「1 時間・4 時間閉じていた」ことにして読み込み直す。
// 計算の時間（開いてから旅の記録が出るまで）、進んだ距離、通った町・喫茶店・名所、旅の記録の画面写真を残す。
// 開発サーバーが動いている前提（MAP_BASE、既定 5180）。node scripts/journey-check.mjs。結果は artifacts/adventure/a2。
// HOURS=1,4 で閉じていた時間。冒険の残りは 200km にする（4 時間でも尽きないように）。

import { chromium } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";

const base = process.env.MAP_BASE || "http://localhost:5180";
const out = process.env.OUT || "artifacts/adventure/a2";
const HOURS = (process.env.HOURS || "1,4").split(",").map(Number);
mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || "chrome", headless: true });

const WORLDS = [
  { id: "generated", query: "" },
  { id: "hokkaido", query: "&world=hokkaido" },
].filter((w) => !process.env.ONLY || w.id === process.env.ONLY);

const result = {};
for (const w of WORLDS) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  const settle = () => page.waitForFunction(() => window.__dev?.state().ready && window.__dev.state().settled, null, { timeout: 240000, polling: 250 });
  const info = () => page.evaluate(() => window.__dev.journeyInfo());
  // 冒険で始めて、旅に出る（画面のボタン）
  await page.goto(`${base}/?fresh=1&notitle=1&time=10&weather=clear${w.query}`);
  await settle();
  await page.evaluate(() => window.__dev.startAdventure());
  await settle();
  await page.evaluate(() => window.__dev.setAdventureBalance(200000));
  await page.locator(".menu-btn").click();
  await page.locator(".menu-buttons button", { hasText: "冒険" }).click();
  await page.locator(".adventure-panel button", { hasText: "旅に出る" }).click();
  await page.waitForTimeout(5000);
  const r = { errors, runs: [] };
  r.started = await info();
  for (const hours of HOURS) {
    const before = await page.evaluate(() => ({ odometer: window.__dev.rideInfo()?.odometer ?? 0, stamps: window.__dev.journeyInfo().stamps }));
    await page.evaluate((h) => window.__dev.rewindJourney(h), hours);
    // 読み込み直す（保存から続き。旅の途中なので眺めたまま）
    const t0 = Date.now();
    await page.goto(`${base}/?notitle=1&time=10&weather=clear${w.query}`);
    await page.waitForFunction(() => window.__dev?.journeyInfo().catchingUp, null, { timeout: 240000, polling: 100 });
    const tStart = Date.now();
    await page.waitForTimeout(1500);
    await page.screenshot({ path: `${out}/${w.id}-${hours}h-progress.png` });
    await page.waitForFunction(() => !window.__dev.journeyInfo().catchingUp, null, { timeout: 600000, polling: 250 });
    const tEnd = Date.now();
    await page.waitForTimeout(800);
    await page.screenshot({ path: `${out}/${w.id}-${hours}h-log.png` });
    const after = await info();
    const odo = await page.evaluate(() => window.__dev.rideInfo()?.odometer ?? 0);
    r.runs.push({
      hours,
      reloadToStartMs: tStart - t0,
      catchupWallMs: tEnd - tStart,
      catchupMsInGame: after.lastCatchupMs,
      odometerGain: odo - before.odometer,
      newStamps: after.stamps - before.stamps,
      last: after.last,
      balance: after.balance,
    });
    // 旅の記録を閉じて、そのまま眺めて走り続けるか
    await page.locator(".journey-panel .stamp-head button").click();
    await page.waitForTimeout(4000);
    const o2 = await page.evaluate(() => window.__dev.rideInfo()?.odometer ?? 0);
    r.runs.at(-1).movesAfter = o2 - odo;
    r.runs.at(-1).watching = await page.evaluate(() => window.__dev.watchInfo().watching);
  }
  result[w.id] = r;
  await ctx.close();
}
await browser.close();
writeFileSync(`${out}/result.json`, JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
