// 鉄道の 2D 地図の画面写真（鉄道の草案 L1）。map.html を開き、線路と道路の生成を待ってから撮る。
// 開発サーバーが動いている前提（MAP_BASE で指定、既定は 5180）。結果は artifacts/rail/。
// node scripts/rail-shots.mjs
import { chromium } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";

const base = process.env.MAP_BASE || "http://localhost:5180";
const out = "artifacts/rail";
mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
const shots = {};
const wait = async () => {
  await page.waitForFunction(() => {
    const m = window.__map;
    if (!m) return false;
    const s = m.status();
    return s.pendingTiles === 0 && s.pendingBlocks === 0 && (s.railPending ?? 1) === 0;
  }, null, { timeout: 600000, polling: 500 });
  await page.waitForTimeout(800);
};
// 起点の周り 100km 四方（道路は描かない縮尺）、起点の周り、起点に近い駅
const views = [
  ["wide", -32500, 11250, 75],
  ["origin", -32500, 11250, 18],
  ["origin-near", -32500, 11250, 5],
];
await page.goto(`${base}/map.html?x=-32500&z=11250&mpp=75`);
for (const [name, x, z, mpp] of views) {
  const t0 = Date.now();
  await page.evaluate(({ x, z, mpp }) => window.__map.setView(x, z, mpp), { x, z, mpp });
  await wait();
  await page.screenshot({ path: `${out}/map-${name}.png` });
  shots[name] = { rails: await page.evaluate(() => window.__map.rails.size), waitS: Math.round((Date.now() - t0) / 100) / 10 };
}
// 起点にいちばん近い拠点の駅の周りを拡大
const near = await page.evaluate(() => {
  let best = null;
  for (const l of window.__map.rails.values())
    for (const st of l.stations) {
      if (st.kind !== "hub" && st.kind !== "passing") continue;
      const n = l.points.length / 3, ds = l.length / (n - 1), i = Math.min(n - 1, Math.round(st.s / ds));
      const x = l.points[i * 3] + l.origin[0], z = l.points[i * 3 + 2] + l.origin[1];
      const d = Math.hypot(x + 32500, z - 11250);
      if (!best || d < best.d) best = { x, z, d, name: st.name };
    }
  return best;
});
if (near) {
  await page.evaluate(({ x, z }) => window.__map.setView(x, z, 4), near);
  await wait();
  await page.screenshot({ path: `${out}/map-station.png` });
  shots.station = { name: near.name, km: Math.round(near.d / 100) / 10 };
}
writeFileSync(`${out}/map-results.json`, JSON.stringify({ date: new Date().toISOString(), shots, errors }, null, 2));
console.log(JSON.stringify({ shots, errors }));
await browser.close();
