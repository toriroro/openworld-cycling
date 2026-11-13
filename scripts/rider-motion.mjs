// ゲームの中でライダーの動きを確かめる: カーブでの倒し込みとハンドルの向き、後方確認、ペダリング（足首）の連続写真。
// node scripts/rider-motion.mjs <出力先>   （開発サーバーが動いている前提。RIDER_BASE で接続先を変える）

import { chromium } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";

const out = process.argv[2] || "artifacts/rider/motion";
const base = process.env.RIDER_BASE || "http://localhost:5182";
mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
await page.goto(`${base}/`);
await page.waitForFunction(() => window.__dev?.state().ready && window.__dev.state().settled, null, { timeout: 180000, polling: 250 });
await page.evaluate(() => {
  window.__dev.game.manual.setting = 260;
  window.dispatchEvent(new KeyboardEvent("keydown", { code: "Space" }));
});

// 自転車の座標に置いたカメラで描く
const closeCam = (x, y, z, ty = 0.75) =>
  page.evaluate(
    ([x, y, z, ty]) => {
      const v = window.__dev.view;
      const p = window.__dev.game.player.group;
      const V = p.position.constructor;
      if (!v.__origRender) v.__origRender = v.renderer.render.bind(v.renderer);
      const cam = v.camera.clone();
      cam.fov = 34;
      cam.near = 0.05;
      cam.updateProjectionMatrix();
      v.renderer.render = (scene) => {
        p.updateMatrixWorld(true);
        cam.position.copy(p.localToWorld(new V(x, y, z)));
        cam.lookAt(p.localToWorld(new V(0, ty, 0)));
        v.__origRender(scene, cam);
      };
    },
    [x, y, z, ty],
  );
const sample = () =>
  page.evaluate(() => {
    const pl = window.__dev.game.player;
    const g = pl.group;
    g.updateMatrixWorld(true);
    // 倒れている向き: 上の点が自転車の左右どちらにずれているか（+ が左）。曲がる向き: 前方が左右どちらへ回っているか
    const V = g.position.constructor;
    const up = new V(0, 1, 0).applyQuaternion(g.quaternion);
    const right = new V(1, 0, 0).applyQuaternion(g.quaternion.clone().multiply(g.quaternion.clone().set(0, 0, Math.sin(pl.lean / 2), Math.cos(pl.lean / 2))));
    return { lean: pl.lean, steer: pl.steer, headYaw: pl.headYaw, upTowardLeft: up.dot(right), steeringRotY: pl.bike.steering.rotation.y };
  });

// 1. 曲がる（BRANCH=1 の時だけ）: 分岐で大きく曲がる道を選び、ハンドルが最も切れた所を撮る
let curve = null;
if (process.env.BRANCH) {
await page.evaluate(() => (window.__dev.game.manual.setting = 400));
const pick = await page
  .waitForFunction(
    () => {
      const u = window.__dev.game.ride?.upcoming;
      if (!u || u.distance > 80) return null;
      let best = -1;
      u.choices.forEach((c, i) => {
        if (Math.abs(c.angle) > 0.9 && (best < 0 || Math.abs(c.angle) > Math.abs(u.choices[best].angle))) best = i;
      });
      return best >= 0 ? { index: best, angle: u.choices[best].angle } : null;
    },
    null,
    { timeout: 600000, polling: 200 },
  )
  .then((h) => h.jsonValue());
await page.evaluate((i) => window.__dev.game.ride.choose(i), pick.index);
for (let i = 0; i < 300; i++) {
  await page.waitForTimeout(100);
  const s = await sample();
  if (!curve || Math.abs(s.steer) > Math.abs(curve.steer)) {
    curve = { ...s, branchAngle: pick.angle };
    if (Math.abs(s.steer) > 0.03) await page.screenshot({ path: `${out}/turn-chase.png` });
  }
}
await page.evaluate(() => (window.__dev.game.paused = true));
await closeCam(0.4, 2.2, 2.6, 0.9);
await page.waitForTimeout(300);
await page.screenshot({ path: `${out}/after-turn-front.png` });
await page.evaluate(() => {
  window.__dev.view.renderer.render = window.__dev.view.__origRender;
  window.__dev.game.paused = false;
});
await page.waitForTimeout(3000);
}
console.log("curve", JSON.stringify(curve));

// 2. 右へ寄せる: 右の肩越しに後方を見て、ハンドルを右へ切る。いちばん切れた所で止めて撮る
await page.evaluate(() => (window.__dev.game.manual.setting = 200));
await page.waitForTimeout(4000);
await page.evaluate(() => {
  window.dispatchEvent(new KeyboardEvent("keydown", { code: "KeyD" }));
  window.dispatchEvent(new KeyboardEvent("keyup", { code: "KeyD" }));
});
let lane = null;
for (let i = 0; i < 40; i++) {
  await page.waitForTimeout(50);
  const s = await sample();
  if (!lane || Math.abs(s.steer) > Math.abs(lane.steer)) lane = s;
  if (i === 12) {
    await page.evaluate(() => (window.__dev.game.paused = true));
    lane = { ...(await sample()), at: "pause" };
    break;
  }
}
await closeCam(-1.7, 1.6, -1.4, 1.1);
await page.waitForTimeout(300);
await page.screenshot({ path: `${out}/lane-right-look.png` });
await closeCam(-0.6, 2.0, 2.4, 0.9);
await page.waitForTimeout(300);
await page.screenshot({ path: `${out}/lane-right-steer.png` });
await page.evaluate(() => (window.__dev.view.renderer.render = window.__dev.view.__origRender));
console.log("lane", JSON.stringify(lane));

// 3. ペダリング: 右から 1/4 回転ずつ
await page.evaluate(() => (window.__dev.game.paused = true));
const frames = [];
for (let k = 0; k < 4; k++) {
  await page.evaluate((k) => {
    const pl = window.__dev.game.player;
    pl.pose(0, { phase: (k * Math.PI) / 2, speed: 8, watts: 200, distance: 0, steer: 0, lean: 0, firstPerson: false });
  }, k);
  await closeCam(-1.9, 0.7, 0.15, 0.55);
  await page.waitForTimeout(250);
  await page.screenshot({ path: `${out}/pedal-${k * 90}.png` });
  frames.push(await page.evaluate(() => window.__dev.game.player.bike.pedalPitch(-1)));
}
writeFileSync(`${out}/results.json`, JSON.stringify({ curve, lane, pedalPitchRight: frames, errors }, null, 2));
console.log("errors", errors.length);
await browser.close();
