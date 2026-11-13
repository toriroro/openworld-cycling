// M4 の完了条件「無操作で1時間走り続け、その間の計測値が安定している」（モック仕様 10章）。
// 眺める乗り方（V）を入れたあとは何も操作しない。1分ごとにヒープ・ジオメトリ数・テクスチャ数・描画量・フレーム間隔・距離を記録する。
// node scripts/m4-hour.mjs   （開発サーバー 5180 が動いている前提。MINUTES=60、QUALITY=standard）。結果は artifacts/m4/hour/。

import { chromium } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";

const base = process.env.MAP_BASE || "http://localhost:5180";
const minutes = Number(process.env.MINUTES || 60);
const quality = process.env.QUALITY || "standard";
const out = "artifacts/m4/hour";
mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--enable-precise-memory-info", "--autoplay-policy=no-user-gesture-required"] });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
await page.goto(`${base}/?fresh=1&quality=${quality}`);
await page.waitForFunction(() => window.__dev?.state().ready && window.__dev.state().settled, null, { timeout: 180000, polling: 250 });
// 眺める乗り方を入れる（これ以降は操作しない）
await page.evaluate(() => {
  window.dispatchEvent(new KeyboardEvent("keydown", { code: "KeyV" }));
  window.dispatchEvent(new KeyboardEvent("keyup", { code: "KeyV" }));
  window.__dev.frames(true);
});
const started = new Date();
const samples = [];
const pct = (a, p) => {
  if (!a.length) return null;
  const s = a.slice().sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.floor(s.length * p))];
};
for (let m = 1; m <= minutes; m++) {
  await page.waitForTimeout(60000);
  const s = await page.evaluate(() => {
    const d = window.__dev;
    const st = d.state();
    const w = d.watchInfo();
    const frames = d.frames(true);
    return {
      odometer: st.odometer,
      speed: st.speed,
      stats: st.stats,
      frames,
      watching: w.watching,
      camera: w.camera,
      awake: w.awake,
      stamps: d.stopInfo().stamps.length,
      ridden: Object.keys(d.snapshot().ridden).length,
      nodes: d.roads.net.nodes.size,
      junctions: d.roads.net.junctions.size,
      landscape: d.rideInfo()?.landscape ?? null,
      elevation: d.rideInfo()?.y ?? null,
    };
  });
  const sample = {
    minute: m,
    km: +(s.odometer / 1000).toFixed(2),
    heapMB: s.stats.heapMB !== null ? +s.stats.heapMB.toFixed(1) : null,
    geometries: s.stats.geometries,
    textures: s.stats.textures,
    programs: s.stats.programs,
    triangles: s.stats.triangles,
    calls: s.stats.calls,
    roadsLoaded: s.stats.roadsLoaded,
    nodes: s.nodes,
    junctions: s.junctions,
    buildings: s.stats.buildings?.buildings ?? null,
    frameMedianMs: pct(s.frames.slice(1), 0.5),
    frameP95Ms: pct(s.frames.slice(1), 0.95),
    frameMaxMs: s.frames.length ? Math.max(...s.frames.slice(1)) : null,
    watching: s.watching,
    awake: s.awake,
    elevation: s.elevation !== null ? Math.round(s.elevation) : null,
  };
  samples.push(sample);
  console.log(JSON.stringify(sample));
  writeFileSync(`${out}/samples.json`, JSON.stringify({ started: started.toISOString(), quality, minutes, samples, errors }, null, 2));
  if (m === 1 || m % 15 === 0) await page.screenshot({ path: `${out}/minute-${String(m).padStart(2, "0")}.png` });
}
writeFileSync(`${out}/samples.json`, JSON.stringify({ started: started.toISOString(), ended: new Date().toISOString(), quality, minutes, samples, errors }, null, 2));
await browser.close();
