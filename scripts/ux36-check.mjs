// D7c 車の付け替えの確認（配達の草案 35 章。402×874 タッチ）:
// 軽自動車に乗って燃料店の前で止まり、「付け替え」の頁へ。荷室の棚（持てる数 +1）、冬タイヤ（押せない）、塗装（赤）で車の色が変わる。
// 開発サーバーが動いている前提（MAP_BASE、既定 5180）。node scripts/ux36-check.mjs。結果は artifacts/ux36。

import { chromium } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";

const base = process.env.MAP_BASE || "http://localhost:5180";
const out = process.env.OUT || "artifacts/ux36";
mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || "chrome", headless: true });
const page = await (await browser.newContext({ viewport: { width: 402, height: 874 }, deviceScaleFactor: 2, hasTouch: true })).newPage();
// 開発サーバーの自動の読み込み直し（HMR）をつながない（同じフォルダのほかの作業の書き換えで、試しの途中に読み込み直されないように）
await page.routeWebSocket(/.*/, () => {});
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
const g = (fn, arg) => page.evaluate(fn, arg);
const snap = (name) => page.screenshot({ path: `${out}/${name}.png` });
const result = { errors };
const card = () => g(() => ({ rows: [...document.querySelectorAll(".rest-card .rest-rows dt")].map((e) => `${e.textContent} ${e.nextElementSibling.textContent}`), items: [...document.querySelectorAll(".rest-card .rest-item")].map((b) => `${b.innerText.replace(/\n/g, " ")}${b.disabled ? "（押せない）" : ""}`) }));

await page.goto(`${base}/?world=hokkaido&fresh=1&notitle=1&time=11&weather=clear&touch=1`);
await page.waitForFunction(() => window.__dev?.state().ready && window.__dev.state().settled && window.__dev.game.deliveryArea && window.__dev.game.ride?.road, null, { timeout: 240000, polling: 250 });
await page.waitForTimeout(1500);
await g(() => {
  const gm = window.__dev.game;
  gm.wallet = 2_000_000;
  gm.delivered = 40;
  gm.openCompany();
});
await page.waitForTimeout(300);
await page.locator(".company-open .btn").first().click();
await page.waitForTimeout(300);
await g(() => {
  const gm = window.__dev.game;
  gm.market.own().fleet = { kei: 1 };
  gm.companyPanel.close();
  gm.chooseDrive("kei");
});
result.carryBefore = await g(() => window.__dev.game.carry());
const st = await g(() => {
  const gm = window.__dev.game;
  const p = gm.ride.pose();
  return gm.restsForMap().filter((s) => s.kind === "car").sort((a, b) => Math.hypot(a.roadX - p.x, a.roadZ - p.z) - Math.hypot(b.roadX - p.x, b.roadZ - p.z))[0];
});
await g((st) => window.__dev.game.teleport(st.roadX, st.roadZ), st);
await page.waitForFunction(() => window.__dev.game.ride?.road && window.__dev.state().settled, null, { timeout: 120000, polling: 250 });
await page.waitForFunction(() => document.querySelector(".rest-card .offer-title")?.textContent?.includes("燃料店"), null, { timeout: 20000 });
await page.locator(".rest-card .rest-item", { hasText: "付け替え" }).click();
await page.waitForTimeout(300);
result.modsPage = await card();
await snap("1-mods-page");
await page.locator(".rest-card .rest-item", { hasText: "荷室の棚" }).click();
await page.waitForTimeout(300);
await page.locator(".rest-card .rest-item", { hasText: "塗装（赤）" }).click();
await page.waitForTimeout(400);
result.after = { card: await card(), carry: await g(() => window.__dev.game.carry()), mods: await g(() => window.__dev.game.carMods.kei), money: await g(() => window.__dev.game.money) };
await page.locator(".rest-card .btn", { hasText: "閉じる" }).click();
await g(() => window.__dev.game.setPace(1));
await page.waitForTimeout(2500);
await snap("2-red-car");
writeFileSync(`${out}/result.json`, JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 1));
await browser.close();
