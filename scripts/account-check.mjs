// アカウントとセーブの同期の画面の確認（配達の草案 23.3、D6a）。
// 2 つの端末（ブラウザの文脈 A・B）で: 門を通る → A でゲストの保存を作る → 登録してゲストの保存を移す → B でログインすると同じ保存 →
// B で進めて送る → A で進めると食い違い → サーバーの保存で読み込み直す → ログアウトでゲストに戻る → B でアカウントを消す。縦画面。
// 先に: npm run build、npm run db:migrate:local、wrangler dev（.claude/launch.json の worker、8791）。node scripts/account-check.mjs。結果は artifacts/online/d6a。

import { chromium } from "@playwright/test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

const base = process.env.API_BASE || "http://localhost:8791";
const out = process.env.OUT || "artifacts/online/d6a";
mkdirSync(out, { recursive: true });
const vars = Object.fromEntries(
  readFileSync(new URL("../.dev.vars", import.meta.url), "utf8")
    .split(/\r?\n/)
    .filter((l) => l.includes("="))
    .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
);
const browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || "chrome", headless: true });
const errors = [];
const result = { errors };
const id = `d6a${Date.now().toString(36)}`.slice(0, 16);
const pw = "check horse 2026";
const URL0 = `${base}/?world=generated&notitle=1&time=11&weather=clear`;

async function device(name) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  page.on("pageerror", (e) => errors.push(`${name}: ${e}`));
  if (process.env.TRACE) page.on("response", (r) => r.url().includes("/api/") && console.log(name, r.request().method(), new URL(r.url()).pathname, r.status()));
  page.on("console", (m) => m.type() === "error" && !/status of 40[19]/.test(m.text()) && errors.push(`${name}: ${m.text()}`));
  // サイトのパスワードの門
  await page.goto(`${base}/`);
  await page.fill("input[name=password]", vars.SITE_PASSWORD);
  await Promise.all([page.waitForNavigation(), page.press("input[name=password]", "Enter")]);
  return page;
}
const ready = (page) => page.waitForFunction(() => window.__dev?.game?.loaded && window.__dev.state().ready, null, { timeout: 180000, polling: 250 });
const load = async (page, url = URL0) => {
  await page.goto(url);
  await ready(page);
};
const money = (page) => page.evaluate(() => window.__dev.game.money);
const setMoney = (page, n) =>
  page.evaluate(async (n) => {
    window.__dev.game.money = n;
    await window.__dev.save();
  }, n);
const openAccount = async (page) => {
  await page.click(".menu-btn");
  await page.getByRole("button", { name: "アカウント", exact: true }).click();
  await page.waitForTimeout(300);
};
// 走っている間は 10 秒ごとに保存して送るので、待っている方の端末は止めておく
const pause = (page) => page.evaluate(() => window.__dev.setPaused(true));
const panel = (page) => page.evaluate(() => document.querySelector(".account").innerText);
// 走っている間は 10 秒ごとに保存して「送る前」に戻るので、一度でも「同期済み」になったかを見張る
const watchSynced = (page) =>
  page.evaluate(() => {
    window.__sawSynced = false;
    const el = document.querySelector(".account");
    const look = () => el.innerText.includes("同期済み") && (window.__sawSynced = true);
    look();
    new MutationObserver(look).observe(el, { childList: true, subtree: true, characterData: true });
  });
const waitSynced = (page, label) =>
  page.waitForFunction(() => window.__sawSynced, null, { timeout: 20000 }).catch(async (e) => {
    throw new Error(`${label}: ${await panel(page)} / ${e}`);
  });
const reloaded = (page) => page.waitForEvent("load", { timeout: 60000 }).then(() => ready(page));

// 1. 起動画面のアカウントのボタン（ゲスト）
const A = await device("A");
await A.goto(`${base}/?world=generated&title=1&time=11&weather=clear`);
await A.waitForSelector(".title-screen:not(.hidden)", { timeout: 180000 });
result.titleGuest = await A.evaluate(() => document.querySelector(".title-account").innerText);
await A.screenshot({ path: `${out}/1-title-guest.png` });

// 2. A: ゲストで所持金を作って保存
await load(A);
await setMoney(A, 12345);
await openAccount(A);
result.guestPanel = await panel(A);
await A.screenshot({ path: `${out}/2-guest-panel.png` });

