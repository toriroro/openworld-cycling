// 配達 D2 の確認（配達の草案 16 章）: 歩く人、道端の頼み事（忘れ物・書類・買い物）、旗の立つ家（家からの発送）、
// 配達アプリの受け取りが店になること、常連の店からの知らせ、保存して読み直す。
// 開発サーバーが動いている前提（MAP_BASE、既定 5180）。node scripts/delivery-d2-check.mjs。結果は artifacts/delivery/d2。

import { chromium } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";

const base = process.env.MAP_BASE || "http://localhost:5180";
const out = process.env.OUT || "artifacts/delivery/d2";
mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || "chrome", headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await context.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
const settle = () => page.waitForFunction(() => window.__dev?.state().ready && window.__dev.state().settled, null, { timeout: 240000, polling: 250 });
const snap = (name) => page.screenshot({ path: `${out}/${name}.png` });
const g = (fn, arg) => page.evaluate(fn, arg);
const result = { errors };

await page.goto(`${base}/?world=hokkaido&fresh=1&notitle=1&time=11&weather=clear`);
await settle();
await page.waitForFunction(() => window.__dev.game.streetWork !== null && window.__dev.game.ride?.road, null, { timeout: 60000 });
await page.click(".menu-btn");
await page.selectOption("label.menu-row:has-text('配達の案内') select", "route");
await page.click(".menu-btn");
await g(() => {
  const gm = window.__dev.game;
  gm.appOn = false;
  gm.timeScale = 6;
});
await page.waitForTimeout(2500);

// 1. 近くにある物の数
result.near = await g(() => {
  const gm = window.__dev.game;
  const p = gm.ride.pose();
  const sw = gm.streetWork;
  sw.forget();
  sw.refresh(p.x, p.z, gm.ride.time, Date.now() / 1000 + gm.workClockOffset);
  return {
    errands: sw.errands.map((e) => ({ kind: e.kind, d: Math.round(Math.hypot(e.roadX - p.x, e.roadZ - p.z)) })),
    flags: sw.flags.length,
    mealShops: sw.shopPlaces(p.x, p.z, 800, [5, 6, 13, 14, 19]).length,
    goodsShops: sw.shopPlaces(p.x, p.z, 650, [0, 1, 2, 9, 16, 17, 18, 22, 23, 26]).length,
    drawn: { ...gm.view.pedestrians.stats },
  };
});
await snap("1-street");

/** 世界の時刻を窓ごとに進めて、条件に合う頼み事・旗の家が近くに出るまで探す */
const findAsk = (kind) =>
  g((kind) => {
    const gm = window.__dev.game;
    const sw = gm.streetWork;
    const p = gm.ride.pose();
    for (let i = 0; i < 60; i++) {
      sw.forget();
      sw.refresh(p.x, p.z, gm.ride.time, Date.now() / 1000 + gm.workClockOffset);
      const hit = kind === "house" ? sw.flags[0] : sw.errands.find((e) => e.kind === kind || (kind === "any" && e.kind !== "shopping"));
      if (hit) {
        const at = kind === "house" ? hit.spot : { x: hit.roadX, z: hit.roadZ };
        return { tries: i, x: at.x, z: at.z, d: Math.round(Math.hypot(at.x - p.x, at.z - p.z)) };
      }
      gm.workClockOffset += 600;
    }
    return null;
  }, kind);

/** 見つけた所を地図で押した時と同じに行き先にし、止まって知らせが出るまで待つ */
async function goAsk(at, shot) {
  await g(({ x, z }) => {
    const gm = window.__dev.game;
    const s = gm.streetWork.snap(x, z);
    gm.stopAtGoal = !!s;
    gm.ride.setGoal(s.x, s.z);
    gm.setPace(2);
  }, at);
  await page.waitForSelector(".offer-card:not(.hidden)", { timeout: 240000 });
  await snap(shot);
  return page.evaluate(() => document.querySelector(".offer-card").innerText);
}

