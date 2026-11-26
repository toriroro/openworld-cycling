// 歩く人の形の並びを撮る（people.html。町の見た目の草案 3 章）。MAP_BASE の開発サーバー。OUT=artifacts/pedestrians
import { chromium } from "@playwright/test";
import { mkdirSync } from "node:fs";
const base = process.env.MAP_BASE || "http://localhost:5180";
const out = process.env.OUT || "artifacts/pedestrians";
const tag = process.env.TAG || "";
mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || "chrome", headless: true });
const page = await browser.newPage({ viewport: { width: 1400, height: 700 } });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => m.type() === "error" && errors.push(m.text().slice(0, 400)));
for (const [name, query] of (process.env.VIEWS || "front:view=front&phase=0.25;side:view=side&phase=0.25;back:view=back&phase=0.75;still:view=front&still=1;face:view=face&still=1").split(";").map((s) => s.split(":"))) {
  await page.goto(`${base}/people.html?${query}`);
  await page.waitForFunction(() => window.__people?.real.ready || window.__people?.real.error, null, { timeout: 60000 });
  await page.waitForTimeout(800);
  await page.screenshot({ path: `${out}/lineup${tag}-${name}.png` });
}
console.log(errors.length ? errors : "ok");
await browser.close();
