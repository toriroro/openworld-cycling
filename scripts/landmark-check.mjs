// 名所帳と名所の立ち寄り（名所の草案 docs/history/specs/2026-11-18-landmarks-draft.md）を通しで確かめる。
// 名所帳を開く → 名所を行き先にする → こいで向かう → そばでブレーキ → 立ち寄りの表示とスタンプ → 出発 → 地図の印。
// 開発サーバーが動いている前提（MAP_BASE、既定 5180）。node scripts/landmark-check.mjs [名所の id]（既定 tvtower）
// 結果は artifacts/hokkaido/landmarks/check/。

import { chromium } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";

const base = process.env.MAP_BASE || "http://localhost:5180";
const out = "artifacts/hokkaido/landmarks/check";
mkdirSync(out, { recursive: true });
const id = process.argv[2] || "tvtower";
/** 走り始める所（名所から 400m ほど離れた走る道） */
const STARTS = { tvtower: [100, -60], clocktower: [-100, -300], akarenga: [200, -500], nakajima: [400, 1000] };
const browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || "chrome", headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e.stack || e)));
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
const ready = () => page.waitForFunction(() => window.__dev?.state().ready && window.__dev.state().settled, null, { timeout: 240000, polling: 250 });
const pedal = (on) => page.evaluate((v) => window.dispatchEvent(new KeyboardEvent(v ? "keydown" : "keyup", { code: "Space" })), on);
const result = { id, errors };

await page.goto(`${base}/?world=hokkaido&fresh=1&notitle=1&time=11&weather=clear`);
await ready();
const [sx, sz] = STARTS[id] ?? [100, -60];
await page.evaluate(({ x, z }) => window.__dev.teleport(x, z), { x: sx, z: sz });
await page.waitForFunction(() => window.__dev.state().ready, null, { timeout: 120000, polling: 250 });
await ready();
await page.waitForFunction(() => window.__dev.landmarks().length > 0, null, { timeout: 60000, polling: 250 });

// 名所帳を開いて、名所の行の「行き先にする」を押す
await page.click(".menu-btn");
await page.getByRole("button", { name: "名所帳" }).click();
await page.waitForTimeout(400);
await page.screenshot({ path: `${out}/book.png` });
result.book = await page.evaluate(() => [...document.querySelectorAll(".landmark-book .stamp-item")].map((e) => e.textContent));
const lm = await page.evaluate((id) => window.__dev.landmarks().find((l) => l.id === id), id);
await page.locator(".landmark-book .stamp-item", { hasText: lm.name }).getByRole("button", { name: "行き先にする" }).click();
await page.waitForTimeout(500);
result.goal = await page.evaluate(() => ({ info: window.__dev.rideInfo(), road: document.querySelector(".hud-road, .road-name")?.textContent ?? null }));
result.hudText = await page.evaluate(() => document.body.innerText.split("\n").filter((l) => /まで/.test(l)));

// こいで向かう（時間 4 倍）。区域から 25m（走る道までの距離による）でブレーキ
await page.evaluate(() => window.__dev.setTimeScale(4));
await pedal(true);
const t0 = Date.now();
await page.waitForFunction(
  (lm) => {
    const p = window.__dev.rideInfo();
    return p && (p.goalReached || Math.hypot(p.x - lm.x, p.z - lm.z) < 60);
  },
  lm,
  { timeout: 300000, polling: 50 },
);
await page.evaluate(() => window.__dev.setTimeScale(1));
await pedal(false);
await page.evaluate(() => window.dispatchEvent(new KeyboardEvent("keydown", { code: "ShiftLeft" })));
await page.waitForFunction(() => window.__dev.stopInfo().stop !== null, null, { timeout: 60000, polling: 100 });
await page.evaluate(() => window.dispatchEvent(new KeyboardEvent("keyup", { code: "ShiftLeft" })));
result.rideSec = (Date.now() - t0) / 1000;
await page.waitForTimeout(2500);
await page.screenshot({ path: `${out}/stop.png` });
result.stop = await page.evaluate(() => ({ info: window.__dev.stopInfo(), panel: document.querySelector(".stop-panel")?.textContent }));
await page.click(".stop-depart");
await page.waitForTimeout(800);

// 名所帳（行った印）と地図の印
await page.click(".menu-btn");
await page.getByRole("button", { name: "名所帳" }).click();
await page.waitForTimeout(400);
await page.screenshot({ path: `${out}/book-after.png` });
await page.click(".landmark-book .stamp-head .btn");
await page.evaluate(() => window.__dev.game.toggleMap());
await page.waitForTimeout(1500);
await page.screenshot({ path: `${out}/map.png` });
await page.evaluate(() => window.__dev.game.toggleMap());
await page.waitForTimeout(300);
await page.screenshot({ path: `${out}/minimap.png`, clip: { x: 1280 - 170, y: 800 - 170, width: 170, height: 170 } });
writeFileSync(`${out}/result-${id}.json`, JSON.stringify(result, null, 2));
console.log(JSON.stringify({ ...result, book: result.book.length }, null, 1));
await browser.close();
