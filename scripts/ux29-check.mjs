// 配達の草案 29 章の確認（402×874、タッチ）:
// 1. 配達鞄（背中）とリアキャリア・箱（後ろ）: 後ろから・横から（自転車と装いの画面）
// 2. 自転車店: 傷んだ自転車で前に止まると札が出て、空気を入れる・まとめて点検・リアキャリアを買う
// 3. 燃料店・車の整備: 空気入れだけ、車は持っていない
// 4. 傷みの知らせ、詳しい数字の「自転車の具合」、世界地図の印
// 開発サーバーが動いている前提（MAP_BASE、既定 5180）。node scripts/ux29-check.mjs。結果は artifacts/ux29。

import { chromium } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";

const base = process.env.MAP_BASE || "http://localhost:5180";
const out = process.env.OUT || "artifacts/ux29";
mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || "chrome", headless: true });
const page = await (await browser.newContext({ viewport: { width: 402, height: 874 }, deviceScaleFactor: 2, hasTouch: true })).newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
const g = (fn, arg) => page.evaluate(fn, arg);
const snap = (name) => page.screenshot({ path: `${out}/${name}.png` });
const result = { errors };
const save = () => writeFileSync(`${out}/result.json`, JSON.stringify(result, null, 2));
const wait = (fn, arg, ms = 120000) => page.waitForFunction(fn, arg, { timeout: ms, polling: 200 }).then(() => true).catch(() => false);

await page.goto(`${base}/?world=hokkaido&fresh=1&notitle=1&time=11&weather=clear&touch=1`);
await page.waitForFunction(() => window.__dev?.state().ready && window.__dev.state().settled && window.__dev.game.deliveryArea && window.__dev.game.ride?.road, null, { timeout: 240000, polling: 250 });
await page.waitForTimeout(2500);

// 1. 鞄とキャリア
const cargo = () => g(() => ({ bag: window.__dev.game.player.cargo.bag.visible, rack: window.__dev.game.player.cargo.rack.visible, gear: window.__dev.game.gear }));
result.cargoBag = await cargo();
await snap("1-bag-back");
await g(() => (window.__dev.game.gear = "carrier"));
await page.waitForTimeout(600);
result.cargoCarrier = await cargo();
await snap("1b-carrier-back");
await g(() => window.__dev.game.input.push("outfit"));
await page.waitForTimeout(1500);
await snap("1c-carrier-side");
await g(() => window.__dev.game.input.push("outfit"));
await page.waitForTimeout(800);
await g(() => (window.__dev.game.gear = "bag"));
save();

// 2. 自転車店
const stops = () => g(() => window.__dev.game.restStops.map((s) => ({ id: s.id, kind: s.kind, roadX: s.roadX, roadZ: s.roadZ })));
let list = await stops();
result.stops = list.reduce((a, s) => ((a[s.kind] = (a[s.kind] ?? 0) + 1), a), {});
const visit = async (kind) => {
  let st = (await stops()).find((s) => s.kind === kind);
  if (!st) {
    // 近くに無ければ、地図の範囲（1km）から探す
    st = await g((kind) => window.__dev.game.restsForMap().find((s) => s.kind === kind), kind);
  }
  if (!st) return null;
  await g((st) => {
    const gm = window.__dev.game;
    gm.setPace(0);
    gm.teleport(st.roadX, st.roadZ);
  }, st);
  await page.waitForFunction(() => window.__dev.game.ride?.road && window.__dev.state().settled, null, { timeout: 120000, polling: 250 });
  const shown = await wait(() => !document.querySelector(".rest-card").classList.contains("hidden"), null, 15000);
  await page.waitForTimeout(600);
  return { shown, title: await g(() => document.querySelector(".rest-card .offer-title").textContent) };
};
const card = () =>
  g(() => ({
    rows: [...document.querySelectorAll(".rest-card .rest-rows dt")].map((e) => `${e.textContent} ${e.nextElementSibling.textContent}`),
    items: [...document.querySelectorAll(".rest-card .rest-item")].map((b) => `${b.innerText.replace(/\n/g, " ")}${b.disabled ? "（押せない）" : ""}`),
    note: document.querySelector(".rest-note").textContent,
  }));
await g(() => {
  const gm = window.__dev.game;
  gm.care = { tire: 0.3, chain: 0.55, brake: 0.8 };
  gm.money = 5000;
});
const bike = await visit("bike");
if (bike) {
  result.bike = { ...bike, before: await card() };
  await snap("2-bike-shop");
  await page.locator(".rest-card .rest-item", { hasText: "空気を入れる" }).click();
  await page.waitForTimeout(300);
  result.bike.afterAir = { care: await g(() => window.__dev.game.care), card: await card() };
  await page.locator(".rest-card .rest-item", { hasText: "まとめて点検" }).click();
  await page.waitForTimeout(300);
  result.bike.afterAll = { care: await g(() => window.__dev.game.care), money: await g(() => window.__dev.game.money) };
  await g(() => (window.__dev.game.money = 20000));
  await g(() => window.__dev.game.depart?.());
  // 札を出し直す（所持金を増やしたので）
  await page.locator(".rest-card .btn", { hasText: "閉じる" }).click();
  await g(() => {
    const r = window.__dev.game.ride;
    r.pos = { ...r.pos, s: r.pos.s + r.pos.dir * 40 };
  });
  await page.waitForTimeout(1200);
  await g(() => {
    const r = window.__dev.game.ride;
    r.pos = { ...r.pos, s: r.pos.s - r.pos.dir * 40 };
  });
  await wait(() => !document.querySelector(".rest-card").classList.contains("hidden"), null, 15000);
  await page.locator(".rest-card .rest-item", { hasText: "リアキャリア" }).click();
  await page.waitForTimeout(400);
  result.bike.carrier = { gear: await g(() => window.__dev.game.gear), money: await g(() => window.__dev.game.money), card: await card() };
  await snap("2b-bike-shop-after");
  // 手前から見る
  await g(() => {
    const r = window.__dev.game.ride;
    r.pos = { ...r.pos, s: r.pos.s - r.pos.dir * 25 };
  });
  await page.waitForTimeout(1500);
  await snap("2c-bike-shop-approach");
}
save();

// 3. 燃料店・車の整備
await g(() => (window.__dev.game.care = { tire: 0.4, chain: 1, brake: 1 }));
const car = await visit("car");
if (car) {
  result.car = { ...car, card: await card() };
  await snap("3-car-shop");
}
save();

// 4. 傷みの知らせ・詳しい数字・地図
await page.locator(".rest-card .btn", { hasText: "閉じる" }).click().catch(() => {});
await g(() => window.__dev.game.setPace(2));
await page.waitForTimeout(2500);
await g(() => (window.__dev.game.care = { tire: 0.49, chain: 1, brake: 1 }));
await page.waitForTimeout(500);
result.careFlash = await g(() => document.querySelector(".flash")?.textContent ?? null);
await snap("4-care-flash");
await page.locator(".ride-status").click();
await page.waitForTimeout(300);
result.details = await g(() => document.querySelector(".stat-care")?.innerText.replace(/\n/g, " ") ?? null);
await snap("4b-details");
await page.locator(".ride-info").click();
await g(() => window.__dev.game.toggleMap());
await page.waitForTimeout(1500);
result.mapStops = await g(() => window.__dev.game.restsForMap().reduce((a, s) => ((a[s.kind] = (a[s.kind] ?? 0) + 1), a), {}));
await snap("4c-map");
await g(() => window.__dev.game.toggleMap());
save();
console.log(JSON.stringify(result, null, 1));
await browser.close();
