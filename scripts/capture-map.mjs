// map.html を開いて、道路と地形の生成を待ってから画面写真を撮る。
// node scripts/capture-map.mjs <出力.png> "<map.html のクエリ>" [幅] [高さ]
// 開発サーバー（.claude/launch.json の dev、5180）が動いている前提。
import { chromium } from "@playwright/test";

const [out, query, w = "1440", h = "900"] = process.argv.slice(2);
const base = process.env.MAP_BASE || "http://localhost:5180";
const browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || "chrome", headless: true });
const page = await browser.newPage({ viewport: { width: Number(w), height: Number(h) } });
page.on("console", (m) => { if (m.type() === "error") console.error("console:", m.text()); });
await page.goto(`${base}/map.html?${query}`);
const t0 = Date.now();
await page.waitForFunction(() => {
  const m = window.__map;
  if (!m) return false;
  const s = m.status();
  return s.pendingBlocks === 0 && s.pendingTiles === 0 && s.roads > 0;
}, null, { timeout: 300000, polling: 500 });
await page.waitForTimeout(500);
const st = await page.evaluate(() => { const s = window.__map.status(); return { roads: s.roads, roadMs: s.roadMs.length }; });
await page.screenshot({ path: out });
console.log(`${out}: 道路 ${st.roads} 本、待ち ${((Date.now() - t0) / 1000).toFixed(1)}s`);
await browser.close();
