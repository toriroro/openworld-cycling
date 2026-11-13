// 景観3種の画面写真（モック仕様 M2 の「ユーザーへ見せるもの」）。scripts/find-scenes.ts の地点を使う。
// node scripts/m2-shots.mjs   （開発サーバー 5180 が動いている前提）

import { chromium } from "@playwright/test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

const base = process.env.MAP_BASE || "http://localhost:5180";
const scenes = JSON.parse(readFileSync("artifacts/m2/scenes.json", "utf8"));
const out = "artifacts/m2/shots";
mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ channel: "chrome", headless: true });
const results = [];
for (const [quality, w, h] of [["standard", 1440, 900], ["light", 844, 390]]) {
  const page = await browser.newPage({ viewport: { width: w, height: h } });
  await page.goto(`${base}/?quality=${quality}&hud=0`);
  await page.waitForFunction(() => window.__dev.state().ready, null, { timeout: 120000 });
  for (const kind of (process.env.KINDS || "coast,plain,mountain,gravel").split(",")) {
    const sc = scenes[kind];
    if (!sc) continue;
    await page.evaluate((s) => {
      window.__dev.setPaused(true);
      window.__dev.teleport(s.x, s.z);
    }, sc);
    await page.waitForFunction(() => window.__dev.state().ready, null, { timeout: 120000 });
    await page.evaluate((s) => {
      window.__dev.placeOn(s.road, s.s, 1);
      if (s.seaX !== undefined) window.__dev.setCameraOverride({ x: s.x, y: s.y + 6, z: s.z }, { x: s.seaX, y: 0, z: s.seaZ });
      else window.__dev.setCameraOverride(null, null);
    }, sc);
    await page.waitForFunction(() => window.__dev.state().settled, null, { timeout: 180000, polling: 250 });
    await page.waitForTimeout(2500);
    const st = await page.evaluate(() => window.__dev.state());
    const file = `${out}/${kind}-${quality}-${w}x${h}.png`;
    await page.screenshot({ path: file });
    results.push({ kind, quality, file, triangles: st.stats.triangles, calls: st.stats.calls, eye: st.eye });
    console.log(file, `三角形 ${(st.stats.triangles / 1000).toFixed(0)}k 描画命令 ${st.stats.calls}`);
  }
  await page.close();
}
writeFileSync(`${out}/shots.json`, JSON.stringify(results, null, 2));
await browser.close();
