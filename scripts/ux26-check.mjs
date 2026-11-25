// 操作と受け渡しの見直しの確認（配達の草案 26 章）。スマホの縦・横の大きさで:
// 左右のボタンと分岐の案内の置き方、ペースごとの速さ、配達アプリの注文を受けて受け取りの光の柱と円・受け取りの動き・届けるまで、
// 世界地図の行き先の印と経路の線、地図を開き直した時の縮尺、地図を押した行き先への経路（曲がる回数）、車に当たった時の体力と知らせ。
// 開発サーバーが動いている前提（MAP_BASE、既定 5180）。node scripts/ux26-check.mjs。結果は artifacts/ux26。

import { chromium } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";

const base = process.env.MAP_BASE || "http://localhost:5180";
const out = process.env.OUT || "artifacts/ux26";
mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || "chrome", headless: true });
// iPhone 17 Pro の縦の CSS の大きさに近づける
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

await page.goto(`${base}/?world=hokkaido&fresh=1&notitle=1&time=11&weather=clear&touch=1`);
await page.waitForFunction(() => window.__dev?.state().ready && window.__dev.state().settled && window.__dev.game.deliveryArea && window.__dev.game.ride?.road, null, { timeout: 240000, polling: 250 });

// 1. 操作の置き方（縦）: 左右のボタンが左下・右下の角にあるか
await page.click(".menu-btn");
await page.selectOption("label.menu-row:has-text('配達の案内') select", "route");
await page.click(".menu-btn");
const rects = () =>
  g(() => {
    const r = (sel) => {
      const e = document.querySelector(sel);
      if (!e) return null;
      const b = e.getBoundingClientRect();
      return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) };
    };
    const lanes = [...document.querySelectorAll(".touch-btn.lane")].map((e) => {
      const b = e.getBoundingClientRect();
      return { text: e.textContent, x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) };
    });
    return { vw: innerWidth, vh: innerHeight, lanes, pedal: r(".touch-btn.pedal"), brake: r(".touch-btn.brake"), minimap: r(".minimap"), pace: r(".pace-bar"), info: r(".ride-info"), branch: r(".branch") };
  });
result.portrait = await rects();

// 2. ペースごとの速さ（平らな所で 20 秒ずつ。世界の時計は 1 倍）
const speedAt = async (pace) => {
  await g((p) => window.__dev.game.setPace(p), pace);
  await page.waitForTimeout(9000);
  const xs = [];
  for (let i = 0; i < 20; i++) {
    xs.push(await g(() => ({ v: window.__dev.game.ride.speed * 3.6, grade: window.__dev.game.ride.grade, assist: window.__dev.game.ride.assist, watts: window.__dev.game.ride.watts })));
    await page.waitForTimeout(500);
  }
  const flat = xs.filter((x) => Math.abs(x.grade) < 0.01);
  const use = flat.length >= 5 ? flat : xs;
  return { pace, kmh: Math.round((use.reduce((a, x) => a + x.v, 0) / use.length) * 10) / 10, max: Math.round(Math.max(...use.map((x) => x.v)) * 10) / 10, assist: xs[0].assist, watts: Math.round(xs[0].watts), samples: use.length };
};
result.speed = [await speedAt(2), await speedAt(3)];
// 分岐の案内が出た所を撮る
await g(() => window.__dev.game.setPace(2));
if (await wait(() => document.querySelector(".branch:not(.hidden) .choice") !== null, null, 60000)) {
  result.branch = await g(() => ({ rect: (() => { const b = document.querySelector(".branch").getBoundingClientRect(); return { y: Math.round(b.y), h: Math.round(b.height), w: Math.round(b.width) }; })(), choices: [...document.querySelectorAll(".branch .choice")].map((e) => { const b = e.getBoundingClientRect(); return { text: e.innerText.replace(/\n/g, " "), x: Math.round(b.x), y: Math.round(b.y) }; }) }));
  await snap("1-portrait-branch");
}
save();

