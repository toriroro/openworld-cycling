// 配達 D1 の確認（配達の草案 14 章）: 配達アプリの知らせを受け、「経路を自動で引く」で受け取り → 届け先まで半オートで走り、
// 着いたら自動で止まって受け渡し。ペースと脚・体力、経路の引き方、喫茶店で食べる、保存して読み直す。
// 開発サーバーが動いている前提（MAP_BASE、既定 5180）。node scripts/delivery-d1-check.mjs。結果は artifacts/delivery/d1。

import { chromium } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";

const base = process.env.MAP_BASE || "http://localhost:5180";
const out = process.env.OUT || "artifacts/delivery/d1";
mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || "chrome", headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await context.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
const settle = () => page.waitForFunction(() => window.__dev?.state().ready && window.__dev.state().settled, null, { timeout: 240000, polling: 250 });
const snap = (name) => page.screenshot({ path: `${out}/${name}.png` });
const g = (fn, arg) => page.evaluate(fn, arg);

await page.goto(`${base}/?world=hokkaido&fresh=1&notitle=1&time=10&weather=clear`);
await settle();
await page.waitForFunction(() => window.__dev.game.addresses !== null && window.__dev.game.deliveryArea !== null, null, { timeout: 60000 });
const result = { errors };

// 1. 配達アプリの知らせ（案内は「経路を自動で引く」、時間 4 倍）
await page.click(".menu-btn");
await page.selectOption("label.menu-row:has-text('配達の案内') select", "route");
await page.click(".menu-btn");
await g(() => (window.__dev.game.timeScale = 4));
await page.waitForSelector(".offer-card:not(.hidden)", { timeout: 60000 });
await snap("1-offer");
result.offer = await page.evaluate(() => document.querySelector(".offer-card").innerText);
await page.getByRole("button", { name: "受ける", exact: true }).click();

// 2. 受け取り → 届け先（自動で止まる）
const t0 = Date.now();
const samples = [];
let shotRide = false;
while (Date.now() - t0 < 300000) {
  await page.waitForTimeout(1000);
  const st = await g(() => {
    const gm = window.__dev.game;
    const r = gm.ride;
    return { phase: gm.delivery?.phase ?? "done", pace: gm.manual.pace, speed: r.speed, legs: gm.stamina.legsShare, energy: gm.stamina.energyShare, odo: r.odometer, time: r.time, panel: !document.querySelector(".delivery-panel").classList.contains("hidden") };
  });
  samples.push(st);
  if (!shotRide && st.speed > 3) {
    await snap("2-riding");
    shotRide = true;
  }
  if (st.panel) break;
}
await snap("3-result");
result.delivery = { panel: await page.evaluate(() => document.querySelector(".delivery-panel").innerText), phases: [...new Set(samples.map((s) => s.phase))], last: samples.at(-1) };
await g(() => window.__dev.game.deliveryPanel.hide());

// 3. ペース「全力」で脚が減り、尽きると上限がかかる
await g(() => {
  const gm = window.__dev.game;
  const p = gm.ride.pose();
  gm.ride.setGoal(p.x + 1500, p.z);
  gm.setPace(4);
  gm.appOn = false;
});
const legs = [];
for (let i = 0; i < 12; i++) {
  await page.waitForTimeout(1000);
  legs.push(await g(() => ({ legs: Math.round(window.__dev.game.stamina.legsShare * 100), watts: Math.round(window.__dev.game.ride.watts), cap: window.__dev.game.manual.cap })));
}
await snap("4-all-out");
result.allOut = legs;
await g(() => window.__dev.game.setPace(1));

// 4. 経路の引き方: 同じ行き先（円山の方、坂がある）で道のりを比べる
result.routeStyles = await g(() => {
  const gm = window.__dev.game;
  const r = gm.ride;
  const out = {};
  for (const style of ["short", "flat", "main"]) {
    r.routeStyle = style;
    r.setGoal(-2700, -100);
    out[style] = r.plan ? Math.round(r.plan.length) : null;
  }
  r.routeStyle = "short";
  r.setGoal(null);
  return out;
});

// 5. 喫茶店: 近くの店へ行って止まり、食べる
const cafe = await g(() => window.__dev.cafes(1500).sort((a, b) => a.d - b.d)[0]);
if (cafe) {
  await g(({ x, z }) => {
    const gm = window.__dev.game;
    gm.stamina.energy = gm.stamina.p.energy * 0.3;
    gm.ride.setGoal(x, z);
    gm.setPace(2);
  }, cafe);
  await page.waitForFunction(() => window.__dev.game.ride.goalReached, null, { timeout: 240000 });
  await g(() => {
    window.__dev.game.setPace(0);
    window.__dev.game.input.brakeKey = true;
  });
  await page.waitForFunction(() => window.__dev.game.stop !== null, null, { timeout: 30000 }).catch(() => {});
  await g(() => (window.__dev.game.input.brakeKey = false));
  const before = await g(() => ({ money: window.__dev.game.money, energy: window.__dev.game.stamina.energyShare, stop: !!window.__dev.game.stop }));
  await snap("5-cafe");
  if (before.stop) await page.getByRole("button", { name: /^食事/ }).click();
  await page.waitForTimeout(300);
  await snap("6-cafe-ate");
  const after = await g(() => ({ money: window.__dev.game.money, energy: window.__dev.game.stamina.energyShare }));
  result.cafe = { name: cafe.name, d: Math.round(cafe.d), before, after };
  await g(() => window.__dev.game.depart());
}

// 走っている間のフレーム間隔（読み直す前の 600 フレーム）
result.frames = await g(() => {
  const f = window.__dev.game.frameDt.slice(-600).sort((a, b) => a - b);
  return { p50: f[Math.floor(f.length * 0.5)], p95: f[Math.floor(f.length * 0.95)] };
});

// 6. 保存して読み直す（続きから）
const saved = await g(async () => {
  await window.__dev.save();
  const gm = window.__dev.game;
  return { money: gm.money, delivered: gm.delivered, onTime: gm.onTime, guide: gm.deliveryGuide, energy: Math.round(gm.stamina.energy) };
});
await page.goto(`${base}/?world=hokkaido&notitle=1&time=10&weather=clear`);
await page.waitForFunction(() => window.__dev?.state().ready, null, { timeout: 240000 });
const loaded = await g(() => {
  const gm = window.__dev.game;
  return { money: gm.money, delivered: gm.delivered, onTime: gm.onTime, guide: gm.deliveryGuide, energy: Math.round(gm.stamina.energy) };
});
result.save = { saved, loaded, same: JSON.stringify(saved) === JSON.stringify(loaded) };
// 縦画面（タッチなし）での並び
await page.setViewportSize({ width: 390, height: 844 });
await page.waitForTimeout(1500);
await snap("7-portrait");
writeFileSync(`${out}/result.json`, JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
await browser.close();
