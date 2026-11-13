// 接続点の見た目と、曲がる時の走り方の画面写真。
// node scripts/junction-shots.mjs   （開発サーバー 5180 が動いている前提）。結果は artifacts/junctions/。

import { chromium } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";

const base = process.env.MAP_BASE || "http://localhost:5180";
const out = "artifacts/junctions";
mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
await page.goto(`${base}/`);
await page.waitForFunction(() => window.__dev?.state().ready && window.__dev.state().settled, null, { timeout: 180000, polling: 250 });

// 上から見るカメラ（描画の frame を差し替える）
await page.evaluate(() => {
  const d = window.__dev;
  const v = d.view;
  v._f = v.frame.bind(v);
  v.frame = (e, t, f, cb) => (v._cam ? v._f(v._cam.e, v._cam.t, 50, cb) : v._f(e, t, f, cb));
});
const settle = () => page.waitForFunction(() => window.__dev.state().settled, null, { timeout: 120000, polling: 250 });

// 1. 上から: 結節点の三叉路、T字の合流、浅い分かれ道（以前は2本の道が重なって X 字に交わっていた所）
const tops = [
  ["node-3way", -32500, 11250],
  ["merge-T", -26607, 11693],
  ["fork-shallow", -37178, 6996],
];
const result = { date: new Date().toISOString(), shots: [], turn: null };
for (const [name, x, z] of tops) {
  await page.evaluate(([x, z]) => {
    window.__dev.teleport(x, z);
    window.__dev.setPaused(true);
  }, [x, z]);
  await page.waitForTimeout(1500);
  await settle();
  await page.evaluate(([x, z]) => {
    const d = window.__dev;
    let best = null;
    for (const j of d.roads.net.junctions.values()) {
      const dd = Math.hypot(j.x - x, j.z - z);
      if (!best || dd < best.dd) best = { j, dd };
    }
    const j = best.j;
    d.view._cam = { e: { x: j.x - 15, y: j.y + 75, z: j.z - 50 }, t: { x: j.x, y: j.y, z: j.z } };
  }, [x, z]);
  await page.waitForTimeout(2500);
  await settle();
  await page.screenshot({ path: `${out}/top-${name}.png` });
  result.shots.push(`top-${name}.png`);
}

// 2. 曲がる: 起点の三叉路へ向かい、左へ曲がる。後方の視点で曲がる途中を写し、向きの変わり方を記録する
await page.evaluate(() => {
  const d = window.__dev;
  d.view._cam = null;
  const r = d.game.ride;
  r.pos = { road: "n_-9_2~n_-8_2", s: 60, dir: -1 };
  r.upcoming = null;
  r.power = { read: () => ({ watts: 200, brake: 0 }) };
  r.speed = 6;
});
await page.waitForTimeout(1500);
await settle();
await page.evaluate(() => {
  const d = window.__dev;
  const r = d.game.ride;
  window.__trace = [];
  window.__shots = [];
  d.setPaused(false);
  const tick = () => {
    const u = r.upcoming;
    if (u && u.selected === null) {
      const i = u.choices.findIndex((c) => !c.straightOn && c.angle < -0.3);
      if (i >= 0) r.choose(i);
    }
    const p = r.pose();
    window.__trace.push({ x: p.x, z: p.z, h: Math.atan2(p.dz, p.dx), turning: !!r.turn, speed: r.speed, road: r.pos.road });
    if (r.turn && r.turn.d > r.turn.length * 0.5 && !window.__half) {
      window.__half = true;
      d.setPaused(true);
    }
    if (window.__trace.length < 1200) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
});
await page.waitForFunction(() => window.__half, null, { timeout: 60000, polling: 50 });
await page.waitForTimeout(800);
await page.screenshot({ path: `${out}/turn-chase.png` });
result.shots.push("turn-chase.png");
await page.evaluate(() => window.__dev.setPaused(false));
await page.waitForTimeout(4000);
const trace = await page.evaluate(() => window.__trace);
// 1フレームあたりの向きの変わり方の最大と、曲がる間の最低速度
let maxDh = 0;
let minTurnSpeed = Infinity;
for (let i = 1; i < trace.length; i++) {
  let dh = trace[i].h - trace[i - 1].h;
  while (dh > Math.PI) dh -= 2 * Math.PI;
  while (dh < -Math.PI) dh += 2 * Math.PI;
  maxDh = Math.max(maxDh, Math.abs(dh));
  if (trace[i].turning) minTurnSpeed = Math.min(minTurnSpeed, trace[i].speed);
}
result.turn = {
  frames: trace.length,
  roads: [...new Set(trace.map((t) => t.road))],
  maxHeadingChangePerFrameDeg: (maxDh * 180) / Math.PI,
  minSpeedInTurnKmh: minTurnSpeed * 3.6,
};
result.errors = errors;
writeFileSync(`${out}/results.json`, JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
await browser.close();
