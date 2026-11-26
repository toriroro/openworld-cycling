// 配達の草案 28 章の確認（402×874 と 874×402、タッチ）:
// 1. 起動画面の遊び方（配達・サイクリング）と、メニューの欄
// 2. 体力を戻す所（自販機・牛丼屋・定食屋）: 近くに出る数、前で止まると札が出て、買うと体力が戻る。地図の印
// 3. 受注のカットイン
// 4. 車に当たった時: 自転車が跳ねて横へずれ、車は逆へ寄りながら減速して止まる（本物の交通の車を自転車の位置へ置く）
// 5. NPC の配達員と、止まって荷を届ける業者の車の運転手
// 6. サイクリングでは配達の物（配達アプリ・体力）が出ない
// 開発サーバーが動いている前提（MAP_BASE、既定 5180）。node scripts/ux28-check.mjs。結果は artifacts/ux28。

import { chromium } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";

const base = process.env.MAP_BASE || "http://localhost:5180";
const out = process.env.OUT || "artifacts/ux28";
mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || "chrome", headless: true });
const context = await browser.newContext({ viewport: { width: 402, height: 874 }, deviceScaleFactor: 2, hasTouch: true });
const page = await context.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
const g = (fn, arg) => page.evaluate(fn, arg);
const snap = (name) => page.screenshot({ path: `${out}/${name}.png` });
const result = { errors };
const save = () => writeFileSync(`${out}/result.json`, JSON.stringify(result, null, 2));
const wait = (fn, arg, ms = 120000) => page.waitForFunction(fn, arg, { timeout: ms, polling: 200 }).then(() => true).catch(() => false);
const ready = () => page.waitForFunction(() => window.__dev?.state().ready && window.__dev.state().settled && window.__dev.game.ride?.road, null, { timeout: 240000, polling: 250 });

// 1. 起動画面（初めては配達）
await page.goto(`${base}/?title=1&time=11&weather=clear&touch=1`);
await page.waitForSelector(".title-screen:not(.hidden)", { timeout: 240000 });
result.title = await g(() => ({
  modes: [...document.querySelectorAll(".title-modes .btn")].map((b) => `${b.textContent}${b.classList.contains("current") ? "（選択）" : ""}`),
  world: !!document.querySelector(".title-world"),
  buttons: [...document.querySelectorAll(".title-buttons .btn")].map((b) => b.textContent),
}));
await snap("1-title-delivery");
// サイクリングへ切り替える（読み込み直す）
await page.locator(".title-modes .btn", { hasText: "サイクリング" }).click();
await page.waitForSelector(".title-screen:not(.hidden) .title-modes .btn.current", { timeout: 240000 });
await page.waitForFunction(() => document.querySelector(".title-modes .btn.current")?.textContent === "サイクリング", null, { timeout: 240000 });
result.titleCycling = await g(() => ({
  modes: [...document.querySelectorAll(".title-modes .btn")].map((b) => `${b.textContent}${b.classList.contains("current") ? "（選択）" : ""}`),
  worlds: [...document.querySelectorAll(".title-world .btn")].map((b) => b.textContent),
  buttons: [...document.querySelectorAll(".title-buttons .btn")].map((b) => b.textContent),
}));
await snap("1b-title-cycling");
await page.locator(".title-buttons .btn", { hasText: "続きから" }).or(page.locator(".title-buttons .btn", { hasText: "はじめから" })).first().click();
if (await page.locator(".title-buttons .btn", { hasText: "自由ではじめる" }).count()) await page.locator(".title-buttons .btn", { hasText: "自由ではじめる" }).click();
await ready();
await page.waitForTimeout(1500);
const menuOf = () =>
  g(() => ({
    sections: [...document.querySelectorAll(".menu .menu-head")].map((e) => e.textContent),
    top: [...document.querySelectorAll(".menu .menu-main .btn")].map((b) => b.textContent),
    mode: [...document.querySelectorAll(".menu > .menu-section")[0].querySelectorAll(".menu-buttons .btn")].map((b) => b.textContent),
    modeRows: [...document.querySelectorAll(".menu > .menu-section")[0].querySelectorAll(".menu-row span:first-child")].map((e) => e.textContent),
    other: [...[...document.querySelectorAll(".menu > .menu-section")].at(-1).querySelectorAll(".menu-buttons .btn")].map((b) => b.textContent),
    settings: [...document.querySelectorAll(".menu .menu-settings .menu-row span:first-child")].map((e) => e.textContent),
  }));
