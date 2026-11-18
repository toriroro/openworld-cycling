// 本番ビルド（dist）の後始末。npm run build の最後に動く。
// - 公開先（Cloudflare Workers の静的ファイル）は 1 ファイル 25MiB までなので、それより大きいファイルを
//   name.part0, part1, … に分けて元を消す。読む側（src/workers/hokkaido-load.ts の get）は、元が無ければ分けた物をつなぐ。
// - 今は読まない北海道の H0 の変換データ（public/data/hokkaido/h0/。H2 が置き換えた）を除く。

import { readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const DIST = "dist";
const PART = 24 * 1024 * 1024;

rmSync(join(DIST, "data/hokkaido/h0"), { recursive: true, force: true });

const walk = (dir) => readdirSync(dir).flatMap((n) => (statSync(join(dir, n)).isDirectory() ? walk(join(dir, n)) : [join(dir, n)]));
let split = 0;
for (const f of walk(DIST)) {
  const size = statSync(f).size;
  if (size <= PART) continue;
  const buf = readFileSync(f);
  const n = Math.ceil(size / PART);
  for (let i = 0; i < n; i++) writeFileSync(`${f}.part${i}`, buf.subarray(i * PART, Math.min(size, (i + 1) * PART)));
  rmSync(f);
  split++;
  console.log(`分けた: ${f}（${(size / 1048576).toFixed(1)}MiB → ${n} 個）`);
}
const files = walk(DIST);
console.log(`dist: ${files.length} ファイル（大きいファイルを分けた数 ${split}）`);
