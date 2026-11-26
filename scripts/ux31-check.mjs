// 配達の草案 30 章の確認（402×874、タッチ）:
// 1. 左右へ寄る: 1 回押して 0.8m 動くまでの時間と、画面の向きの振れ
// 2. 注文の導線: 持っている注文が無い時の「配達」は配達アプリを開く。受けたら経路を引いて漕ぎ出す
// 3. 脚が尽きた時: 全力でも抑えた出力のペースになり、20% に戻るまで続く
// 4. 体力を戻す所の円: 押すと向かい、着くと自販機は飲む・店は入店して出る演出の後に体力が戻る
// 5. 近くの配達員を人の形で描く
// 6. 車のタイヤの所（近くから）
// 開発サーバーが動いている前提（MAP_BASE、既定 5180）。node scripts/ux31-check.mjs。結果は artifacts/ux31。

import { chromium } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";

const base = process.env.MAP_BASE || "http://localhost:5180";
const out = process.env.OUT || "artifacts/ux31";
mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || "chrome", headless: true });
const page = await (await browser.newContext({ viewport: { width: 402, height: 874 }, deviceScaleFactor: 2, hasTouch: true })).newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
const g = (fn, arg) => page.evaluate(fn, arg);
const snap = (name) => page.screenshot({ path: `${out}/${name}.png` });
const result = { errors };
const save = () => writeFileSync(`${out}/result.json`, JSON.stringify(result, null, 2));
const wait = (fn, arg, ms = 120000) => page.waitForFunction(fn, arg, { timeout: ms, polling: 100 }).then(() => true).catch(() => false);

await page.goto(`${base}/?world=hokkaido&fresh=1&notitle=1&time=11&weather=clear&touch=1`);
await page.waitForFunction(() => window.__dev?.state().ready && window.__dev.state().settled && window.__dev.game.deliveryArea && window.__dev.game.ride?.road, null, { timeout: 240000, polling: 250 });
await page.waitForTimeout(2000);

// 1. 左右へ寄る
await g(() => window.__dev.game.setPace(2));
await page.waitForTimeout(3000);
result.lane = await g(async () => {
  const gm = window.__dev.game;
  const cam = gm.view.camera;
  const r = gm.ride;
  const o0 = r.offset;
  const d0 = cam.getWorldDirection(cam.position.clone());
  gm.input.push("lane-right");
  const t0 = performance.now();
  let reach = null;
  let maxTurn = 0;
  while (performance.now() - t0 < 1500) {
    await new Promise((res) => requestAnimationFrame(res));
    const d = cam.getWorldDirection(cam.position.clone());
    maxTurn = Math.max(maxTurn, Math.acos(Math.min(1, d.x * d0.x + d.y * d0.y + d.z * d0.z)));
    if (reach === null && r.offset - o0 >= 0.72) reach = Math.round(performance.now() - t0);
  }
  return { msTo90: reach, moved: +(r.offset - o0).toFixed(2), cameraTurnDeg: +((maxTurn * 180) / Math.PI).toFixed(2) };
});
save();

// 2. 注文の導線
await g(() => window.__dev.game.setPace(0));
await page.waitForTimeout(1500);
await g(() => window.__dev.game.openDelivery());
await page.waitForTimeout(300);
result.flow = await g(() => ({ panelOpen: window.__dev.game.deliveryPanel?.isOpen ?? null, phoneOpen: !document.querySelector(".phone").classList.contains("folded") }));
await g(() => {
  const gm = window.__dev.game;
  gm.appOn = true;
  gm.timeScale = 3;
});
await wait(() => window.__dev.game.feed.items.length >= 1, null, 120000);
await g(() => window.__dev.game.acceptFromPhone(window.__dev.game.feed.items[0].order.no));
await page.waitForTimeout(500);
result.flow.afterAccept = await g(() => ({ goal: !!window.__dev.game.ride.goal, pace: window.__dev.game.manual.pace, guide: window.__dev.game.deliveryGuide }));
await g(() => (window.__dev.game.timeScale = 1));
// 以降の画面を見やすくするため、配達アプリの画面を畳む
await g(() => window.__dev.game.phone.setOpen(false, false));
save();

