// H0 の標高タイル（国土地理院 標高タイル PNG）を取る（北海道の草案 3.2・4.1）。
//
//   npx tsx scripts/hokkaido/fetch-dem.ts --list            取るタイルの数を出す（取得しない）
//   npx tsx scripts/hokkaido/fetch-dem.ts --sample 6        何枚かだけ大きさを問い合わせる（HEAD。保存しない）
//   npx tsx scripts/hokkaido/fetch-dem.ts --fetch           取得して assets-source/hokkaido/h0/dem/ に保存
//
// z15 の各タイルを DEM5A → DEM5B の順に探し、どちらも無ければ z14 の DEM10B（親のタイル）を取る。
// 出典: 国土地理院 標高タイル（基盤地図情報 数値標高モデル）https://maps.gsi.go.jp/development/ichiran.html
// 開発中の内部の利用。公開の前に測量法第 30 条の使用承認を申請する（北海道の草案 3.2）。

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { H0_BOX, SOURCE_DIR } from "./area.ts";
import { decodePng, demHeights } from "./png.ts";
import { tileOf } from "./projection.ts";

const OUT_DIR = `${SOURCE_DIR}/h0/dem`;
const BASE = "https://cyberjapandata.gsi.go.jp/xyz";
const Z = 15;
const UA = { "User-Agent": "openworld-cycling-dev-data-fetch" };

interface Tile {
  x: number;
  y: number;
}

function tilesOfBox(): Tile[] {
  const a = tileOf(H0_BOX.north, H0_BOX.west, Z);
  const b = tileOf(H0_BOX.south, H0_BOX.east, Z);
  const out: Tile[] = [];
  for (let y = a.y; y <= b.y; y++) for (let x = a.x; x <= b.x; x++) out.push({ x, y });
  return out;
}

