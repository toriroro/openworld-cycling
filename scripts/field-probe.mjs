// 指定した点の近くの道路標識・路面の印・走る道・走らない道を一覧にする（町の見た目の点検の続き）。
// AT=x,z R=m node scripts/field-probe.mjs。開発サーバーは MAP_BASE。
import { chromium } from "@playwright/test";
const base = process.env.MAP_BASE || "http://localhost:5180";
const [x, z] = (process.env.AT || "0,0").split(",").map(Number);
const R = Number(process.env.R || 15);
const browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || "chrome", headless: true });
const page = await browser.newPage({ viewport: { width: 800, height: 500 } });
await page.goto(`${base}/?world=hokkaido&fresh=1&notitle=1&time=11&weather=clear&x=${x}&z=${z}`);
await page.waitForFunction(() => window.__dev?.state().ready && window.__dev.state().settled && window.__dev.game.ride?.road, null, { timeout: 240000, polling: 250 });
const r = await page.evaluate(async ({ x, z, R }) => {
  const d = window.__dev, local = d.view.world.local, SW = local.sidewalks, C = SW.index.cell;
  const out = { signs: [], roads: [], streets: [], junctions: [] };
  for (let i = Math.floor((x - R) / C); i <= Math.floor((x + R) / C); i++)
    for (let j = Math.floor((z - R) / C); j <= Math.floor((z + R) / C); j++)
      for (const t of SW.index.signs[`${i},${j}`] ?? []) {
        const o = t * 8, D = SW.signs;
        if (Math.hypot(D[o] - x, D[o + 2] - z) > R) continue;
        out.signs.push([...D.slice(o, o + 8)].map((v) => +v.toFixed(2)));
      }
  for (const rd of d.roads.net.roads.values()) {
    const P = rd.points;
    for (let i = 0; i < P.length; i += 3)
      if (Math.hypot(P[i] + rd.origin[0] - x, P[i + 2] + rd.origin[1] - z) < R) {
        out.roads.push({ id: rd.id, w: rd.width, cls: rd.cls, name: rd.name, start: rd.start, len: +rd.length.toFixed(1), spans: rd.spans });
        break;
      }
  }
  for (const j of d.roads.net.junctions.values()) if (Math.hypot(j.x - x, j.z - z) < R + 30) out.junctions.push({ id: j.id, x: +j.x.toFixed(1), z: +j.z.toFixed(1), arms: j.arms.length });
  const S = local.streets, SC = S.index.cell;
  for (let i = Math.floor((x - R) / SC); i <= Math.floor((x + R) / SC); i++)
    for (let j = Math.floor((z - R) / SC); j <= Math.floor((z + R) / SC); j++)
      for (const pc of S.cell(i, j) ?? []) {
        const [o, n, w10, kind, ends] = pc;
        const pts = [];
        let near = false;
        for (let k = 0; k < n; k++) {
          const px = S.pts[(o + k) * 2], pz = S.pts[(o + k) * 2 + 1];
          pts.push([+px.toFixed(1), +pz.toFixed(1)]);
          if (Math.hypot(px - x, pz - z) < R) near = true;
        }
        if (near) out.streets.push({ w: w10 / 10, kind: S.index.kinds[kind], ends, pts });
      }
  const { sidewalkHeightAt } = await import("/src/sim/walk-surface.ts");
  out.heights = { sidewalk: sidewalkHeightAt(SW, x, z), terrainTile: d.view.terrain.heightAt(x, z), terrainFn: d.view.heights.height(x, z), road: d.view.roads.surfaceAt(x, z), drawn: d.groundAt([[x, z]])[0], surface: d.view.surfaceHeight(x, z) };
  // 真上からの光線が当たる面（名前・高さ・材質の番号）
  const THREE = await import("/node_modules/.vite/deps/three.js");
  const v = d.view;
  v.scene.updateMatrixWorld(true);
  const rc = new THREE.Raycaster(new THREE.Vector3(x - v.originX, 500, z - v.originZ), new THREE.Vector3(0, -1, 0));
  out.hits = rc.intersectObjects(v.scene.children, true).filter((h) => h.object.visible).slice(0, 12).map((h) => [h.object.name || h.object.parent?.name, +h.point.y.toFixed(2), h.face?.materialIndex]);
  return out;
}, { x, z, R });
console.log(JSON.stringify(r, null, 1));
await browser.close();
