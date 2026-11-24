// 配達 D3 の確認（配達の草案 18 章）: NPC 業者と丁目の陣取り、順位。
// 世界地図の縄張り・営業所・凡例、順位の画面、業者に入って届けた配達がその業者の件数に入ること、住所の横の持ち主、
// 配達用の車の色、世界の日が変わった時の縄張りの変化、保存して読み直す。
// 開発サーバーが動いている前提（MAP_BASE、既定 5180）。node scripts/delivery-d3-check.mjs。結果は artifacts/delivery/d3。

import { chromium } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";

const base = process.env.MAP_BASE || "http://localhost:5180";
const out = process.env.OUT || "artifacts/delivery/d3";
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

const t0 = Date.now();
await page.goto(`${base}/?world=hokkaido&fresh=1&notitle=1&time=11&weather=clear`);
await page.waitForFunction(() => window.__dev?.state().ready && window.__dev.state().settled && window.__dev.game.market && window.__dev.game.ride?.road, null, { timeout: 240000, polling: 250 });
result.loadSeconds = Math.round((Date.now() - t0) / 1000);

// 1. 経済の場
result.arena = await g(async () => {
  const m = window.__dev.game.market;
  // 縄張りを最初から計算し直す時間（日ごとの割り振りの控えが無い時。日が変わった時に近い）
  const eco = await import("/src/shared/economy.ts");
  const t0 = performance.now();
  eco.territory(m.arena, m.state, m.now.day, new Map());
  const stepMs = performance.now() - t0;
  return {
    chomes: m.arena.chomes.length,
    areaKm2: +(m.arena.chomes.reduce((s, c) => s + c.area, 0) / 1e6).toFixed(2),
    companies: m.state.companies.filter((c) => c.closed === null).map((c) => ({ name: c.name, staff: c.staff, depots: c.depots.length, policy: c.policy })),
    stepAndTerritoryMs: Math.round(stepMs),
    entities: m.now.entities.map((e) => ({ name: e.name, chomes: e.chomes, ha: Math.round(e.area / 1e4), salesWeek: e.salesWeek })),
  };
});
result.road = await page.evaluate(() => document.querySelector(".road-name").textContent);

// 2. 世界地図の縄張り
await g(() => {
  const gm = window.__dev.game;
  gm.toggleMap();
  const p = gm.addresses.byName.get("大通西4丁目");
  gm.mapOverlay.map.setView(p.x, p.z, 7);
});
await page.waitForTimeout(1500);
await snap("1-map-territory");
await g(() => {
  const m = window.__dev.game.mapOverlay.map;
  m.setView(m.cx, m.cz, 2.5);
});
await page.waitForTimeout(1200);
await snap("2-map-close");
await g(() => window.__dev.game.toggleMap());

// 3. 順位
await page.click(".menu-btn");
await page.getByRole("button", { name: "順位", exact: true }).click();
await page.waitForTimeout(300);
await snap("3-ranking-area");
await page.getByRole("button", { name: "売上 1 週", exact: true }).click();
await snap("4-ranking-sales");
// 2 位の業者に入る
const joined = await g(() => {
  const m = window.__dev.game.market;
  const e = [...m.now.entities].filter((x) => x.kind !== "player").sort((a, b) => b.salesWeek - a.salesWeek)[1];
  return { id: e.id, name: e.name };
});
await page.locator(".ranking-item", { hasText: joined.name }).getByRole("button", { name: "入る" }).click();
await page.waitForTimeout(300);
result.join = { ...joined, company: await g(() => window.__dev.game.market.state.player.company), note: await page.evaluate(() => document.querySelector(".ranking-note").textContent) };
await snap("5-ranking-joined");
await page.locator(".ranking .btn", { hasText: "閉じる" }).click();

