// 配達 D5 の確認（配達の草案 22 章）: 長距離の便と放置。
// 始める条件（中堅から）、行き先までの道（Worker の道路網）、申し込み、トラックを買って契約に付ける、走っている便の様子、
// 世界地図の経路とトラック、保存して読み直す、閉じていた間（時計を 10 時間進める）の「留守の間の便」、締めた収支、縦画面、フレーム間隔。
// 開発サーバーが動いている前提（MAP_BASE、既定 5180）。node scripts/delivery-d5-check.mjs。結果は artifacts/delivery/d5。

import { chromium } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";

const base = process.env.MAP_BASE || "http://localhost:5180";
const out = process.env.OUT || "artifacts/delivery/d5";
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
const panelText = () => page.evaluate(() => document.querySelector(".company").innerText);
const menu = async (name) => {
  await page.click(".menu-btn");
  await page.getByRole("button", { name, exact: true }).click();
  await page.waitForTimeout(300);
};
const closePanel = () => page.locator(".company .stamp-head .btn").click();
const freight = () =>
  g(() => {
    const c = window.__dev.game.market.own();
    return c && { cash: c.cash, staff: c.staff, trust: +c.trust.toFixed(3), trucks: c.fleet.truck ?? 0, contracts: (c.contracts ?? []).map((k) => ({ town: k.town, loads: k.loads, rate: k.rate, km: k.km, min: k.min, runs: k.runs.length, next: k.next, total: k.total, pending: k.pending.length, sum: k.sum })), freight: c.freight, freightAt: c.freightAt };
  });

await page.goto(`${base}/?world=hokkaido&fresh=1&notitle=1&time=11&weather=clear`);
await page.waitForFunction(() => window.__dev?.state().ready && window.__dev.state().settled && window.__dev.game.market && window.__dev.game.ride?.road, null, { timeout: 240000, polling: 250 });

