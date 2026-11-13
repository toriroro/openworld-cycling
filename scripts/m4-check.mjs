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

// 眺める乗り方（7.2）: 視点の自動切替 20〜40 秒、HUD を 5 秒で消す、30 fps、常時点灯
if (want("watch")) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(`${base}/?fresh=1`);
  await ready(page);
  await page.evaluate(() => window.dispatchEvent(new KeyboardEvent("keydown", { code: "KeyV" })));
  await page.evaluate(() => window.dispatchEvent(new KeyboardEvent("keyup", { code: "KeyV" })));
  await page.waitForTimeout(7000);
  const early = await page.evaluate(() => window.__dev.watchInfo());
  await page.screenshot({ path: `${out}/watch-hud-hidden.png` });
  await page.evaluate(() => window.__dev.frames(true));
  await page.waitForTimeout(100000);
  const info = await page.evaluate(() => window.__dev.watchInfo());
  const frames = await page.evaluate(() => window.__dev.frames(true));
  const sorted = frames.slice(1).sort((a, b) => a - b);
  const med = sorted[Math.floor(sorted.length / 2)];
  const p95 = sorted[Math.floor(sorted.length * 0.95)];
  const gaps = info.cameraLog.slice(1).map((c, i) => (c.t - info.cameraLog[i].t) / 1000);
  const odo = await page.evaluate(() => window.__dev.state().odometer);
  await page.screenshot({ path: `${out}/watch-after.png` });
  results.watch = { watching: info.watching, hudHiddenAfter7s: early.hudFaded, switches: info.cameraLog.length, gapsSec: gaps, frameMedianMs: med, frameP95Ms: p95, awake: info.awake, odometer: odo, errors };
  console.log("眺める", JSON.stringify(results.watch));
  await ctx.close();
}

// 喫茶店に寄ってスタンプが残る（7.1）: 行き先を店にして走り、店の前で止まる。出発して、読み込み直してもスタンプがある
if (want("cafe")) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(`${base}/`);
  await ready(page);
  await page.waitForFunction(() => window.__dev.cafes().length > 0, null, { timeout: 120000, polling: 500 });
  const cafe = await page.evaluate(() => {
    const list = window.__dev.cafes().sort((a, b) => a.d - b.d);
    const c = list[0];
    window.__dev.setGoal(c.x, c.z);
    window.__dev.setTimeScale(6);
    return c;
  });
  await pedal(page, true);
  const t0 = Date.now();
  // 店の 150m 手前から等倍、22m 手前でブレーキ
  const near = (d) =>
    page.waitForFunction(
      ([c, dd]) => {
        const p = window.__dev.rideInfo();
        return p && Math.hypot(p.x - c.x, p.z - c.z) < dd;
      },
      [cafe, d],
      { timeout: 300000, polling: 50 },
    );
  await near(150);
  await page.evaluate(() => window.__dev.setTimeScale(1));
  await near(22);
  await pedal(page, false);
  await page.evaluate(() => window.dispatchEvent(new KeyboardEvent("keydown", { code: "ShiftLeft" })));
  await page.waitForFunction(() => window.__dev.stopInfo().stop !== null, null, { timeout: 60000, polling: 100 });
  await page.evaluate(() => window.dispatchEvent(new KeyboardEvent("keyup", { code: "ShiftLeft" })));
  const rideSec = (Date.now() - t0) / 1000;
  await page.waitForTimeout(2500);
  await page.screenshot({ path: `${out}/cafe-stop.png` });
  const atStop = await page.evaluate(() => ({ info: window.__dev.stopInfo(), panel: document.querySelector(".stop-panel")?.textContent }));
  await page.click(".stop-depart");
  await page.waitForTimeout(1500);
  const departed = await page.evaluate(() => window.__dev.stopInfo().stop === null);
  await page.evaluate(() => window.__dev.save());
  await page.reload();
  await ready(page);
  const afterReload = await page.evaluate(() => window.__dev.stopInfo().stamps);
  await page.evaluate(() => {
    const b = [...document.querySelectorAll(".menu-buttons .btn")].find((e) => e.textContent === "スタンプ帳");
    b.click();
  });
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${out}/stamp-book.png` });
  results.cafe = { cafe, rideSec, stopAt: atStop.info.stop, panel: atStop.panel, departed, stampsAfterReload: afterReload, errors };
  console.log("喫茶店", JSON.stringify(results.cafe));
  await ctx.close();
}

writeFileSync(`${out}/results-${Object.keys(results).filter((k) => k !== "date").join("-") || "none"}.json`, JSON.stringify(results, null, 2));
await browser.close();
