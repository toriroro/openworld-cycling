// ガレージ（garage.html）で自転車とライダーを数方向から撮る。
// node scripts/rider-garage-shots.mjs <出力先> [lod=high|low] [outfit の JSON]
// 開発サーバー（.claude/launch.json の rider、5182）が動いている前提。

import { chromium } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";

const out = process.argv[2] || "artifacts/rider/garage";
const lod = process.argv[3] || "high";
const outfit = process.argv[4] || "";
const base = process.env.RIDER_BASE || "http://localhost:5182";
mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
await page.goto(`${base}/garage.html?lod=${lod}${process.env.NORIDER ? "&norider" : ""}${outfit ? `&outfit=${encodeURIComponent(outfit)}` : ""}`);
await page.waitForFunction(() => window.__garage?.cyclist.rider.stats().ready || window.__garage?.cyclist.rider.stats().error, null, { timeout: 60000 });
await page.waitForTimeout(500);
const views = {
  right: { yaw: -90, pitch: 6, dist: 3.1, ty: 0.72, tz: 0.05 },
  left: { yaw: 90, pitch: 6, dist: 3.1, ty: 0.72, tz: 0.05 },
  front34: { yaw: 38, pitch: 12, dist: 3.0, ty: 0.8, tz: 0.05 },
  rear34: { yaw: -140, pitch: 16, dist: 3.0, ty: 0.8, tz: 0 },
  top: { yaw: -160, pitch: 62, dist: 3.0, ty: 0.8, tz: 0 },
  face: { yaw: 25, pitch: 4, dist: 1.0, ty: 1.35, tz: 0.2 },
  drive: { yaw: -100, pitch: 10, dist: 1.25, ty: 0.32, tz: -0.18 },
  cockpit: { yaw: 160, pitch: 35, dist: 1.0, ty: 0.92, tz: 0.45 },
};
for (const [name, v] of Object.entries(views)) {
  await page.evaluate((v) => Object.assign(window.__garage.view, v), v);
  await page.waitForTimeout(250);
  await page.screenshot({ path: `${out}/${name}.png` });
}
const stats = await page.evaluate(() => window.__garage.stats());
writeFileSync(`${out}/stats.json`, JSON.stringify({ lod, stats, errors }, null, 2));
console.log(JSON.stringify({ lod, stats, errors }));
await browser.close();