// 1. 開業する（D4 と同じ。所持金と届けた数を足し、営業所の無い丁目へ移る）
await g(() => {
  const gm = window.__dev.game;
  gm.money = 3_000_000;
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

// 2. 便のタブ: 配達員 3 人では始められない（中堅から）
for (let i = 0; i < 3; i++) await page.getByRole("button", { name: "配達員", exact: true }).click().then(() => page.locator(".company .btn", { hasText: "雇う" }).first().click());
await page.getByRole("button", { name: "便", exact: true }).click();
await page.waitForFunction(() => !document.querySelector(".company").innerText.includes("行き先までの道を調べている"), null, { timeout: 60000, polling: 250 });
result.gate = await panelText();
await snap("1-freight-gate");

// 3. 配達員を足して中堅にする（応募は世界の 1 日に 3 人なので、ここでは直接足す）
await g(() => {
  const c = window.__dev.game.market.own();
  const day = window.__dev.game.market.state.day;
  for (let i = 0; i < 6; i++) c.crew.push({ id: `t${i}`, no: c.nextNo++, speed: 0.8 + i * 0.05, wage: 6500 + i * 300, since: day - 10 });
  c.staff = c.crew.length;
});
await page.getByRole("button", { name: "収支", exact: true }).click();
await page.getByRole("button", { name: "便", exact: true }).click();
result.offers = await panelText();
await snap("2-freight-offers");

// 4. トラックを 2 台買い、いちばん上の申し込みと契約して、要る台数だけ付ける
const buyTruck = () => page.locator(".company .stamp-item", { hasText: "トラック" }).first().getByRole("button", { name: "買う" }).click();
await buyTruck();
await buyTruck();
// 2 トンで運べる（荷が 2 トンまでの）申し込み。無ければ先頭（22.6 の荷の量）
const fits = page.locator(".company .stamp-item", { hasText: "（2 トンから）" }).filter({ hasText: "契約する" });
await ((await fits.count()) ? fits.first() : page.locator(".company .stamp-item", { hasText: "契約する" }).first()).getByRole("button", { name: "契約する" }).click();
await page.waitForTimeout(200);
const need = await g(() => {
  const k = window.__dev.game.market.own().contracts[0];
  return Math.min(2, Math.ceil((k.loads * (2 * k.min * 60000 + 2 * 20 * 60000)) / (24 * 3600 * 1000 / 7) - 1e-9));
});
for (let i = 0; i < need; i++) await page.locator(".company .stamp-item", { hasText: "これまで" }).getByRole("button", { name: "+", exact: true }).click();
await page.waitForTimeout(300);
result.contracted = await freight();
result.crewAfter = await g(() => {
  const gm = window.__dev.game;
  const c = gm.market.own();
  return document.querySelector(".company-note").innerText;
});
await snap("3-freight-contracted");

// 5. 時計を 25 分進める → 1 台目が行き先へ向かっている
await g(() => {
  const gm = window.__dev.game;
  gm.clockOffset += 25 * 60_000;
  gm.market.update(gm.market.state.day + 1, Date.now() + gm.clockOffset);
  gm.companyPanel.refreshFreight();
});
await page.waitForTimeout(300);
result.running = { panel: await panelText(), state: await freight() };
await snap("4-freight-running");

// 6. 世界地図: 経路の線とトラック
await closePanel();
const view = await g(() => {
  const gm = window.__dev.game;
  const k = gm.market.own().contracts[0];
  const c0 = gm.addresses.byName.get("大通西4丁目");
  gm.toggleMap();
  const cx = (c0.x + k.x) / 2;
  const cz = (c0.z + k.z) / 2;
  const span = Math.max(Math.abs(k.x - c0.x), Math.abs(k.z - c0.z));
  gm.mapOverlay.map.setView(cx, cz, (span * 1.3) / 800);
  return { town: k.town, cx, cz };
});
await page.waitForTimeout(3000);
await snap("5-map-route");
result.mapLayer = await g(() => window.__dev.game.freightLayer().map((f) => ({ town: f.town, points: f.path.length / 2, trucks: f.trucks })));
await g(() => window.__dev.game.toggleMap());

// 7. 保存して読み直す（契約・走っている便）。読み直すと時計のずらしは 0 に戻るので、便は先の時刻のまま待つ
await g(() => window.__dev.save());
const saved = await freight();
await page.goto(`${base}/?world=hokkaido&notitle=1&time=11&weather=clear`);
await page.waitForFunction(() => window.__dev?.state().ready && window.__dev.game.market && window.__dev.game.ride?.road, null, { timeout: 240000, polling: 250 });
const loaded = await freight();
result.save = { same: JSON.stringify(saved) === JSON.stringify(loaded), saved, loaded };

// 8. 閉じていた間: 時計を 10 時間（世界の約 3 日）進める → 留守の間の便が経営の画面に出る。日ごとに締めた収支に便が入る
await g(() => {
  const gm = window.__dev.game;
  gm.clockOffset += 25 * 60_000 + 10 * 3600_000;
});
await page.waitForFunction(() => window.__dev.game.companyPanel.isOpen, null, { timeout: 10000, polling: 200 });
await page.waitForTimeout(500);
result.away = { panel: await panelText(), state: await freight() };
await snap("6-away");
await page.getByRole("button", { name: "収支", exact: true }).click();
result.ledger = await panelText();
await snap("7-ledger-freight");

// 9. 縦画面
await page.setViewportSize({ width: 390, height: 844 });
await page.getByRole("button", { name: "便", exact: true }).click();
await page.waitForTimeout(300);
await snap("8-portrait-freight");
await page.setViewportSize({ width: 1440, height: 900 });
await closePanel();

// 10. 便を持って走る時のフレーム間隔（ふつうのペースで 15 秒）
await g(() => window.__dev.game.setPace(2));
await page.waitForTimeout(15000);
result.frames = await g(() => {
  const f = window.__dev.game.frameDt.slice(-600).sort((a, b) => a - b);
  return { n: f.length, p50: f[Math.floor(f.length * 0.5)], p95: f[Math.floor(f.length * 0.95)] };
});
await g(() => window.__dev.game.setPace(0));

writeFileSync(`${out}/result.json`, JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
await browser.close();
