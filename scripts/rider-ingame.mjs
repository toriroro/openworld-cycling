// ゲームの中で自分の自転車とライダーを確かめる: 後方・一人称・ドローンの視点、近くから、設定画面、描画量。
// node scripts/rider-ingame.mjs <出力先>   （開発サーバーが動いている前提。RIDER_BASE で接続先を変える）
// 描画量は、自分の自転車とライダーをシーンから外した時との差（標準は影の描画を含む）。

import { chromium } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";

const out = process.argv[2] || "artifacts/rider/after";
const base = process.env.RIDER_BASE || "http://localhost:5182";
mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ channel: "chrome", headless: true });
const result = { date: new Date().toISOString(), base, budget: {}, errors: [] };

async function open(w, h, query) {
  const page = await browser.newPage({ viewport: { width: w, height: h } });
  page.on("pageerror", (e) => result.errors.push(String(e)));
  page.on("console", (m) => m.type() === "error" && !m.text().includes("404") && result.errors.push(m.text()));
  await page.goto(`${base}/?${query}`);
  await page.waitForFunction(() => window.__dev?.state().ready && window.__dev.state().settled, null, { timeout: 180000, polling: 250 });
  await page.evaluate(() => window.dispatchEvent(new KeyboardEvent("keydown", { code: "Space" })));
  await page.waitForTimeout(4000);
  return page;
}

for (const [quality, w, h] of [["standard", 1440, 900], ["light", 844, 390]]) {
  const page = await open(w, h, `quality=${quality}`);
  const r = {};
  for (const cam of ["chase", "rider", "drone"]) {
    await page.evaluate((c) => {
      window.__dev.game.paused = false;
      window.__dev.game.camera = c;
    }, cam);
    await page.waitForTimeout(1500);
    if (quality === "standard") await page.screenshot({ path: `${out}/camera-${cam}.png` });
    await page.evaluate(() => (window.__dev.game.paused = true));
    await page.waitForTimeout(500);
    const on = await page.evaluate(() => window.__dev.state().stats);
    await page.evaluate(() => {
      const g = window.__dev.game.player.group;
      window.__pp = g.parent;
      g.parent.remove(g);
    });
    await page.waitForTimeout(500);
    const off = await page.evaluate(() => window.__dev.state().stats);
    await page.evaluate(() => window.__pp.add(window.__dev.game.player.group));
    r[cam] = { calls: on.calls - off.calls, tris: on.triangles - off.triangles, totalCalls: on.calls, totalTris: on.triangles };
  }
  r.model = await page.evaluate(() => window.__dev.game.player.stats());
  result.budget[quality] = r;
  console.log(quality, JSON.stringify(r));
  if (quality === "standard") {
    // 近くから（一時停止して、自転車の座標に置いたカメラで描く）
    await page.evaluate(() => (window.__dev.game.camera = "chase"));
    await page.waitForTimeout(300);
    const angles = { "close-left": [2.6, 1.0, 0.1], "close-right": [-2.6, 1.0, 0.1], "close-front34": [1.6, 1.5, 2.2], "close-rear34": [-1.5, 1.6, -2.3], "close-top": [0.6, 3.2, -0.6], "close-face": [0.35, 1.45, 1.1] };
    for (const [name, [x, y, z]] of Object.entries(angles)) {
      await page.evaluate(
        ([x, y, z, face]) => {
          const v = window.__dev.view;
          const p = window.__dev.game.player.group;
          const V = p.position.constructor;
          if (!v.__origRender) v.__origRender = v.renderer.render.bind(v.renderer);
          const cam = v.camera.clone();
          cam.fov = face ? 30 : 34;
          cam.near = 0.05;
          cam.updateProjectionMatrix();
          v.renderer.render = (scene) => {
            p.updateMatrixWorld(true);
            cam.position.copy(p.localToWorld(new V(x, y, z)));
            cam.lookAt(p.localToWorld(new V(0, face ? 1.35 : 0.75, face ? 0.2 : 0)));
            v.__origRender(scene, cam);
          };
        },
        [x, y, z, name === "close-face"],
      );
      await page.waitForTimeout(500);
      await page.screenshot({ path: `${out}/${name}.png` });
    }
    await page.evaluate(() => (window.__dev.view.renderer.render = window.__dev.view.__origRender));
    // メニューから設定画面を開く
    await page.click(".menu-btn");
    await page.waitForTimeout(200);
    await page.getByRole("button", { name: "自転車と装い" }).click();
    await page.waitForTimeout(1200);
    await page.screenshot({ path: `${out}/outfit-panel.png` });
    await page.click(".of-row:nth-child(1) .of-choice:nth-child(1)"); // エアロ
    await page.click(".of-row:nth-child(2) .of-swatch:nth-child(8)");
    await page.waitForTimeout(600);
    await page.screenshot({ path: `${out}/outfit-panel-changed.png` });
    result.outfit = await page.evaluate(() => window.__dev.game.outfit);
    await page.getByRole("button", { name: "閉じる" }).click();
    await page.waitForTimeout(300);
    result.pausedAfterClose = await page.evaluate(() => window.__dev.game.paused);
  }
  await page.close();
}
writeFileSync(`${out}/results.json`, JSON.stringify(result, null, 2));
console.log("errors", result.errors.length, "outfit", JSON.stringify(result.outfit?.bike), "paused after close", result.pausedAfterClose);
await browser.close();
