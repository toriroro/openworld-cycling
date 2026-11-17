// 道路のメッシュを区画ごとにまとめた後の描画量と突き抜けの確認（北海道の草案 14.1 #10）。
// 開発サーバーが動いている前提（MAP_BASE、既定 5180）。node scripts/road-batch-check.mjs。結果は artifacts/hokkaido/road-batch.json。
import { chromium } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";

const base = process.env.MAP_BASE || "http://localhost:5180";
mkdirSync("artifacts/hokkaido", { recursive: true });
const browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || "chrome", headless: true });
const out = {};
for (const world of ["hokkaido", "generated"])
  for (const quality of ["standard", "light"]) {
    const vp = quality === "light" ? { width: 844, height: 390 } : { width: 1440, height: 900 };
    const page = await browser.newPage({ viewport: vp });
    const errors = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    await page.goto(`${base}/?world=${world}&fresh=1&notitle=1&time=10&weather=clear&quality=${quality}`);
    await page.waitForFunction(() => window.__dev?.state().ready && window.__dev.state().settled, null, { timeout: 240000, polling: 250 });
    await page.waitForTimeout(1500);
    const s = await page.evaluate(() => {
      const st = window.__dev.view.stats();
      const ray = window.__dev.rayCheck(400);
      const ms = window.__dev.view.roadMeshes.buildMs.slice().sort((a, b) => a - b);
      return { triangles: st.triangles, calls: st.calls, roads: st.roads, ray: { rays: ray.rays, poke: ray.poke, worst: ray.worst }, buildMsP95: ms[Math.floor(ms.length * 0.95)] ?? null, buildMsMax: ms[ms.length - 1] ?? null };
    });
    await page.screenshot({ path: `artifacts/hokkaido/road-batch-${world}-${quality}.png` });
    out[`${world}-${quality}`] = { ...s, errors };
    await page.close();
  }
writeFileSync("artifacts/hokkaido/road-batch.json", JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 1));
await browser.close();
