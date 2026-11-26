// 今いる所（住所と方位磁針）を画面上部へ移した確認（ユーザーの指定 2026-11-26）。
// 大きな画面（タッチなし）1280×720・1024×640 と、縦 402×680・横 874×342＋左右 61px（タッチ）で、走る画面の部品の重なりを数え、撮る。
// 開発サーバーが動いている前提（MAP_BASE、既定 5180）。node scripts/ux30-check.mjs。結果は artifacts/ux30。

import { chromium } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";

const base = process.env.MAP_BASE || "http://localhost:5180";
const out = process.env.OUT || "artifacts/ux30";
mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || "chrome", headless: true });
const SEL = [".menu-btn", ".road-name", ".uturn", ".ride-status", ".branch", ".delivery-strip", ".phone", ".minimap-wrap", ".minimap-zoom", ".pace-bar", ".touch-left", ".touch-btn.brake", ".touch-right .lane"];
const result = {};
for (const v of [
  { name: "desktop-1280", w: 1280, h: 720, touch: false },
  { name: "desktop-1024", w: 1024, h: 640, touch: false },
  { name: "portrait", w: 402, h: 680, touch: true },
  { name: "landscape", w: 874, h: 342, touch: true, safe: 61 },
]) {
  const page = await (await browser.newContext({ viewport: { width: v.w, height: v.h }, deviceScaleFactor: 1, hasTouch: v.touch })).newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(`${base}/?world=hokkaido&fresh=1&notitle=1&time=11&weather=clear${v.touch ? "&touch=1" : ""}`);
  await page.waitForFunction(() => window.__dev?.state().ready && window.__dev.state().settled && window.__dev.game.deliveryArea && window.__dev.game.ride?.road, null, { timeout: 240000, polling: 250 });
  if (v.safe) await page.addStyleTag({ content: `:root{--safe-l:${v.safe}px !important;--safe-r:${v.safe}px !important}` });
  await page.evaluate(() => {
    window.__dev.game.timeScale = 3;
    window.__dev.game.appOn = true;
  });
  await page.waitForFunction(() => window.__dev.game.feed.items.length >= 1, null, { timeout: 120000, polling: 250 });
  await page.evaluate(() => window.__dev.game.acceptFromPhone(window.__dev.game.feed.items[0].order.no));
  await page.evaluate(() => window.__dev.game.setPace(2));
  await page.waitForTimeout(3000);
  const m = await page.evaluate((SEL) => {
    const vis = (e) => e && !e.closest(".hidden") && getComputedStyle(e).display !== "none" && e.getBoundingClientRect().width > 0;
    const r = {};
    for (const s of SEL) {
      const e = document.querySelector(s);
      if (!vis(e)) continue;
      const b = e.getBoundingClientRect();
      r[s] = [Math.round(b.left), Math.round(b.top), Math.round(b.right), Math.round(b.bottom)];
    }
    const over = [];
    const keys = Object.keys(r);
    for (let i = 0; i < keys.length; i++)
      for (let j = i + 1; j < keys.length; j++) {
        const a = r[keys[i]];
        const b = r[keys[j]];
        const w = Math.min(a[2], b[2]) - Math.max(a[0], b[0]);
        const h = Math.min(a[3], b[3]) - Math.max(a[1], b[1]);
        if (w > 0 && h > 0) over.push(`${keys[i]} × ${keys[j]} (${w}×${h})`);
      }
    return { rects: r, over };
  }, SEL);
  await page.screenshot({ path: `${out}/${v.name}.png` });
  result[v.name] = { ...m, errors };
  console.log(v.name, "重なり", m.over);
  await page.close();
}
writeFileSync(`${out}/result.json`, JSON.stringify(result, null, 2));
await browser.close();
