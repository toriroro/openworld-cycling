// 装備と乗り物の段の確認（配達の草案 22.6）: 背負い鞄 → リアキャリア（自分は 2 件持てる、大きめの小包）、
// 配達員のリアキャリア、軽自動車、トラックの 2 トン・3 トン・10 トンと便の荷の量、保存して読み直す、縦画面。
// 開発サーバーが動いている前提（MAP_BASE、既定 5180）。node scripts/delivery-gear-check.mjs。結果は artifacts/delivery/gear。

import { chromium } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";

const base = process.env.MAP_BASE || "http://localhost:5180";
const out = process.env.OUT || "artifacts/delivery/gear";
mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || "chrome", headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await context.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
const g = (fn, arg) => page.evaluate(fn, arg);
const snap = (name) => page.screenshot({ path: `${out}/${name}.png` });
const result = { errors };
const menu = async (name) => {
  await page.click(".menu-btn");
  await page.getByRole("button", { name, exact: true }).click();
  await page.waitForTimeout(300);
};
const deliveryText = () => g(() => document.querySelector(".delivery-panel").innerText);
const companyText = () => g(() => document.querySelector(".company").innerText);
const state = () => g(() => ({ gear: window.__dev.game.gear, n: window.__dev.game.deliveries.length, orders: window.__dev.game.deliveries.map((d) => ({ no: d.order.no, phase: d.phase, target: d.target.name })), strip: document.querySelector(".delivery-strip")?.innerText ?? "" }));

await page.goto(`${base}/?world=hokkaido&fresh=1&notitle=1&time=11&weather=clear`);
await page.waitForFunction(() => window.__dev?.state().ready && window.__dev.state().settled && window.__dev.game.market && window.__dev.game.ride?.road, null, { timeout: 240000, polling: 250 });

// 1. 装備: 背負い鞄、所持金が足りないと買えない
await menu("装備");
result.gearBag = await deliveryText();
result.buyDisabled = await g(() => [...document.querySelectorAll(".delivery-panel button")].find((b) => b.textContent.startsWith("リアキャリア"))?.disabled);
await snap("1-gear-bag");

// 2. 所持金を足してリアキャリアを買う
await g(() => {
  window.__dev.game.money = 50_000;
  window.__dev.game.openGear();
});
await page.getByRole("button", { name: /リアキャリアを買う/ }).click();
await page.waitForTimeout(200);
result.gearCarrier = { panel: await deliveryText(), money: await g(() => window.__dev.game.money) };
await snap("2-gear-carrier");
await page.getByRole("button", { name: "閉じる", exact: true }).first().click();

// 3. 大きめの小包の知らせ: 鞄では受けられない（表示だけ。家の旗は止まった時にしか出ないため、注文を作って出す）
result.bigCard = await g(() => {
  const gm = window.__dev.game;
  const o = { no: 9999, source: "house", kind: "parcel", pickup: { name: "家", x: 0, z: 0, kind: "house" }, dropoff: { name: "北1条西1丁目", x: 0, z: 0 }, pickedAtStart: true, distance: 1500, approach: 0, limit: 900, reward: 900, big: true };
  gm.offerCard.show(o, 0, "大きめの小包はリアキャリアが要る");
  return { text: document.querySelector(".offer-card").innerText, disabled: document.querySelector(".offer-card .delivery-primary").disabled };
});
await snap("3-big-parcel-bag");
await g(() => window.__dev.game.offerCard.hide());

// 4. 配達アプリの注文を 2 件受ける（リアキャリアなので 1 件持っていても知らせが来る）
await page.click(".menu-btn");
await page.selectOption("label.menu-row:has-text('配達の案内') select", "route");
await page.click(".menu-btn");
for (let i = 0; i < 2; i++) {
  await g(() => {
    const gm = window.__dev.game;
    gm.appOn = true;
    gm.nextOfferAt = 0;
  });
  await page.waitForSelector(".offer-card:not(.hidden)", { timeout: 60000 });
  await page.getByRole("button", { name: "受ける", exact: true }).click();
  await page.waitForTimeout(500);
}
result.two = await state();
// 3 件目の知らせは来ない
await g(() => (window.__dev.game.nextOfferAt = 0));
await page.waitForTimeout(3000);
result.noThird = await g(() => document.querySelector(".offer-card").classList.contains("hidden"));
await snap("4-two-orders-strip");
await menu("配達");
result.activePanel = await deliveryText();
await snap("5-two-orders-panel");
await page.getByRole("button", { name: "2 件目へ向かう" }).click();
await page.waitForTimeout(300);
result.focused = await state();

// 5. 走って 1 件を届けると、残りの注文へ向かう
await g(() => (window.__dev.game.timeScale = 6));
let one = false;
for (let i = 0; i < 100 && !one; i++) {
  await page.waitForTimeout(5000);
  one = await g(() => window.__dev.game.deliveries.length === 1 && window.__dev.game.deliveryPanel.isOpen);
}
result.afterOne = { ok: one, state: await state(), panel: one ? await deliveryText() : "", goal: await g(() => window.__dev.game.ride.goal) };
await snap("6-one-delivered");
await g(() => {
  const gm = window.__dev.game;
  gm.timeScale = 1;
  gm.deliveryPanel.hide();
  gm.deliveryPanel.onCancel(0);
});

