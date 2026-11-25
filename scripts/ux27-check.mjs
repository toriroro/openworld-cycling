// 配達の草案 27 章の確認。402×874（スマホの縦）と 874×402 で:
// 1. 案内の選び方、小地図の＋－（読み直しても残る）
// 2. 今いる所の表示（丁目・方角・方位磁針）と、交差点の住所の看板
// 3. 配達アプリの画面: 注文が一覧に届き、期限が来ると消える。開いて受ける
// 4. 案内が「経路は自分で選ぶ」でも行き先の印が世界地図に出て、印を押すと経路が引かれ、受け取った後も届け先へ続く
// 5. 走っている時の U ターン（減速して回り、逆向きに走る）
// 6. 横画面の置き方
// 開発サーバーが動いている前提（MAP_BASE、既定 5180）。node scripts/ux27-check.mjs。結果は artifacts/ux27。

import { chromium } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";

const base = process.env.MAP_BASE || "http://localhost:5180";
const out = process.env.OUT || "artifacts/ux27";
mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || "chrome", headless: true });
const context = await browser.newContext({ viewport: { width: 402, height: 874 }, deviceScaleFactor: 2, hasTouch: true });
const page = await context.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
const g = (fn, arg) => page.evaluate(fn, arg);
const snap = (name) => page.screenshot({ path: `${out}/${name}.png` });
const result = { errors };
const save = () => writeFileSync(`${out}/result.json`, JSON.stringify(result, null, 2));
const wait = (fn, arg, ms = 120000) => page.waitForFunction(fn, arg, { timeout: ms, polling: 200 }).then(() => true).catch(() => false);
const ready = () => page.waitForFunction(() => window.__dev?.state().ready && window.__dev.state().settled && window.__dev.game.deliveryArea && window.__dev.game.ride?.road, null, { timeout: 240000, polling: 250 });

await page.goto(`${base}/?world=hokkaido&fresh=1&notitle=1&time=11&weather=clear&touch=1`);
await ready();
await page.waitForTimeout(2000);

// 1. 案内の選び方・小地図の＋－
await page.click(".menu-btn");
result.guideOptions = await g(() => {
  const row = [...document.querySelectorAll("label.menu-row")].find((l) => l.innerText.includes("配達の案内"));
  return [...row.querySelector("select").options].map((o) => `${o.value}:${o.text}${o.selected ? "（選択）" : ""}`);
});
await page.click(".menu-btn");
const range = () => g(() => window.__dev.game.minimap.radiusM);
const r0 = await range();
await page.getByRole("button", { name: "小地図を近く" }).click();
await page.getByRole("button", { name: "小地図を近く" }).click();
const r1 = await range();
const nearDisabled = await page.getByRole("button", { name: "小地図を近く" }).isDisabled();
await page.waitForTimeout(200);
await snap("1-minimap-near");
for (let i = 0; i < 3; i++) await page.getByRole("button", { name: "小地図を遠く" }).click();
result.minimap = { start: r0, afterNear2: r1, nearDisabledAtMin: nearDisabled, afterFar3: await range() };
save();

// 2. 今いる所の表示と住所の看板（ゆっくり交差点の手前まで走って止まる）
await g(() => window.__dev.game.setPace(1));
await page.waitForTimeout(6000);
await g(() => window.__dev.game.setPace(0));
await page.waitForTimeout(3000);
result.where = await g(() => ({ text: document.querySelector(".road-name").innerText.replace(/\n/g, " | "), signs: window.__dev.game.view.addressSigns.stats }));
await snap("2-where-and-signs");
save();

// 3. 配達アプリの画面
await g(() => {
  const gm = window.__dev.game;
  gm.appOn = true;
  gm.timeScale = 3;
});
if (await page.locator(".phone.folded").count()) await page.locator(".phone-head").click();
const listed = await wait(() => document.querySelectorAll(".phone-item:not(.gone)").length >= 3, null, 240000);
const list = () => g(() => [...document.querySelectorAll(".phone-item:not(.gone)")].map((e) => e.innerText.split("\n").slice(0, 2).join(" / ")));
result.phone = { listed, items: await list() };
await snap("3-phone-list");
// いちばん古い注文（下）が期限で消えるのを待つ
const oldest = await g(() => window.__dev.game.feed.items.at(-1));
result.phone.oldest = oldest && { no: oldest.order.no, lifeS: Math.round(oldest.until - oldest.at) };
if (oldest) result.phone.expired = await wait((no) => !window.__dev.game.feed.items.some((x) => x.order.no === no) && !document.querySelector(".phone-item:not(.gone)") !== null, oldest.order.no, 240000);
await page.waitForTimeout(500);
await snap("3b-phone-after-expire");
// 開いて受ける
await page.locator(".phone-item:not(.gone)").first().click();
await page.waitForTimeout(300);
await snap("3c-phone-open");
const before = await g(() => window.__dev.game.deliveries.length);
await page.locator(".phone-item.open .phone-ok").click();
await page.waitForTimeout(800);
result.phone.accepted = await g((b) => ({ before: b, after: window.__dev.game.deliveries.length, pickup: window.__dev.game.deliveries[0]?.order.pickup.name, stillListed: window.__dev.game.feed.items.some((x) => x.order.no === window.__dev.game.deliveries[0]?.order.no) }), before);
result.phone.blockedText = await g(() => document.querySelector(".phone-item .phone-why")?.textContent ?? null);
await snap("3d-phone-after-accept");
save();

