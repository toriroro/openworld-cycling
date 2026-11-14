// 街区の描画量: 起点 葛郷で、標準画質と軽量画質の三角形の数と描画命令の数を測る（上限はモック仕様 5.6: 標準 150 万・300、軽量 50 万・150）。
// 開発サーバーが動いている前提（MAP_BASE で指定、既定は 5180）。node scripts/district-budget.mjs

import { chromium } from "@playwright/test";

const base = process.env.MAP_BASE || "http://localhost:5180";
const browser = await chromium.launch({ channel: "chrome", headless: true });
const result = {};
for (const [quality, w, h] of [["standard", 1440, 900], ["light", 844, 390]]) {
  const page = await browser.newPage({ viewport: { width: w, height: h } });
  await page.goto(`${base}/?fresh=1&notitle=1&quality=${quality}`);
  await page.waitForFunction(() => window.__dev?.state().ready && window.__dev.state().settled, null, { timeout: 180000, polling: 250 });
  await page.evaluate(() => {
    const d = window.__dev;
    d.setPaused(true);
    const v = d.view;
    v._f = v.frame.bind(v);
    v.frame = (e, t, f, cb) => (v._cam ? v._f(v._cam.e, v._cam.t, v._cam.fov ?? 50, cb) : v._f(e, t, f, cb));
  });
  let maxT = 0, maxC = 0;
  // 結節点のまわり 8 方向を、道路の高さの視点と上からの視点で見る
  for (let k = 0; k < 16; k++) {
    await page.evaluate((k) => {
      const d = window.__dev, n = d.roads.net.nodes.get("n_-9_2");
      const a = (k % 8) * (Math.PI / 4), high = k >= 8;
      const r = high ? 260 : 120;
      d.view._cam = { e: { x: n.x + Math.cos(a) * r, y: n.y + (high ? 140 : 2.5), z: n.z + Math.sin(a) * r }, t: { x: n.x, y: n.y + 3, z: n.z }, fov: 60 };
    }, k);
    await page.waitForTimeout(500);
    await page.waitForFunction(() => window.__dev.state().settled, null, { timeout: 120000, polling: 250 });
    await page.waitForTimeout(500);
    const s = await page.evaluate(() => window.__dev.view.stats());
    maxT = Math.max(maxT, s.triangles);
    maxC = Math.max(maxC, s.calls);
    result[quality] = { maxTriangles: maxT, maxCalls: maxC, buildings: s.buildings, districts: s.districts };
  }
  await page.close();
}
console.log(JSON.stringify(result));
await browser.close();