// 3. 脚が尽きた時
await g(() => window.__dev.game.setPace(4));
await page.waitForTimeout(3000);
const fast = await g(() => Math.round(window.__dev.game.ride.speed * 3.6));
await g(() => (window.__dev.game.stamina.legs = 0));
await page.waitForTimeout(300);
const flash = await g(() => document.querySelector(".flash")?.textContent ?? null);
await page.waitForTimeout(8000);
result.legs = {
  fullKmh: fast,
  flash,
  afterKmh: await g(() => Math.round(window.__dev.game.ride.speed * 3.6)),
  legs: await g(() => +window.__dev.game.stamina.legsShare.toFixed(3)),
  exhausted: await g(() => window.__dev.game.stamina.exhausted),
  cappedButton: await g(() => document.querySelector(".pace-btn.capped")?.textContent ?? null),
};
await snap("3-legs-capped");
await g(() => {
  const s = window.__dev.game.stamina;
  s.legs = s.p.wPrime;
  s.exhausted = false;
  window.__dev.game.setPace(0);
});
save();

// 4. 円を押して回復
const project = (st) =>
  g((st) => {
    const gm = window.__dev.game;
    const cam = gm.view.camera;
    const rx = st.x - st.fx * 1.3 - gm.view.originX;
    const rz = st.z - st.fz * 1.3 - gm.view.originZ;
    const v = cam.position.clone().set(rx, st.y + 0.05, rz).project(cam);
    const r = gm.view.renderer.domElement.getBoundingClientRect();
    return { x: r.left + ((v.x + 1) / 2) * r.width, y: r.top + ((1 - v.y) / 2) * r.height, inView: Math.abs(v.x) < 0.95 && Math.abs(v.y) < 0.95 && v.z < 1, rings: gm.view.restStops.stats.rings };
  }, st);
const tapRing = async (kind) => {
  const st = await g((kind) => {
    const gm = window.__dev.game;
    const p = gm.ride.pose();
    return gm.restStops.filter((s) => (kind === "vending" ? s.kind === "vending" : s.kind === "gyudon" || s.kind === "teishoku")).sort((a, b) => Math.hypot(a.x - p.x, a.z - p.z) - Math.hypot(b.x - p.x, b.z - p.z))[0] ?? null;
  }, kind);
  if (!st) return null;
  // その所へ移る
  await g((st) => {
    const gm = window.__dev.game;
    gm.setPace(0);
    gm.teleport(st.roadX, st.roadZ);
  }, st);
  await page.waitForFunction(() => window.__dev.game.ride?.road && window.__dev.state().settled, null, { timeout: 120000, polling: 250 });
  // 円が画面に入る所まで下がる
  let pt = null;
  for (const back of [18, 30, 45]) {
    await g((back) => {
      const r = window.__dev.game.ride;
      r.pos = { ...r.pos, s: r.pos.s - r.pos.dir * back };
      r.speed = 0;
    }, back);
    await page.waitForTimeout(1500);
    pt = await project(st);
    if (pt.inView) break;
    await g((back) => {
      const r = window.__dev.game.ride;
      r.pos = { ...r.pos, s: r.pos.s + r.pos.dir * back };
    }, back);
  }
  await snap(`4-${kind}-ring`);
  const before = await g(() => ({ energy: +window.__dev.game.stamina.energyShare.toFixed(3), money: window.__dev.game.money }));
  let tapped = "no";
  if (pt.inView) {
    await page.mouse.click(pt.x, pt.y);
    tapped = (await g(() => !!window.__dev.game.restGoal || !!window.__dev.game.restAction)) ? "tap" : "missed";
  }
  // 円が画面に入らなかった時（交差する道へ移った時など）は、押した時と同じ関数で向かう
  if (tapped !== "tap") {
    await g((id) => window.__dev.game.goToRest(window.__dev.game.restStops.find((s) => s.id === id)), st.id);
    tapped += "→direct";
  }
  const started = await wait(() => !!window.__dev.game.restAction, null, 40000);
  await page.waitForTimeout(kind === "vending" ? 1500 : 600);
  await snap(`4-${kind}-action`);
  if (kind !== "vending") {
    await page.waitForTimeout(1500);
    await snap(`4-${kind}-inside`);
  }
  await wait(() => !window.__dev.game.restAction, null, 20000);
  const after = await g(() => ({ energy: +window.__dev.game.stamina.energyShare.toFixed(3), money: window.__dev.game.money, flash: document.querySelector(".flash")?.textContent ?? null }));
  return { name: st.name, point: pt, tapped, started, before, after };
};
await g(() => (window.__dev.game.stamina.energy = window.__dev.game.stamina.p.energy * 0.4));
result.vending = await tapRing("vending");
save();
await g(() => (window.__dev.game.money = 5000));
result.shop = await tapRing("shop");
save();

