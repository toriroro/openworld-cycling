// 天候の割合と、1 か所で続く長さの検査。npx tsx scripts/weather-report.ts
import { DAY_MS, weatherAt, worldHour } from "../src/shared/world/weather.ts";

const t0 = Date.UTC(2026, 10, 14);
const counts = { clear: 0, cloudy: 0, fog: 0 };
const byHour: Record<number, { clear: number; cloudy: number; fog: number }> = {};
let n = 0;
for (let i = 0; i < 40; i++)
  for (let j = 0; j < 40; j++)
    for (let k = 0; k < 60; k++) {
      const ms = t0 + k * 2.3 * 3600e3 + i * 977 + j * 13;
      const w = weatherAt(-60000 + i * 3100, -60000 + j * 2900, ms);
      counts[w.kind]++;
      const h = Math.floor(worldHour(ms) / 3) * 3;
      (byHour[h] ??= { clear: 0, cloudy: 0, fog: 0 })[w.kind]++;
      n++;
    }
const pct = (v: number, t: number) => `${((v / t) * 100).toFixed(1)}%`;
console.log("全体", Object.fromEntries(Object.entries(counts).map(([k, v]) => [k, pct(v, n)])));
for (const [h, c] of Object.entries(byHour)) {
  const t = c.clear + c.cloudy + c.fog;
  console.log(`${h}時台`, pct(c.clear, t), pct(c.cloudy, t), pct(c.fog, t));
}
// 1 か所で、天候が変わるまでの長さ（実時間の分）
const runs: number[] = [];
for (let p = 0; p < 30; p++) {
  let prev = "";
  let start = 0;
  for (let m = 0; m < 24 * 60 * 3; m++) {
    const k = weatherAt(p * 7919, p * -3571, t0 + m * 60e3).kind;
    if (k !== prev) {
      if (prev) runs.push(m - start);
      prev = k;
      start = m;
    }
  }
}
runs.sort((a, b) => a - b);
console.log("続く長さ（分）中央", runs[runs.length >> 1], "最短", runs[0], "1割", runs[Math.floor(runs.length * 0.1)], "回数", runs.length, "1日", DAY_MS / 60e3, "分");
