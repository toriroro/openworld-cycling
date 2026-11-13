// 川の網の試作の確認（河川の草案 9章の 1〜4）。
// npx tsx scripts/river-report.ts --seed 6 --x -32500 --z 11250 --size 200000
// 結果は artifacts/r1/river-report.json に残す。

import { mkdirSync, writeFileSync } from "node:fs";
import { ORIGIN, WORLD_SEED } from "../src/shared/world/constants.ts";
import { RIVER_GRID, RIVER_MIN_ACC, RiverNet, riverSize } from "../src/shared/world/rivers.ts";
import { Terrain } from "../src/shared/world/terrain.ts";

const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i].replace(/^--/, ""), process.argv[i + 1]);
const seed = Number(args.get("seed") ?? WORLD_SEED);
const cx = Number(args.get("x") ?? ORIGIN.x);
const cz = Number(args.get("z") ?? ORIGIN.z);
const size = Number(args.get("size") ?? 200000);
const half = size / 2;
const i0 = Math.floor((cx - half) / RIVER_GRID);
const j0 = Math.floor((cz - half) / RIVER_GRID);
const i1 = Math.floor((cx + half) / RIVER_GRID);
const j1 = Math.floor((cz + half) / RIVER_GRID);
const log = (...a: unknown[]) => console.log(...a);

const terrain = new Terrain(seed);
const net = terrain.rivers;

// 1・2: 海へ届く割合、くぼ地、水路、湖
let t0 = performance.now();
const st = net.stats(i0, j0, i1, j1);
log(`格子点 ${st.cells}（陸）  海へ届く ${st.sea}（${((st.sea / st.cells) * 100).toFixed(1)}%）`);
log(`くぼ地 ${st.pits}  水路で解消 ${st.channels}  湖 ${st.lakes}  (${(performance.now() - t0).toFixed(0)}ms)`);

// 大きな川の格子点と総延長
t0 = performance.now();
const acc40 = net.accumulation(i0, j0, i1, j1);
const accMs = performance.now() - t0;
const net80 = new RiverNet(seed, (x, z) => terrain.baseHeight(x, z), 80);
const acc80 = net80.accumulation(i0, j0, i1, j1);
let rivers40 = 0;
let rivers80 = 0;
let widthChanged10 = 0;
let widthChanged30 = 0;
let classChanged = 0;
let both = 0;
const bandOf = (a: number) => (a * 4 < 200 ? 0 : a * 4 < 1000 ? 1 : 2);
const accHist = [0, 0, 0];
let maxAcc = 0;
for (let k = 0; k < acc40.length; k++) {
  const a = acc40[k];
  const b = acc80[k];
  if (a >= RIVER_MIN_ACC) {
    rivers40++;
    accHist[bandOf(a)]++;
    if (a > maxAcc) maxAcc = a;
  }
  if (b >= RIVER_MIN_ACC) rivers80++;
  if (a >= RIVER_MIN_ACC && b >= RIVER_MIN_ACC) {
    both++;
    const wa = riverSize(a).plain;
    const wb = riverSize(b).plain;
    if (Math.abs(wb - wa) / wb > 0.1) widthChanged10++;
    if (Math.abs(wb - wa) / wb > 0.3) widthChanged30++;
    if (bandOf(a) !== bandOf(b)) classChanged++;
  }
}
log(`大きな川の格子点 40格子: ${rivers40}  80格子: ${rivers80}  （流域の計算 ${accMs.toFixed(0)}ms）`);
log(`  80km と 160km で川の幅が 10% 超変わる ${widthChanged10}/${both}、30% 超 ${widthChanged30}/${both}、表の区分が変わる ${classChanged}/${both}`);
log(`  区分 中小河川 ${accHist[0]}、河川 ${accHist[1]}、大河川 ${accHist[2]}、最大の流域 ${maxAcc * 4}km²`);

