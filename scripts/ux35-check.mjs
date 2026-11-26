// D7b 車の燃料と傷みの確認（配達の草案 34 章。402×874 タッチ）:
// 軽自動車に乗り、走りの要点の棒が「燃料」「車」になる。燃料を少なくして走らせ、燃料 25%・10% の知らせ、尽きて止まって呼んで届けてもらう札。
// 燃料店の前で止まり、給油・まとめて点検。マイページの車の棒。
// 開発サーバーが動いている前提（MAP_BASE、既定 5180）。node scripts/ux35-check.mjs。結果は artifacts/ux35。

import { chromium } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";

const base = process.env.MAP_BASE || "http://localhost:5180";
const out = process.env.OUT || "artifacts/ux35";
mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || "chrome", headless: true });
const page = await (await browser.newContext({ viewport: { width: 402, height: 874 }, deviceScaleFactor: 2, hasTouch: true })).newPage();
// 開発サーバーの自動の読み込み直し（HMR の WebSocket）をつながない（同じフォルダのほかの作業の書き換えで、試しの途中に読み込み直されないように）
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
// 開業して軽自動車に乗る（画面の操作は ux34 で確かめたので、ここは関数で）
await g(() => {
  const gm = window.__dev.game;
  gm.wallet = 2_000_000;
  gm.delivered = 40;
  gm.openCompany();
});
await page.waitForTimeout(300);
await page.locator(".company-open .btn").first().click();
await page.waitForTimeout(300);
result.drive = await g(() => {
  const gm = window.__dev.game;
  const c = gm.market.own();
  c.fleet = { kei: 1 };
  gm.companyPanel.close();
  return gm.chooseDrive("kei");
});
await page.waitForTimeout(500);
result.gauges = await g(() => [...document.querySelectorAll(".gauge")].map((e) => e.innerText.replace(/\n/g, " ")));

// 燃料を少なくして走る
await g(() => {
  const gm = window.__dev.game;
  gm.carCare.kei = { fuel: 0.03, tire: 0.7, oil: 0.9, brake: 0.95 };
  gm.setPace(3);
});
const flashes = [];
for (let i = 0; i < 60; i++) {
  await page.waitForTimeout(500);
  const f = await g(() => document.querySelector(".flash:not(.hidden)")?.textContent ?? null);
  if (f && !flashes.includes(f)) flashes.push(f);
  if (await g(() => window.__dev.game.carCare.kei.fuel <= 0 && window.__dev.game.ride.speed < 0.3)) break;
}
result.flashes = flashes;
result.rescueCard = await wait(() => document.querySelector(".rest-card .offer-title")?.textContent === "燃料が無い", null, 10000);
await snap("1-fuel-out");
const m0 = await g(() => window.__dev.game.money);
await page.locator(".rest-card .rest-item", { hasText: "呼んで届けてもらう" }).click();
await page.waitForTimeout(300);
result.rescue = { paid: m0 - (await g(() => window.__dev.game.money)), fuel: await g(() => window.__dev.game.carCare.kei.fuel) };
save();

// 燃料店で給油・点検
const st = await g(() => window.__dev.game.restsForMap().filter((s) => s.kind === "car").sort((a, b) => Math.hypot(a.roadX - window.__dev.game.ride.pose().x, a.roadZ - window.__dev.game.ride.pose().z) - Math.hypot(b.roadX - window.__dev.game.ride.pose().x, b.roadZ - window.__dev.game.ride.pose().z))[0]);
if (st) {
  await g((st) => {
    const gm = window.__dev.game;
    gm.setPace(0);
    gm.teleport(st.roadX, st.roadZ);
  }, st);
  await page.waitForFunction(() => window.__dev.game.ride?.road && window.__dev.state().settled, null, { timeout: 120000, polling: 250 });
  result.stationCard = await wait(() => document.querySelector(".rest-card .offer-title")?.textContent?.includes("燃料店"), null, 15000);
  result.stationItems = await g(() => [...document.querySelectorAll(".rest-card .rest-item")].map((b) => b.innerText.replace(/\n/g, " ")));
  await snap("2-station");
  const before = await g(() => ({ ...window.__dev.game.carCare.kei, money: window.__dev.game.money }));
  await page.locator(".rest-card .rest-item", { hasText: "まとめて点検" }).click();
  await page.waitForTimeout(300);
  result.service = { before, after: await g(() => ({ ...window.__dev.game.carCare.kei, money: window.__dev.game.money })) };
  await snap("2b-station-after");
}
// マイページ
await page.locator(".rest-card .btn", { hasText: "閉じる" }).click().catch(() => {});
await g(() => window.__dev.game.myPage.open(() => window.__dev.game.myPageInfo()));
await page.waitForTimeout(400);
await snap("3-my-page-car");
save();
console.log(JSON.stringify(result, null, 1));
await browser.close();
