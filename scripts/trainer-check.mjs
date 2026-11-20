// トレーナー連携 B1 の確認（トレーナー連携の草案 7章）: 仮想トレーナーと仮想心拍計をつないで走り、
// 送った勾配・受けた出力・切断と再接続・一時停止を記録する。生成の世界と北海道の世界の両方。
// 開発サーバーが動いている前提（MAP_BASE、既定 5180）。node scripts/trainer-check.mjs。結果は artifacts/trainer/b1。
// RIDE_SEC で 1 つの世界で走る秒数（既定 60）。ONLY=generated|hokkaido で世界を絞る。

import { chromium } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";

const base = process.env.MAP_BASE || "http://localhost:5180";
const out = process.env.OUT || "artifacts/trainer/b1";
const RIDE_SEC = Number(process.env.RIDE_SEC || 60);
mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || "chrome", headless: true });

// 坂のある所から走る（生成の世界は起点、北海道は中山峠の国道）
const WORLDS = [
  { id: "generated", query: "", at: null },
  { id: "hokkaido", query: "&world=hokkaido", at: [-20556, 22888], uTurn: true },
].filter((w) => !process.env.ONLY || w.id === process.env.ONLY);

const result = {};
for (const w of WORLDS) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  const q = w.at ? `&x=${w.at[0]}&z=${w.at[1]}` : "";
  await page.goto(`${base}/?fresh=1&notitle=1&time=10&weather=clear${w.query}${q}`);
  const settle = () => page.waitForFunction(() => window.__dev?.state().ready && window.__dev.state().settled, null, { timeout: 240000, polling: 250 });
  await settle();
  const info = () => page.evaluate(() => window.__dev.trainerInfo());
  // 峠へ登る向きにする（止まっている間だけ U ターンできる）
  if (w.uTurn) await page.evaluate(() => window.__dev.game.ride.uTurn());
  const r = { errors, checks: {} };

  // つなぐ前: 手動の入力元、既定の重さ 75 + 8 kg
  const before = await info();
  r.checks.beforeOnTrainer = before.onTrainer;
  r.checks.defaultMass = before.mass;

  const t = await page.evaluate(() => window.__dev.virtualTrainer("trainer"));
  const hr = await page.evaluate(() => window.__dev.virtualTrainer("heart"));
  r.checks.attach = { trainer: t, heart: hr };
  await page.waitForTimeout(1500);
  const after = await info();
  r.checks.afterOnTrainer = after.onTrainer;
  r.checks.awake = after.awake;
  r.checks.readings = { watts: after.watts, cadence: after.cadence, heartRate: after.heartRate };

  // 走る: 1 秒ごとに速度・ゲームの勾配・最後に送った勾配
  const samples = [];
  for (let i = 0; i < RIDE_SEC; i++) {
    // 出力を 150〜300W で変える
    if (i % 20 === 0) await page.evaluate((wt) => window.__dev.setVirtualWatts(wt), [200, 300, 150][(i / 20) % 3]);
    await page.waitForTimeout(1000);
    const s = await page.evaluate(() => {
      const i = window.__dev.trainerInfo();
      const ri = window.__dev.rideInfo();
      return { speed: ri?.speed ?? 0, odometer: ri?.odometer ?? 0, rideGrade: i.rideGrade, sent: i.lastSent?.grade ?? null, received: i.received.length, watts: i.watts, average: i.average };
    });
    samples.push(s);
  }
  const full = await info();
  r.ride = {
    seconds: RIDE_SEC,
    distance: samples.at(-1).odometer - samples[0].odometer,
    sends: full.sentLog.length,
    received: full.received.length,
    sentGradeRange: [Math.min(...full.sentLog.map((x) => x.grade)), Math.max(...full.sentLog.map((x) => x.grade))],
    rideGradeRange: [Math.min(...samples.map((x) => x.rideGrade)), Math.max(...samples.map((x) => x.rideGrade))],
    // 送った値と機器が受けた値が一致するか（最後の 1 つ）
    lastSentMatchesReceived: full.received.length > 0 && Math.abs(full.received.at(-1).grade - full.lastSent.grade) < 1e-3,
    // 送る間隔（最短）
    minIntervalMs: Math.min(...full.sentLog.slice(1).map((x, k) => x.t - full.sentLog[k].t)),
    samples,
  };
  await page.screenshot({ path: `${out}/${w.id}-riding.png` });

  // 名所・喫茶店に立ち寄っていたら出発する
  await page.evaluate(() => window.__dev.depart());
  // 画面: メニュー → トレーナー
  await page.locator(".menu-btn").click();
  await page.locator(".menu-buttons button", { hasText: "トレーナー" }).click();
  await page.waitForTimeout(700);
  await page.screenshot({ path: `${out}/${w.id}-panel.png` });
  await page.locator(".trainer-panel .stamp-head button").click();

  // 体重を変えると重さが変わる（保存の設定を通す）
  await page.evaluate(() => {
    const g = window.__dev.game;
    g.settings.bodyMass = 60;
    g.applyMass();
  });
  r.checks.massAfter60kg = (await info()).mass;

  // 一時停止: 勾配 0 を送る
  await page.evaluate(() => window.__dev.setPaused(true));
  await page.waitForTimeout(1500);
  r.checks.pausedSent = (await info()).lastSent?.grade;
  await page.evaluate(() => window.__dev.setPaused(false));

  // 切断 → 出力 0・「再接続を待っている」→ つなぎ直す
  await page.evaluate(() => window.__dev.dropVirtual("trainer"));
  await page.waitForTimeout(300);
  const dropped = await info();
  await page.waitForTimeout(800);
  await page.screenshot({ path: `${out}/${w.id}-dropped.png` });
  const note = await page.evaluate(() => document.querySelector(".road-name")?.textContent ?? "");
  await page.waitForTimeout(3500);
  const back = await info();
  r.checks.drop = { stateAfterDrop: dropped.trainer?.state, wattsAfterDrop: dropped.watts, hudNote: note, stateLater: back.trainer?.state, wattsLater: back.watts, onTrainer: back.onTrainer };

  // 外すと手動に戻る
  await page.evaluate(() => {
    const g = window.__dev.game;
    g.trainer.detach("trainer");
    g.trainer.detach("heart");
  });
  await page.waitForTimeout(300);
  const off = await info();
  r.checks.detached = { onTrainer: off.onTrainer, awake: off.awake };
  result[w.id] = r;
  await page.close();
}
await browser.close();
writeFileSync(`${out}/result.json`, JSON.stringify(result, null, 2));
const brief = Object.fromEntries(Object.entries(result).map(([k, v]) => [k, { checks: v.checks, ride: { ...v.ride, samples: undefined }, errors: v.errors }]));
console.log(JSON.stringify(brief, null, 2));