await page.click(".menu-btn");
result.menuCycling = await menuOf();
result.cyclingHud = await g(() => ({ phone: !document.querySelector(".phone")?.closest(".hidden") && !!document.querySelector(".phone:not(.hidden)"), gauges: [...document.querySelectorAll(".gauge:not(.hidden)")].length, deliveryArea: !!window.__dev.game.deliveryArea }));
await snap("1c-menu-cycling");
await page.click(".menu-btn");
// 配達へ戻す
await g(() => window.__dev.game.showTitle());
await page.locator(".title-modes .btn", { hasText: "配達" }).click();
await page.waitForFunction(() => document.querySelector(".title-modes .btn.current")?.textContent === "配達", null, { timeout: 240000 });
await page.locator(".title-buttons .btn.primary").click();
await page.waitForFunction(() => window.__dev?.state().ready && window.__dev.state().settled && window.__dev.game.deliveryArea && window.__dev.game.ride?.road, null, { timeout: 240000, polling: 250 });
await page.waitForTimeout(2000);
await page.click(".menu-btn");
result.menuDelivery = await menuOf();
await snap("1d-menu-delivery");
await page.locator(".menu-settings > summary").click();
await page.waitForTimeout(200);
await snap("1e-menu-settings-open");
await page.click(".menu-btn");
save();

// 2. 体力を戻す所
await page.waitForTimeout(1500);
const rests = () => g(() => window.__dev.game.restStops.map((s) => ({ id: s.id, kind: s.kind, x: s.x, z: s.z, roadX: s.roadX, roadZ: s.roadZ })));
let list = await rests();
result.rests = { near: list.length, byKind: list.reduce((a, s) => ((a[s.kind] = (a[s.kind] ?? 0) + 1), a), {}), drawn: await g(() => window.__dev.game.view.restStops.stats) };
// 店（牛丼屋か定食屋）の前へ移って止まる
const shop = list.find((s) => s.kind !== "vending");
const vend = list.find((s) => s.kind === "vending");
const visit = async (st, name) => {
  await g((st) => {
    const gm = window.__dev.game;
    gm.setPace(0);
    gm.teleport(st.roadX, st.roadZ);
  }, st);
  await page.waitForFunction(() => window.__dev.game.ride?.road && window.__dev.state().settled, null, { timeout: 120000, polling: 250 });
  const shown = await wait(() => !document.querySelector(".rest-card").classList.contains("hidden"), null, 15000);
  await page.waitForTimeout(800);
  await snap(name);
  // 手前から見る: 同じ道を 28m 戻って止まる（物は前の左右に見える）
  await g(() => {
    const r = window.__dev.game.ride;
    r.pos = { ...r.pos, s: r.pos.s - r.pos.dir * 28 };
    r.speed = 0;
  });
  await page.waitForTimeout(1500);
  await snap(`${name}-approach`);
  await g(() => {
    const r = window.__dev.game.ride;
    r.pos = { ...r.pos, s: r.pos.s + r.pos.dir * 28 };
  });
  await wait(() => !document.querySelector(".rest-card").classList.contains("hidden"), null, 15000);
  return shown;
};
if (shop) {
  await g(() => {
    const gm = window.__dev.game;
    gm.stamina.energy = gm.stamina.p.energy * 0.25;
    gm.stamina.legs = 0;
  });
  const shown = await visit(shop, "2-rest-shop");
  const card = await g(() => ({ title: document.querySelector(".rest-card .offer-title").textContent, items: [...document.querySelectorAll(".rest-card .rest-item")].map((b) => b.innerText.replace(/\n/g, " ")) }));
  const before = await g(() => ({ energy: window.__dev.game.stamina.energyShare, money: window.__dev.game.money, legs: window.__dev.game.stamina.legsShare }));
  await page.locator(".rest-card .rest-item").first().click();
  await page.waitForTimeout(300);
  const after = await g(() => ({ energy: window.__dev.game.stamina.energyShare, money: window.__dev.game.money, legs: window.__dev.game.stamina.legsShare, note: document.querySelector(".rest-note").textContent, flash: document.querySelector(".flash")?.textContent }));
  await snap("2b-rest-bought");
  result.shop = { kind: shop.kind, shown, card, before, after };
  // 動き出すと閉じる
  await g(() => window.__dev.game.setPace(2));
  result.shop.closedOnRide = await wait(() => document.querySelector(".rest-card").classList.contains("hidden"), null, 15000);
}
list = await rests();
const vend2 = list.find((s) => s.kind === "vending") ?? vend;
if (vend2) {
  const shown = await visit(vend2, "2c-rest-vending");
  result.vending = { shown, items: await g(() => [...document.querySelectorAll(".rest-card .rest-item")].map((b) => b.innerText.replace(/\n/g, " "))) };
  await page.locator(".rest-card .btn", { hasText: "閉じる" }).click();
  await page.waitForTimeout(500);
  result.vending.closed = await g(() => document.querySelector(".rest-card").classList.contains("hidden"));
}
// 体力が少ない知らせ
await g(() => {
  const gm = window.__dev.game;
  gm.stamina.energy = gm.stamina.p.energy * 0.29;
});
await page.waitForTimeout(400);
result.lowFlash = await g(() => document.querySelector(".flash")?.textContent ?? null);
// 世界地図の印
await g(() => window.__dev.game.toggleMap());
await page.waitForTimeout(1500);
result.mapRests = await g(() => window.__dev.game.restsForMap().length);
await snap("2d-map-rests");
await g(() => window.__dev.game.toggleMap());
save();

