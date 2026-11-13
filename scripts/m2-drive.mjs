// M2 の完了条件の検査（モック仕様 10章）。
// 道路に沿って 12.5km 進んで道を記録し、記録した道を往復する（1往復 = 1周）。4周で合計 100km を加速移動する。
// 各周の終点・起点で: 地形タイル・道路の区間・GPU の形状と画像の数・ヒープ（gc 後）、路面への地面の突き抜け（光線検査）、
// 見た目（縮小した明るさ）を記録する。移動中のフレーム間隔も記録する。
// node scripts/m2-drive.mjs [速度 m/s] [片道 m]   （開発サーバー 5180 が動いている前提。QUALITY=light で軽量画質）

import { chromium } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";

const speed = Number(process.argv[2] ?? 200);
const legM = Number(process.argv[3] ?? 12500);
const quality = process.env.QUALITY || "standard";
const base = process.env.MAP_BASE || "http://localhost:5180";
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const out = `artifacts/m2/drive-${stamp}-${quality}`;
mkdirSync(out, { recursive: true });

const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--js-flags=--expose-gc"] });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on("console", (m) => {
  if (m.type() === "error") errors.push(m.text());
});
page.on("pageerror", (e) => errors.push(String(e)));
await page.goto(`${base}/?quality=${quality}&hud=1`);
const gpu = await page.evaluate(() => {
  const gl = window.__dev.view.renderer.getContext();
  const e = gl.getExtension("WEBGL_debug_renderer_info");
  return e ? gl.getParameter(e.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
});
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

async function waitSettled(timeout = 180000) {
  const t0 = Date.now();
  await page.waitForFunction(() => window.__dev.state().ready && window.__dev.state().settled, null, { timeout, polling: 250 });
  return Date.now() - t0;
}

const summarize = (a) => {
  const s = [...a].sort((x, y) => x - y);
  const p = (q) => s[Math.min(s.length - 1, Math.round((s.length - 1) * q))];
  return { frames: s.length, median: p(0.5), p95: p(0.95), p99: p(0.99), max: s[s.length - 1] };
};

async function measure(name) {
  await page.evaluate(() => window.__dev.setPaused(true));
  const waitMs = await waitSettled();
  await page.waitForTimeout(2500);
  await page.evaluate(() => window.gc?.());
  await page.waitForTimeout(500);
  await page.evaluate(() => window.gc?.());
  const st = await page.evaluate(() => window.__dev.state());
  const ray = await page.evaluate(() => window.__dev.rayCheck(800));
  const sig = await page.evaluate(() => window.__dev.signature());
  await page.screenshot({ path: `${out}/${name}.png` });
  const m = {
    name,
    waitMs,
    travelledKm: st.travelled / 1000,
    pos: st.pos,
    eye: st.eye,
    terrainMeshes: st.stats.terrain.meshes,
    roadChunks: st.stats.roads.chunks,
    geometries: st.stats.geometries,
    textures: st.stats.textures,
    programs: st.stats.programs,
    heapMB: st.stats.heapMB,
    triangles: st.stats.triangles,
    calls: st.stats.calls,
    terrain: st.stats.terrain,
    roadsLoaded: st.stats.roadsLoaded,
    rebases: st.stats.rebases,
    ray: { rays: ray.rays, poke: ray.poke, missed: ray.missed, worst: ray.worst },
    sig,
  };
  log(
    name,
    `走行 ${m.travelledKm.toFixed(1)}km 地形 ${m.terrainMeshes} 道路 ${m.roadChunks} 形状(GPU) ${m.geometries} 画像 ${m.textures} ヒープ ${m.heapMB?.toFixed(1)}MB 三角形 ${(m.triangles / 1000).toFixed(0)}k 命令 ${m.calls} 光線 ${ray.rays} 突き抜け ${ray.poke}`,
  );
  await page.evaluate(() => window.__dev.setPaused(false));
  return m;
}

async function drive(label, until) {
  await page.evaluate(() => window.__dev.frames(true));
  const t0 = Date.now();
  await page.waitForFunction(until, null, { timeout: 1800000, polling: 500 });
  const frames = await page.evaluate(() => window.__dev.frames(true));
  const f = summarize(frames.slice(5));
  log(label, `${((Date.now() - t0) / 1000).toFixed(0)}s フレーム間隔 中央 ${f.median.toFixed(1)}ms p95 ${f.p95.toFixed(1)}ms p99 ${f.p99.toFixed(1)}ms 最大 ${f.max.toFixed(0)}ms`);
  return { label, seconds: (Date.now() - t0) / 1000, ...f, all: frames };
}

await waitSettled();
const results = { date: new Date().toISOString(), gpu, speed, legKm: legM / 1000, quality, viewport: "1440x900", measures: [], drives: [] };
results.measures.push(await measure("lap0-start"));

// 1周目: 道を記録しながら片道進み、記録した道を戻る
await page.evaluate((v) => {
  window.__dev.startRecording();
  window.__dev.setSpeed(v);
}, speed);
results.drives.push(await drive("1周目 往路（記録）", `window.__dev.state().travelled >= ${legM}`));
const legs = await page.evaluate(() => window.__dev.legs());
writeFileSync(`${out}/legs.json`, JSON.stringify(legs));
results.measures.push(await measure("lap1-end"));
await page.evaluate((l) => window.__dev.followPlan(l, true), legs);
results.drives.push(await drive("1周目 復路", "window.__dev.state().planDone"));
results.measures.push(await measure("lap1-start"));

// 2周目以降: 記録した道を往復
const laps = Math.max(2, Math.round(100000 / (2 * legM)));
for (let lap = 2; lap <= laps; lap++) {
  await page.evaluate((l) => window.__dev.followPlan(l, false), legs);
  results.drives.push(await drive(`${lap}周目 往路`, "window.__dev.state().planDone"));
  results.measures.push(await measure(`lap${lap}-end`));
  await page.evaluate((l) => window.__dev.followPlan(l, true), legs);
  results.drives.push(await drive(`${lap}周目 復路`, "window.__dev.state().planDone"));
  results.measures.push(await measure(`lap${lap}-start`));
}

const diff = (a, b) => {
  let s = 0;
  let mx = 0;
  for (let i = 0; i < a.length; i++) {
    const d = Math.abs(a[i] - b[i]);
    s += d;
    mx = Math.max(mx, d);
  }
  return { meanAbs: s / a.length, max: mx };
};
const M = Object.fromEntries(results.measures.map((m) => [m.name, m]));
results.sameView = {};
for (let lap = 2; lap <= laps; lap++) {
  results.sameView[`終点 1周目と${lap}周目`] = diff(M["lap1-end"].sig, M[`lap${lap}-end`].sig);
  results.sameView[`起点 1周目と${lap}周目`] = diff(M["lap1-start"].sig, M[`lap${lap}-start`].sig);
}
const moving = results.drives.flatMap((d) => d.all.slice(5));
results.framesAll = summarize(moving);
for (const d of results.drives) delete d.all;
for (const m of results.measures) delete m.sig;
results.errors = errors;
writeFileSync(`${out}/results.json`, JSON.stringify(results, null, 2));
log("移動中の全フレーム", JSON.stringify(results.framesAll));
log("同じ場所の見た目（明るさ 0〜255 の差）", JSON.stringify(results.sameView));
log("エラー", errors.length ? errors.slice(0, 5) : "なし");
log(`保存: ${out}/results.json`);
await browser.close();