// 3. 配達アプリの注文を受けて、受け取りの円へ（経路を自動で引く・ふつう）
await g(() => {
  const gm = window.__dev.game;
  gm.appOn = true;
  gm.timeScale = 3;
});
const got = await page.waitForSelector(".offer-card:not(.hidden)", { timeout: 300000 }).catch(() => null);
if (got) {
  if (await g(() => document.querySelector(".offer-card .delivery-primary").disabled)) await page.locator(".offer-card").getByRole("button", { name: "見送る" }).click();
  else await page.locator(".offer-card").getByRole("button", { name: "受ける", exact: true }).click();
}
const hasOrder = await wait(() => window.__dev.game.deliveries.length > 0, null, 300000);
result.order = hasOrder && (await g(() => { const d = window.__dev.game.deliveries[0]; return { pickup: d.order.pickup.name, dropoff: d.order.dropoff.name, kind: d.order.pickup.kind ?? "chome" }; }));
if (hasOrder) {
  // 受け取りの柱が見える所（120m 以内）で撮る
  const zoneDist = () => g(() => { const gm = window.__dev.game; const d = gm.deliveries[0]; const z = d && gm.zoneOf(d.target); const p = gm.ride.pose(); return z ? Math.hypot(z.zone.x - p.x, z.zone.z - p.z) : null; });
  // 円が前方 40〜100m にある時（無ければ 110m 以内に入った時）
  await wait(() => {
    const gm = window.__dev.game;
    const d = gm.deliveries[0];
    const z = d && gm.zoneOf(d.target);
    const p = gm.ride.pose();
    if (!d || d.phase !== "pickup") return true;
    if (!z) return false;
    const dist = Math.hypot(z.zone.x - p.x, z.zone.z - p.z);
    const ahead = (z.zone.x - p.x) * p.dx + (z.zone.z - p.z) * p.dz;
    return (ahead > 40 && ahead < 100 && dist < 110) || dist < 35;
  }, null, 600000);
  result.nearPickup = await zoneDist();
  result.pillars = await g(() => window.__dev.game.view.handoff.group.children.filter((c) => c.visible).map((c) => ({ name: c.geometry.type, x: Math.round(c.position.x), y: Math.round(c.position.y), z: Math.round(c.position.z) })));
  await snap("2-pickup-pillar");
  // 世界地図: 受け取りの印と経路の線。縮尺を 2 回拡大して閉じ、開き直して縮尺が同じか
  await page.locator(".minimap").click();
  await page.waitForTimeout(2500);
  await snap("3-map-pickup-route");
  await page.getByRole("button", { name: "拡大" }).click();
  await page.getByRole("button", { name: "拡大" }).click();
  const mpp1 = await g(() => window.__dev.game.mapOverlay.map.mpp);
  await page.getByRole("button", { name: "閉じる", exact: true }).click();
  await page.locator(".minimap").click();
  await page.waitForTimeout(800);
  const mpp2 = await g(() => window.__dev.game.mapOverlay.map.mpp);
  result.mapZoomKept = { closedAt: mpp1, reopenedAt: mpp2 };
  await page.getByRole("button", { name: "閉じる", exact: true }).click();
  // 受け取った瞬間（荷が飛ぶ動き）
  const picked = await wait(() => { const d = window.__dev.game.deliveries[0]; return !d || d.phase === "dropoff"; }, null, 600000);
  await page.waitForTimeout(150);
  await snap("4-picked-moment");
  result.picked = picked && (await g(() => ({ flash: document.querySelector(".flash")?.innerText ?? null, speed: Math.round(window.__dev.game.ride.speed * 36) / 10 })));
  // 届け先の柱
  await wait(() => { const gm = window.__dev.game; const d = gm.deliveries[0]; const z = d && gm.zoneOf(d.target); const p = gm.ride.pose(); return !d || (z && Math.hypot(z.zone.x - p.x, z.zone.z - p.z) < 110); }, null, 900000);
  await snap("5-dropoff-pillar");
  const t0 = await g(() => window.__dev.game.ride.time);
  const done = await wait(() => window.__dev.game.deliveries.length === 0, null, 900000);
  await page.waitForTimeout(150);
  await snap("6-delivered");
  result.delivered = done && (await g((t0) => ({ panel: window.__dev.game.deliveryPanel.isOpen, money: window.__dev.game.money, rideS: Math.round(window.__dev.game.ride.time - t0) }), t0));
  await g(() => window.__dev.game.deliveryPanel.hide());
}
save();

