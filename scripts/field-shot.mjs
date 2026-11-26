// 指定した所を撮る（町の見た目の点検の続き）。開発サーバーが動いている前提（MAP_BASE、既定 5180）。
// AT=x,z（見る点）、START=x,z（起点。無ければ AT）、VIEW=top|side|eye（真上・斜め・目の高さ）、DIST=m、NAME=ファイル名、OUT=artifacts/field
// 例: AT=330,-1470 VIEW=top DIST=60 NAME=kita-gap node scripts/field-shot.mjs

import { chromium } from "@playwright/test";
import { mkdirSync } from "node:fs";

const base = process.env.MAP_BASE || "http://localhost:5180";
const out = process.env.OUT || "artifacts/field";
mkdirSync(out, { recursive: true });
const [x, z] = (process.env.AT || "0,0").split(",").map(Number);
const [sx, sz] = (process.env.START || `${x},${z}`).split(",").map(Number);
const views = (process.env.VIEW || "top,side").split(",");
const dist = Number(process.env.DIST || 50);
const name = process.env.NAME || `at${Math.round(x)}_${Math.round(z)}`;
const quality = process.env.QUALITY ? `&quality=${process.env.QUALITY}` : "";
const browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || "chrome", headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
await page.goto(`${base}/?world=hokkaido&fresh=1&notitle=1&time=${process.env.TIME || 11}&weather=clear&x=${sx}&z=${sz}${quality}`);
await page.waitForFunction(() => window.__dev?.state().ready && window.__dev.state().settled && window.__dev.game.ride?.road, null, { timeout: 240000, polling: 250 });
await page.evaluate(() => {
  const v = window.__dev.view;
  v._f = v.frame.bind(v);
  v.frame = (e, t, f, cb) => (v._cam ? v._f(v._cam.e, v._cam.t, v._cam.fov ?? 45, cb) : v._f(e, t, f, cb));
  document.querySelectorAll(".hud, .order-phone, .phone, .minimap").forEach((e) => (e.style.visibility = "hidden"));
});
await page.waitForTimeout(Number(process.env.WAIT || 3000));
await page.evaluate(() => window.__dev.setPaused(true));
const gy = await page.evaluate(({ x, z }) => window.__dev.groundAt([[x, z]])[0] ?? window.__dev.rideInfo().y, { x, z });
for (const v of views) {
  const cam =
    v === "top"
      ? { e: { x, y: gy + dist, z: z + 0.01 }, t: { x, y: gy, z }, fov: 50 }
      : v === "eye"
        ? { e: { x: x + dist * 0.7, y: gy + 1.6, z: z + dist * 0.7 }, t: { x, y: gy + 1.4, z }, fov: 60 }
        : { e: { x: x + dist * 0.6, y: gy + dist * 0.45, z: z + dist * 0.6 }, t: { x, y: gy, z }, fov: 55 };
  await page.evaluate((c) => (window.__dev.view._cam = c), cam);
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${out}/${name}-${v}.png` });
  console.log(`${out}/${name}-${v}.png`);
}
if (errors.length) console.log(errors);
await browser.close();
