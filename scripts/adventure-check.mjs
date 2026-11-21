// 冒険の乗り方 A1 の確認（冒険の草案 7 章）: 冒険で始め、旅に出て冒険の距離が尽きると走った道だけを走る、
// 運動の記録のファイル（GPX・TCX、作り物）を取り込むと増える、地図で走っていない所を描かない、遠くへのワープを断る、起動画面の選択。
// 開発サーバーが動いている前提（MAP_BASE、既定 5180）。node scripts/adventure-check.mjs。結果は artifacts/adventure/a1。

import { chromium } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";

const base = process.env.MAP_BASE || "http://localhost:5180";
const out = process.env.OUT || "artifacts/adventure/a1";
mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || "chrome", headless: true });

const WORLDS = [
  { id: "generated", query: "" },
  { id: "hokkaido", query: "&world=hokkaido" },
].filter((w) => !process.env.ONLY || w.id === process.env.ONLY);

// 作り物の運動の記録（位置は札幌の大通の近くを北へ。中身の位置はゲームに残らない）
const now = Date.now();
const gpx = (startMs, km, type) => {
  const pts = [];
  const n = Math.round((km * 1000) / 111.2);
  for (let i = 0; i <= n; i++) pts.push(`<trkpt lat="${(43.06 + i * 0.001).toFixed(6)}" lon="141.35"><time>${new Date(startMs + i * 30000).toISOString()}</time></trkpt>`);
  return `<?xml version="1.0"?><gpx version="1.1" creator="test"><trk><type>${type}</type><trkseg>${pts.join("")}</trkseg></trk></gpx>`;
};
const tcx = (startMs, m, s) =>
  `<?xml version="1.0"?><TrainingCenterDatabase><Activities><Activity Sport="Other"><Lap StartTime="${new Date(startMs).toISOString()}"><TotalTimeSeconds>${s}</TotalTimeSeconds><DistanceMeters>${m}</DistanceMeters></Lap></Activity></Activities></TrainingCenterDatabase>`;
const b64 = (s) => Buffer.from(s, "utf8").toString("base64");
const FILES = [
  { name: "morning-run.gpx", base64: b64(gpx(now - 3 * 3600e3, 3, "running")) },
  // 同じ記録を別のサービスから（開始が 60 秒ずれ）
  { name: "morning-run-strava.gpx", base64: b64(gpx(now - 3 * 3600e3 + 60e3, 3, "running")) },
  { name: "walk.tcx", base64: b64(tcx(now - 2 * 3600e3, 2000, 1500)) },
  // 種目の無い GPX
  { name: "no-type.gpx", base64: b64(gpx(now - 3600e3, 1, "")) },
  // 10 日前（取り込めない）
  { name: "old.gpx", base64: b64(gpx(now - 10 * 86400e3, 5, "running")) },
];

const result = {};
for (const w of WORLDS) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  await page.goto(`${base}/?fresh=1&notitle=1&time=10&weather=clear${w.query}`);
  const settle = () => page.waitForFunction(() => window.__dev?.state().ready && window.__dev.state().settled, null, { timeout: 240000, polling: 250 });
  await settle();
  const r = { errors };
  const info = () => page.evaluate(() => window.__dev.adventureInfo());
  await page.evaluate(() => window.__dev.startAdventure());
  await settle();
  r.start = await info();

  // 旅に出る（画面のボタン）。確かめやすいように残りを 400m にし、4 倍で進める
  await page.evaluate(() => {
    window.__dev.game.adventure.balance = 400;
    window.__dev.setTimeScale(4);
  });
  await page.locator(".menu-btn").click();
  await page.locator(".menu-buttons button", { hasText: "冒険" }).click();
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${out}/${w.id}-panel.png` });
  await page.locator(".adventure-panel button", { hasText: "旅に出る" }).click();
  // 尽きるまで（最大 90 秒）
  let exhausted = null;
  for (let i = 0; i < 90; i++) {
    await page.waitForTimeout(1000);
    const a = await info();
    if (a.balance < 10) {
      exhausted = { atSec: i + 1, ...a, odometer: (await page.evaluate(() => window.__dev.rideInfo())).odometer };
      break;
    }
  }
  r.exhausted = exhausted;
  // 尽きた後の 30 秒: 走った道だけ走る（使った距離が増えない）
  const spent0 = (await info()).spent;
  const odo0 = (await page.evaluate(() => window.__dev.rideInfo())).odometer;
  let blockedSeen = 0;
  for (let i = 0; i < 30; i++) {
    await page.waitForTimeout(1000);
    if ((await info()).blocked) blockedSeen++;
  }
  const odo1 = (await page.evaluate(() => window.__dev.rideInfo())).odometer;
  r.afterExhausted = { spentChange: (await info()).spent - spent0, moved: odo1 - odo0, blockedSeconds: blockedSeen };
  await page.screenshot({ path: `${out}/${w.id}-exhausted.png` });
  await page.evaluate(() => window.__dev.setTimeScale(1));

  // 取り込み
  const pending = await page.evaluate((files) => window.__dev.readImports(files), FILES);
  r.pending = pending;
  // 名所・喫茶店に立ち寄っていたら出発し、眺めるのをやめる（画面のボタンを出す）
  r.stopDuringJourney = await page.evaluate(() => window.__dev.stopInfo().stop);
  await page.evaluate(() => {
    window.__dev.depart();
    window.__dev.game.setWatching(false);
  });
  await page.locator(".menu-btn").click();
  await page.locator(".menu-buttons button", { hasText: "冒険" }).click();
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${out}/${w.id}-preview.png`, fullPage: false });
  const rows = await page.evaluate(() => [...document.querySelectorAll(".adventure-preview .stamp-item")].map((e) => e.textContent));
  r.previewRows = rows;
  // 種目の無い GPX はウォーキングにする
  const sel = page.locator(".adventure-preview select");
  if (await sel.count()) await sel.first().selectOption("walk");
  const before = (await info()).balance;
  await page.locator(".adventure-preview button", { hasText: "取り込む" }).click();
  await page.waitForTimeout(300);
  const after = await info();
  r.imported = { added: after.balance - before, imports: after.imports };
  await page.screenshot({ path: `${out}/${w.id}-imported.png` });
  await page.locator(".adventure-panel .stamp-head button").click();

  // 地図（走っていない所の道を描かない）と、遠くへのワープを断る
  await page.evaluate(() => window.__dev.game.toggleMap());
  await page.waitForTimeout(4000);
  await page.screenshot({ path: `${out}/${w.id}-map.png` });
  r.warp = await page.evaluate(() => {
    const g = window.__dev.game;
    const p = g.ride.pose();
    g.mapOverlay.setWarping(true);
    g.mapOverlay.map.opts.game.onTap(p.x + 15000, p.z + 15000);
    return { stillOpen: g.mapOverlay.isOpen };
  });
  await page.waitForTimeout(300);
  r.warp.note = await page.evaluate(() => document.querySelector(".map-info")?.textContent);
  await page.evaluate(() => window.__dev.game.mapOverlay.close());

  // 起動画面: はじめから → 自由・冒険
  await page.evaluate(() => window.__dev.game.showTitle());
  await page.waitForTimeout(500);
  await page.locator(".title-buttons button", { hasText: "はじめから" }).click();
  await page.waitForTimeout(200);
  r.title = await page.evaluate(() => [...document.querySelectorAll(".title-buttons button")].map((b) => b.textContent));
  await page.screenshot({ path: `${out}/${w.id}-title.png` });
  result[w.id] = r;
  await page.close();
}
await browser.close();
writeFileSync(`${out}/result.json`, JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
