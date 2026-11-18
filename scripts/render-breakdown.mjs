// 1 フレームに描く三角形・描画命令を、物の名前ごと・画面と影に分けて数える（北海道の草案 24 章）。
// renderer.renderBufferDirect を包んで、実際に描いた分（視野の外で省かれた物を除く）だけを数える。
// 開発サーバーが動いている前提（MAP_BASE、既定 5180）。node scripts/render-breakdown.mjs。結果は artifacts/perf/breakdown*.json。
// ONLY=名前,名前 で場所を絞る。QUALITY=light で軽量。

import { chromium } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";

const base = process.env.MAP_BASE || "http://localhost:5180";
const out = process.env.OUT || "artifacts/perf";
const quality = process.env.QUALITY || "standard";
const tag = process.env.TAG ? `-${process.env.TAG}` : "";
mkdirSync(out, { recursive: true });
const PLACES = [
  ["generated", "generated", null, null],
  ["odori", "hokkaido", 240, 40],
  ["kotoni", "hokkaido", -4300, -2300],
  ["jozankei", "hokkaido", -15093, 10137],
  ["farm", "hokkaido", 9752, -11952],
];
const only = process.env.ONLY ? new Set(process.env.ONLY.split(",")) : null;

const browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || "chrome", headless: true });
const result = { quality, places: {} };
for (const [name, world, x, z] of PLACES.filter(([n]) => !only || only.has(n))) {
  const vp = quality === "light" ? { width: 844, height: 390 } : { width: 1440, height: 900 };
  const page = await browser.newPage({ viewport: vp });
  const at = x === null ? "" : `&x=${x}&z=${z}`;
  await page.goto(`${base}/?world=${world}&fresh=1&notitle=1&time=10&weather=clear&quality=${quality}${at}`);
  await page.waitForFunction(() => window.__dev?.state().ready && window.__dev.state().settled, null, { timeout: 300000, polling: 250 });
  await page.waitForTimeout(4000);
  const r = await page.evaluate(async () => {
    const view = window.__dev.view;
    const R = view.renderer;
    const orig = R.renderBufferDirect.bind(R);
    const acc = {};
    const label = (o) => {
      // 場面のすぐ下の組の名前 / 物の名前
      let top = o;
      while (top.parent && top.parent.type !== "Scene") top = top.parent;
      // 地形のタイルは段ごとに分ける
      const own = (o.name || o.type) + (o.name === "terrain" && o.userData.level !== undefined ? `@L${o.userData.level}` : "");
      return top === o ? own : `${top.name || top.type}/${own}`;
    };
    R.renderBufferDirect = (camera, scene, geometry, material, object, group) => {
      const pass = camera.isOrthographicCamera ? "shadow" : "main";
      const idx = geometry.index;
      let n = idx ? idx.count : geometry.attributes.position.count;
      if (group) n = Math.min(n, group.count);
      n = Math.min(n, geometry.drawRange.count);
      const inst = object.isInstancedMesh ? object.count : geometry.isInstancedBufferGeometry ? geometry.instanceCount : 1;
      const tri = object.isMesh ? Math.floor(n / 3) * inst : 0;
      // インスタンス描画は 1 個あたりの三角形の数も付ける（同じ名前の物を分ける）
      const k = label(object) + (object.isInstancedMesh ? `[${Math.floor(n / 3)}]` : "");
      const a = (acc[k] ??= { main: 0, shadow: 0, mainCalls: 0, shadowCalls: 0 });
      a[pass] += tri;
      a[pass + "Calls"]++;
      return orig(camera, scene, geometry, material, object, group);
    };
    const origRender = R.render.bind(R);
    let frames = 0;
    R.render = (sc, cam) => {
      frames++;
      return origRender(sc, cam);
    };
    await new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(res))));
    R.renderBufferDirect = orig;
    R.render = origRender;
    for (const a of Object.values(acc)) for (const k of Object.keys(a)) a[k] = Math.round(a[k] / frames);
    const s = view.stats();
    return { acc, triangles: s.triangles, calls: s.calls, frames, stats: { vegetation: s.vegetation, realBuildings: s.realBuildings, realStreets: s.realStreets } };
  });
  const rows = Object.entries(r.acc).sort((a, b) => b[1].main + b[1].shadow - (a[1].main + a[1].shadow));
  const sum = rows.reduce((t, [, v]) => ({ main: t.main + v.main, shadow: t.shadow + v.shadow, calls: t.calls + v.mainCalls + v.shadowCalls }), { main: 0, shadow: 0, calls: 0 });
  result.places[name] = { sum, rows, info: { triangles: r.triangles, calls: r.calls }, stats: r.stats };
  console.log(`\n== ${name}  画面 ${(sum.main / 1e4).toFixed(1)}万 影 ${(sum.shadow / 1e4).toFixed(1)}万 命令 ${sum.calls}`);
  console.log(JSON.stringify(r.stats));
  for (const [k, v] of rows.slice(0, 22)) console.log(`${k.padEnd(44)} 画面 ${(v.main / 1e4).toFixed(1).padStart(5)}万 (${v.mainCalls})  影 ${(v.shadow / 1e4).toFixed(1).padStart(5)}万 (${v.shadowCalls})`);
  await page.close();
}
writeFileSync(`${out}/breakdown${quality === "light" ? "-light" : ""}${tag}.json`, JSON.stringify(result, null, 2));
await browser.close();
