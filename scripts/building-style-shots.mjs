// 建物の型ごとの画面写真（起点 葛郷の街区から、型ごとに何棟かを道路側の斜め前から撮る）。開発サーバーが動いている前提（MAP_BASE で指定、既定は 5180）。
// 結果は artifacts/district/style-<型>-<番号>.png。node scripts/building-style-shots.mjs [型の名前で絞る] [型ごとの枚数]
// VIEW=back で裏から、VIEW=top で斜め上から撮る。

import { chromium } from "@playwright/test";
import { mkdirSync } from "node:fs";

const base = process.env.MAP_BASE || "http://localhost:5180";
const only = process.argv[2] && process.argv[2] !== "-" ? process.argv[2] : null;
const per = Number(process.argv[3] || 2);
const viewKind = process.env.VIEW || "front";
const out = "artifacts/district";
mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
await page.goto(`${base}/?fresh=1&notitle=1`);
await page.waitForFunction(() => window.__dev?.state().ready && window.__dev.state().settled, null, { timeout: 180000, polling: 250 });
// KIND=village: 起点にいちばん近い集落へ移って撮る（集落の建物は型が決まっておらず、描く時に家の型を当てる）
let nodeId = "n_-9_2";
if (process.env.KIND === "village") {
  const v = await page.evaluate(() => {
    const d = window.__dev, o = d.roads.net.nodes.get("n_-9_2");
    return [...d.roads.net.nodes.values()].filter((q) => q.kind === "village").sort((p, q) => Math.hypot(p.x - o.x, p.z - o.z) - Math.hypot(q.x - o.x, q.z - o.z))[0];
  });
  nodeId = v.id;
  await page.goto(`${base}/?fresh=1&notitle=1&x=${v.x}&z=${v.z}`);
  await page.waitForFunction(() => window.__dev?.state().ready && window.__dev.state().settled, null, { timeout: 180000, polling: 250 });
}
const list = await page.evaluate((nodeId) => {
  const d = window.__dev;
  d.setPaused(true);
  const v = d.view;
  v._f = v.frame.bind(v);
  v.frame = (e, t, f, cb) => (v._cam ? v._f(v._cam.e, v._cam.t, v._cam.fov ?? 50, cb) : v._f(e, t, f, cb));
  document.querySelector(".hud-root")?.classList.add("hidden");
  const n = d.roads.net.nodes.get(nodeId);
  const town = v.towns.townsNear(n.x, n.z, 400).find((t) => t.node === nodeId);
  return town.buildings.map((b, i) => ({ i, style: b.style ?? "village", x: b.x, z: b.z, w: b.w, d: b.d, h: b.h, top: b.top, angle: b.angle, front: b.front, gap: b.gap, floors: b.floors, roof: b.roof, r: Math.hypot(b.x - n.x, b.z - n.z) }));
}, nodeId);
const styles = [...new Set(list.map((b) => b.style))].sort();
const count = Object.fromEntries(styles.map((s) => [s, list.filter((b) => b.style === s).length]));
for (const style of styles) {
  if (only && !style.includes(only)) continue;
  // 中心に近い順ではなく、番号を散らして選ぶ（似た建物が続かないように）
  const all = list.filter((b) => b.style === style);
  const picks = Array.from({ length: Math.min(per, all.length) }, (_, k) => all[Math.floor(((k + 0.5) * all.length) / Math.min(per, all.length))]);
  for (const [k, b] of picks.entries()) {
    const zx = -Math.sin(b.angle) * b.front, zz = Math.cos(b.angle) * b.front; // 道路の向き
    const ux = zz, uz = -zx;
    const dist = Math.max(9, b.w * 0.75 + b.h * 0.55);
    const sgn = viewKind === "back" ? -1 : 1;
    const e = viewKind === "top"
      ? { x: b.x + zx * (b.d / 2 + dist * 0.8) + ux * dist * 0.5, y: b.top + b.h + dist * 0.6, z: b.z + zz * (b.d / 2 + dist * 0.8) + uz * dist * 0.5 }
      : { x: b.x + sgn * zx * (b.d / 2 + dist) + ux * dist * 0.45, y: b.top + 2.2, z: b.z + sgn * zz * (b.d / 2 + dist) + uz * dist * 0.45 };
    const t = { x: b.x, y: b.top + b.h * 0.5, z: b.z };
    await page.evaluate(({ e, t }) => (window.__dev.view._cam = { e, t, fov: 55 }), { e, t });
    await page.waitForTimeout(700);
    await page.waitForFunction(() => window.__dev.state().settled, null, { timeout: 120000, polling: 250 });
    await page.waitForTimeout(900);
    await page.screenshot({ path: `${out}/style-${style}-${viewKind === "front" ? "" : `${viewKind}-`}${k}.png` });
  }
}
const s = await page.evaluate(() => window.__dev.view.stats());
console.log(JSON.stringify({ count, buildings: s.buildings, errors }));
await browser.close();
