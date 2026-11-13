// ガレージ（garage.html）で1枚だけ撮る。node scripts/rider-shot.mjs <png> '<view の JSON>' [追加のクエリ]
import { chromium } from "@playwright/test";

const [out, view, extra] = [process.argv[2], JSON.parse(process.argv[3]), process.argv[4] || ""];
const base = process.env.RIDER_BASE || "http://localhost:5182";
const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
await page.goto(`${base}/garage.html?${extra}`);
await page.waitForFunction(() => window.__garage?.cyclist.rider.stats().ready, null, { timeout: 60000 });
await page.evaluate((v) => Object.assign(window.__garage.view, v), view);
if (process.env.POSE) await page.evaluate((p) => Object.assign(window.__garage.pose, p), JSON.parse(process.env.POSE));
await page.waitForTimeout(400);
await page.screenshot({ path: out });
await browser.close();