// 川の線の総延長（範囲内のブロック）
t0 = performance.now();
const all = net.inRect(cx - half, cz - half, cx + half, cz + half);
const segMs = performance.now() - t0;
let length = 0;
let toSea = 0;
let rise = 0;
let minSlope = Infinity;
let maxSlope = 0;
const slopes: number[] = [];
for (const s of all.segs) {
  const inside = s.x[0] >= cx - half && s.x[0] < cx + half && s.z[0] >= cz - half && s.z[0] < cz + half;
  if (!inside) continue;
  let L = 0;
  for (let p = 1; p < s.n; p++) {
    L += Math.sqrt((s.x[p] - s.x[p - 1]) ** 2 + (s.z[p] - s.z[p - 1]) ** 2);
    if (s.w[p] > s.w[p - 1] + 1e-9) rise++;
  }
  length += L;
  if (s.toSea) toSea++;
  const g = (s.w[0] - s.w[s.n - 1]) / L;
  slopes.push(g);
  if (g < minSlope) minSlope = g;
  if (g > maxSlope) maxSlope = g;
}
slopes.sort((a, b) => a - b);
const pct = (p: number) => slopes[Math.min(slopes.length - 1, Math.floor(p * slopes.length))];
log(
  `川の線 ${all.segs.length}（範囲内の元 ${slopes.length}）  総延長 ${(length / 1000).toFixed(0)}km  海へ出る ${toSea}  湖 ${all.lakes.length}  水面が上がる点 ${rise}`,
);
log(`  区間の勾配 中央値 ${(pct(0.5) * 100).toFixed(2)}%  p10 ${(pct(0.1) * 100).toFixed(2)}%  p90 ${(pct(0.9) * 100).toFixed(2)}%  最大 ${(maxSlope * 100).toFixed(1)}%`);
log(`  ブロック ${net.blockCount} 個  計 ${net.blockMs.toFixed(0)}ms（1 個あたり ${(net.blockMs / Math.max(1, net.blockCount)).toFixed(0)}ms）  川の線を集める ${segMs.toFixed(0)}ms`);

// 4: 高さ関数の費用。近景タイル1枚（33×33 点 + 法線用の余白 = 35×35）の高さを、川あり・下地だけで比べる
const tiles: [number, number][] = [];
for (const s of all.segs.slice(0, 400)) if (s.acc >= 25) tiles.push([Math.floor(s.x[s.n >> 1] / 256) * 256, Math.floor(s.z[s.n >> 1] / 256) * 256]);
const sampleTiles = tiles.slice(0, 60);
const fresh = new Terrain(seed);
for (const [x, z] of sampleTiles) fresh.height(x, z); // ブロックを先に作る
const timeTiles = (f: (x: number, z: number) => number) => {
  const t = performance.now();
  let acc = 0;
  for (const [x0, z0] of sampleTiles) for (let j = 0; j < 35; j++) for (let i = 0; i < 35; i++) acc += f(x0 + (i - 1) * 8, z0 + (j - 1) * 8);
  return { ms: (performance.now() - t) / sampleTiles.length, acc };
};
timeTiles((x, z) => fresh.height(x, z));
const withRiver = timeTiles((x, z) => fresh.height(x, z));
const baseOnly = timeTiles((x, z) => fresh.baseHeight(x, z));
log(`近景タイル1枚の高さ（川の近く ${sampleTiles.length} 枚の平均）: 川あり ${withRiver.ms.toFixed(2)}ms  下地だけ ${baseOnly.ms.toFixed(2)}ms`);

const out = {
  date: new Date().toISOString(),
  seed,
  center: [cx, cz],
  size,
  cells: st,
  seaRatio: st.sea / st.cells,
  rivers: { cells40: rivers40, cells80: rivers80, both, widthChanged10, widthChanged30, classChanged, bands: accHist, maxAreaKm2: maxAcc * 4 },
  segs: { count: slopes.length, lengthKm: length / 1000, toSea, lakes: all.lakes.length, rise, slopeMedian: pct(0.5), slopeP10: pct(0.1), slopeP90: pct(0.9), slopeMax: maxSlope },
  cost: { blocks: net.blockCount, blockMsAvg: net.blockMs / Math.max(1, net.blockCount), accMs, tileMsRiver: withRiver.ms, tileMsBase: baseOnly.ms },
};
mkdirSync("artifacts/r1", { recursive: true });
writeFileSync("artifacts/r1/river-report.json", JSON.stringify(out, null, 2));
log("artifacts/r1/river-report.json");