const urlOf = (src: string, z: number, x: number, y: number) => `${BASE}/${src}/${z}/${x}/${y}.png`;
const pathOf = (src: string, z: number, x: number, y: number) => `${OUT_DIR}/${src}/${z}/${x}/${y}.png`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 取れたら中身、無ければ null（404） */
async function get(url: string): Promise<Buffer | null> {
  const res = await fetch(url, { headers: UA });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`${url} ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

async function main() {
  const mode = process.argv[2];
  const tiles = tilesOfBox();
  const xs = new Set(tiles.map((t) => t.x)).size;
  const ys = new Set(tiles.map((t) => t.y)).size;
  if (mode === "--list") {
    console.log(`z${Z} のタイル ${tiles.length} 枚（東西 ${xs} × 南北 ${ys}）。1 枚 256×256 画素`);
    console.log(`各タイルは DEM5A → DEM5B → z14 の DEM10B の順に探す。問い合わせは最大 ${tiles.length * 2 + Math.ceil(tiles.length / 4)} 回`);
    return;
  }
  if (mode === "--sample") {
    const n = Number(process.argv[3] ?? 6);
    const step = Math.max(1, Math.floor(tiles.length / n));
    let sum = 0;
    let got = 0;
    for (let i = 0; i < tiles.length && got < n; i += step) {
      const t = tiles[i];
      for (const src of ["dem5a_png", "dem5b_png"]) {
        const res = await fetch(urlOf(src, Z, t.x, t.y), { method: "HEAD", headers: UA });
        const len = Number(res.headers.get("content-length") ?? 0);
        console.log(`${src} ${t.x}/${t.y}: ${res.status} ${len ? `${(len / 1024).toFixed(0)}KB` : ""}`);
        await sleep(300);
        if (res.ok) {
          sum += len;
          got++;
          break;
        }
      }
    }
    if (got) console.log(`平均 ${(sum / got / 1024).toFixed(0)}KB → ${tiles.length} 枚で約 ${((sum / got) * tiles.length / 1e6).toFixed(0)}MB`);
    return;
  }
  if (mode === "--fill") {
    await fill();
    return;
  }
  if (mode !== "--fetch") {
    console.log("--list・--sample・--fetch・--fill のどれかを付ける");
    return;
  }

  const manifest: object[] = [];
  const parents = new Set<string>();
  let i = 0;
  for (const t of tiles) {
    i++;
    let done = false;
    for (const src of ["dem5a_png", "dem5b_png"]) {
      const path = pathOf(src, Z, t.x, t.y);
      let buf: Buffer | null = existsSync(path) ? readFileSync(path) : null;
      if (!buf) {
        buf = await get(urlOf(src, Z, t.x, t.y));
        await sleep(150);
        if (!buf) continue;
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, buf);
      }
      manifest.push({ z: Z, x: t.x, y: t.y, src, url: urlOf(src, Z, t.x, t.y), path, bytes: buf.length, sha256: createHash("sha256").update(buf).digest("hex") });
      done = true;
      break;
    }
    if (!done) parents.add(`${t.x >> 1},${t.y >> 1}`);
    if (i % 50 === 0) console.log(`${i}/${tiles.length}`);
  }
  for (const key of parents) {
    const [x, y] = key.split(",").map(Number);
    const path = pathOf("dem_png", 14, x, y);
    let buf: Buffer | null = existsSync(path) ? readFileSync(path) : null;
    if (!buf) {
      buf = await get(urlOf("dem_png", 14, x, y));
      await sleep(150);
    }
    if (!buf) {
      manifest.push({ z: 14, x, y, src: "dem_png", url: urlOf("dem_png", 14, x, y), missing: true });
      continue;
    }
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, buf);
    manifest.push({ z: 14, x, y, src: "dem_png", url: urlOf("dem_png", 14, x, y), path, bytes: buf.length, sha256: createHash("sha256").update(buf).digest("hex") });
  }
  writeFileSync(
    `${OUT_DIR}/manifest.json`,
    JSON.stringify(
      {
        source: "国土地理院 標高タイル（基盤地図情報 数値標高モデル）",
        page: "https://maps.gsi.go.jp/development/ichiran.html",
        fetchedAt: new Date().toISOString(),
        bbox: H0_BOX,
        tiles: manifest,
      },
      null,
      2,
    ),
  );
  const bySrc = new Map<string, number>();
  for (const m of manifest as { src: string; missing?: boolean }[]) if (!m.missing) bySrc.set(m.src, (bySrc.get(m.src) ?? 0) + 1);
  console.log([...bySrc].map(([k, v]) => `${k} ${v} 枚`).join("、"));
}

/**
 * --fill: DEM5A のタイルで欠けた画素（川・湖の水面など）がある物について、同じ所の DEM5B と z14 の DEM10B を取る。
 * 変換では 5A → 5B → 10B の順に、欠けていない値を使う。
 */
async function fill() {
  const path = `${OUT_DIR}/manifest.json`;
  const m = JSON.parse(readFileSync(path, "utf8")) as { tiles: { z: number; x: number; y: number; src: string; path?: string }[]; fill?: object[] };
  const holes = m.tiles.filter((t) => t.src === "dem5a_png" && t.path && demHeights(decodePng(readFileSync(t.path))).some(Number.isNaN));
  const fillList: object[] = [];
  const want: [string, number, number, number][] = [];
  const parents = new Set<string>();
  for (const t of holes) {
    want.push(["dem5b_png", Z, t.x, t.y]);
    const key = `${t.x >> 1},${t.y >> 1}`;
    if (!parents.has(key)) {
      parents.add(key);
      want.push(["dem_png", 14, t.x >> 1, t.y >> 1]);
    }
  }
  console.log(`欠けのある DEM5A ${holes.length} 枚 → DEM5B ${holes.length} 枚、DEM10B ${parents.size} 枚を探す`);
  let bytes = 0;
  for (const [src, z, x, y] of want) {
    const p = pathOf(src, z, x, y);
    let buf: Buffer | null = existsSync(p) ? readFileSync(p) : null;
    if (!buf) {
      buf = await get(urlOf(src, z, x, y));
      await sleep(150);
    }
    if (!buf) {
      fillList.push({ z, x, y, src, url: urlOf(src, z, x, y), missing: true });
      continue;
    }
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, buf);
    bytes += buf.length;
    fillList.push({ z, x, y, src, url: urlOf(src, z, x, y), path: p, bytes: buf.length, sha256: createHash("sha256").update(buf).digest("hex") });
  }
  m.fill = fillList;
  writeFileSync(path, JSON.stringify(m, null, 2));
  const got = (s: string) => fillList.filter((f) => (f as { src: string; missing?: boolean }).src === s && !(f as { missing?: boolean }).missing).length;
  console.log(`DEM5B ${got("dem5b_png")} 枚、DEM10B ${got("dem_png")} 枚、${(bytes / 1e6).toFixed(1)}MB`);
}

await main();