// 4. 地図を押した行き先への経路: 曲がる回数（1.5km 先の碁盤の斜め向こう）と線
await g(() => {
  const gm = window.__dev.game;
  gm.appOn = false;
  gm.timeScale = 1;
  gm.setPace(0);
});
const routeInfo = await g(() => {
  const gm = window.__dev.game;
  const p = gm.ride.pose();
  gm.ride.setGoal(p.x + 900, p.z + 900);
  const plan = gm.ride.plan;
  if (!plan) return null;
  let turns = 0;
  let cur = { ...gm.ride.pos };
  const net = gm.roads.net;
  const heading = (road, s, dir) => {
    const r = net.roads.get(road);
    const P = r.points;
    const n = P.length / 3;
    const i = Math.min(n - 1, Math.max(0, Math.round(s / (r.length / (n - 1)))));
    const a = Math.max(0, i - 2), b = Math.min(n - 1, i + 2);
    const dx = (P[b * 3] - P[a * 3]) * dir, dz = (P[b * 3 + 2] - P[a * 3 + 2]) * dir;
    const l = Math.hypot(dx, dz) || 1;
    return [dx / l, dz / l];
  };
  for (const st of plan.steps) {
    const j = net.junctionsOn(cur.road).find((x) => x.junction.id === st.junction);
    if (!j) break;
    const [ax, az] = heading(cur.road, j.s, cur.dir);
    const [bx, bz] = heading(st.arm.road, st.arm.s, st.arm.dir);
    if (ax * bx + az * bz < 0.82) turns++;
    cur = st.arm;
  }
  return { steps: plan.steps.length, turns, km: Math.round(plan.length) / 1000, line: gm.routeLine()?.length / 2 };
});
result.pinRoute = routeInfo;
await page.locator(".minimap").click();
await page.waitForTimeout(2500);
await snap("7-map-pin-route");
await page.getByRole("button", { name: "閉じる", exact: true }).click();
save();

// 5. 車に当たった時（車との重なりを 1 回だけ起こす）
await g(() => window.__dev.game.setPace(2));
await page.waitForTimeout(3000);
const hit = await g(async () => {
  const gm = window.__dev.game;
  const before = gm.stamina.energyShare;
  const orig = gm.traffic.contacts.bind(gm.traffic);
  let n = 0;
  gm.traffic.contacts = (r) => (n++ < 3 ? [{ id: 987654 }] : orig(r));
  await new Promise((res) => setTimeout(res, 400));
  gm.traffic.contacts = orig;
  return { before: Math.round(before * 1000) / 10, after: Math.round(gm.stamina.energyShare * 1000) / 10, flash: document.querySelector(".flash")?.innerText ?? null };
});
result.carHit = hit;
await page.waitForTimeout(100);
await snap("8-car-hit");
// 本物の車と重なるか: 前を走る車の真後ろへ寄せて急ぐ（当たれば体力が減る）
save();

// 6. 横画面
await page.setViewportSize({ width: 874, height: 402 });
await page.waitForTimeout(1500);
result.landscape = await rects();
await snap("9-landscape");
await page.setViewportSize({ width: 402, height: 874 });
await page.waitForTimeout(800);
await snap("10-portrait");
save();
console.log(JSON.stringify(result, null, 1));
await browser.close();
