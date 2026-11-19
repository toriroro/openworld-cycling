// 北海道の市街地の交差点を撮る（角の歩道・横断歩道・電柱・街灯の確かめ）。
// 開発サーバーが動いている前提（MAP_BASE、既定 5180）。node scripts/hokkaido-junction-shots.mjs。
// 結果は OUT（既定 artifacts/hokkaido/junction）。AT=x,z で場所、N で交差点の数（既定 4）、TAG で名前の後ろに付ける文字、TIME で時刻（既定 10）、CLS で腕の等級の上限（既定 1）。
// 視点: 交差点の斜め上（高さ 16m・28m 離れて）と、目の高さ（1.6m、腕の 1 本の 25m 先から中心を見る）。

import { chromium } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";

const base = process.env.MAP_BASE || "http://localhost:5180";
const out = process.env.OUT || "artifacts/hokkaido/junction";
const tag = process.env.TAG ? `-${process.env.TAG}` : "";
const [ax, az] = (process.env.AT || "240,40").split(",").map(Number);
const N = Number(process.env.N || 4);
const CLS = Number(process.env.CLS ?? 1);
mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || "chrome", headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e.stack || e)));
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
await page.goto(`${base}/?world=hokkaido&fresh=1&notitle=1&time=${process.env.TIME || 10}&weather=clear&x=${ax}&z=${az}`);
const settle = () => page.waitForFunction(() => window.__dev?.state().ready && window.__dev.state().settled, null, { timeout: 240000, polling: 250 });
await settle();
await page.evaluate(() => {
  const v = window.__dev.view;
  if (!v._f) {
    v._f = v.frame.bind(v);
    v.frame = (e, t, f, cb) => (v._cam ? v._f(v._cam.e, v._cam.t, v._cam.fov ?? 45, cb) : v._f(e, t, f, cb));
  }
  window.__dev.setPaused(true);
});
await page.waitForTimeout(1500);
// 近い順に、腕が 3 本以上で幹線か一般道を含む接続点
const js = await page.evaluate(({ N, CLS }) => {
  const d = window.__dev;
  const p = d.rideInfo();
  const net = d.roads.net;
  const list = [];
  for (const j of net.junctions.values()) {
    if (j.arms.length < 3) continue;
    const cls = Math.min(...j.arms.map((a) => net.roads.get(a.road)?.cls ?? 9));
    if (cls > CLS) continue;
    const dd = Math.hypot(j.x - p.x, j.z - p.z);
    if (dd > 500) continue;
    const a = j.arms[0];
    const r = net.roads.get(a.road);
    const ds = r.length / (r.points.length / 3 - 1);
    const i = Math.max(0, Math.min(r.points.length / 3 - 1, Math.round((a.s + a.dir * 25) / ds)));
    const ex = r.points[i * 3] + r.origin[0], ez = r.points[i * 3 + 2] + r.origin[1], ey = r.points[i * 3 + 1];
    list.push({ id: j.id, x: j.x, y: j.y, z: j.z, d: dd, arms: j.arms.length, eye: { x: ex, y: ey, z: ez } });
  }
  list.sort((a, b) => a.d - b.d);
  // 互いに 60m 以上離れた物
  const picked = [];
  for (const j of list) if (picked.every((q) => Math.hypot(q.x - j.x, q.z - j.z) > 60)) picked.push(j);
  return picked.slice(0, N);
}, { N, CLS });
const shots = [];
for (const [k, j] of js.entries()) {
  await page.evaluate((j) => (window.__dev.view._cam = { e: { x: j.x + 22, y: j.y + 16, z: j.z + 18 }, t: { x: j.x, y: j.y, z: j.z }, fov: 55 }), j);
  await page.waitForTimeout(1500);
  const a = `${out}/j${k}${tag}-above.png`;
  await page.screenshot({ path: a });
  await page.evaluate((j) => (window.__dev.view._cam = { e: { x: j.eye.x, y: j.eye.y + 1.6, z: j.eye.z }, t: { x: j.x, y: j.y + 1.2, z: j.z }, fov: 64 }), j);
  await page.waitForTimeout(1500);
  const b = `${out}/j${k}${tag}-eye.png`;
  await page.screenshot({ path: b });
  shots.push({ ...j, above: a, eye: b });
}
// 近くの電柱を 2 本（電柱から 14m 離れた高さ 3m から、電柱の 7m の高さを見る）
for (const [k, pole] of (await page.evaluate(() => {
  const d = window.__dev;
  const p = d.rideInfo();
  const S = d.view.world.local.sidewalks;
  const C = S.index.cell;
  const out = [];
  for (const [key, list] of Object.entries(S.index.poles)) {
    const [i, j] = key.split(",").map(Number);
    if (Math.abs(i * C - p.x) > 600 || Math.abs(j * C - p.z) > 600) continue;
    for (const [off, n] of list)
      for (let q = 0; q < n; q++) {
        const o = (off + q) * 6;
        const f = S.poles[o + 5];
        if (f & 4) continue;
        out.push({ x: S.poles[o], z: S.poles[o + 2], tx: S.poles[o + 3], tz: S.poles[o + 4], f, d: Math.hypot(S.poles[o] - p.x, S.poles[o + 2] - p.z) });
      }
  }
  out.sort((a, b) => a.d - b.d);
  const street = out.find((q) => q.f & 8);
  const pole = out.find((q) => !(q.f & 8) && q.f & 2);
  return [street, pole].filter(Boolean);
})).entries()) {
  const y = await page.evaluate((q) => window.__dev.view.surfaceHeight(q.x, q.z), pole);
  // 道の方 (−tz, tx) から、道に沿って少しずらして見る
  const e = { x: pole.x - pole.tz * 10 + pole.tx * 9, y: y + 3, z: pole.z + pole.tx * 10 + pole.tz * 9 };
  await page.evaluate(({ e, t }) => (window.__dev.view._cam = { e, t, fov: 60 }), { e, t: { x: pole.x, y: y + 7, z: pole.z } });
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${out}/pole${k}${tag}.png` });
}
// 標識の種類ごとに一番近いものを、表の正面の目の高さから（北海道の草案 27 章）。一方通行は板の横から
const SIGN_NAMES = { 1: "stop", 2: "crosswalk", 3: "oneway", 4: "noentry", 5: "speed", 6: "guide" };
const signShots = await page.evaluate(() => {
  const d = window.__dev;
  const p = d.rideInfo();
  const S = d.view.world.local.sidewalks;
  const best = {};
  for (const list of Object.values(S.index.signs))
    for (const t of list) {
      const o = t * 8;
      const type = S.signs[o + 5];
      const x = S.signs[o], z = S.signs[o + 2];
      const dd = Math.hypot(x - p.x, z - p.z);
      if (dd > 1500) continue;
      const k = type === 1 && Number.isNaN(S.signs[o + 1]) ? "street-stop" : String(type);
      if (!best[k] || dd < best[k].d) best[k] = { x, z, fx: S.signs[o + 3], fz: S.signs[o + 4], type, d: dd, reach: S.signs[o + 7] };
    }
  return best;
});
for (const [k, q] of Object.entries(signShots)) {
  const name = k === "street-stop" ? "street-stop" : SIGN_NAMES[q.type];
  const y = await page.evaluate((q) => window.__dev.view.surfaceHeight(q.x, q.z), q);
  const guide = q.type === 6;
  // 一方通行の板は道に沿うので横 (−fz, fx) から。案内標識は板の中心（腕の先）の 40m 手前
  const nx = q.type === 3 ? -q.fz : q.fx, nz = q.type === 3 ? q.fx : q.fz;
  const cx = guide ? q.x + q.fz * q.reach : q.x, cz = guide ? q.z - q.fx * q.reach : q.z;
  const back = guide ? 40 : 9;
  const e = { x: cx + nx * back, y: y + 1.6, z: cz + nz * back };
  await page.evaluate(({ e, t, fov }) => (window.__dev.view._cam = { e, t, fov }), { e, t: { x: cx, y: y + (guide ? 5.5 : 2), z: cz }, fov: guide ? 40 : 50 });
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${out}/sign-${name}${tag}.png` });
}
const stats = await page.evaluate(() => window.__dev.view.stats());
writeFileSync(`${out}/results${tag}.json`, JSON.stringify({ at: [ax, az], shots, stats, errors }, null, 2));
console.log(JSON.stringify({ shots: shots.map((s) => ({ id: s.id, x: Math.round(s.x), z: Math.round(s.z), arms: s.arms })), errors }, null, 1));
await browser.close();
