// M4 の確認（モック仕様 7章・10章）。開発サーバー 5180 が動いている前提。結果は artifacts/m4/check/。
// node scripts/m4-check.mjs [resume] [watch] [map] [cafe] [audio]   （省略するとすべて）

import { chromium } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";

const base = process.env.MAP_BASE || "http://localhost:5180";
const out = "artifacts/m4/check";
mkdirSync(out, { recursive: true });
const only = new Set(process.argv.slice(2));
const want = (k) => only.size === 0 || only.has(k);
const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--autoplay-policy=no-user-gesture-required"] });
const results = { date: new Date().toISOString() };

async function ready(page) {
  await page.waitForFunction(() => window.__dev?.state().ready && window.__dev.state().settled, null, { timeout: 180000, polling: 250 });
}
const pedal = (page, on) => page.evaluate((v) => window.dispatchEvent(new KeyboardEvent(v ? "keydown" : "keyup", { code: "Space" })), on);

// 続きから始まる（7.3）
if (want("resume")) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(`${base}/`);
  await ready(page);
  await pedal(page, true);
  await page.waitForTimeout(8000);
  await pedal(page, false);
  await page.evaluate(() => window.__dev.setPaused(true));
  const before = await page.evaluate(async () => {
    const d = window.__dev;
    await d.save();
    const s = d.snapshot();
    return { pos: s.pos, odometer: s.odometer, time: s.time, ridden: Object.keys(s.ridden).length };
  });
  await page.reload();
  await ready(page);
  const after = await page.evaluate(() => {
    const s = window.__dev.snapshot();
    return { pos: s.pos, odometer: s.odometer, time: s.time, ridden: Object.keys(s.ridden).length };
  });
  await page.screenshot({ path: `${out}/resume-after-reload.png` });
  const same = before.pos.road === after.pos.road && Math.abs(before.pos.s - after.pos.s) < 0.5 && before.pos.dir === after.pos.dir && Math.abs(before.odometer - after.odometer) < 0.5;
  results.resume = { before, after, same, errors };
  console.log("続きから", same ? "一致" : "不一致", JSON.stringify({ before, after }));
  await ctx.close();
}

writeFileSync(`${out}/results-${Object.keys(results).filter((k) => k !== "date").join("-") || "none"}.json`, JSON.stringify(results, null, 2));
await browser.close();
