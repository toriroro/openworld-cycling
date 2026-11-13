// R1 の 3D 画面写真（川の谷・橋・堤防の上の自転車道）。scripts/r1-scenes.ts の地点を使う。
// node scripts/r1-shots.mjs   （開発サーバー 5180 が動いている前提）。水面は R2 で描くので、ここでは谷と橋だけが見える。

import { chromium } from "@playwright/test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

const base = process.env.MAP_BASE || "http://localhost:5180";
const scenes = JSON.parse(readFileSync("artifacts/r1/scenes.json", "utf8"));
const out = "artifacts/r1/shots";
mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
await page.goto(`${base}/?mode=m2&quality=standard&hud=0`);
await page.waitForFunction(() => window.__dev.state().ready, null, { timeout: 180000 });
const results = [];
for (const [kind, sc] of Object.entries(scenes)) {
  await page.evaluate((s) => {
    window.__dev.setPaused(true);
    window.__dev.teleport(s.x, s.z);
  }, sc);
  await page.waitForFunction(() => window.__dev.state().ready, null, { timeout: 180000 });
  await page.evaluate((s) => {
    window.__dev.placeOn(s.road, s.s, s.dir);
    window.__dev.setCameraOverride(s.eye ?? null, s.target ?? null);
  }, sc);
  await page.waitForFunction(() => window.__dev.state().settled, null, { timeout: 180000, polling: 250 });
  await page.waitForTimeout(2500);
  const st = await page.evaluate(() => window.__dev.state());
  const file = `${out}/${kind}.png`;
  await page.screenshot({ path: file });
  results.push({ kind, note: sc.note, file, triangles: st.stats.triangles, calls: st.stats.calls });
  console.log(file, sc.note, `三角形 ${(st.stats.triangles / 1000).toFixed(0)}k 描画命令 ${st.stats.calls}`);
}
writeFileSync(`${out}/shots.json`, JSON.stringify({ results, errors }, null, 2));
console.log(`エラー ${errors.length}`);
await browser.close();