// 3. A: 新しく作ってログイン → ゲストの保存を移すか → 移す → 読み込み直す
const reg = A.locator(".account-form").nth(1);
await reg.locator("input").nth(0).fill(id);
await reg.locator("input").nth(1).fill(pw);
await reg.locator("input").nth(2).fill(pw);
await reg.getByRole("button", { name: "作ってログイン" }).click();
await A.waitForSelector("text=このアカウントへ移す", { timeout: 30000 });
result.takeGuest = await panel(A);
await A.screenshot({ path: `${out}/3-take-guest.png` });
await Promise.all([reloaded(A), A.getByRole("button", { name: "このアカウントへ移す" }).click()]);
result.afterTake = { money: await money(A), guestKey: await A.evaluate(() => localStorage.getItem("owc:save")), scoped: await A.evaluate(() => Object.keys(localStorage).filter((k) => k.includes("@r"))) };
await pause(A);
await openAccount(A);
await watchSynced(A);
await A.evaluate(() => (window.__sawSynced = false));
await A.getByRole("button", { name: "今すぐ送る" }).click();
await waitSynced(A, "A");
result.signedIn = await panel(A);
await A.screenshot({ path: `${out}/4-signed-in.png` });
await A.locator(".account .stamp-head .btn").click();

// 4. B: 別の端末でログインすると、同じ保存で読み込み直す
const B = await device("B");
await load(B);
result.bBefore = await money(B);
await openAccount(B);
const lf = B.locator(".account-form").first();
await lf.locator("input").nth(0).fill(id);
await lf.locator("input").nth(1).fill(pw);
await Promise.all([reloaded(B), lf.getByRole("button", { name: "ログイン" }).click()]);
result.bAfter = await money(B);
await pause(B);

// 5. B で進めてすぐ送る（rev 2）
await setMoney(B, 777);
await openAccount(B);
await watchSynced(B);
await B.evaluate(() => (window.__sawSynced = false));
await B.getByRole("button", { name: "今すぐ送る" }).click();
await waitSynced(B, "B");
await B.locator(".account .stamp-head .btn").click();

// 6. A で進める（前の rev を元に送る）→ 食い違い → アカウントの画面が出る
await setMoney(A, 555);
await A.evaluate(async () => {
  // 次に送るのは 60 秒の間を空けた後なので、裏に回った時と同じくすぐ送らせる
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
  await window.__dev.save();
  delete document.visibilityState;
});
await A.waitForFunction(() => !document.querySelector(".account").classList.contains("hidden") && document.querySelector(".account").innerText.includes("食い違って"), null, { timeout: 30000 });
await A.waitForTimeout(500);
result.conflict = await panel(A);
await A.screenshot({ path: `${out}/5-conflict.png` });
await Promise.all([reloaded(A), A.getByRole("button", { name: "サーバーの保存で読み込み直す" }).click()]);
result.afterResolve = await money(A);

// 7. 縦画面のアカウントの画面
await A.setViewportSize({ width: 390, height: 844 });
await openAccount(A);
await A.waitForTimeout(500);
await A.screenshot({ path: `${out}/6-portrait.png` });
result.portraitFits = await A.evaluate(() => {
  const r = document.querySelector(".account").getBoundingClientRect();
  return r.left >= 0 && r.right <= innerWidth && document.documentElement.scrollWidth <= innerWidth;
});
await A.setViewportSize({ width: 1440, height: 900 });

// 8. A: ログアウト → ゲスト（移したので空）
await Promise.all([reloaded(A), A.getByRole("button", { name: "ログアウト" }).click()]);
result.afterLogout = { money: await money(A), auth: await A.evaluate(() => JSON.parse(localStorage.getItem("owc:auth") || "{}").token ?? null) };

// 9. B: アカウントを消す（2 回押す）
await openAccount(B);
const df = B.locator(".account-form").last();
await df.locator("input").fill(pw);
await df.getByRole("button", { name: "消す" }).click();
await Promise.all([reloaded(B), df.getByRole("button", { name: "もう一度押すと消す" }).click()]);
result.afterDelete = await B.evaluate(() => ({ auth: JSON.parse(localStorage.getItem("owc:auth") || "{}"), scoped: Object.keys(localStorage).filter((k) => k.includes("@r")) }));

writeFileSync(`${out}/result.json`, JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
await browser.close();
