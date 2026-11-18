// 走行中のパフォーマンスの計測。場所ごとに、自動で走らせて（30fps の上限なし）フレーム間隔・長いタスク・メモリ・描画量と、
// メインスレッドの CPU の使い道（関数ごとの自己時間。Chrome の CPU プロファイル）を取る。
// 開発サーバーが動いている前提（MAP_BASE、既定 5180）。node scripts/perf-check.mjs。結果は artifacts/perf/。
// ONLY=名前,名前 で場所を絞る。SECONDS で走らせる秒数（既定 20）。SCALE で時間の倍率（既定 2）。QUALITY=light で軽量。

import { chromium } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";

const base = process.env.MAP_BASE || "http://localhost:5180";
const out = process.env.OUT || "artifacts/perf";
const SECONDS = Number(process.env.SECONDS || 20);
const SCALE = Number(process.env.SCALE || 2);
const quality = process.env.QUALITY || "standard";
mkdirSync(out, { recursive: true });
const PLACES = [
  ["generated", "generated", null, null],
  ["odori", "hokkaido", 240, 40],
  ["kotoni", "hokkaido", -4300, -2300],
  ["jozankei", "hokkaido", -15093, 10137],
  ["farm", "hokkaido", 9752, -11952],
];
const only = process.env.ONLY ? new Set(process.env.ONLY.split(",")) : null;

const browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || "chrome", headless: true });
const result = { quality, seconds: SECONDS, scale: SCALE, places: {} };
for (const [name, world, x, z] of PLACES.filter(([n]) => !only || only.has(n))) {
  const vp = quality === "light" ? { width: 844, height: 390 } : { width: 1440, height: 900 };
  const page = await browser.newPage({ viewport: vp });
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  const t0 = Date.now();
  const at = x === null ? "" : `&x=${x}&z=${z}`;
  await page.goto(`${base}/?world=${world}&fresh=1&notitle=1&time=10&weather=clear&quality=${quality}${at}`);
  await page.waitForFunction(() => window.__dev?.state().ready && window.__dev.state().settled, null, { timeout: 300000, polling: 250 });
  const loadSec = (Date.now() - t0) / 1000;
  await page.evaluate(() => {
    window.__longTasks = [];
    new PerformanceObserver((l) => {
      for (const e of l.getEntries()) window.__longTasks.push(e.duration);
    }).observe({ entryTypes: ["longtask"] });
    const g = window.__dev.game;
    g.settings.fps30 = false;
    g.setWatching(true);
  });
  await page.evaluate((k) => window.__dev.setTimeScale(k), SCALE);
  await page.waitForTimeout(2000);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Profiler.enable");
  await cdp.send("Profiler.setSamplingInterval", { interval: 500 });
  await page.evaluate(() => {
    window.__dev.frames(true);
    window.__longTasks.length = 0;
  });
  await cdp.send("Profiler.start");
  const odo0 = await page.evaluate(() => window.__dev.rideInfo().odometer);
  await page.waitForTimeout(SECONDS * 1000);
  const { profile } = await cdp.send("Profiler.stop");
  const r = await page.evaluate(() => {
    const d = window.__dev;
    const f = d.frames(true).sort((a, b) => a - b);
    const q = (p) => +(f[Math.floor(p * (f.length - 1))] ?? 0).toFixed(1);
    const s = d.view.stats();
    const lt = window.__longTasks.slice().sort((a, b) => b - a);
    const mem = performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1e6) : null;
    return { frames: f.length, p50: q(0.5), p95: q(0.95), p99: q(0.99), max: q(1), longTasks: lt.length, longTaskMs: Math.round(lt.reduce((a, b) => a + b, 0)), longTop: lt.slice(0, 5).map((v) => Math.round(v)), heapMB: mem, triangles: s.triangles, calls: s.calls, odometer: d.rideInfo().odometer };
  });
  // CPU プロファイル: 関数ごとの自己時間（ファイル名:関数名）
  const byId = new Map(profile.nodes.map((n) => [n.id, n]));
  const self = new Map();
  const dt = profile.timeDeltas;
  const total = (profile.endTime - profile.startTime) / 1000;
  profile.samples.forEach((id, i) => {
    const n = byId.get(id);
    const cf = n.callFrame;
    const file = (cf.url || "").split("/").pop()?.split("?")[0] || "(native)";
    const key = `${file}:${cf.functionName || "(anon)"}`;
    self.set(key, (self.get(key) ?? 0) + (dt[i] ?? 0) / 1000);
  });
  const top = [...self].sort((a, b) => b[1] - a[1]);
  const idle = (self.get("(native):(idle)") ?? 0) + (self.get("(native):(program)") ?? 0) * 0;
  const byFile = new Map();
  for (const [k, v] of self) {
    const f = k.split(":")[0];
    byFile.set(f, (byFile.get(f) ?? 0) + v);
  }
  result.places[name] = {
    loadSec,
    metersPerSec: +((r.odometer - odo0) / SECONDS).toFixed(1),
    ...r,
    cpu: {
      totalMs: Math.round(total),
      idlePct: +((idle / total) * 100).toFixed(1),
      topFunctions: top.filter(([k]) => k !== "(native):(idle)").slice(0, 25).map(([k, v]) => [k, Math.round(v)]),
      topFiles: [...byFile].sort((a, b) => b[1] - a[1]).slice(0, 15).map(([k, v]) => [k, Math.round(v)]),
    },
    errors,
  };
  console.log(name, JSON.stringify({ loadSec, ...r, idlePct: result.places[name].cpu.idlePct }));
  await page.close();
}
writeFileSync(`${out}/results${quality === "light" ? "-light" : ""}.json`, JSON.stringify(result, null, 2));
await browser.close();
