// D7a 自分の車での配達の確認（配達の草案 33 章。402×874 タッチ・1280×720）:
// 開業して軽自動車を買い、経営の画面の乗り物のタブで乗る。速さの段、注文を受けて受け取りの円で止まって渡す、自転車に戻る。
// 開発サーバーが動いている前提（MAP_BASE、既定 5180）。node scripts/ux34-check.mjs。結果は artifacts/ux34。

import { chromium } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";

const base = process.env.MAP_BASE || "http://localhost:5180";
const out = process.env.OUT || "artifacts/ux34";
mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || "chrome", headless: true });
const page = await (await browser.newContext({ viewport: { width: 402, height: 874 }, deviceScaleFactor: 2, hasTouch: true })).newPage();
// 開発サーバーの自動の読み込み直し（HMR）をつながない（ほかの作業の書き換えで試しの途中に読み込み直されないように）
await page.routeWebSocket(/.*/, () => {});
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
await page.waitForTimeout(1500);

// 開業して軽自動車を買う
await g(() => {
  const gm = window.__dev.game;
  gm.wallet = 2_000_000;
  gm.delivered = 40;
  gm.openCompany();
});
await page.waitForTimeout(300);
await page.locator(".company-open .btn").first().click();
await page.waitForTimeout(400);
await page.locator(".ranking-tab", { hasText: "乗り物" }).click();
await page.waitForTimeout(300);
await page.locator(".company-card", { hasText: "軽自動車" }).locator(".btn", { hasText: "買う" }).click();
await page.waitForTimeout(300);
await page.locator(".btn", { hasText: "軽自動車に乗る" }).click();
await page.waitForTimeout(400);
result.afterDrive = await g(() => ({ driving: window.__dev.game.driving, carry: window.__dev.game.carry(), labels: [...document.querySelectorAll(".pace-btn")].map((b) => b.textContent), card: document.querySelector(".company-card")?.innerText.replace(/\n/g, " ") }));
await snap("1-company-drive");
await page.locator(".company .btn", { hasText: "閉じる" }).first().click();
await page.waitForTimeout(800);
await snap("2-car-stopped");

// 速さの段（40km/h）
await g(() => window.__dev.game.setPace(2));
await page.waitForTimeout(8000);
result.speed40 = await g(() => Math.round(window.__dev.game.ride.speed * 3.6));
await snap("3-car-driving");
await g(() => (window.__dev.game.camera = "rider"));
await page.waitForTimeout(800);
await snap("3b-car-first-person");
await g(() => (window.__dev.game.camera = "chase"));

// 注文を受けて、受け取りの円で止まって渡す
await g(() => {
  const gm = window.__dev.game;
  gm.appOn = true;
  gm.timeScale = 3;
});
await wait(() => window.__dev.game.feed.items.length >= 1, null, 120000);
await g(() => window.__dev.game.acceptFromPhone(window.__dev.game.feed.items[0].order.no));
const t0 = Date.now();
const picked = await wait(() => window.__dev.game.deliveries[0]?.phase === "dropoff", null, 300000);
result.pickup = { picked, sec: Math.round((Date.now() - t0) / 1000), speedAtPick: await g(() => +window.__dev.game.ride.speed.toFixed(2)), handover: await g(() => window.__dev.game.deliveries[0]?.handover ?? null) };
await snap("4-car-picked");
save();

// 自転車に戻る（止まってから）
await g(() => {
  const gm = window.__dev.game;
  gm.timeScale = 1;
  gm.setPace(0);
});
await wait(() => window.__dev.game.ride.speed < 0.3, null, 20000);
result.back = await g(() => window.__dev.game.chooseDrive(null));
await page.waitForTimeout(500);
result.afterBack = await g(() => ({ driving: window.__dev.game.driving, labels: [...document.querySelectorAll(".pace-btn")].map((b) => b.textContent), playerVisible: window.__dev.game.player.group.visible }));
await snap("5-back-to-bike");
save();
console.log(JSON.stringify(result, null, 1));
await browser.close();
