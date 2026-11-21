// 交差点での減速の確認: 眺める乗り方（道なり）で走り、自動減速が入った所が「交差点を直進」か「曲がる」か「カーブ」かを数える。
// 開発サーバーが動いている前提（MAP_BASE、既定 5180）。node scripts/junction-speed-check.mjs。結果は artifacts/junction-speed/<OUT_TAG>。
// RIDE_SEC で走る秒数（既定 180）。ONLY=generated|hokkaido。

import { chromium } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";

const base = process.env.MAP_BASE || "http://localhost:5180";
const out = `artifacts/junction-speed/${process.env.OUT_TAG || "before"}`;
const RIDE_SEC = Number(process.env.RIDE_SEC || 180);
mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ channel: "chrome", headless: true });
const WORLDS = [
  { id: "generated", query: "" },
  { id: "hokkaido", query: "&world=hokkaido" },
].filter((w) => !process.env.ONLY || w.id === process.env.ONLY);

const result = {};
for (const w of WORLDS) {
  const page = await browser.newPage({ viewport: { width: 960, height: 600 } });
  await page.goto(`${base}/?fresh=1&notitle=1&time=10&weather=clear${w.query}`);
  await page.waitForFunction(() => window.__dev?.state().ready && window.__dev.state().settled, null, { timeout: 240000, polling: 250 });
  // 眺める・道なり・交通なし・30fps の上限なし。ページの中で 1 フレームごとに記録する
  await page.evaluate(() => {
    const g = window.__dev.game;
    g.settings.watchRoute = "follow";
    g.settings.fps30 = false;
    g.traffic.level = "off";
    g.setWatching(true);
    const log = (window.__jlog = []);
    const tick = () => {
      const r = g.ride;
      if (r?.road) {
        const u = r.upcoming;
        const pick = u ? u.choices[u.selected ?? u.defaultIndex] : null;
        log.push({ v: r.speed, brake: r.autoBrake, turn: !!r.turn, ud: u ? u.distance : null, angle: pick ? pick.angle : null, straightOn: pick ? pick.straightOn : null, odo: r.odometer });
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  await page.waitForTimeout(RIDE_SEC * 1000);
  const log = await page.evaluate(() => window.__jlog);
  // 自動減速の区間をまとめる
  const events = [];
  let cur = null;
  for (const e of log) {
    if (e.brake > 0) {
      if (!cur) cur = { v0: e.v, vmin: e.v, odo: e.odo, nearJunction: false, angle: null, straightOn: null };
      cur.vmin = Math.min(cur.vmin, e.v);
      if (e.turn || (e.ud !== null && e.ud < 60)) {
        cur.nearJunction = true;
        if (e.angle !== null) {
          cur.angle = e.angle;
          cur.straightOn = e.straightOn;
        }
      }
    } else if (cur) {
      events.push(cur);
      cur = null;
    }
  }
  const deg = (a) => (a === null ? null : Math.round((a * 180) / Math.PI));
  const ev = events.filter((e) => e.v0 - e.vmin > 0.5).map((e) => ({ ...e, angle: deg(e.angle), drop: +(e.v0 - e.vmin).toFixed(2) }));
  result[w.id] = {
    seconds: RIDE_SEC,
    distance: log.at(-1).odo - log[0].odo,
    brakes: ev.length,
    atStraightJunction: ev.filter((e) => e.nearJunction && e.angle !== null && Math.abs(e.angle) < 20).length,
    atTurn: ev.filter((e) => e.nearJunction && e.angle !== null && Math.abs(e.angle) >= 20).length,
    elsewhere: ev.filter((e) => !e.nearJunction).length,
    events: ev,
  };
  await page.close();
}
await browser.close();
writeFileSync(`${out}/result.json`, JSON.stringify(result, null, 2));
for (const [k, r] of Object.entries(result)) console.log(k, JSON.stringify({ ...r, events: r.events.slice(0, 30) }));
