// リアルな歩く人の確かめ（町の見た目の草案 3 章）: 近くの歩く人を、前・横・少し離れた所から撮る。
// 開発サーバーが動いている前提（MAP_BASE、既定 5180）。AT=x,z（既定は大通）、OUT=artifacts/pedestrians。
import { chromium } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";

const base = process.env.MAP_BASE || "http://localhost:5180";
const out = process.env.OUT || "artifacts/pedestrians";
mkdirSync(out, { recursive: true });
const [x, z] = (process.env.AT || "240,40").split(",").map(Number);
const browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || "chrome", headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
await page.goto(`${base}/?world=hokkaido&fresh=1&notitle=1&time=${process.env.TIME || 11}&weather=clear&x=${x}&z=${z}`);
await page.waitForFunction(() => window.__dev?.state().ready && window.__dev.state().settled && window.__dev.game.ride?.road && window.__dev.view.pedestrians.real.ready, null, { timeout: 240000, polling: 250 });
await page.evaluate(() => {
  const v = window.__dev.view;
  v._f = v.frame.bind(v);
  v.frame = (e, t, f, cb) => (v._cam ? v._f(v._cam.e, v._cam.t, v._cam.fov ?? 45, cb) : v._f(e, t, f, cb));
  document.querySelectorAll(".order-phone, .phone").forEach((e) => (e.style.visibility = "hidden"));
});
await page.waitForTimeout(4000);
const people = await page.evaluate(() => window.__dev.view.pedestrians.realList.map((p) => ({ ...p })));
const result = { people: people.length, stats: await page.evaluate(() => ({ ...window.__dev.view.pedestrians.stats, real: { ...window.__dev.view.pedestrians.real.stats } })), errors };
// 歩いている人を 1 人選び、その人の進む向きの前・横・斜め後ろから撮る（時間は流したまま、撮る直前に止める）
const walking = people.filter((p) => !p.still);
const shots = [];
for (const [k, who] of walking.slice(0, 3).entries()) {
  for (const [name, ang, dist, h] of [["front", 0, 3.5, 1.5], ["back", Math.PI, 4, 1.6], ["far", 0.5, 10, 2.5]]) {
    await page.evaluate(({ who, ang, dist, h }) => {
      window.__dev.setPaused(false);
      const a = who.yaw + ang;
      window.__dev.view._cam = { e: { x: who.x + Math.sin(a) * dist, y: who.y + h, z: who.z + Math.cos(a) * dist }, t: { x: who.x, y: who.y + 0.95, z: who.z }, fov: 45 };
    }, { who, ang, dist, h });
    await page.waitForTimeout(300);
    await page.evaluate(() => window.__dev.setPaused(true));
    await page.waitForTimeout(500);
    const file = `${out}/p${k}-${name}.png`;
    await page.screenshot({ path: file });
    shots.push(file);
  }
}
// 通りの眺め（目の高さ）
await page.evaluate(({ x, z }) => {
  const p = window.__dev.rideInfo();
  window.__dev.view._cam = { e: { x: p.x, y: p.y + 1.6, z: p.z }, t: { x: p.x + 30, y: p.y + 1.2, z: p.z }, fov: 55 };
}, { x, z });
await page.waitForTimeout(800);
await page.screenshot({ path: `${out}/street.png` });
result.shots = shots;
writeFileSync(`${out}/result.json`, JSON.stringify(result, null, 2));
console.log(JSON.stringify(result));
await browser.close();