// 3. 受注のカットイン
await g(() => {
  const gm = window.__dev.game;
  gm.stamina.energy = gm.stamina.p.energy;
  gm.appOn = true;
  gm.timeScale = 3;
});
await wait(() => window.__dev.game.feed.items.length >= 1, null, 120000);
await g(() => window.__dev.game.acceptFromPhone(window.__dev.game.feed.items[0].order.no));
await page.waitForTimeout(350);
result.cutin = await g(() => ({ shown: !document.querySelector(".cutin").classList.contains("hidden"), main: document.querySelector(".cutin-main").textContent, sub: document.querySelector(".cutin-sub").textContent }));
await snap("3-cutin");
await page.waitForTimeout(1500);
result.cutin.hiddenAfter = await g(() => document.querySelector(".cutin").classList.contains("hidden"));
await g(() => (window.__dev.game.timeScale = 1));
save();

// 4. 車に当たった時: 後ろから来る本物の交通の車を、自転車の位置へ置く
await g(() => window.__dev.game.setPace(2));
await page.waitForTimeout(4000);
const crash = await g(async () => {
  const gm = window.__dev.game;
  const r = gm.ride;
  const v = gm.traffic.vehicles.filter((o) => o.type !== "bus" && o.type !== "courier").sort((a, b) => Math.hypot(a.x - r.pose().x, a.z - r.pose().z) - Math.hypot(b.x - r.pose().x, b.z - r.pose().z))[0];
  if (!v) return null;
  v.turn = null;
  v.plan = null;
  v.passing = null;
  v.pos = { road: r.pos.road, s: r.pos.s - r.pos.dir * 2.5, dir: r.pos.dir };
  v.offset = r.offset + 0.3;
  v.speed = 12;
  const trace = [];
  const t0 = performance.now();
  const e0 = gm.stamina.energyShare;
  while (performance.now() - t0 < 7000) {
    await new Promise((res) => setTimeout(res, 100));
    const p = r.pose();
    trace.push({ t: Math.round(performance.now() - t0), rideOff: +r.offset.toFixed(2), hop: +r.hopHeight.toFixed(2), rideKmh: Math.round(r.speed * 3.6), carKmh: Math.round(v.speed * 3.6), carOff: +v.offset.toFixed(2), crash: !!v.crash, gap: +Math.hypot(v.x - p.x, v.z - p.z).toFixed(1) });
    if (trace.length === 3) window.__shotNow = true;
  }
  return { type: v.type, energyBefore: +e0.toFixed(3), energyAfter: +gm.stamina.energyShare.toFixed(3), trace };
});
result.crash = crash && { ...crash, trace: crash.trace.filter((_, i) => i % 3 === 0 || i < 8) };
await snap("4-after-crash");
save();
// 跳ねた瞬間を撮る（もう一度、今度はすぐ撮る）
await page.waitForTimeout(4000);
await g(() => {
  const gm = window.__dev.game;
  const r = gm.ride;
  const v = gm.traffic.vehicles.filter((o) => o.type !== "bus" && o.type !== "courier" && !o.crash).sort((a, b) => Math.hypot(a.x - r.pose().x, a.z - r.pose().z) - Math.hypot(b.x - r.pose().x, b.z - r.pose().z))[0];
  if (!v) return;
  v.turn = null;
  v.plan = null;
  v.passing = null;
  v.pos = { road: r.pos.road, s: r.pos.s - r.pos.dir * 2.5, dir: r.pos.dir };
  v.offset = r.offset + 0.3;
  v.speed = 12;
});
await page.waitForTimeout(250);
await snap("4b-bump");
await page.waitForTimeout(1500);
await snap("4c-car-stopping");
save();

