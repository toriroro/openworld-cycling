// 川の網の概観図（PNG）。下地の高さの色、大きな川の線、湖、海へ届かない流域の色分け。
// npx tsx scripts/river-overview.ts --size 200000 --mpp 500 --out artifacts/r1/overview.png

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { deflateSync } from "node:zlib";
import { ORIGIN, WORLD_SEED } from "../src/shared/world/constants.ts";
import { RIVER_GRID } from "../src/shared/world/rivers.ts";
import { Terrain } from "../src/shared/world/terrain.ts";

const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i].replace(/^--/, ""), process.argv[i + 1]);
const seed = Number(args.get("seed") ?? WORLD_SEED);
const cx = Number(args.get("x") ?? ORIGIN.x);
const cz = Number(args.get("z") ?? ORIGIN.z);
const size = Number(args.get("size") ?? 200000);
const mpp = Number(args.get("mpp") ?? 500);
const outPath = args.get("out") ?? "artifacts/r1/overview.png";
const basins = args.get("basins") !== "0";

const W = Math.round(size / mpp);
const x0 = cx - size / 2;
const z0 = cz - size / 2;
const t = new Terrain(seed);
const net = t.rivers;
const img = new Uint8Array(W * W * 3);

// 海へ届くか（格子点ごと）
const reach = new Map<string, boolean>();
const reachesSea = (i: number, j: number): boolean => {
  const path: string[] = [];
  let ci = i;
  let cj = j;
  let res = false;
  for (let k = 0; k < 5000; k++) {
    const key = `${ci},${cj}`;
    const r = reach.get(key);
    if (r !== undefined) {
      res = r;
      break;
    }
    path.push(key);
    if (net.cellHeight(ci, cj) < 0) {
      res = true;
      break;
    }
    const d = net.down(ci, cj);
    if (!d) break;
    [ci, cj] = d;
  }
  for (const k of path) reach.set(k, res);
  return res;
};

for (let py = 0; py < W; py++)
  for (let px = 0; px < W; px++) {
    const x = x0 + (px + 0.5) * mpp;
    const z = z0 + (py + 0.5) * mpp;
    const s = t.sample(x, z, false);
    const h = s.routeHeight;
    let c: [number, number, number];
    if (h < 0) c = [70, 120, 170];
    else {
      const k = Math.min(1, h / 1200);
      c = [120 + 110 * k, 160 + 40 * k, 100 + 100 * k];
      if (basins) {
        const i = Math.floor(x / RIVER_GRID);
        const j = Math.floor(z / RIVER_GRID);
        if (!reachesSea(i, j)) c = [c[0] * 0.75 + 60, c[1] * 0.75 + 20, c[2] * 0.6];
      }
    }
    if (s.water === 3 || s.water === 2) c = [30, 80, 200];
    const o = (py * W + px) * 3;
    img[o] = c[0];
    img[o + 1] = c[1];
    img[o + 2] = c[2];
  }

// 川の線
const { segs, lakes } = net.inRect(x0, z0, x0 + size, z0 + size);
const plot = (x: number, z: number, r: number, c: [number, number, number]) => {
  const px = Math.floor((x - x0) / mpp);
  const py = Math.floor((z - z0) / mpp);
  for (let dy = -r; dy <= r; dy++)
    for (let dx = -r; dx <= r; dx++) {
      const qx = px + dx;
      const qy = py + dy;
      if (qx < 0 || qy < 0 || qx >= W || qy >= W) continue;
      const o = (qy * W + qx) * 3;
      img[o] = c[0];
      img[o + 1] = c[1];
      img[o + 2] = c[2];
    }
};
for (const s of segs) {
  const r = s.acc * 4 >= 1000 ? 1 : 0;
  for (let p = 0; p < s.n; p++) plot(s.x[p], s.z[p], r, [20, 60, 220]);
}
for (const l of lakes) plot(l.x, l.z, 2, [220, 30, 30]);
// 起点
plot(ORIGIN.x, ORIGIN.z, 3, [0, 0, 0]);

// PNG
const crcTable = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc = (b: Uint8Array) => {
  let c = 0xffffffff;
  for (const v of b) c = crcTable[(c ^ v) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type: string, data: Uint8Array) => {
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  out.set(Buffer.from(type, "ascii"), 4);
  out.set(data, 8);
  dv.setUint32(8 + data.length, crc(out.subarray(4, 8 + data.length)));
  return out;
};
const ihdr = new Uint8Array(13);
const dv = new DataView(ihdr.buffer);
dv.setUint32(0, W);
dv.setUint32(4, W);
ihdr[8] = 8;
ihdr[9] = 2;
const raw = new Uint8Array(W * (W * 3 + 1));
for (let y = 0; y < W; y++) {
  raw[y * (W * 3 + 1)] = 0;
  raw.set(img.subarray(y * W * 3, (y + 1) * W * 3), y * (W * 3 + 1) + 1);
}
const png = Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  chunk("IHDR", ihdr),
  chunk("IDAT", deflateSync(raw)),
  chunk("IEND", new Uint8Array(0)),
]);
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, png);
console.log(outPath, `${W}x${W}`, `川の線 ${segs.length}  湖 ${lakes.length}`);
