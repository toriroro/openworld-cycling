// 配達 D0 の確認（配達の草案 13 章）: 札幌の中心で注文を受け、受け取りの丁目・届け先の丁目へ走って止まり、結果が出るまで。
// 道は経路の自動選択で走らせる（人が住所から道を選ぶ遊びの確認ではなく、仕組みが通るかの確認）。
// 開発サーバーが動いている前提（MAP_BASE、既定 5180）。node scripts/delivery-d0-check.mjs。結果は artifacts/delivery/d0。

import { chromium } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";

const base = process.env.MAP_BASE || "http://localhost:5180";
const out = process.env.OUT || "artifacts/delivery/d0";
const ORDERS = Number(process.env.ORDERS || 2);
mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || "chrome", headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
await page.goto(`${base}/?world=hokkaido&fresh=1&notitle=1&time=10&weather=clear`);
const settle = () => page.waitForFunction(() => window.__dev?.state().ready && window.__dev.state().settled, null, { timeout: 240000, polling: 250 });
await settle();
await page.waitForFunction(() => window.__dev.game.addresses !== null, null, { timeout: 60000 });
const snap = (name) => page.screenshot({ path: `${out}/${name}.png` });
const result = { addresses: await page.evaluate(() => window.__dev.game.addresses.points.length), orders: [], errors };

// 住宅街の道（等級 2・幅 6m）が走る道に入っているか
result.streets = await page.evaluate(() => {
  let n = 0;
  let km = 0;
  for (const r of window.__dev.roads.net.roads.values())
    if (r.cls === 2 && r.width === 6) {
      n++;
      km += r.length / 1000;
    }
  return { roads: n, km: Math.round(km * 10) / 10 };
});

for (let k = 0; k < ORDERS; k++) {
  const g = () => window.__dev.game;
  // メニューの「配達」ボタンから開く
  await page.click(".menu-btn");
  await page.getByRole("button", { name: "配達", exact: true }).click();
  await page.waitForTimeout(300);
  await snap(`order-${k + 1}`);
  const order = await page.evaluate(() => {
    const o = window.__dev.game.offer;
    return o && { pickup: o.pickup.name, dropoff: o.dropoff.name, approach: Math.round(o.approach), distance: Math.round(o.distance), limit: o.limit, reward: o.reward, pts: [o.pickup, o.dropoff].map((p) => ({ x: p.x, z: p.z })) };
  });
  if (!order) {
    result.orders.push({ error: "注文が出ない" });
    break;
  }
  await page.evaluate(() => window.__dev.game.acceptOrder());
  const legs = [];
  for (const [i, pt] of order.pts.entries()) {
    const phase0 = i === 0 ? "pickup" : "dropoff";
    const t0 = await page.evaluate(() => window.__dev.game.ride.time);
    const planned = await page.evaluate(({ x, z }) => {
      const gm = window.__dev.game;
      gm.timeScale = 4;
      gm.input.pedalKey = true;
      gm.input.brakeKey = false;
      return gm.ride.setGoal(x, z);
    }, pt);
    // 着くまで（経路の終わり）走らせる
    let state = null;
    const deadline = Date.now() + 240000;
    let shot = false;
    while (Date.now() < deadline) {
      await page.waitForTimeout(500);
      state = await page.evaluate(() => {
        const gm = window.__dev.game;
        const r = gm.ride;
        return { reached: r.goalReached, hasGoal: !!r.goal, speed: r.speed, odo: r.odometer, choices: r.upcoming?.choices.length ?? 0 };
      });
      if (!shot && state.odo > 0 && state.choices >= 3) {
        await snap(`order-${k + 1}-${phase0}-junction`);
        shot = true;
      }
      if (state.reached || !state.hasGoal) break;
    }
    // 止まる
    await page.evaluate(() => {
      const gm = window.__dev.game;
      gm.input.pedalKey = false;
      gm.input.brakeKey = true;
    });
    await page.waitForFunction(() => window.__dev.game.ride.speed < 0.3, null, { timeout: 30000 });
    await page.waitForTimeout(600);
    const after = await page.evaluate(() => {
      const gm = window.__dev.game;
      const p = gm.ride.pose();
      return { phase: gm.delivery?.phase ?? "done", here: gm.addresses.at(p.x, p.z)?.name ?? null, time: gm.ride.time, x: Math.round(p.x), z: Math.round(p.z) };
    });
    await snap(`order-${k + 1}-${phase0}-stopped`);
    legs.push({ planned, reached: state?.reached ?? false, seconds: Math.round(after.time - t0), ...after });
    await page.evaluate(() => (window.__dev.game.input.brakeKey = false));
    if (after.phase === phase0) break; // 着いたことにならなかった
  }
  const panel = await page.evaluate(() => document.querySelector(".delivery-panel")?.innerText ?? "");
  result.orders.push({ order, legs, panel, money: await page.evaluate(() => window.__dev.game.money) });
  await page.evaluate(() => window.__dev.game.deliveryPanel.hide());
}

// 地図: 丁目の名前（短い形・正式の形）と、案内「地図に行き先の印」
await page.evaluate(() => {
  const gm = window.__dev.game;
  gm.deliveryGuide = "map";
  gm.openDelivery();
  gm.acceptOrder();
  gm.timeScale = 1;
  gm.toggleMap();
});
await page.waitForTimeout(1500);
for (const [name, mpp] of [
  ["map-short", 2.4],
  ["map-full", 1.2],
  ["map-wide", 6],
]) {
  await page.evaluate((mpp) => {
    const m = window.__dev.game.mapOverlay.map;
    const t = window.__dev.game.delivery.target;
    m.setView((t.x + window.__dev.game.ride.pose().x) / 2, (t.z + window.__dev.game.ride.pose().z) / 2, mpp);
  }, mpp);
  await page.waitForTimeout(1500);
  await snap(name);
}
result.frames = await page.evaluate(() => {
  const f = window.__dev.game.frameDt.slice(-600).sort((a, b) => a - b);
  return { p50: f[Math.floor(f.length * 0.5)], p95: f[Math.floor(f.length * 0.95)] };
});
writeFileSync(`${out}/result.json`, JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
await browser.close();
