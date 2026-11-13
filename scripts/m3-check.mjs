// M3 の確認（モック仕様 10章）: 4つの画面の大きさで画面の部品が重ならないこと、描画量、分岐の候補、視点3種。
// node scripts/m3-check.mjs   （開発サーバー 5180 が動いている前提）。結果は artifacts/m3/。

import { chromium } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";

const base = process.env.MAP_BASE || "http://localhost:5180";
const out = "artifacts/m3/check";
mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ channel: "chrome", headless: true });
const results = { date: new Date().toISOString(), sizes: [], budget: [], branch: null, cameras: [] };

async function open(w, h, query = "") {
  const page = await browser.newPage({ viewport: { width: w, height: h }, hasTouch: w < 900 || h < 500, isMobile: false });
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  await page.goto(`${base}/?${query}`);
  await page.waitForFunction(() => window.__dev?.state().ready && window.__dev.state().settled, null, { timeout: 180000, polling: 250 });
  return { page, errors };
}

const pedal = (page, on) => page.evaluate((v) => window.dispatchEvent(new KeyboardEvent(v ? "keydown" : "keyup", { code: "Space" })), on);

// 1. 4つの大きさで重なりを調べる
for (const [w, h] of [[1440, 900], [844, 390], [390, 844], [1024, 768]]) {
  const touch = w < 900 || h < 500;
  const { page, errors } = await open(w, h, touch ? "touch=1" : "");
  await pedal(page, true);
  await page.waitForTimeout(4000);
  const rects = await page.evaluate(() => {
    const sel = [".ride-info", ".menu-btn", ".road-name", ".branch:not(.hidden)", ".uturn:not(.hidden)", ".touch-left", ".touch-right", ".minimap"];
    const out = [];
    for (const s of sel) {
      const e = document.querySelector(s);
      if (!e) continue;
      const st = getComputedStyle(e);
      if (st.display === "none" || e.closest(".hidden")) continue;
      const r = e.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      out.push({ sel: s, x: r.x, y: r.y, w: r.width, h: r.height });
    }
    // 押す対象の大きさ
    const small = [...document.querySelectorAll(".btn")]
      .filter((b) => !b.closest(".hidden") && !b.closest(".menu") && getComputedStyle(b).display !== "none")
      .map((b) => b.getBoundingClientRect())
      .filter((r) => r.width > 0 && (r.width < 44 || r.height < 44)).length;
    return { rects: out, small, vw: innerWidth, vh: innerHeight };
  });
  const overlaps = [];
  for (let i = 0; i < rects.rects.length; i++)
    for (let j = i + 1; j < rects.rects.length; j++) {
      const a = rects.rects[i], b = rects.rects[j];
      if (a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h) overlaps.push(`${a.sel} × ${b.sel}`);
    }
  const outside = rects.rects.filter((r) => r.x < 0 || r.y < 0 || r.x + r.w > rects.vw + 0.5 || r.y + r.h > rects.vh + 0.5).map((r) => r.sel);
  await page.screenshot({ path: `${out}/size-${w}x${h}.png` });
  // メニューを開いた状態も
  await page.click(".menu-btn");
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${out}/size-${w}x${h}-menu.png` });
  const menuFits = await page.evaluate(() => {
    const r = document.querySelector(".menu").getBoundingClientRect();
    return r.right <= innerWidth + 0.5 && r.bottom <= innerHeight + 0.5;
  });
  results.sizes.push({ size: `${w}x${h}`, touch, elements: rects.rects.map((r) => r.sel), overlaps, outside, smallButtons: rects.small, menuFits, errors });
  console.log(`${w}x${h} 部品 ${rects.rects.length} 重なり ${overlaps.length ? overlaps.join(", ") : "なし"} はみ出し ${outside.length ? outside.join(",") : "なし"} 44px 未満 ${rects.small} メニュー ${menuFits ? "収まる" : "はみ出す"} エラー ${errors.length}`);
  await page.close();
}

// 2. 描画量（標準 1440×900、軽量 844×390）と、分岐の候補・視点
for (const [quality, w, h] of [["standard", 1440, 900], ["light", 844, 390]]) {
  const { page } = await open(w, h, `quality=${quality}`);
  await pedal(page, true);
  const samples = [];
  for (let i = 0; i < 10; i++) {
    await page.waitForTimeout(1000);
    const s = await page.evaluate(() => window.__dev.state().stats);
    samples.push({ triangles: s.triangles, calls: s.calls });
  }
  const maxT = Math.max(...samples.map((s) => s.triangles));
  const maxC = Math.max(...samples.map((s) => s.calls));
  results.budget.push({ quality, size: `${w}x${h}`, maxTriangles: maxT, maxCalls: maxC, samples });
  console.log(`${quality} 三角形 最大 ${(maxT / 1000).toFixed(0)}k 描画命令 最大 ${maxC}`);
  if (quality === "standard") {
    // 分岐の候補が出るまで進む（速度を上げるため出力を 400W に）
    await page.evaluate(() => {
      window.__dev.game.manual.setting = 400;
    });
    await page.waitForFunction(() => {
      const u = window.__dev.state().upcoming;
      return u && u.choices >= 2 && u.distance < 120;
    }, null, { timeout: 600000, polling: 200 });
    await page.screenshot({ path: `${out}/branch.png` });
    results.branch = await page.evaluate(() => {
      const u = window.__dev.game.ride.upcoming;
      return { distance: u.distance, choices: u.choices.map((c) => ({ dest: c.destination, angle: (c.angle * 180) / Math.PI, km: c.distance / 1000 })), defaultIndex: u.defaultIndex };
    });
    console.log("分岐", JSON.stringify(results.branch));
    for (const cam of ["chase", "rider", "drone"]) {
      await page.evaluate((c) => {
        window.__dev.game.camera = c;
      }, cam);
      await page.waitForTimeout(1500);
      await page.screenshot({ path: `${out}/camera-${cam}.png` });
      results.cameras.push(cam);
    }
  }
  await page.close();
}
writeFileSync(`${out}/results.json`, JSON.stringify(results, null, 2));
await browser.close();
