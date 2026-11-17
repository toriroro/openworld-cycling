// 北海道 H2: トンネルの確認（北海道の草案 20 章）。坑口を外から、中を追う視点で、上から、路面への地形の突き抜け。
// 開発サーバーが動いている前提（MAP_BASE、既定 5180）。先に npx tsx scripts/hokkaido/build.ts で変換データを作る。
// node scripts/hokkaido-tunnel-shots.mjs。結果は artifacts/hokkaido/h2/tunnel/。

import { chromium } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";

const base = process.env.MAP_BASE || "http://localhost:5180";
const out = process.env.OUT || "artifacts/hokkaido/h2/tunnel";
mkdirSync(out, { recursive: true });

// [名前, 坑口の x, z, 坑口から外へ向く単位ベクトル dx, dz, 中ほどの x, z]
const TUNNELS = [
  // 国道 230 号の八剣山トンネル（736m）。東の坑口
  ["hakkenzan", -8457, 10890, 0.993, 0.114, -8822, 10850],
  // 西野真駒内清田線（小林峠の下、1.6km）
  ["kobayashi", null, null, 0, 0, -4261, 4342],
  // 小樽定山渓線（1.5km）
  ["otaru-jozankei", null, null, 0, 0, -17022, 5257],
  // 創成トンネル（市街地の地下の道、746m。大通の東）
  ["sosei", null, null, 0, 0, 613, 65],
];
const only = process.env.ONLY ? new Set(process.env.ONLY.split(",")) : null;

const browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || "chrome", headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
await page.goto(`${base}/?world=hokkaido&fresh=1&notitle=1&time=10&weather=clear`);
const settle = () => page.waitForFunction(() => window.__dev?.state().ready && window.__dev.state().settled, null, { timeout: 240000, polling: 250 });
await settle();
const snap = async (name) => {
  await page.waitForTimeout(800);
  await page.screenshot({ path: `${out}/${name}.png` });
};
const go = async (x, z) => {
  await page.evaluate(({ x, z }) => window.__dev.teleport(x, z), { x, z });
  await page.waitForFunction(() => window.__dev.state().ready, null, { timeout: 120000, polling: 250 });
  await settle();
};
const freeCam = () =>
  page.evaluate(() => {
    const d = window.__dev;
    d.setPaused(true);
    const v = d.view;
    if (!v._f) {
      v._f = v.frame.bind(v);
      v.frame = (e, t, f, cb) => (v._cam ? v._f(v._cam.e, v._cam.t, v._cam.fov ?? 45, cb) : v._f(e, t, f, cb));
    }
  });
const release = () =>
  page.evaluate(() => {
    window.__dev.view._cam = null;
    window.__dev.setPaused(false);
  });

const result = { tunnels: {}, errors };
for (const [name, px, pz, dx, dz, mx, mz] of TUNNELS.filter(([n]) => !only || only.has(n))) {
  const r = {};
  // 中ほど: 追う視点、突き抜け
  await go(mx, mz);
  await page.evaluate(() => (window.__dev.game.camera = "chase"));
  await snap(`${name}-inside-chase`);
  r.inside = await page.evaluate(() => {
    const ray = window.__dev.rayCheck(400);
    const s = window.__dev.view.stats();
    const p = window.__dev.rideInfo();
    return { pos: { x: Math.round(p.x), y: Math.round(p.y), z: Math.round(p.z) }, poke: ray.poke, rays: ray.rays, missed: ray.missed, triangles: s.triangles, calls: s.calls };
  });
  // 上から
  await freeCam();
  await page.evaluate((p) => (window.__dev.view._cam = { e: { x: p.x - 200, y: p.y + 260, z: p.z + 200 }, t: { x: p.x, y: p.y, z: p.z }, fov: 50 }), r.inside.pos);
  await snap(`${name}-above`);
  await release();
  // 坑口を外から
  if (px !== null) {
    await go(px + dx * 60, pz + dz * 60);
    await freeCam();
    const y = await page.evaluate(({ x, z }) => window.__dev.view.surfaceHeight(x, z), { x: px, z: pz });
    await page.evaluate(
      ({ px, pz, dx, dz, y }) => (window.__dev.view._cam = { e: { x: px + dx * 45 - dz * 8, y: y + 7, z: pz + dz * 45 + dx * 8 }, t: { x: px, y: y + 4, z: pz }, fov: 55 }),
      { px, pz, dx, dz, y },
    );
    await snap(`${name}-portal`);
    await release();
    r.portal = { x: px, z: pz, y: Math.round(y * 10) / 10 };
  }
  result.tunnels[name] = r;
}
writeFileSync(`${out}/results.json`, JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
await browser.close();
