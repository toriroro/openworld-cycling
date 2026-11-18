// 北海道の世界の名所（名所の草案 docs/history/specs/2026-11-18-landmarks-draft.md）の画面写真。
// 開発サーバーが動いている前提（MAP_BASE、既定 5180）。先に npx tsx scripts/hokkaido/landmarks.ts で名所のデータを作る。
// node scripts/landmark-shots.mjs [名所の id ...]。OUT=フォルダ（既定 artifacts/hokkaido/landmarks）、QUALITY=light で軽量画質。
// 名所ごとに、走る道からの眺め（chase）と、名所を見下ろす眺め（view）を撮る。

import { chromium } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";

const base = process.env.MAP_BASE || "http://localhost:5180";
const quality = process.env.QUALITY || "standard";
const out = process.env.OUT || "artifacts/hokkaido/landmarks";
const only = process.argv.slice(2);
mkdirSync(out, { recursive: true });

/** 撮る所: 名所の id、走る場所 [x, z]、見下ろす視点 [x, y（地面から）, z]、見る先 [x, y（地面から）, z] */
const SHOTS = [
  ["tvtower", [470, -40], [250, 25, -60], [525, 70, -124]],
  ["odori", [-150, 30], [330, 60, -80], [-200, 0, 20]],
  ["clocktower", [330, -260], [340, 18, -245], [293, 8, -285]],
  ["akarenga", [-160, -330], [-60, 30, -420], [-159, 12, -439]],
  ["hokudai", [-480, -1180], [-900, 30, -1450], [-1000, 10, -1560]],
  ["nakajima", [330, 1500], [280, 25, 1500], [209, 6, 1528]],
  ["jingu", [-3400, 470], [-3380, 40, 520], [-3456, 5, 630]],
  ["asahiyama", [-2900, 2400], [-2900, 30, 2240], [-2966, 0, 2297]],
  ["moiwa", [-2250, 4197], [-2180, 40, 4130], [-2250, 0, 4197]],
  ["moere", [6400, -6800], [6500, 40, -6880], [6578, 10, -6954]],
  ["okurayama", [-4900, 980], [-4900, 60, 1100], [-5100, 30, 1000]],
  ["hitsujigaoka", [3650, 6700], [3640, 6, 6730], [3655, 4, 6751]],
  // テレビ塔を 2.6km 南の中島公園の辺りから
  ["tvtower-far", [330, 1500], [300, 30, 2500], [525, 80, -124]],
];

const browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || "chrome", headless: true });
const vp = quality === "light" ? { width: 844, height: 390 } : { width: 1440, height: 900 };
const page = await browser.newPage({ viewport: vp });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e.stack || e)));
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
await page.goto(`${base}/?world=hokkaido&fresh=1&notitle=1&time=11&weather=clear&quality=${quality}`);
const settle = () => page.waitForFunction(() => window.__dev?.state().ready && window.__dev.state().settled, null, { timeout: 240000, polling: 250 });
await settle();
// 一時停止の表示を隠す（写真に入るため）
await page.addStyleTag({ content: ".pause-banner { display: none !important; }" });
await page.evaluate(() => {
  const v = window.__dev.view;
  if (!v._f) {
    v._f = v.frame.bind(v);
    v.frame = (e, t, f, cb) => (v._cam ? v._f(v._cam.e, v._cam.t, v._cam.fov ?? 45, cb) : v._f(e, t, f, cb));
  }
});
const result = { quality, shots: {}, errors };
for (const [id, at, eye, look] of SHOTS) {
  if (only.length && !only.includes(id)) continue;
  await page.evaluate(({ x, z }) => window.__dev.teleport(x, z), { x: at[0], z: at[1] });
  await page.waitForFunction(() => window.__dev.state().ready, null, { timeout: 120000, polling: 250 });
  await settle();
  await page.evaluate(() => (window.__dev.game.camera = "chase"));
  await page.waitForTimeout(1200);
  await page.screenshot({ path: `${out}/${id}-chase.png` });
  await page.evaluate(() => window.__dev.setPaused(true));
  const cam = await page.evaluate(
    ({ eye, look }) => {
      const h = (x, z) => window.__dev.view.heights.height(x, z);
      const c = { e: { x: eye[0], y: h(eye[0], eye[2]) + eye[1], z: eye[2] }, t: { x: look[0], y: h(look[0], look[2]) + look[1], z: look[2] }, fov: 55 };
      window.__dev.view._cam = c;
      return c;
    },
    { eye, look },
  );
  await page.waitForTimeout(400);
  await page.waitForFunction(() => window.__dev.state().settled, null, { timeout: 120000, polling: 250 });
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${out}/${id}-view.png` });
  const s = await page.evaluate(() => {
    const st = window.__dev.view.stats();
    const L = window.__dev.view.landmarks; const sl = (L?.sliceMs ?? []).slice().sort((a, b) => a - b); return { triangles: st.triangles, calls: st.calls, landmarks: st.landmarks ?? null, buildMs: L?.buildMs.map((x) => Math.round(x)) ?? [], sliceMax: sl[sl.length - 1] ?? null, skeletonMs: L?.skeletonMs.map((x) => Math.round(x * 10) / 10), mergeMs: L?.mergeMs.map((x) => Math.round(x * 10) / 10), arraysMs: L?.arraysMs.map((x) => Math.round(x * 10) / 10), sliceP95: sl[Math.floor(sl.length * 0.95)] ?? null, slices: sl.length };
  });
  // 名所の模型を隠した時の描画量（差が名所の分。置き換えた OSM の建物は描かないままなので、その分は差に入らない）
  const without = await page.evaluate(async () => {
    const v = window.__dev.view;
    if (!v.landmarks) return null;
    v.landmarks.group.visible = false;
    await new Promise((r) => setTimeout(r, 400));
    const st = v.stats();
    v.landmarks.group.visible = true;
    return { triangles: st.triangles, calls: st.calls };
  });
  s.without = without;
  await page.evaluate(() => {
    window.__dev.view._cam = null;
    window.__dev.setPaused(false);
  });
  result.shots[id] = { cam, ...s };
  console.log(id, s.triangles, s.calls, without ? `名所なし ${without.triangles} ${without.calls}` : "");
}
writeFileSync(`${out}/shots${quality === "light" ? "-light" : ""}.json`, JSON.stringify(result, null, 2));
if (errors.length) console.log("errors", errors.slice(0, 5));
await browser.close();
