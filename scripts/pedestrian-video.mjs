// 歩く人の動きを動画で撮る（町の見た目の草案 3 章）。止めた写真では分からない歩きのなめらかさを見るため。
// 開発サーバーが動いている前提（MAP_BASE、既定 5180）。AT=x,z（既定は大通）、OUT=artifacts/pedestrians/video。
// 並び（people.html の横・斜め）と、ゲームの中で歩く人を追う 2 本を撮り、ffmpeg が有れば GIF にもする。
import { chromium } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdirSync, renameSync, rmSync } from "node:fs";

const base = process.env.MAP_BASE || "http://localhost:5180";
const out = process.env.OUT || "artifacts/pedestrians/video";
const [x, z] = (process.env.AT || "240,40").split(",").map(Number);
mkdirSync(out, { recursive: true });
const size = { width: 960, height: 540 };
const browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || "chrome", headless: true, args: ["--enable-gpu", "--ignore-gpu-blocklist"] });
const errors = [];
const files = [];

// 同じ作業ツリーでほかの作業が進むと、開発サーバーがページを読み込み直す。撮っている間に読み込み直したら撮り直す
async function record(name, run) {
  for (let attempt = 0; ; attempt++) {
    const ctx = await browser.newContext({ viewport: size, recordVideo: { dir: `${out}/tmp`, size } });
    const page = await ctx.newPage();
    page.on("pageerror", (e) => errors.push(String(e)));
    page.on("console", (m) => m.type() === "error" && errors.push(m.text().slice(0, 300)));
    let loads = 0;
    page.on("load", () => loads++);
    const cut = await run(page);
    const video = page.video();
    await ctx.close();
    if (loads > 1 && attempt < 3) {
      errors.push(`${name}: 撮っている間に読み込み直した（${attempt + 1} 回目）`);
      continue;
    }
    return save(name, video, cut);
  }
}

async function save(name, video, cut) {
  const webm = `${out}/${name}.webm`;
  rmSync(webm, { force: true });
  renameSync(await video.path(), webm);
  files.push({ name, webm, cut });
}

// 1. 並び: その場で歩く。横と斜めから
for (const [name, q] of [["lineup-side", "view=side&group=0"], ["lineup-quarter", "view=quarter&group=1"]])
  await record(name, async (page) => {
    await page.goto(`${base}/people.html?${q}`);
    await page.waitForFunction(() => window.__people?.real.ready || window.__people?.real.error, null, { timeout: 60000 });
    const t0 = Date.now();
    await page.waitForTimeout(800);
    const start = (Date.now() - t0) / 1000;
    await page.waitForTimeout(5000);
    return start;
  });

// 2. ゲームの中: 歩いている人を 1 人選び、横に並んで追う
await record("street-follow", async (page) => {
  const t0 = Date.now();
  await page.goto(`${base}/?world=hokkaido&fresh=1&notitle=1&time=${process.env.TIME || 11}&weather=clear&x=${x}&z=${z}`);
  await page.waitForFunction(() => window.__dev?.state().ready && window.__dev.state().settled && window.__dev.game.ride?.road && window.__dev.view.pedestrians.real.ready, null, { timeout: 240000, polling: 250 });
  await page.evaluate(() => {
    // 画面の部品を隠す（描画の面とそれを含む物だけ残す）
    for (const e of document.body.querySelectorAll("*")) if (e.tagName !== "CANVAS" && !e.querySelector("canvas")) e.style.visibility = "hidden";
    const v = window.__dev.view;
    v._f = v.frame.bind(v);
    v.frame = (e, t, f, cb) => {
      const s = v._follow;
      if (s == null) return v._f(e, t, f, cb);
      const p = v.pedestrians.realList.find((q) => q.seed === s);
      if (p) v._last = p;
      const w = v._last;
      if (!w) return v._f(e, t, f, cb);
      // 進む向きの右横 3.4m・少し前から、腰の高さを見る
      const a = w.yaw + Math.PI / 2 - 0.35;
      return v._f({ x: w.x + Math.sin(a) * 3.4, y: w.y + 1.3, z: w.z + Math.cos(a) * 3.4 }, { x: w.x, y: w.y + 0.9, z: w.z }, 45, cb);
    };
  });
  await page.waitForTimeout(2500);
  const seed = await page.evaluate(() => {
    const v = window.__dev.view;
    const walking = v.pedestrians.realList.filter((p) => !p.still);
    walking.sort((a, b) => Math.hypot(a.x - v.pedestrians.eye.x, a.z - v.pedestrians.eye.z) - Math.hypot(b.x - v.pedestrians.eye.x, b.z - v.pedestrians.eye.z));
    const w = walking[0];
    v._follow = w?.seed ?? null;
    return w?.seed ?? null;
  });
  if (seed == null) errors.push("歩いている人がいない");
  await page.waitForTimeout(600);
  const start = (Date.now() - t0) / 1000;
  await page.waitForTimeout(7000);
  return start;
});
await browser.close();

// GIF（前の待ちの分を切る）
const ff = process.env.FFMPEG || "ffmpeg";
for (const f of files) {
  const gif = f.webm.replace(/\.webm$/, ".gif");
  try {
    execFileSync(ff, ["-y", "-loglevel", "error", "-ss", String(f.cut), "-i", f.webm, "-vf", "fps=20,scale=720:-1:flags=lanczos,split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4", gif]);
    f.gif = gif;
  } catch (e) {
    errors.push(`GIF にできなかった: ${f.name}`);
  }
}
rmSync(`${out}/tmp`, { recursive: true, force: true });
console.log(JSON.stringify({ files, errors }, null, 2));
