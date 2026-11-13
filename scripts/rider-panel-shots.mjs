// 設定画面（garage.html?panel）を4つの画面の大きさで撮り、押す対象の大きさと はみ出しを調べる。
// node scripts/rider-panel-shots.mjs <出力先>
import { chromium } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";

const out = process.argv[2] || "artifacts/rider/panel";
const base = process.env.RIDER_BASE || "http://localhost:5182";
mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ channel: "chrome", headless: true });
const results = [];
for (const [w, h] of [[1440, 900], [844, 390], [390, 844], [1024, 768]]) {
  const page = await browser.newPage({ viewport: { width: w, height: h }, hasTouch: w < 900 || h < 500 });
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(`${base}/garage.html?panel`);
  await page.waitForFunction(() => window.__garage?.cyclist.rider.stats().ready, null, { timeout: 60000 });
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${out}/panel-bike-${w}x${h}.png` });
  const check = () =>
    page.evaluate(() => {
      const panel = document.querySelector(".outfit-panel").getBoundingClientRect();
      const small = [...document.querySelectorAll(".outfit-panel button")]
        .map((b) => b.getBoundingClientRect())
        .filter((r) => r.width > 0 && (r.width < 44 || r.height < 44)).length;
      return { inside: panel.left >= 0 && panel.top >= 0 && panel.right <= innerWidth + 0.5 && panel.bottom <= innerHeight + 0.5, small };
    });
  const bike = await check();
  // ライダーの頁に切り替え、ジャージの色を1つ選ぶ
  await page.click(".of-tab:nth-child(2)");
  await page.click(".of-row:nth-child(2) .of-swatch:nth-child(8)");
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${out}/panel-rider-${w}x${h}.png` });
  const rider = await check();
  const jersey = await page.evaluate(() => window.__garage.outfit.rider.jerseyColor);
  results.push({ size: `${w}x${h}`, bike, rider, jersey, errors });
  console.log(`${w}x${h}`, JSON.stringify({ bike, rider, jersey, errors: errors.length }));
  await page.close();
}
writeFileSync(`${out}/results.json`, JSON.stringify(results, null, 2));
await browser.close();
