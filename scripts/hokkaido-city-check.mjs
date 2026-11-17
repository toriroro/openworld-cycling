// 北海道の市街地の検査: 建物の土台と地面の差（宙に浮く建物）を数え、一番浮いている所・道路の様子を撮る。
// 開発サーバーが動いている前提（MAP_BASE、既定 5180）。node scripts/hokkaido-city-check.mjs。結果は artifacts/hokkaido/city/。
// 地面の高さは、描いている地形（近景のタイル）に上から光線を当てて取る。

import { chromium } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";

const base = process.env.MAP_BASE || "http://localhost:5180";
const out = process.env.OUT || "artifacts/hokkaido/city";
mkdirSync(out, { recursive: true });
const PLACES = [
  ["odori", 240, 40],
  ["susukino", 150, 900],
  ["maruyama", -2600, 300],
  ["moiwa", -2300, 4200],
  ["toyohira", 2600, 2800],
  ["kotoni", -4300, -2300],
  ["teine", -8400, -3800],
];
const only = process.env.ONLY ? new Set(process.env.ONLY.split(",")) : null;
const browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || "chrome", headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e.stack || e)));
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
await page.goto(`${base}/?world=hokkaido&fresh=1&notitle=1&time=10&weather=clear`);
const settle = () => page.waitForFunction(() => window.__dev?.state().ready && window.__dev.state().settled, null, { timeout: 240000, polling: 250 });
await settle();
await page.evaluate(() => {
  const v = window.__dev.view;
  if (!v._f) {
    v._f = v.frame.bind(v);
    v.frame = (e, t, f, cb) => (v._cam ? v._f(v._cam.e, v._cam.t, v._cam.fov ?? 45, cb) : v._f(e, t, f, cb));
  }
});

const result = { places: {}, errors };
for (const [name, x, z] of PLACES.filter(([n]) => !only || only.has(n))) {
  await page.evaluate(({ x, z }) => window.__dev.teleport(x, z), { x, z });
  await page.waitForFunction(() => window.__dev.state().ready, null, { timeout: 120000, polling: 250 });
  await settle();
  await page.waitForTimeout(1500);
  const r = await page.evaluate(() => {
    const d = window.__dev;
    const v = d.view;
    const p = d.rideInfo();
    const B = v.world.local.buildings;
    const D = B.data;
    const C = B.index.cell;
    const ground = (gx, gz) => d.groundAt([[gx, gz]])[0];
    const R = 220;
    const list = [];
    for (let i = Math.floor((p.x - R) / C); i <= Math.floor((p.x + R) / C); i++)
      for (let j = Math.floor((p.z - R) / C); j <= Math.floor((p.z + R) / C); j++) {
        const c = B.cell(i, j);
        if (!c) continue;
        for (let k = c[0]; k < c[0] + c[1]; k++) {
          const o = k * 16;
          const bx = D[o], bz = D[o + 1];
          if (Math.hypot(bx - p.x, bz - p.z) > R) continue;
          const a = D[o + 5];
          const ax = Math.cos(a), az = Math.sin(a);
          const hw = D[o + 2] / 2, hd = D[o + 3] / 2;
          let worst = -Infinity;
          let sunk = -Infinity;
          for (const [s, t] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
            const cx = bx + ax * s * hw - az * t * hd;
            const cz = bz + az * s * hw + ax * t * hd;
            const g = ground(cx, cz);
            if (g === null) continue;
            worst = Math.max(worst, D[o + 6] - g);
            sunk = Math.max(sunk, g - (D[o + 7] + 0.0));
          }
          if (worst === -Infinity) continue;
          list.push({ x: Math.round(bx), z: Math.round(bz), gap: +worst.toFixed(2), sunk: +sunk.toFixed(2), base: +D[o + 6].toFixed(2), road: +D[o + 8].toFixed(2), front: +D[o + 9].toFixed(1) });
        }
      }
    list.sort((a, b) => b.gap - a.gap);
    const n = list.length;
    return {
      pos: { x: Math.round(p.x), y: Math.round(p.y), z: Math.round(p.z) },
      buildings: n,
      floating03: list.filter((b) => b.gap > 0.3).length,
      floating1: list.filter((b) => b.gap > 1).length,
      maxGap: list[0]?.gap ?? null,
      worst: list.slice(0, 5),
    };
  });
  result.places[name] = r;
  // 一番浮いている建物の近く・斜め上から
  const w = r.worst[0];
  if (w) {
    await page.evaluate(() => window.__dev.setPaused(true));
    await page.evaluate((w) => (window.__dev.view._cam = { e: { x: w.x + 28, y: w.base + 14, z: w.z + 28 }, t: { x: w.x, y: w.base + 2, z: w.z }, fov: 50 }), w);
    await page.waitForTimeout(1200);
    await page.screenshot({ path: `${out}/${name}-worst.png` });
  }
  // 低い斜めの見下ろし（道路のつながりを見る）
  await page.evaluate((p) => (window.__dev.view._cam = { e: { x: p.x - 90, y: p.y + 55, z: p.z + 90 }, t: { x: p.x, y: p.y, z: p.z }, fov: 55 }), r.pos);
  await page.waitForTimeout(1200);
  await page.screenshot({ path: `${out}/${name}-oblique.png` });
  await page.evaluate(() => {
    window.__dev.view._cam = null;
    window.__dev.setPaused(false);
  });
}
writeFileSync(`${out}/results.json`, JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 1));
await browser.close();
