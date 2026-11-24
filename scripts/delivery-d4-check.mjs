// 配達 D4 の確認（配達の草案 21 章）: 開業と経営。
// 開業の条件、開業する、応募から雇う、乗り物を買う、値段、世界の日を進めて締める、自分で届けた配達が業者の資金と件数に入る、
// 順位と地図の営業所、保存して読み直す、畳む、廃業の知らせ、縦画面。
// 開発サーバーが動いている前提（MAP_BASE、既定 5180）。node scripts/delivery-d4-check.mjs。結果は artifacts/delivery/d4。

import { chromium } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";

const base = process.env.MAP_BASE || "http://localhost:5180";
const out = process.env.OUT || "artifacts/delivery/d4";
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
const DAY = (24 * 3600 * 1000) / 7;
const panelText = () => page.evaluate(() => document.querySelector(".company").innerText);
const menu = async (name) => {
  await page.click(".menu-btn");
  await page.getByRole("button", { name, exact: true }).click();
  await page.waitForTimeout(300);
};
const own = () =>
  g(() => {
    const c = window.__dev.game.market.own();
    return c && { id: c.id, name: c.name, cash: c.cash, staff: c.staff, depots: c.depots, fleet: Object.fromEntries(Object.entries(c.fleet).filter(([, n]) => n > 0).sort()), price: c.price, trust: +c.trust.toFixed(3), ledger: c.ledger, crew: c.crew.map((m) => [m.no, m.speed, m.wage]) };
  });

await page.goto(`${base}/?world=hokkaido&fresh=1&notitle=1&time=11&weather=clear`);
await page.waitForFunction(() => window.__dev?.state().ready && window.__dev.state().settled && window.__dev.game.market && window.__dev.game.ride?.road, null, { timeout: 240000, polling: 250 });

// 1. 開業の前（条件に届いていない）
await menu("経営");
result.before = await panelText();
await snap("1-open-locked");

// 2. 条件を満たす（所持金と届けた数を足す）→ 営業所の無い丁目へ移って開業する
const spot = await g(() => {
  const gm = window.__dev.game;
  gm.money = 400000;
  gm.delivered = 30;
  const m = gm.market;
  const taken = new Set(m.state.companies.filter((c) => c.closed === null).flatMap((c) => c.depots));
  // 町の中心から 1km ほどの、営業所の無い丁目
  const c0 = gm.addresses.byName.get("大通西4丁目");
  const cand = m.arena.chomes.filter((c) => !taken.has(c.name) && Math.hypot(c.x - c0.x, c.z - c0.z) > 900 && Math.hypot(c.x - c0.x, c.z - c0.z) < 1300).sort((a, b) => b.base - a.base)[0];
  gm.teleport(cand.x, cand.z);
  return { name: cand.name, x: cand.x, z: cand.z };
});
await page.waitForFunction(() => window.__dev.state().ready && window.__dev.game.ride?.road, null, { timeout: 120000, polling: 250 });
await page.locator(".company .stamp-head .btn").click();
await menu("経営");
result.here = await panelText();
await snap("2-open-ready");
await page.locator(".company-open .btn").click();
await page.waitForTimeout(300);
result.opened = await own();
result.wallet = await g(() => window.__dev.game.wallet);
await snap("3-ledger-empty");

// 3. 応募から 3 人雇う
await page.getByRole("button", { name: "配達員", exact: true }).click();
await snap("4-crew-applicants");
for (let i = 0; i < 3; i++) await page.locator(".company .btn", { hasText: "雇う" }).first().click();
await page.waitForTimeout(200);
await snap("5-crew-hired");

// 4. 乗り物: 電動自転車 2 台とバイク 1 台
await page.getByRole("button", { name: "乗り物", exact: true }).click();
const buy = (label) => page.locator(".company .stamp-item", { hasText: label }).getByRole("button", { name: "買う" }).click();
await buy("電動自転車");
await buy("電動自転車");
await buy("バイク");
await page.waitForTimeout(200);
await snap("6-vehicles");

// 5. 収支: 今日の見込み。値段を 2 段上げて見込みの変化
await page.getByRole("button", { name: "収支", exact: true }).click();
const est = () => g(() => document.querySelectorAll(".company .stamp-item")[1].innerText);
result.estimate = { at520: await est() };
await page.locator(".company .stamp-item").first().getByRole("button", { name: "+" }).click();
await page.locator(".company .stamp-item").first().getByRole("button", { name: "+" }).click();
result.estimate.at560 = await est();
await page.locator(".company .stamp-item").first().getByRole("button", { name: "−" }).click();
await page.locator(".company .stamp-item").first().getByRole("button", { name: "−" }).click();
await snap("7-ledger-estimate");
result.afterSetup = await own();

