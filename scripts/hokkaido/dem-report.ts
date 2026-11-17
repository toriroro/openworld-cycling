// 取得した H0 の標高タイルを全部復号し、欠けた画素と標高の範囲を数える（北海道の草案 4.1・4.4）。
//   npx tsx scripts/hokkaido/dem-report.ts

import { readFileSync } from "node:fs";
import { SOURCE_DIR } from "./area.ts";
import { decodePng, demHeights } from "./png.ts";

interface Entry {
  src: string;
  path?: string;
  missing?: boolean;
}

const m = JSON.parse(readFileSync(`${SOURCE_DIR}/h0/dem/manifest.json`, "utf8")) as { tiles: Entry[] };
const bySrc = new Map<string, { tiles: number; px: number; miss: number; min: number; max: number; partial: number }>();
for (const t of m.tiles) {
  if (t.missing || !t.path) continue;
  const img = decodePng(readFileSync(t.path));
  if (img.width !== 256 || img.height !== 256) throw new Error(`${t.path}: ${img.width}×${img.height}`);
  const h = demHeights(img);
  const s = bySrc.get(t.src) ?? { tiles: 0, px: 0, miss: 0, min: Infinity, max: -Infinity, partial: 0 };
  let miss = 0;
  for (const v of h) {
    if (Number.isNaN(v)) miss++;
    else {
      if (v < s.min) s.min = v;
      if (v > s.max) s.max = v;
    }
  }
  s.tiles++;
  s.px += h.length;
  s.miss += miss;
  if (miss > 0) s.partial++;
  bySrc.set(t.src, s);
}
// 埋めた後: 5A の欠けを 5B → z14 の 10B（同じ地点の画素）で埋めて、残る欠けを数える
const fills = new Map<string, Float32Array>();
for (const f of (m as { fill?: (Entry & { z: number; x: number; y: number })[] }).fill ?? []) {
  if (!f.missing && f.path) fills.set(`${f.src}/${f.z}/${f.x}/${f.y}`, demHeights(decodePng(readFileSync(f.path))));
}
let left = 0;
let filled = 0;
for (const t of m.tiles as (Entry & { z: number; x: number; y: number })[]) {
  if (t.src !== "dem5a_png" || !t.path) continue;
  const h = demHeights(decodePng(readFileSync(t.path)));
  const b = fills.get(`dem5b_png/15/${t.x}/${t.y}`);
  const c = fills.get(`dem_png/14/${t.x >> 1}/${t.y >> 1}`);
  for (let i = 0; i < h.length; i++) {
    if (!Number.isNaN(h[i])) continue;
    const px = i % 256;
    const py = (i / 256) | 0;
    const ci = (((t.y & 1) * 128 + (py >> 1)) * 256) + (t.x & 1) * 128 + (px >> 1);
    const v = b && !Number.isNaN(b[i]) ? b[i] : c ? c[ci] : Number.NaN;
    if (Number.isNaN(v)) left++;
    else filled++;
  }
}
console.log(`埋めた画素 ${filled}、残る欠け ${left}`);
for (const [src, s] of bySrc) {
  console.log(
    `${src}: ${s.tiles} 枚、欠けた画素 ${((s.miss / s.px) * 100).toFixed(2)}%（欠けを含むタイル ${s.partial} 枚）、標高 ${s.min.toFixed(1)}〜${s.max.toFixed(1)}m`,
  );
}