// 4. 世界地図の印を押す → 経路
const hasOrder = await g(() => window.__dev.game.deliveries.length > 0);
if (hasOrder) {
  result.afterAccept = await g(() => ({ goal: !!window.__dev.game.ride.goal, guide: window.__dev.game.deliveryGuide }));
  await page.locator(".minimap").click();
  await page.waitForTimeout(2500);
  await snap("4-map-pin");
  const hit = await g(() => window.__dev.game.mapOverlay.map.markHits[0] ?? null);
  if (hit) {
    const box = await page.locator(".map-canvas").boundingBox();
    await page.mouse.click(box.x + (hit.x0 + hit.x1) / 2, box.y + (hit.y0 + hit.y1) / 2);
    await page.waitForTimeout(2500);
    result.afterPinTap = await g(() => ({ goal: !!window.__dev.game.ride.goal, plan: !!window.__dev.game.ride.plan, pace: window.__dev.game.manual.pace, info: document.querySelector(".map-info")?.innerText ?? null }));
    await snap("5-map-after-pin-tap");
  }
  await page.getByRole("button", { name: "閉じる", exact: true }).click();
  const picked = await wait(() => { const d = window.__dev.game.deliveries[0]; return !d || d.phase === "dropoff"; }, null, 600000);
  await page.waitForTimeout(1500);
  result.afterPickup = picked && (await g(() => ({ phase: window.__dev.game.deliveries[0]?.phase ?? "done", goal: !!window.__dev.game.ride.goal })));
  await snap("6-after-pickup");
}
save();

// 5. 走っている時の U ターン
await g(() => {
  const gm = window.__dev.game;
  gm.ride.setGoal(null);
  gm.timeScale = 1;
  gm.setPace(2);
});
await page.waitForTimeout(8000);
const u0 = await g(() => ({ v: Math.round(window.__dev.game.ride.speed * 3.6), d: [window.__dev.game.ride.pose().dx, window.__dev.game.ride.pose().dz], n: window.__dev.game.ride.uTurns }));
await page.getByRole("button", { name: "Uターン" }).click();
let minV = 99;
for (let i = 0; i < 40; i++) {
  await page.waitForTimeout(100);
  minV = Math.min(minV, await g(() => window.__dev.game.ride.speed * 3.6));
}
await page.waitForTimeout(4000);
result.uTurn = await g(
  (u0) => {
    const r = window.__dev.game.ride;
    const p = r.pose();
    return { speedBefore: u0.v, speedAfter: Math.round(r.speed * 3.6), headingDot: Math.round((p.dx * u0.d[0] + p.dz * u0.d[1]) * 100) / 100, uTurns: r.uTurns - u0.n, pending: r.uTurnPending };
  },
  u0,
);
result.uTurn.minSpeed = Math.round(minV);
await snap("7-after-uturn");
save();

// 6. 横画面
await page.setViewportSize({ width: 874, height: 402 });
await page.waitForTimeout(1500);
await snap("8-landscape");
result.landscape = await g(() => Object.fromEntries([".ride-info", ".road-name", ".phone", ".delivery-strip", ".minimap-wrap", ".branch", ".pace-bar"].map((s) => { const e = document.querySelector(s); if (!e || e.classList.contains("hidden")) return [s, null]; const b = e.getBoundingClientRect(); return [s, [Math.round(b.left), Math.round(b.top), Math.round(b.right), Math.round(b.bottom)]]; })));
await page.setViewportSize({ width: 402, height: 874 });

// 7. 読み直しても小地図の半径が残る
await page.reload();
await ready();
await page.waitForTimeout(800);
result.minimapAfterReload = await range();
save();
console.log(JSON.stringify(result, null, 1));
await browser.close();