// 6. 経営: 配達員のリアキャリア、軽自動車、トラックの段（10 トンは大手から）、便の荷の量
await g(() => {
  const gm = window.__dev.game;
  gm.money = 30_000_000;
  gm.delivered = 30;
  const m = gm.market;
  const taken = new Set(m.state.companies.filter((c) => c.closed === null).flatMap((c) => c.depots));
  const c0 = gm.addresses.byName.get("大通西4丁目");
  const cand = m.arena.chomes.filter((c) => !taken.has(c.name) && Math.hypot(c.x - c0.x, c.z - c0.z) > 900 && Math.hypot(c.x - c0.x, c.z - c0.z) < 1300).sort((a, b) => b.base - a.base)[0];
  gm.teleport(cand.x, cand.z);
});
await page.waitForFunction(() => window.__dev.state().ready && window.__dev.game.ride?.road, null, { timeout: 120000, polling: 250 });
await menu("経営");
await page.locator(".company-open .btn").click();
await page.waitForTimeout(300);
await g(() => {
  const c = window.__dev.game.market.own();
  const day = window.__dev.game.market.state.day;
  for (let i = 0; i < 9; i++) c.crew.push({ id: `t${i}`, no: c.nextNo++, speed: 0.8 + i * 0.05, wage: 6500 + i * 300, since: day - 10 });
  c.staff = c.crew.length;
});
await page.getByRole("button", { name: "配達員", exact: true }).click();
const capBefore = await g(() => document.querySelector(".company .company-sub").innerText);
await page.locator(".company .btn", { hasText: "リアキャリア" }).first().click();
await page.waitForTimeout(200);
result.crewCarrier = { before: capBefore, after: await g(() => document.querySelector(".company .company-sub").innerText), first: await g(() => document.querySelectorAll(".company .stamp-item")[0].innerText) };
await snap("7-crew-carrier");
await page.getByRole("button", { name: "乗り物", exact: true }).click();
result.vehicles = await companyText();
await snap("8-vehicles-kei");
await page.getByRole("button", { name: "便", exact: true }).click();
await page.waitForFunction(() => !document.querySelector(".company").innerText.includes("行き先までの道を調べている"), null, { timeout: 60000, polling: 250 });
result.freightMid = await companyText();
await snap("9-trucks-mid");
// 大手にして 10 トンを買える
await g(() => {
  const c = window.__dev.game.market.own();
  const day = window.__dev.game.market.state.day;
  for (let i = 0; i < 17; i++) c.crew.push({ id: `u${i}`, no: c.nextNo++, speed: 1, wage: 7000, since: day - 10 });
  c.staff = c.crew.length;
});
await page.getByRole("button", { name: "収支", exact: true }).click();
await page.getByRole("button", { name: "便", exact: true }).click();
const buy = (label) => page.locator(".company .stamp-item", { hasText: `トラック ${label}` }).getByRole("button", { name: "買う" }).click();
await buy("10 トン");
await buy("3 トン");
await buy("2 トン");
await page.waitForTimeout(200);
// 申し込みをすべて契約して、トラックを付ける（荷の量を積める段だけ付く）
for (let i = 0; i < 3; i++) {
  const b = page.locator(".company .btn", { hasText: "契約する" }).first();
  if (await b.isEnabled().catch(() => false)) await b.click();
}
await page.waitForTimeout(200);
const nk = await g(() => window.__dev.game.market.own().contracts.length);
for (let i = 0; i < nk; i++) {
  const plus = page.locator(".company .stamp-item", { hasText: "これまで" }).nth(i).getByRole("button", { name: "+", exact: true });
  if (await plus.isEnabled()) await plus.click();
}
await page.waitForTimeout(300);
result.freightLarge = {
  panel: await companyText(),
  contracts: await g(() => window.__dev.game.market.own().contracts.map((k) => ({ town: k.town, tons: k.tons, rate: k.rate, runs: k.runs.map((r) => r.v) }))),
  fleet: await g(() => window.__dev.game.market.own().fleet),
};
await snap("10-trucks-large");

// 7. 保存して読み直す（装備・配達員のキャリア・トラックの段）
await g(() => window.__dev.save());
const pick = () => g(() => {
  const gm = window.__dev.game;
  const c = gm.market.own();
  return { gear: gm.gear, carriers: c.crew.filter((m) => m.carrier).length, fleet: c.fleet, runs: c.contracts.map((k) => k.runs.map((r) => r.v)), tons: c.contracts.map((k) => k.tons) };
});
const saved = await pick();
await page.goto(`${base}/?world=hokkaido&notitle=1&time=11&weather=clear`);
await page.waitForFunction(() => window.__dev?.state().ready && window.__dev.game.market && window.__dev.game.ride?.road, null, { timeout: 240000, polling: 250 });
const loaded = await pick();
result.save = { same: JSON.stringify(saved) === JSON.stringify(loaded), saved, loaded };

// 8. 縦画面（装備と、便のトラックの段）
await page.setViewportSize({ width: 390, height: 844 });
await g(() => window.__dev.game.openGear());
await page.waitForTimeout(200);
await snap("11-portrait-gear");
await g(() => window.__dev.game.deliveryPanel.hide());
await menu("経営");
await page.getByRole("button", { name: "便", exact: true }).click();
await page.waitForTimeout(300);
await snap("12-portrait-trucks");

writeFileSync(`${out}/result.json`, JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
await browser.close();