// 5. 近くの配達員
await g(() => window.__dev.game.setPace(2));
const seen = await wait(() => window.__dev.view.npcRiders.drawn.size > 0, null, 60000);
const behind = await g(() => {
  const gm = window.__dev.game;
  const p = gm.ride.pose();
  const c = gm.traffic.vehicles.filter((v) => v.type === "courier" && !v.turn).sort((a, b) => Math.hypot(a.x - p.x, a.z - p.z) - Math.hypot(b.x - p.x, b.z - p.z))[0];
  if (!c) return null;
  gm.setPace(1);
  const r = gm.ride;
  r.pos = { road: c.pos.road, s: c.pos.s - c.pos.dir * 7, dir: c.pos.dir };
  r.speed = c.speed;
  return c.id;
});
await page.waitForTimeout(1200);
result.npc = { seen, drawn: await g(() => window.__dev.view.npcRiders.drawn.size), behind };
await snap("5-npc-rider");
save();

// 6. 車のタイヤの所
await g(() => window.__dev.game.setPace(0));
const car = await g(() => {
  const gm = window.__dev.game;
  const p = gm.ride.pose();
  const v = gm.traffic.vehicles.filter((o) => o.type === "sedan" || o.type === "minivan" || o.type === "kei").sort((a, b) => Math.hypot(a.x - p.x, a.z - p.z) - Math.hypot(b.x - p.x, b.z - p.z))[0];
  if (!v) return null;
  const r = gm.ride;
  r.pos = { road: v.pos.road, s: v.pos.s - v.pos.dir * 6, dir: v.pos.dir };
  r.speed = 0;
  // 車を止めて、自転車を右の車線へ寄せて斜め後ろから見る
  v.speed = 0;
  v.crash = { side: 1, from: v.offset, stoppedAt: performance.now() };
  r.laneShift = 2.5;
  return v.type;
});
await page.waitForTimeout(900);
result.car = car;
await snap("6-car-wheels");
save();
// 7. 横（幅寄せ）: 走っている配達員の右横へ自分を置いて、左へ寄る操作をする
await g(() => window.__dev.game.setPace(2));
await page.waitForTimeout(1500);
result.yose = await g(async () => {
  const gm = window.__dev.game;
  const r = gm.ride;
  const c = gm.traffic.vehicles.filter((v) => v.type === "courier" && !v.turn && v.speed > 3).sort((a, b) => Math.hypot(a.x - r.pose().x, a.z - r.pose().z) - Math.hypot(b.x - r.pose().x, b.z - r.pose().z))[0];
  if (!c) return null;
  r.pos = { road: c.pos.road, s: c.pos.s, dir: c.pos.dir };
  r.offset = c.offset + 1.1;
  r.laneShift = r.offset + r.road.width / 4;
  r.speed = c.speed;
  await new Promise((res) => setTimeout(res, 150));
  const e0 = c.energy;
  const o0 = c.offset;
  gm.input.push("lane-left");
  await new Promise((res) => setTimeout(res, 350));
  return { energyBefore: e0, energyAfter: c.energy, courierMoved: +(c.offset - o0).toFixed(2), flash: document.querySelector(".flash")?.textContent ?? null, playerEnergy: +gm.stamina.energyShare.toFixed(3) };
});
await snap("7-yose");
save();
console.log(JSON.stringify(result, null, 1));
await browser.close();
