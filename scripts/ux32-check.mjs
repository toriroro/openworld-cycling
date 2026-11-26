// 配達の草案 31 章の確認: 配達アプリの画面（スマートフォンの形。402×874 で開いた時・畳んだ時、1280×720）と、
// 交差点の住所の看板を表と裏から見た所（柱が字にかぶらない・字が左から右へ読める）。
// 開発サーバーが動いている前提（MAP_BASE、既定 5180）。node scripts/ux32-check.mjs。結果は artifacts/ux32。

import { chromium } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";

const base = process.env.MAP_BASE || "http://localhost:5180";
const out = process.env.OUT || "artifacts/ux32";
mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || "chrome", headless: true });
const result = {};
for (const v of [
  { name: "phone", w: 402, h: 874, touch: true },
  { name: "desktop", w: 1280, h: 720, touch: false },
]) {
  const page = await (await browser.newContext({ viewport: { width: v.w, height: v.h }, deviceScaleFactor: 2, hasTouch: v.touch })).newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(`${base}/?world=hokkaido&fresh=1&notitle=1&time=11&weather=clear${v.touch ? "&touch=1" : ""}`);
  await page.waitForFunction(() => window.__dev?.state().ready && window.__dev.state().settled && window.__dev.game.deliveryArea && window.__dev.game.ride?.road, null, { timeout: 240000, polling: 250 });
  await page.evaluate(() => {
    window.__dev.game.timeScale = 3;
    window.__dev.game.appOn = true;
    window.__dev.game.phone.setOpen(true, false);
  });
  await page.waitForFunction(() => window.__dev.game.feed.items.length >= 3, null, { timeout: 120000, polling: 250 });
  await page.evaluate(() => (window.__dev.game.timeScale = 1));
  await page.locator(".phone-item:not(.gone)").first().click();
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${out}/${v.name}-open.png` });
  await page.locator(".phone-head").click();
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${out}/${v.name}-folded.png` });
  result[v.name] = { errors, clock: await page.evaluate(() => document.querySelector(".phone-clock").textContent) };
  if (v.name === "desktop") {
    // 住所の看板: 近い看板の表の側と裏の側から、板の高さで見る
    for (const side of [1, -1]) {
      // 描く時の目と注視点を差し替える（ゲームは毎フレーム自転車の後ろへカメラを戻すため）
      const label = await page.evaluate((side) => {
        const gm = window.__dev.game;
        const s = gm.signList?.[0];
        if (!s) return null;
        const y = s.y + 2.7 + 0.33;
        const eye = { x: s.x + s.nx * 5 * side - s.nz * 1.2, y: y + 0.3, z: s.z + s.nz * 5 * side + s.nx * 1.2 };
        const target = { x: s.x, y, z: s.z };
        const view = gm.view;
        if (!view.__frame) view.__frame = view.frame.bind(view);
        view.frame = (_e, _t, _f, cb) => view.__frame(eye, target, 50, cb);
        return s.label;
      }, side);
      await page.waitForTimeout(800);
      await page.screenshot({ path: `${out}/sign-${side > 0 ? "front" : "back"}.png`, clip: { x: 340, y: 160, width: 600, height: 400 } });
      result[side > 0 ? "signFront" : "signBack"] = label;
    }
  }
  await page.close();
}
writeFileSync(`${out}/result.json`, JSON.stringify(result, null, 2));
console.log(JSON.stringify(result));
await browser.close();