// 4. 配達アプリの注文を受けて届ける → 届け先の丁目の件数がその業者に入る
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
await page.getByRole("button", { name: "受ける", exact: true }).click();
const dropName = await g(() => {
  const gm = window.__dev.game;
  const d = gm.delivery.order.dropoff;
  return gm.addresses.at(d.x, d.z).name;
});
const before = await g((n) => {
  const m = window.__dev.game.market;
  const days = m.state.player.days;
  return days.reduce((s, d) => s + Object.entries(d.counts).filter(([k]) => k.endsWith(`|${n}`)).reduce((a, [, v]) => a + v, 0), 0);
}, dropName);
// 届け終わるまで待つ（途中の様子を残す）
const trace = [];
for (let i = 0; i < 84; i++) {
  await page.waitForTimeout(5000);
  const st = await g(() => {
    const gm = window.__dev.game;
    const p = gm.ride.pose();
    const tg = gm.delivery?.target;
    return { t: Math.round(gm.ride.time), v: +gm.ride.speed.toFixed(1), phase: gm.delivery?.phase ?? "done", dist: tg ? Math.round(Math.hypot(tg.x - p.x, tg.z - p.z)) : null, plan: gm.ride.plan ? Math.round(gm.ride.plan.length) : null, pace: gm.manual.pace, stop: !!gm.stop, paused: gm.paused, panel: gm.deliveryPanel.isOpen, map: gm.mapOverlay.isOpen };
  });
  trace.push(st);
  if (st.panel) break;
}
result.trace = trace;
if (!trace.at(-1).panel) {
  writeFileSync(`${out}/result.json`, JSON.stringify(result, null, 2));
  await snap("x-stuck");
  throw new Error("届かない");
}
result.delivery = await g((n) => {
  const m = window.__dev.game.market;
  const counts = {};
  for (const d of m.state.player.days) for (const [k, v] of Object.entries(d.counts)) if (k.endsWith(`|${n}`)) counts[k] = (counts[k] ?? 0) + v;
  return { dropoff: n, counts, owner: m.ownerOf(n)?.name ?? null };
}, dropName);
result.delivery.before = before;
await snap("6-delivered");
await g(() => window.__dev.game.deliveryPanel.hide());

// 5. 配達用の車の色（業者の色）
result.vans = await g(() => {
  const gm = window.__dev.game;
  const colors = new Set(gm.market.state.companies.map((c) => c.color));
  const vans = gm.traffic.vehicles.filter((v) => v.type === "van" || v.type === "keiTruck");
  return { cars: gm.traffic.vehicles.length, vans: vans.length, companyColored: vans.filter((v) => colors.has(v.color)).length };
});

// 6. 世界の日を 3 日進める（時計を 3 日ずらす）→ 進めて、昨日からの変化
result.nextDays = await g(() => {
  const gm = window.__dev.game;
  const before = gm.market.now.entities.map((e) => [e.name, e.chomes]);
  gm.clockOffset += 3 * (24 * 3600 * 1000) / 7;
  const t0 = performance.now();
  const n = gm.market.update(window.__dev.game.market.now.day + 3);
  return { stepped: n, ms: Math.round(performance.now() - t0), changed: gm.market.changedSinceYesterday(), before, after: gm.market.now.entities.map((e) => [e.name, e.chomes]) };
});
await page.click(".menu-btn");
await page.getByRole("button", { name: "順位", exact: true }).click();
await page.waitForTimeout(300);
await snap("7-ranking-later");
await page.locator(".ranking .btn", { hasText: "閉じる" }).click();

// 走っている間のフレーム間隔
result.frames = await g(() => {
  const f = window.__dev.game.frameDt.slice(-600).sort((a, b) => a - b);
  return { p50: f[Math.floor(f.length * 0.5)], p95: f[Math.floor(f.length * 0.95)] };
});

// 7. 保存して読み直す
const pick = () => g(() => {
  const m = window.__dev.game.market;
  return { day: m.state.day, company: m.state.player.company, companies: m.state.companies.map((c) => [c.name, c.staff, c.cash, c.depots.join(",")]), owners: Array.from(m.now.owner).join(",").length };
});
await g(() => window.__dev.save());
const saved = await pick();
await page.goto(`${base}/?world=hokkaido&notitle=1&time=11&weather=clear`);
await page.waitForFunction(() => window.__dev?.state().ready && window.__dev.game.market, null, { timeout: 240000, polling: 250 });
await g(() => (window.__dev.game.clockOffset += 3 * (24 * 3600 * 1000) / 7));
await g(() => window.__dev.game.market.update(window.__dev.game.market.now.day + 3));
const loaded = await pick();
result.save = { same: JSON.stringify({ ...saved, day: 0 }) === JSON.stringify({ ...loaded, day: 0 }), savedDay: saved.day, loadedDay: loaded.day, company: loaded.company };
writeFileSync(`${out}/result.json`, JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
await browser.close();
