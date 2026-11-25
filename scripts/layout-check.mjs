// 画面の置き方の確認（配達の草案 27.6）。実機に近い大きさで、走る画面の部品が重なっていないかを数え、撮る。
// 縦 402×680（iPhone のブラウザの縦の見える所）、横 874×342 で左右の安全領域 61px（--safe-l・--safe-r を上書き）。
// 配達中（注文 1 件）、配達アプリの画面を畳んだ時・開いた時、詳しい数字を開いた時。
// 開発サーバーが動いている前提（MAP_BASE、既定 5180）。node scripts/layout-check.mjs。結果は artifacts/layout。

import { chromium } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";

const base = process.env.MAP_BASE || "http://localhost:5180";
const out = process.env.OUT || "artifacts/layout";
mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || "chrome", headless: true });
const page = await (await browser.newContext({ viewport: { width: 402, height: 680 }, deviceScaleFactor: 2, hasTouch: true })).newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
const g = (fn, arg) => page.evaluate(fn, arg);
await page.goto(`${base}/?world=hokkaido&fresh=1&notitle=1&time=11&weather=clear&touch=1`);
await page.waitForFunction(() => window.__dev?.state().ready && window.__dev.state().settled && window.__dev.game.deliveryArea && window.__dev.game.ride?.road, null, { timeout: 240000, polling: 250 });
// 注文を 1 件持って走る（一覧に届いた物を受ける）
await g(() => {
  window.__dev.game.timeScale = 3;
  window.__dev.game.appOn = true;
});
await page.waitForFunction(() => window.__dev.game.feed.items.length >= 2, null, { timeout: 120000, polling: 250 });
await g(() => window.__dev.game.acceptFromPhone(window.__dev.game.feed.items[0].order.no));
await g(() => window.__dev.game.setPace(2));
await page.waitForTimeout(3000);

const SEL = [".menu-btn", ".road-name", ".uturn", ".ride-status", ".branch", ".delivery-strip", ".phone", ".minimap-wrap", ".minimap-zoom", ".pace-bar", ".touch-left", ".touch-btn.brake", ".touch-right .lane", ".ride-info", ".offer-card"];
const measure = () =>
  g((SEL) => {
    const vis = (e) => e && !e.closest(".hidden") && getComputedStyle(e).display !== "none" && e.getBoundingClientRect().width > 0;
    const r = {};
    for (const s of SEL) {
      const e = document.querySelector(s);
      if (!vis(e)) continue;
      const b = e.getBoundingClientRect();
      r[s] = [Math.round(b.left), Math.round(b.top), Math.round(b.right), Math.round(b.bottom)];
    }
    const over = [];
    const keys = Object.keys(r);
    for (let i = 0; i < keys.length; i++)
      for (let j = i + 1; j < keys.length; j++) {
        const a = r[keys[i]], b = r[keys[j]];
        // .minimap-zoom は .minimap-wrap の中、.touch-btn.brake は .touch-right の外に出す
        if ((keys[i] === ".minimap-wrap" && keys[j] === ".minimap-zoom") || (keys[i] === ".minimap-zoom" && keys[j] === ".minimap-wrap")) continue;
        const w = Math.min(a[2], b[2]) - Math.max(a[0], b[0]);
        const h = Math.min(a[3], b[3]) - Math.max(a[1], b[1]);
        if (w > 2 && h > 2) over.push(`${keys[i]} × ${keys[j]} (${w}×${h})`);
      }
    // 画面からはみ出す
    const outside = keys.filter((k) => r[k][0] < -1 || r[k][1] < -1 || r[k][2] > innerWidth + 1 || r[k][3] > innerHeight + 1);
    return { rects: r, over, outside };
  }, SEL);
const result = { errors };
const shot = async (name) => {
  result[name] = await measure();
  await page.screenshot({ path: `${out}/${name}.png` });
};
const setPhone = (open) => g((open) => window.__dev.game.phone.setOpen(open, false), open);

await setPhone(false);
await shot("portrait");
await setPhone(true);
await page.waitForTimeout(300);
await shot("portrait-phone-open");
await setPhone(false);
await page.locator(".ride-status").click();
await shot("portrait-details");
await page.locator(".ride-status").click();

await page.setViewportSize({ width: 874, height: 342 });
await page.addStyleTag({ content: ":root { --safe-l: 61px !important; --safe-r: 61px !important; --safe-b: 8px !important; }" });
await page.waitForTimeout(1500);
await shot("landscape");
await setPhone(true);
await page.waitForTimeout(300);
await shot("landscape-phone-open");
await setPhone(false);
await page.locator(".ride-status").click();
await shot("landscape-details");
writeFileSync(`${out}/result.json`, JSON.stringify(result, null, 1));
for (const k of Object.keys(result)) if (k !== "errors") console.log(k, "重なり", JSON.stringify(result[k].over), "はみ出し", JSON.stringify(result[k].outside));
console.log("errors", errors.length);
await browser.close();
