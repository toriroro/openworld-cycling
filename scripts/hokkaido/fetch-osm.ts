// H0 の OpenStreetMap のデータを Overpass API から取る（北海道の草案 3.1・4 章）。
//
//   npx tsx scripts/hokkaido/fetch-osm.ts --count   要素の数だけ数える（小さい問い合わせ。取得の前の見積もり）
//   npx tsx scripts/hokkaido/fetch-osm.ts --fetch   取得して assets-source/hokkaido/h0/osm/ に保存
//
// Overpass の利用方針（目安 1 日 1 万回・1GB まで、範囲の継ぎはぎで大量に取らない）に合わせ、
// 種類ごとに 1 回ずつ、順に問い合わせる。データは ODbL 1.0（© OpenStreetMap contributors）。
// 建物は H1 で取る（H0 は数だけ数える）。

import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { bboxString, H0_BOX, SOURCE_DIR } from "./area.ts";

const ENDPOINT = "https://overpass-api.de/api/interpreter";
const OUT_DIR = `${SOURCE_DIR}/h0/osm`;
const BBOX = bboxString(H0_BOX);

/** 種類ごとの問い合わせ。本体は `out body; >; out skel qt;`（道の点の番号と点の座標を別に持つ。交差点を点の共有で作るため） */
const QUERIES: { name: string; what: string; body: string }[] = [
  {
    name: "roads",
    what: "道路・鉄道（高速道路も含めて取り、変換で除く）",
    body: `(way["highway"](${BBOX}); way["railway"](${BBOX}););`,
  },
  {
    name: "water",
    what: "海岸線・川・湖",
    body: `(way["natural"~"^(coastline|water)$"](${BBOX}); relation["natural"="water"](${BBOX}); way["waterway"](${BBOX}); relation["waterway"](${BBOX}););`,
  },
  {
    name: "landuse",
    what: "土地利用・森",
    body: `(way["landuse"](${BBOX}); relation["landuse"](${BBOX}); way["natural"~"^(wood|scrub|grassland|heath|bare_rock)$"](${BBOX}); relation["natural"="wood"](${BBOX}););`,
  },
  {
    name: "places",
    what: "地名・立ち寄り地点の位置（喫茶店・展望地・峠）",
    body: `(node["place"](${BBOX}); nwr["amenity"="cafe"](${BBOX}); nwr["tourism"="viewpoint"](${BBOX}); node["mountain_pass"="yes"](${BBOX}); node["natural"="peak"](${BBOX}););`,
  },
];

/** 建物（H0 は数だけ） */
const BUILDING_COUNT = `way["building"](${BBOX});`;

const HEADER = "[out:json][timeout:180];";

/** 混んでいる時の 429・502・504 は 30 秒・60 秒・120 秒待って 3 回まで問い直す */
async function overpass(query: string): Promise<string> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": "openworld-cycling-dev-data-fetch" },
      body: new URLSearchParams({ data: query }).toString(),
    });
    if (res.ok) return res.text();
    if (attempt < 3 && [429, 502, 503, 504].includes(res.status)) {
      const wait = 30000 * 2 ** attempt;
      console.log(`Overpass ${res.status}、${wait / 1000} 秒後に問い直す`);
      await sleep(wait);
      continue;
    }
    throw new Error(`Overpass ${res.status} ${res.statusText}`);
  }
}

function countOf(text: string): Record<string, number> {
  const json = JSON.parse(text) as { elements: { tags: Record<string, string> }[] };
  const t = json.elements[0]?.tags ?? {};
  return { nodes: Number(t.nodes ?? 0), ways: Number(t.ways ?? 0), relations: Number(t.relations ?? 0) };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const mode = process.argv[2];
  if (mode === "--count") {
    console.log(`範囲 ${BBOX}`);
    for (const q of [...QUERIES, { name: "buildings", what: "建物（H0 は数だけ）", body: BUILDING_COUNT }]) {
      // 本体の要素と、道が参照する点の数を別に数える
      const own = countOf(await overpass(`${HEADER}${q.body} out count;`));
      await sleep(2000);
      const refs = q.name === "buildings" || q.name === "places" ? null : countOf(await overpass(`${HEADER}${q.body} >; out count;`));
      console.log(`${q.name.padEnd(10)} ${q.what}: 道 ${own.ways}、関係 ${own.relations}、点 ${own.nodes}${refs ? `、参照する点 ${refs.nodes}` : ""}`);
      await sleep(2000);
    }
    return;
  }
  if (mode !== "--fetch") {
    console.log("--count か --fetch を付ける");
    return;
  }
  mkdirSync(OUT_DIR, { recursive: true });
  const manifest: object[] = [];
  for (const q of QUERIES) {
    const query = `${HEADER}${q.body} out body; >; out skel qt;`;
    const t0 = Date.now();
    const text = await overpass(query);
    const path = `${OUT_DIR}/${q.name}.json`;
    writeFileSync(path, text);
    const json = JSON.parse(text) as { osm3s?: { timestamp_osm_base?: string }; elements: unknown[] };
    const entry = {
      name: q.name,
      what: q.what,
      path,
      endpoint: ENDPOINT,
      query,
      fetchedAt: new Date().toISOString(),
      osmBase: json.osm3s?.timestamp_osm_base ?? null,
      elements: json.elements.length,
      bytes: Buffer.byteLength(text),
      sha256: createHash("sha256").update(text).digest("hex"),
    };
    manifest.push(entry);
    console.log(`${q.name}: ${entry.elements} 要素、${(entry.bytes / 1e6).toFixed(1)}MB、${((Date.now() - t0) / 1000).toFixed(0)}s`);
    await sleep(5000);
  }
  writeFileSync(
    `${OUT_DIR}/manifest.json`,
    JSON.stringify({ license: "ODbL-1.0", attribution: "© OpenStreetMap contributors", bbox: H0_BOX, files: manifest }, null, 2),
  );
}

await main();