// 6. 配達アプリの注文を受けて自分で届ける → 資金と、届け先の丁目の件数が自分の業者に入る
await page.locator(".company .stamp-head .btn").click();
await page.click(".menu-btn");
await page.selectOption("label.menu-row:has-text('配達の案内') select", "route");
await page.click(".menu-btn");
await g(() => {
  const gm = window.__dev.game;
  gm.timeScale = 6;
  gm.appOn = true;
  gm.nextOfferAt = 0;
});
await page.waitForSelector(".offer-card:not(.hidden)", { timeout: 60000 });
const cashBefore = (await own()).cash;
await page.getByRole("button", { name: "受ける", exact: true }).click();
let done = false;
for (let i = 0; i < 84 && !done; i++) {
  await page.waitForTimeout(5000);
  done = await g(() => window.__dev.game.deliveryPanel.isOpen && !window.__dev.game.delivery);
}
if (!done) {
  await snap("x-stuck");
  writeFileSync(`${out}/result.json`, JSON.stringify(result, null, 2));
  throw new Error("届かない");
}
result.ownDelivery = await g((before) => {
  const gm = window.__dev.game;
  const c = gm.market.own();
  const days = gm.market.state.player.days;
  const counts = {};
  for (const d of days) for (const [k, v] of Object.entries(d.counts)) if (k.startsWith(`${c.id}|`)) counts[k] = v;
  return { cashBefore: before, cashAfter: c.cash, money: gm.money, counts, panel: document.querySelector(".delivery-panel").innerText };
}, cashBefore);
await snap("8-own-delivery");
await g(() => {
  const gm = window.__dev.game;
  gm.deliveryPanel.hide();
  gm.timeScale = 1;
});

// 7. 世界の日を 1 日進める → 締めた収支
result.step = await g((DAY) => {
  const gm = window.__dev.game;
  gm.clockOffset += DAY;
  const n = gm.market.update(gm.market.now.day + 1);
  return { stepped: n };
}, DAY);
await menu("経営");
await snap("9-ledger-closed-day");
result.afterDay = await own();

// 8. 順位（経営の行、入るボタンが無い）と世界地図の営業所
await page.locator(".company .stamp-head .btn").click();
await menu("順位");
result.ranking = await g(() => document.querySelector(".ranking:not(.company)").innerText.slice(0, 600));
await snap("10-ranking");
await page.locator(".ranking:not(.company) .stamp-head .btn").click();
await g((s) => {
  const gm = window.__dev.game;
  gm.toggleMap();
  gm.mapOverlay.map.setView(s.x, s.z, 4);
}, spot);
await page.waitForTimeout(1500);
await snap("11-map-depot");
await g(() => window.__dev.game.toggleMap());

// 9. 保存して読み直す
await g(() => window.__dev.save());
const saved = await own();
await page.goto(`${base}/?world=hokkaido&notitle=1&time=11&weather=clear`);
await page.waitForFunction(() => window.__dev?.state().ready && window.__dev.game.market, null, { timeout: 240000, polling: 250 });
await g((DAY) => {
  const gm = window.__dev.game;
  gm.clockOffset += DAY;
  gm.market.update(gm.market.now.day + 1);
}, DAY);
const loaded = await own();
result.save = { same: JSON.stringify(saved) === JSON.stringify(loaded), saved, loaded };

// 経営している間に走る時のフレーム間隔（ふつうのペースで 15 秒）
await g(() => window.__dev.game.setPace(2));
await page.waitForTimeout(15000);
result.frames = await g(() => {
  const f = window.__dev.game.frameDt.slice(-600).sort((a, b) => a - b);
  return { n: f.length, p50: f[Math.floor(f.length * 0.5)], p95: f[Math.floor(f.length * 0.95)] };
});
await g(() => window.__dev.game.setPace(0));

// 10. 縦画面
await page.setViewportSize({ width: 390, height: 844 });
await menu("経営");
await page.getByRole("button", { name: "配達員", exact: true }).click();
await snap("12-portrait-crew");
await page.setViewportSize({ width: 1440, height: 900 });

// 11. 畳む（2 回押す）→ 所持金に戻る
await page.getByRole("button", { name: "営業所", exact: true }).click();
await snap("13-depots");
const beforeWind = await own();
await page.locator(".company .btn", { hasText: "畳む…" }).click();
await page.locator(".company .btn", { hasText: /^畳む$/ }).click();
await page.waitForTimeout(200);
result.windUp = { cash: beforeWind.cash, fleet: beforeWind.fleet, wallet: await g(() => window.__dev.game.wallet), own: await own(), panel: await panelText() };
await snap("14-wound-up");

// 12. もう一度開業して、資金をマイナスのまま 1 か月に近づけて 1 日進める → 廃業の知らせ
await page.locator(".company-open .btn").click();
await page.waitForTimeout(200);
result.closure = await g((DAY) => {
  const gm = window.__dev.game;
  const c = gm.market.own();
  c.cash = -50000;
  c.negDays = 27;
  gm.companyPanel.close();
  gm.clockOffset += DAY;
  return { name: c.name, id: c.id };
}, DAY);
await page.waitForTimeout(2500);
result.closure.after = await g(() => ({ own: !!window.__dev.game.market.own(), wallet: window.__dev.game.wallet, open: window.__dev.game.companyPanel.isOpen, note: document.querySelector(".company-note").innerText }));
await snap("15-closed");

writeFileSync(`${out}/result.json`, JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
await browser.close();
