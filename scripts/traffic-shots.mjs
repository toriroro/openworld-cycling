// 交通（車・バス・バス停）の画面写真と描画量。起点の葛郷から走り出して車を出し、車種ごとに近くから撮る。
// 開発サーバーが動いている前提（MAP_BASE で指定、既定は 5180）。結果は artifacts/traffic/。
// node scripts/traffic-shots.mjs。QUALITY=light で軽量画質。

import { chromium } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";

const base = process.env.MAP_BASE || "http://localhost:5180";
const quality = process.env.QUALITY || "standard";
const suffix = quality === "light" ? "-light" : "";
const out = "artifacts/traffic";
mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
await page.goto(`${base}/?fresh=1&notitle=1&quality=${quality}&time=8&weather=clear`);
await page.waitForFunction(() => window.__dev?.state().ready && window.__dev.state().settled, null, { timeout: 240000, polling: 250 });
// 車が出るまで走る（自動の入力で、時間を 4 倍に）
await page.evaluate(() => {
  const d = window.__dev;
  d.game.setWatching(true);
  d.setTimeScale(4);
  document.querySelector(".hud-root")?.classList.add("hidden");
});
await page.waitForTimeout(20000);
await page.evaluate(() => window.__dev.setTimeScale(1));
await page.waitForTimeout(3000);
const shots = {};
const snap = async (name) => {
  await page.waitForTimeout(700);
  await page.screenshot({ path: `${out}/${name}${suffix}.png` });
  const s = await page.evaluate(() => ({ stats: window.__dev.view.stats(), t: window.__dev.trafficInfo() }));
  shots[name] = { triangles: s.stats.triangles, calls: s.stats.calls, vehicles: s.t.count, drawn: s.t.view.drawn, stops: s.t.view.stops, shelters: s.t.view.shelters };
};
await page.evaluate(() => (window.__dev.game.camera = "chase"));
await snap("chase");
// 一時停止して、視点を外から決める
await page.evaluate(() => {
  const d = window.__dev;
  d.setPaused(true);
  const v = d.view;
  v._f = v.frame.bind(v);
  v.frame = (e, t, f, cb) => (v._cam ? v._f(v._cam.e, v._cam.t, v._cam.fov ?? 45, cb) : v._f(e, t, f, cb));
});
const camAt = (e, t, fov = 45) => page.evaluate(({ e, t, fov }) => (window.__dev.view._cam = { e, t, fov }), { e, t, fov });
// 上から: 自転車の周り
const info = await page.evaluate(() => ({ r: window.__dev.rideInfo(), t: window.__dev.trafficInfo() }));
const r = info.r;
await camAt({ x: r.x - 90, y: r.y + 70, z: r.z - 90 }, { x: r.x + 40, y: r.y, z: r.z + 40 }, 50);
await snap("above");
// 車種ごとに近くから（いなければ飛ばす）
const types = ["sedan", "kei", "minivan", "van", "keiTruck", "bus"];
for (const type of types) {
  const v = info.t.vehicles.filter((x) => x.type === type).sort((a, b) => Math.hypot(a.x - r.x, a.z - r.z) - Math.hypot(b.x - r.x, b.z - r.z))[0];
  if (!v) continue;
  const p = await page.evaluate((id) => {
    const veh = window.__dev.game.traffic.vehicles.find((x) => x.id === id);
    return veh ? { x: veh.x, y: veh.y, z: veh.z, dx: veh.dx, dz: veh.dz } : null;
  }, v.id);
  if (!p) continue;
  const dist = type === "bus" ? 16 : 8;
  // 斜め前の右から
  const ex = p.x + p.dx * dist * 0.8 - p.dz * dist * 0.7;
  const ez = p.z + p.dz * dist * 0.8 + p.dx * dist * 0.7;
  await camAt({ x: ex, y: p.y + (type === "bus" ? 3.5 : 2.2), z: ez }, { x: p.x, y: p.y + (type === "bus" ? 1.6 : 0.8), z: p.z }, 45);
  await snap(`type-${type}`);
}
// 6 車種を並べる（止めている間に車の一覧を置き換える。交通は止まっているので動かない）
await page.evaluate(() => {
  const d = window.__dev;
  const p = d.game.ride.pose();
  const list = d.game.traffic.vehicles;
  const tmpl = list[0];
  list.length = 0;
  const types = [["sedan", "#b9bdc0"], ["kei", "#cbbd9a"], ["minivan", "#2b3f63"], ["van", "#f2f2ee"], ["keiTruck", "#f2f2ee"], ["bus", "#1f5aa6"]];
  const lens = { sedan: 4.6, kei: 3.4, minivan: 4.7, van: 4.7, keiTruck: 3.4, bus: 10.5 };
  let k = 12;
  // 自転車の進む向きに対して右（対向車線）に並べ、向きは逆
  for (const [type, color] of types) {
    k += lens[type] / 2 + 2.5;
    const x = p.x + p.dx * k + -p.dz * 1.9;
    const z = p.z + p.dz * k + p.dx * 1.9;
    list.push({ ...tmpl, id: 9000 + k, type, color, x, z, y: d.view.surfaceHeight(x, z), dx: -p.dx, dz: -p.dz, grade: 0 });
    k += lens[type] / 2;
  }
  d.view._lineup = { x: p.x, z: p.z, dx: p.dx, dz: p.dz };
});
{
  const L = await page.evaluate(() => window.__dev.view._lineup);
  const y = await page.evaluate(({ x, z }) => window.__dev.view.surfaceHeight(x, z), { x: L.x, z: L.z });
  await camAt({ x: L.x + L.dx * 10 + L.dz * 9, y: y + 4, z: L.z + L.dz * 10 - L.dx * 9 }, { x: L.x + L.dx * 32 - L.dz * 1.9, y: y + 1, z: L.z + L.dz * 32 + L.dx * 1.9 }, 50);
  await snap("lineup");
}
// バス停（自転車から 700m 以内。待合所付きを優先）
const stop = await page.evaluate(({ x, z }) => {
  const near = window.__dev.game.traffic.stopsNear(x, z, 700).filter((s) => Math.hypot(s.x - x, s.z - z) < 700);
  const st = near.sort((a, b) => (b.shelter ? 1 : 0) - (a.shelter ? 1 : 0) || Math.hypot(a.x - x, a.z - z) - Math.hypot(b.x - x, b.z - z))[0];
  return st ? { x: st.x, y: st.y, z: st.z, dx: st.dx, dz: st.dz, side: st.side, shelter: st.shelter } : null;
}, { x: r.x, z: r.z });
if (stop) {
  const ox = -stop.dz * stop.side, oz = stop.dx * stop.side;
  // 道路の反対側から
  await camAt({ x: stop.x - ox * 11 + stop.dx * 6, y: stop.y + 2.2, z: stop.z - oz * 11 + stop.dz * 6 }, { x: stop.x + ox * 1, y: stop.y + 1.2, z: stop.z + oz * 1 }, 45);
  await page.waitForTimeout(800);
  await page.waitForFunction(() => window.__dev.state().settled, null, { timeout: 120000, polling: 250 });
  await snap("bus-stop");
}
// 夜と霧: いちばん近い車を斜め前から（灯火を見る）
const near = await page.evaluate(({ x, z }) => {
  const v = [...window.__dev.game.traffic.vehicles].sort((a, b) => Math.hypot(a.x - x, a.z - z) - Math.hypot(b.x - x, b.z - z))[0];
  return v ? { x: v.x, y: v.y, z: v.z, dx: v.dx, dz: v.dz } : null;
}, { x: r.x, z: r.z });
if (near) await camAt({ x: near.x + near.dx * 22 - near.dz * 4, y: near.y + 2.5, z: near.z + near.dz * 22 + near.dx * 4 }, { x: near.x, y: near.y + 1, z: near.z }, 50);
await page.evaluate(() => window.__dev.setSky({ hour: 21, weather: "clear" }));
await snap("night");
await page.evaluate(() => window.__dev.setSky({ hour: 8, weather: "fog" }));
await snap("fog");
writeFileSync(`${out}/results${suffix}.json`, JSON.stringify({ date: new Date().toISOString(), quality, shots, errors, traffic: (await page.evaluate(() => window.__dev.trafficInfo())).stats }, null, 2));
console.log(JSON.stringify({ shots, errors }));
await browser.close();
