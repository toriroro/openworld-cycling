// H2 の標高タイル（国土地理院 標高タイル PNG、DEM10B・z14）を取る（北海道の草案 18.1）。
//
//   npx tsx scripts/hokkaido/fetch-dem-h2.ts --list     取るタイルの数を出す（取得しない）
//   npx tsx scripts/hokkaido/fetch-dem-h2.ts --fetch    取得して assets-source/hokkaido/h2/dem/ に保存
//
// H0 で取った z14 の DEM10B が同じ番号であれば、それを写して問い合わせない。海のタイルは 404（missing として記録）。
// 出典: 国土地理院 標高タイル（基盤地図情報 数値標高モデル）https://maps.gsi.go.jp/development/ichiran.html
// 開発中の内部の利用。公開の前に測量法第 30 条の使用承認を申請する（北海道の草案 3.2）。

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { H2_BOX, SOURCE_DIR } from "./area.ts";
import { tileOf } from "./projection.ts";

const OUT_DIR = `${SOURCE_DIR}/h2/dem`;
const H0_DIR = `${SOURCE_DIR}/h0/dem`;
const BASE = "https://cyberjapandata.gsi.go.jp/xyz";
const Z = 14;
const SRC = "dem_png";
const UA = { "User-Agent": "openworld-cycling-dev-data-fetch" };

const urlOf = (x: number, y: number) => `${BASE}/${SRC}/${Z}/${x}/${y}.png`;
const pathOf = (dir: string, x: number, y: number) => `${dir}/${SRC}/${Z}/${x}/${y}.png`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function get(url: string): Promise<Buffer | null> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, { headers: UA });
    if (res.status === 404) return null;
    if (res.ok) return Buffer.from(await res.arrayBuffer());
    if (attempt >= 3) throw new Error(`${url} ${res.status}`);
    console.log(`${url} ${res.status}、待って問い直す`);
    await sleep(5000 * (attempt + 1));
  }
}

async function main() {
  const mode = process.argv[2];
  const a = tileOf(H2_BOX.north, H2_BOX.west, Z);
  const b = tileOf(H2_BOX.south, H2_BOX.east, Z);
  const tiles: { x: number; y: number }[] = [];
  for (let y = a.y; y <= b.y; y++) for (let x = a.x; x <= b.x; x++) tiles.push({ x, y });
  if (mode === "--list") {
    console.log(`z${Z} の DEM10B ${tiles.length} 枚（東西 ${b.x - a.x + 1} × 南北 ${b.y - a.y + 1}）`);
    return;
  }
  if (mode !== "--fetch") {
    console.log("--list・--fetch のどちらかを付ける");
    return;
  }
  const manifest: object[] = [];
  let bytes = 0;
  let fetched = 0;
  let copied = 0;
  let missing = 0;
  let i = 0;
  for (const t of tiles) {
    i++;
    const path = pathOf(OUT_DIR, t.x, t.y);
    let buf: Buffer | null = null;
    if (existsSync(path)) buf = readFileSync(path);
    else if (existsSync(pathOf(H0_DIR, t.x, t.y))) {
      buf = readFileSync(pathOf(H0_DIR, t.x, t.y));
      copied++;
    } else {
      buf = await get(urlOf(t.x, t.y));
      fetched++;
      await sleep(150);
    }
    if (!buf) {
      missing++;
      manifest.push({ z: Z, x: t.x, y: t.y, src: SRC, url: urlOf(t.x, t.y), missing: true });
    } else {
      if (!existsSync(path)) {
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, buf);
      }
      bytes += buf.length;
      manifest.push({ z: Z, x: t.x, y: t.y, src: SRC, url: urlOf(t.x, t.y), path, bytes: buf.length, sha256: createHash("sha256").update(buf).digest("hex") });
    }
    if (i % 100 === 0) console.log(`${i}/${tiles.length}`);
  }
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(
    `${OUT_DIR}/manifest.json`,
    JSON.stringify(
      {
        source: "国土地理院 標高タイル（基盤地図情報 数値標高モデル）DEM10B",
        page: "https://maps.gsi.go.jp/development/ichiran.html",
        fetchedAt: new Date().toISOString(),
        bbox: H2_BOX,
        tiles: manifest,
      },
      null,
      2,
    ),
  );
  console.log(`${tiles.length} 枚: 取得 ${fetched}（うち 404 ${missing}）・H0 から写した ${copied}、計 ${(bytes / 1e6).toFixed(1)}MB`);
}

await main();
