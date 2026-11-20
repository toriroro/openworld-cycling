// トレーナー連携 B2 の確認（トレーナー連携の草案 6章・7章）: 仮想トレーナーで走って記録し、
// 一時停止の間は残さない、読み込み直しても残っている、「FIT で書き出す」でファイルが落ち、読めて中身が合う、を確かめる。
// 開発サーバーが動いている前提（MAP_BASE、既定 5180）。node scripts/trainer-record-check.mjs。結果は artifacts/trainer/b2。
// RIDE_SEC で走る秒数（既定 60。真ん中で 8 秒一時停止する）。

import { chromium } from "@playwright/test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { decodeFit } from "../tests/fit-decode.ts";

const base = process.env.MAP_BASE || "http://localhost:5180";
const out = process.env.OUT || "artifacts/trainer/b2";
const RIDE_SEC = Number(process.env.RIDE_SEC || 60);
mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || "chrome", headless: true });

const WORLDS = [
  { id: "generated", query: "", at: null },
  // 中山峠へ登る国道 230 号（B1 と同じ所）
  { id: "hokkaido", query: "&world=hokkaido", at: [-20556, 22888], uTurn: true },
].filter((w) => !process.env.ONLY || w.id === process.env.ONLY);

const FIT_EPOCH = 631065600;
const result = {};
for (const w of WORLDS) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  const url = `${base}/?fresh=1&notitle=1&time=10&weather=clear${w.query}${w.at ? `&x=${w.at[0]}&z=${w.at[1]}` : ""}`;
  const settle = () => page.waitForFunction(() => window.__dev?.state().ready && window.__dev.state().settled, null, { timeout: 240000, polling: 250 });
  await page.goto(url);
  await settle();
  const r = { errors };
  // 前の確認の記録が残っていれば消す
  await page.evaluate(() => {
    window.__dev.game.recorder.clear();
    return window.__dev.saveRecord();
  });
  if (w.uTurn) await page.evaluate(() => window.__dev.game.ride.uTurn());
  await page.evaluate(() => window.__dev.virtualTrainer("trainer"));
  await page.evaluate(() => window.__dev.virtualTrainer("heart"));
  const rec = () => page.evaluate(() => window.__dev.recordInfo());
  const half = Math.floor(RIDE_SEC / 2);
  await page.waitForTimeout(half * 1000);
  const beforePause = await rec();
  await page.evaluate(() => window.__dev.setPaused(true));
  await page.waitForTimeout(8000);
  const duringPause = await rec();
  await page.evaluate(() => window.__dev.setPaused(false));
  await page.waitForTimeout((RIDE_SEC - half) * 1000);
  const ride = await page.evaluate(() => window.__dev.rideInfo());
  const afterRide = await rec();
  r.record = { beforePause, duringPause, afterRide, rideOdometer: ride.odometer };

  // 読み込み直す（記録は保存から戻る）
  await page.evaluate(() => window.__dev.saveRecord());
  await page.goto(url);
  await settle();
  const reloaded = await rec();
  r.reload = reloaded;

  // 画面から書き出す
  await page.locator(".menu-btn").click();
  await page.locator(".menu-buttons button", { hasText: "トレーナー" }).click();
  await page.waitForTimeout(700);
  await page.screenshot({ path: `${out}/${w.id}-panel.png` });
  const [download] = await Promise.all([page.waitForEvent("download"), page.locator(".trainer-panel button", { hasText: "FIT で書き出す" }).click()]);
  const file = `${out}/${w.id}.fit`;
  await download.saveAs(file);
  r.download = { suggested: download.suggestedFilename(), afterExport: await rec() };
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${out}/${w.id}-panel-after.png` });

  // ファイルを読む
  const f = decodeFit(new Uint8Array(readFileSync(file)));
  const recs = f.messages.filter((m) => m.global === 20);
  const sess = f.messages.find((m) => m.global === 18).fields;
  const events = f.messages.filter((m) => m.global === 21).map((m) => m.fields.get(1));
  const first = recs[0].fields;
  const last = recs.at(-1).fields;
  const deg = (v) => (v === undefined ? null : (v * 180) / 2 ** 31);
  r.fit = {
    bytes: readFileSync(file).length,
    headerCrcOk: f.headerCrcOk,
    fileCrcOk: f.fileCrcOk,
    records: recs.length,
    events,
    start: new Date((sess.get(2) + FIT_EPOCH) * 1000).toISOString(),
    sport: sess.get(5),
    subSport: sess.get(6),
    elapsed: sess.get(7) / 1000,
    timer: sess.get(8) / 1000,
    distance: sess.get(9) / 100,
    avgPower: sess.get(20),
    avgCadence: sess.get(18),
    avgHeartRate: sess.get(16),
    ascent: sess.get(22),
    firstPos: [deg(first.get(0)), deg(first.get(1))],
    lastPos: [deg(last.get(0)), deg(last.get(1))],
    altitude: [first.get(2) / 5 - 500, last.get(2) / 5 - 500],
  };
  result[w.id] = r;
  await ctx.close();
}
await browser.close();
writeFileSync(`${out}/result.json`, JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
