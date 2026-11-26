// 配達の草案 32 章の確認（402×874、タッチ）: マイページ、配達アプリの下のタブ（注文・配達中・記録）、経営の画面（開業前・収支・配達員・乗り物）。
// 開発サーバーが動いている前提（MAP_BASE、既定 5180）。node scripts/ux33-check.mjs。結果は artifacts/ux33。

import { chromium } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";

const base = process.env.MAP_BASE || "http://localhost:5180";
const out = process.env.OUT || "artifacts/ux33";
mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || "chrome", headless: true });
const page = await (await browser.newContext({ viewport: { width: 402, height: 874 }, deviceScaleFactor: 2, hasTouch: true })).newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
const g = (fn, arg) => page.evaluate(fn, arg);
const snap = (name) => page.screenshot({ path: `${out}/${name}.png` });
const result = { errors };
await page.goto(`${base}/?world=hokkaido&fresh=1&notitle=1&time=11&weather=clear&touch=1`);
await page.waitForFunction(() => window.__dev?.state().ready && window.__dev.state().settled && window.__dev.game.deliveryArea && window.__dev.game.ride?.road, null, { timeout: 240000, polling: 250 });
await g(() => {
  const gm = window.__dev.game;
  gm.timeScale = 3;
  gm.appOn = true;
  gm.phone.setOpen(true, false);
  gm.delivered = 12;
  gm.onTime = 11;
  gm.wallet = 8400;
  gm.dayStats = { day: gm.worldToday(), delivered: 3, earned: 1520, onTime: 3 };
  gm.care = { tire: 0.55, chain: 0.8, brake: 0.9 };
  gm.stamina.energy = gm.stamina.p.energy * 0.62;
});
await page.waitForFunction(() => window.__dev.game.feed.items.length >= 2, null, { timeout: 120000, polling: 250 });
await g(() => window.__dev.game.acceptFromPhone(window.__dev.game.feed.items[0].order.no));
await g(() => (window.__dev.game.timeScale = 1));
await page.waitForTimeout(1500);
// 配達アプリのタブ
await page.locator(".phone-tab.tab-active").click();
await page.waitForTimeout(400);
await snap("1-phone-active");
await page.locator(".phone-tab.tab-record").click();
await page.waitForTimeout(400);
await snap("1b-phone-record");
await page.locator(".phone-tab.tab-orders").click();
// マイページ
await page.click(".menu-btn");
await page.getByRole("button", { name: "マイページ" }).click();
await page.waitForTimeout(500);
result.myPage = await g(() => document.querySelector(".my-page").innerText.slice(0, 400));
await snap("2-my-page");
await page.locator(".my-page .btn", { hasText: "閉じる" }).click();
// 経営: 開業前
await g(() => window.__dev.game.openCompany());
await page.waitForTimeout(500);
await snap("3-company-open");
// 開業して、世界の日を 5 日進める
await g(() => {
  const gm = window.__dev.game;
  gm.wallet = 60000;
  gm.delivered = 40;
  gm.openCompany();
});
await page.waitForTimeout(300);
await page.locator(".company-open .btn").first().click();
await page.waitForTimeout(500);
for (let d = 0; d < 5; d++) {
  await g(() => {
    const gm = window.__dev.game;
    gm.clockOffset += (24 / 7) * 3600 * 1000;
    gm.market.update(gm.worldToday(), gm.nowMs());
  });
}
await g(() => window.__dev.game.openCompany());
await page.waitForTimeout(500);
await snap("3b-company-ledger");
await page.locator(".ranking-tab", { hasText: "配達員" }).click();
await page.waitForTimeout(400);
await snap("3c-company-crew");
await page.locator(".ranking-tab", { hasText: "乗り物" }).click();
await page.waitForTimeout(400);
await snap("3d-company-vehicles");
writeFileSync(`${out}/result.json`, JSON.stringify(result, null, 2));
console.log(JSON.stringify(result));
await browser.close();
