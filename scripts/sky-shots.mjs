// 空と天候の画面写真: 晴れ・曇り・霧 × 朝・昼・夕方・夜。起点の町の外れと、農地の 2 か所。
// 開発サーバーが動いている前提（MAP_BASE で指定、既定は 5180）。結果は artifacts/sky/。
// node scripts/sky-shots.mjs [名前の一部で絞る]。QUALITY=light で軽量画質。

import { chromium } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";

const base = process.env.MAP_BASE || "http://localhost:5180";
const only = process.argv[2];
const quality = process.env.QUALITY || "standard";
const out = "artifacts/sky";
mkdirSync(out, { recursive: true });
const SPOTS = [
  // 名前, x, z, 視点（地面からの高さ）と注視点（相対）。視点がなければ走る時の視点（道路の上、後ろから）
  ["road", -33000, 13750, null, null],
  ["above", -32500, 12750, [-160, 70, 200], [700, 140, -900]],
];
const HOURS = [
  ["morning", 6.5],
  ["noon", 12],
  ["evening", 17.6],
  ["night", 22],
];
const WEATHERS = ["clear", "cloudy", "fog"];
const browser = await chromium.launch({ channel: "chrome", headless: true });
const errors = [];
const stats = {};
for (const [name, x, z, e, t] of SPOTS) {
  if (only && !name.includes(only) && !HOURS.some(([h]) => only.includes(h)) && !WEATHERS.some((w) => only.includes(w))) continue;
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on("pageerror", (er) => errors.push(String(er)));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  await page.goto(`${base}/?fresh=1&notitle=1&quality=${quality}&x=${x}&z=${z}`);
  await page.waitForFunction(() => window.__dev?.state().ready && window.__dev.state().settled, null, { timeout: 240000, polling: 250 });
  await page.evaluate(({ x, z, e, t }) => {
    const d = window.__dev;
    d.setPaused(true);
    document.querySelector(".hud-root")?.classList.add("hidden");
    if (!e) return;
    const v = d.view;
    const g = (px, pz) => v.heights.height(px, pz);
    const cam = { e: { x: x + e[0], y: g(x + e[0], z + e[2]) + e[1], z: z + e[2] }, t: { x: x + t[0], y: g(x + e[0], z + e[2]) + t[1], z: z + t[2] } };
    v._f = v.frame.bind(v);
    v.frame = (_e, _t, _f, cb) => v._f(cam.e, cam.t, 60, cb);
  }, { x, z, e, t });
  await page.waitForTimeout(1500);
  await page.waitForFunction(() => window.__dev.state().settled, null, { timeout: 180000, polling: 250 });
  for (const w of WEATHERS) {
    for (const [hn, hour] of HOURS) {
      const tag = `${name}-${w}-${hn}${quality === "light" ? "-light" : ""}`;
      if (only && !tag.includes(only) && !name.includes(only)) continue;
      await page.evaluate(({ hour, w }) => window.__dev.setSky({ hour, weather: w }), { hour, w });
      await page.waitForTimeout(900);
      await page.screenshot({ path: `${out}/${tag}.png` });
      const s = await page.evaluate(() => ({ ...window.__dev.view.stats(), sky: window.__dev.skyInfo() }));
      stats[tag] = { triangles: s.triangles, calls: s.calls, sky: s.sky };
    }
  }
  await page.close();
}
if (!only) writeFileSync(`${out}/results${quality === "light" ? "-light" : ""}.json`, JSON.stringify({ date: new Date().toISOString(), quality, shots: stats, errors }, null, 2));
console.log(JSON.stringify({ n: Object.keys(stats).length, errors }));
await browser.close();
