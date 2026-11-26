// 掘割とアンダーパスの確認（配達の草案 31 章）: 北5東7 付近の真駒内篠路線（JR の高架の下）を、中から・見上げて・入口の側から撮る。
// 開発サーバーが動いている前提（http://localhost:5180）。node scripts/underpass-shots.mjs。写真は artifacts/tmp（確かめた物は artifacts/ux32/underpass へ写した）。
import { chromium } from "@playwright/test";
import { mkdirSync } from "node:fs";
mkdirSync("artifacts/tmp", { recursive: true });
const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await (await browser.newContext({ viewport: { width: 1200, height: 700 } })).newPage();
const errs = []; page.on("pageerror", (e) => errs.push(String(e)));
await page.goto(`http://localhost:5180/?world=hokkaido&fresh=1&notitle=1&time=11&weather=clear&x=1325&z=-960`);
await page.waitForFunction(() => window.__dev?.state().ready && window.__dev.state().settled && window.__dev.game.ride?.road, null, { timeout: 240000, polling: 250 });
await page.waitForTimeout(3000);
console.log(JSON.stringify(await page.evaluate(() => ({ stats: window.__dev.view.cutWalls.stats, t: (() => { const t0 = performance.now(); const g = window.__dev.game; g.view.cutWalls.key = ""; g.view.cutWalls.update(g.roads.net.roads.values(), g.view.heights, g.view.originX, g.view.originZ, g.ride.pose().x, g.ride.pose().z, g.roads.net.version); return Math.round(performance.now() - t0); })() }))));
for (const [name, look] of [["w-in", 0], ["w-up", 1], ["w-above", 2], ["w-portal", 3]]) {
  await page.evaluate(([look]) => {
    const gm = window.__dev.game; const v = gm.view; const p = gm.ride.pose();
    let eye, target;
    if (look === 0) { eye = { x: p.x - p.dx * 6, y: p.y + 2, z: p.z - p.dz * 6 }; target = { x: p.x + p.dx * 40, y: p.y + 2, z: p.z + p.dz * 40 }; }
    else if (look === 1) { eye = { x: p.x, y: p.y + 1.6, z: p.z }; target = { x: p.x + p.dx * 10 - p.dz * 8, y: p.y + 6, z: p.z + p.dz * 10 + p.dx * 8 }; }
    else if (look === 2) { eye = { x: p.x - p.dz * 50 - p.dx * 30, y: p.y + 45, z: p.z + p.dx * 50 - p.dz * 30 }; target = { x: p.x, y: p.y, z: p.z }; }
    else { eye = { x: p.x - p.dx * 70, y: p.y + 6, z: p.z - p.dz * 70 }; target = { x: p.x, y: p.y + 2, z: p.z }; }
    if (!v.__frame) v.__frame = v.frame.bind(v);
    v.frame = (_e, _t, _f, cb) => v.__frame(eye, target, 60, cb);
  }, [look]);
  await page.waitForTimeout(1200);
  await page.screenshot({ path: `artifacts/tmp/${name}.png` }).catch(() => {});
}
console.log(errs);
await browser.close();
