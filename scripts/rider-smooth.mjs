// 走行中の自転車の向き・倒し込み・ハンドル・頭の向きを毎フレーム記録し、がたつきを数える。
// node scripts/rider-smooth.mjs [秒数]   （開発サーバーが動いている前提。RIDER_BASE で接続先を変える）
// がたつき = 1フレームごとの変化の変化（2階差分）の絶対値の平均と最大。滑らかなら小さい。

import { chromium } from "@playwright/test";

const seconds = Number(process.argv[2] || 40);
const base = process.env.RIDER_BASE || "http://localhost:5182";
const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage({ viewport: { width: 960, height: 600 } });
await page.goto(`${base}/?power=${process.env.POWER || 260}${process.env.START ? `&x=${process.env.START.split(",")[0]}&z=${process.env.START.split(",")[1]}` : ""}`);
await page.waitForFunction(() => window.__dev?.state().ready && window.__dev.state().settled, null, { timeout: 180000, polling: 250 });
await page.evaluate(() => {
  window.__dev.game.manual.setting = Number(new URLSearchParams(location.search).get("power") || 260);
  window.dispatchEvent(new KeyboardEvent("keydown", { code: "Space" }));
});
await page.waitForTimeout(3000);
const rec = await page.evaluate(
  (seconds) =>
    new Promise((done) => {
      const p = window.__dev.game.player;
      const rows = [];
      const t0 = performance.now();
      const step = () => {
        const g = p.group;
        const e = new g.rotation.constructor().setFromQuaternion(g.quaternion, "YXZ");
        rows.push({ yaw: e.y, lean: p.lean, steer: p.bike.steering.rotation.y, head: p.headYaw ?? 0 });
        if (performance.now() - t0 < seconds * 1000) requestAnimationFrame(step);
        else done(rows);
      };
      requestAnimationFrame(step);
    }),
  seconds,
);
const jerk = (key) => {
  let sum = 0;
  let max = 0;
  let n = 0;
  for (let i = 2; i < rec.length; i++) {
    let a = rec[i][key] - rec[i - 1][key];
    let b = rec[i - 1][key] - rec[i - 2][key];
    if (key === "yaw") {
      a = Math.atan2(Math.sin(a), Math.cos(a));
      b = Math.atan2(Math.sin(b), Math.cos(b));
    }
    const d = Math.abs(a - b);
    sum += d;
    max = Math.max(max, d);
    n++;
  }
  return { mean: +(sum / n).toExponential(2), max: +max.toExponential(2) };
};
const out = { frames: rec.length, yaw: jerk("yaw"), lean: jerk("lean"), steer: jerk("steer"), head: jerk("head"), maxLean: Math.max(...rec.map((r) => Math.abs(r.lean))) };
console.log(JSON.stringify(out));
await browser.close();