// 5. NPC の配達員と業者の車
await page.waitForTimeout(3000);
const npc = () =>
  g(() => {
    const gm = window.__dev.game;
    const p = gm.ride.pose();
    const vs = gm.traffic.vehicles;
    return {
      couriers: vs.filter((v) => v.type === "courier").length,
      near: vs.filter((v) => v.type === "courier" && Math.hypot(v.x - p.x, v.z - p.z) < 150).length,
      vehicles: vs.length,
      delivers: vs.filter((v) => v.delivers).length,
      parcelStops: gm.traffic.parcelStops().length,
      colors: [...new Set(vs.filter((v) => v.type === "courier").map((v) => v.color))].slice(0, 6),
    };
  });
result.npc = await npc();
// 近くの配達員の後ろへ移る
const ahead = await g(() => {
  const gm = window.__dev.game;
  const p = gm.ride.pose();
  const c = gm.traffic.vehicles.filter((v) => v.type === "courier" && !v.turn).sort((a, b) => Math.hypot(a.x - p.x, a.z - p.z) - Math.hypot(b.x - p.x, b.z - p.z))[0];
  if (!c) return null;
  gm.setPace(0);
  const r = gm.ride;
  r.pos = { road: c.pos.road, s: c.pos.s - c.pos.dir * 9, dir: c.pos.dir };
  r.speed = c.speed;
  gm.setPace(1);
  return { id: c.id };
});
if (ahead) {
  await page.waitForTimeout(1200);
  await snap("5-courier");
}
// 荷を届けに止まっている車
const stopAt = await wait(() => window.__dev.game.traffic.parcelStops().length > 0, null, 90000);
if (stopAt) {
  await g(() => {
    const gm = window.__dev.game;
    const { v } = gm.traffic.parcelStops()[0];
    gm.setPace(0);
    const r = gm.ride;
    r.pos = { road: v.pos.road, s: v.pos.s - v.pos.dir * 14, dir: v.pos.dir };
    r.speed = 0;
  });
  await page.waitForTimeout(6000);
  result.parcelDriver = await g(() => ({ walkers: window.__dev.game.view.pedestrians.stats.walkers, phase: window.__dev.game.traffic.parcelStops()[0]?.phase }));
  await snap("5b-parcel-driver");
}
result.npc2 = await npc();
save();

// 6. 横画面
await page.setViewportSize({ width: 874, height: 402 });
await page.waitForTimeout(1500);
await snap("6-landscape");
save();
console.log(JSON.stringify(result, null, 1));
await browser.close();
