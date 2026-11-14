// 農地（田・畑・牧草地）の画面写真。場所は scripts/farm-report.ts で調べた、起点に近い広い農地。
// 開発サーバーが動いている前提（MAP_BASE で指定、既定は 5180）。結果は artifacts/farm/。
// node scripts/farm-shots.mjs [名前の一部で絞る]。QUALITY=light で軽量画質。

import { chromium } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";

const base = process.env.MAP_BASE || "http://localhost:5180";
const only = process.argv[2];
const quality = process.env.QUALITY || "standard";
const out = "artifacts/farm";
mkdirSync(out, { recursive: true });
const SPOTS = [
  ["paddy", -33000, 13750],
  ["field", -32500, 12750],
  ["pasture", -40000, 13750],
];
const browser = await chromium.launch({ channel: "chrome", headless: true });
const errors = [];
const stats = {};
for (const [name, x, z] of SPOTS) {
  if (only && !name.includes(only)) continue;
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  await page.goto(`${base}/?fresh=1&notitle=1&quality=${quality}&x=${x}&z=${z}`);
  await page.waitForFunction(() => window.__dev?.state().ready && window.__dev.state().settled, null, { timeout: 240000, polling: 250 });
  await page.evaluate(() => {
    const d = window.__dev;
    d.setPaused(true);
    const v = d.view;
    v._f = v.frame.bind(v);
    v.frame = (e, t, f, cb) => (v._cam ? v._f(v._cam.e, v._cam.t, v._cam.fov ?? 50, cb) : v._f(e, t, f, cb));
    document.querySelector(".hud-root")?.classList.add("hidden");
  });
  // 視点: 上から、低い斜め、地面の高さ（高さは地面からの相対）
  const views = [
    ["above", [-260, 330, 420], [0, 0, 0], 50],
    ["oblique", [-120, 45, 160], [40, 0, -60], 55],
    ["ground", [-30, 2.2, 40], [60, 2, -80], 60],
  ];
  // 走る時の視点: 近くの道路の上（高さ 1.5m）から、道路に沿って見る。農地の中を通る所を 3 つ選ぶ
  const roadViews = await page.evaluate(async ({ x, z }) => {
    const d = window.__dev;
    const F = await import("/src/render/farm/fields.ts");
    const seed = F.fieldSeed(d.view.heights.seed);
    const cand = [];
    for (const r of d.roads.net.roads.values()) {
      const P = r.points, n = P.length / 3;
      for (let i = 4; i < n - 16; i += 8) {
        const px = P[i * 3] + r.origin[0], pz = P[i * 3 + 2] + r.origin[1];
        const dist = Math.hypot(px - x, pz - z);
        if (dist > 1500) continue;
        // 両側 25m が農地の区画
        const qx = P[(i + 12) * 3] + r.origin[0], qz = P[(i + 12) * 3 + 2] + r.origin[1];
        const l = Math.hypot(qx - px, qz - pz) || 1;
        const nx = -(qz - pz) / l, nz = (qx - px) / l;
        if (!F.openAt(seed, px + nx * 25, pz + nz * 25) || !F.openAt(seed, px - nx * 25, pz - nz * 25)) continue;
        cand.push({ dist, e: [px - x, P[i * 3 + 1] + 1.5, pz - z], t: [qx - x, P[(i + 12) * 3 + 1] + 1.0, qz - z] });
      }
    }
    cand.sort((a, b) => a.dist - b.dist);
    return [cand[0], cand[Math.floor(cand.length / 3)], cand[Math.floor((cand.length * 2) / 3)]].filter(Boolean);
  }, { x, z });
  roadViews.forEach((v, k) => views.push([`road${k + 1}`, v.e, v.t, 62, true]));
  for (const [vn, e, t, fov, abs] of views) {
    await page.evaluate(({ x, z, e, t, fov, abs }) => {
      const d = window.__dev;
      // abs: 高さは世界の高さそのまま（道路の上の視点）
      const g = (px, pz) => (abs ? 0 : d.view.heights.height(px, pz));
      d.view._cam = { e: { x: x + e[0], y: g(x + e[0], z + e[2]) + e[1], z: z + e[2] }, t: { x: x + t[0], y: g(x + t[0], z + t[2]) + t[1], z: z + t[2] }, fov };
    }, { x, z, e, t, fov, abs: !!abs });
    await page.waitForTimeout(900);
    await page.waitForFunction(() => window.__dev.state().settled, null, { timeout: 180000, polling: 250 });
    await page.waitForTimeout(1500);
    const tag = `${name}-${vn}${quality === "light" ? "-light" : ""}`;
    await page.screenshot({ path: `${out}/${tag}.png` });
    const s = await page.evaluate(() => window.__dev.view.stats());
    stats[tag] = { triangles: s.triangles, calls: s.calls, vegetation: s.vegetation };
  }
  await page.close();
}
if (!only) writeFileSync(`${out}/results${quality === "light" ? "-light" : ""}.json`, JSON.stringify({ date: new Date().toISOString(), quality, shots: stats, errors }, null, 2));
console.log(JSON.stringify({ shots: stats, errors }));
await browser.close();