/** 受けて、自動の経路で届けるまで待つ */
async function deliver(shotRide) {
  await page.getByRole("button", { name: "受ける", exact: true }).click();
  const order = await g(() => {
    const o = window.__dev.game.delivery?.order;
    return o ? { kind: o.kind, source: o.source, pickup: o.pickup.name, pickupKind: o.pickup.kind ?? "chome", dropoff: o.dropoff.name, dropoffKind: o.dropoff.kind ?? "chome", distance: Math.round(o.distance), limit: o.limit, reward: o.reward } : null;
  });
  const t0 = Date.now();
  let shot = false;
  let marks = 0;
  while (Date.now() - t0 < 420000) {
    await page.waitForTimeout(1000);
    const st = await g(() => ({ panel: !document.querySelector(".delivery-panel").classList.contains("hidden"), speed: window.__dev.game.ride.speed, marks: window.__dev.game.view.pedestrians.stats.marks, phase: window.__dev.game.delivery?.phase }));
    marks = Math.max(marks, st.marks);
    if (!shot && st.speed > 3 && shotRide) {
      await snap(shotRide);
      shot = true;
    }
    if (st.panel) break;
  }
  const panel = await page.evaluate(() => document.querySelector(".delivery-panel").innerText);
  await g(() => window.__dev.game.deliveryPanel.hide());
  return { order, panel, seconds: Math.round((Date.now() - t0) / 1000), maxMarks: marks };
}

// 2. 道端の頼み事（忘れ物・書類）
const a1 = await findAsk("any");
result.errand = { found: a1 };
if (a1) {
  result.errand.card = await goAsk(a1, "2-errand-card");
  result.errand.run = await deliver("3-errand-riding");
}

// 3. 家からの発送
const a2 = await findAsk("house");
result.house = { found: a2 };
if (a2) {
  result.house.card = await goAsk(a2, "4-house-card");
  result.house.run = await deliver(null);
}

// 4. 買い物（店で受け取り、頼んだ人へ）
const a3 = await findAsk("shopping");
result.shopping = { found: a3 };
if (a3) {
  result.shopping.card = await goAsk(a3, "5-shopping-card");
  result.shopping.run = await deliver("6-shopping-riding");
}

// 5. 配達アプリの受け取りは店 / 常連の店からの知らせ
result.app = await g(() => {
  const gm = window.__dev.game;
  const p = gm.ride.pose();
  const o = gm.appOrder(p.x, p.z, 900, 12345);
  return o ? { pickup: o.pickup.name, kind: o.pickup.kind, id: o.pickup.id, reward: o.reward } : null;
});
if (result.app?.id) {
  await g((id) => {
    const gm = window.__dev.game;
    // 届けて止まった所が喫茶店の前だと立ち寄りの画面が開いていて、知らせは出ない。閉じて出発する
    if (gm.stop) gm.depart();
    gm.regulars[id] = 3;
    gm.nextOfferAt = 0;
  }, result.app.id);
  await page.waitForSelector(".offer-card:not(.hidden)", { timeout: 60000 });
  await snap("7-regular-card");
  result.regular = { card: await page.evaluate(() => document.querySelector(".offer-card").innerText) };
  await page.getByRole("button", { name: "見送る", exact: true }).click();
}

// 走っている間のフレーム間隔（読み直す前の 600 フレーム）
result.frames = await g(() => {
  const f = window.__dev.game.frameDt.slice(-600).sort((a, b) => a - b);
  return { p50: f[Math.floor(f.length * 0.5)], p95: f[Math.floor(f.length * 0.95)] };
});

// 6. 保存して読み直す
const pick = () => g(() => ({ money: window.__dev.game.money, delivered: window.__dev.game.delivered, regulars: window.__dev.game.regulars }));
await g(() => window.__dev.save());
const saved = await pick();
await page.goto(`${base}/?world=hokkaido&notitle=1&time=11&weather=clear`);
await page.waitForFunction(() => window.__dev?.state().ready, null, { timeout: 240000 });
const loaded = await pick();
result.save = { saved, loaded, same: JSON.stringify(saved) === JSON.stringify(loaded) };

// 夕方の人の数（夜は減る）
await page.waitForFunction(() => window.__dev.game.ride?.road && window.__dev.game.streetWork, null, { timeout: 120000 });
await page.waitForTimeout(2000);
result.walkersDay = await g(() => window.__dev.game.view.pedestrians.stats.walkers);
await page.setViewportSize({ width: 390, height: 844 });
await page.waitForTimeout(1500);
await snap("8-portrait");
writeFileSync(`${out}/result.json`, JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
await browser.close();
