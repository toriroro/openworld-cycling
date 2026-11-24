// PLATEAU（3D都市モデル 札幌市 2020 年度、CityGML v4）の建物と、今の OSM から作った建物を、配達の範囲（D0）で比べる（配達の草案 19 章）。
//   npx tsx scripts/hokkaido/plateau-compare.ts
//   BASE=<変換データの置き場/> NAME=after npx tsx scripts/hokkaido/plateau-compare.ts   別の変換データと比べる（出力は after.json）
// 入力: assets-source/hokkaido/plateau/bldg/*.gml.gz（1km 区画ごと）、public/data/hokkaido/h2（今の建物の記録）。
// 出力: artifacts/plateau/compare.json。読むだけで、変換データは変えない。

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { project } from "../../src/shared/geo/projection.ts";
import { D0_STREET_BOX } from "../../src/shared/world/address.ts";
import { BUILDING_REC, BUILDING_STYLES, HokkaidoBuildings, type HokkaidoMeta } from "../../src/shared/world/hokkaido.ts";

const SRC = "assets-source/hokkaido/plateau/bldg";
const OUT = "artifacts/plateau";
const USAGE: Record<string, string> = {
  "401": "業務施設", "402": "商業施設", "403": "宿泊施設", "404": "商業系複合施設", "411": "住宅", "412": "共同住宅", "413": "店舗等併用住宅", "414": "店舗等併用共同住宅",
  "415": "作業所併用住宅", "421": "官公庁施設", "422": "文教厚生施設", "431": "運輸倉庫施設", "441": "工場", "451": "農林漁業用施設", "452": "供給処理施設", "453": "防衛施設", "454": "その他", "461": "不明",
};

interface PB {
  x: number;
  z: number;
  area: number;
  usage: string;
  height: number | null;
  storeys: number | null;
  year: number | null;
  structure: string | null;
  lod2: boolean;
}

const a = project(D0_STREET_BOX.north, D0_STREET_BOX.west);
const b = project(D0_STREET_BOX.south, D0_STREET_BOX.east);
const rect = { x0: a.x, z0: a.z, x1: b.x, z1: b.z };
const inside = (x: number, z: number) => x >= rect.x0 && x <= rect.x1 && z >= rect.z0 && z <= rect.z1;

// ---- PLATEAU ----
const pl: PB[] = [];
let noFoot = 0;
for (const f of readdirSync(SRC).filter((n) => n.endsWith(".gml.gz")).sort()) {
  const text = gunzipSync(readFileSync(`${SRC}/${f}`)).toString("utf8");
  const parts = text.split("<bldg:Building ");
  for (let i = 1; i < parts.length; i++) {
    const s = parts[i];
    const end = s.indexOf("</bldg:Building>");
    const body = end >= 0 ? s.slice(0, end) : s;
    const m = (re: RegExp) => re.exec(body)?.[1] ?? null;
    // 外形: 屋根の縁（LOD0）、無ければ LOD1 の立体の最初の面
    const at = Math.max(body.indexOf("<bldg:lod0RoofEdge"), body.indexOf("<bldg:lod0FootPrint"));
    const from = at >= 0 ? at : body.indexOf("<bldg:lod1Solid");
    const pos = from >= 0 ? /<gml:posList>([^<]+)<\/gml:posList>/.exec(body.slice(from)) : null;
    if (!pos) {
      noFoot++;
      continue;
    }
    const v = pos[1].trim().split(/\s+/).map(Number);
    const pts: { x: number; z: number }[] = [];
    for (let k = 0; k + 2 < v.length; k += 3) pts.push(project(v[k], v[k + 1]));
    let area2 = 0;
    let cx = 0;
    let cz = 0;
    for (let k = 0; k < pts.length - 1; k++) {
      const p = pts[k];
      const q = pts[k + 1];
      const c = p.x * q.z - q.x * p.z;
      area2 += c;
      cx += (p.x + q.x) * c;
      cz += (p.z + q.z) * c;
    }
    if (Math.abs(area2) < 1e-6) continue;
    cx /= 3 * area2;
    cz /= 3 * area2;
    if (!inside(cx, cz)) continue;
    const num = (x: string | null) => (x === null ? null : Number(x));
    const h = num(m(/<bldg:measuredHeight[^>]*>([\d.]+)</));
    const st = num(m(/<bldg:storeysAboveGround>(\d+)</));
    pl.push({
      x: cx,
      z: cz,
      area: Math.abs(area2) / 2,
      usage: m(/<bldg:usage[^>]*>(\d+)</) ?? "-",
      height: h !== null && h > 0 && h < 9000 ? h : null,
      storeys: st !== null && st > 0 && st < 9000 ? st : null,
      year: num(m(/<bldg:yearOfConstruction>(\d+)</)),
      structure: m(/name="建物構造">\s*<gen:value>([^<]+)</),
      lod2: body.includes("<bldg:lod2"),
    });
  }
}

// ---- 今の建物（OSM から作った記録） ----
// 変換データの置き場（BASE で変えられる。PLATEAU から作り直した後の確かめにも使う）
const BASE = process.env.BASE ?? "public/data/hokkaido/h2/";
const meta = JSON.parse(readFileSync(`${BASE}world.json`, "utf8")) as HokkaidoMeta;
const store = new HokkaidoBuildings(250, meta.grid, meta.pages, async (path) => {
  try {
    const buf = readFileSync(BASE + path);
    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  } catch {
    return null;
  }
});
await store.ensure(rect);
interface OB {
  x: number;
  z: number;
  area: number;
  h: number;
  floors: number;
  style: string;
  shop: boolean;
  used: boolean;
}
const osm: OB[] = [];
const D = store.data;
for (const [, [start, n]] of Object.entries(store.index.cells))
  for (let k = start; k < start + n; k++) {
    const o = k * BUILDING_REC;
    if (!inside(D[o], D[o + 1])) continue;
    osm.push({ x: D[o], z: D[o + 1], area: D[o + 2] * D[o + 3], h: D[o + 4], floors: D[o + 11], style: BUILDING_STYLES[D[o + 12]], shop: (D[o + 14] & 4) !== 0, used: false });
  }

// ---- 突き合わせ: PLATEAU の重心から、近い OSM の建物（外形の大きさに応じて 6〜25m） ----
const CELL = 50;
const grid = new Map<string, number[]>();
osm.forEach((o, i) => {
  const k = `${Math.floor(o.x / CELL)},${Math.floor(o.z / CELL)}`;
  (grid.get(k) ?? grid.set(k, []).get(k)!).push(i);
});
const pairs: { p: PB; o: OB }[] = [];
for (const p of [...pl].sort((u, w) => w.area - u.area)) {
  const r = Math.min(25, Math.max(6, Math.sqrt(p.area) / 2));
  const gx = Math.floor(p.x / CELL);
  const gz = Math.floor(p.z / CELL);
  let best = -1;
  let bd = r * r;
  for (let i = -1; i <= 1; i++)
    for (let j = -1; j <= 1; j++)
      for (const k of grid.get(`${gx + i},${gz + j}`) ?? []) {
        const o = osm[k];
        if (o.used) continue;
        const d = (o.x - p.x) * (o.x - p.x) + (o.z - p.z) * (o.z - p.z);
        if (d < bd) {
          bd = d;
          best = k;
        }
      }
  if (best >= 0) {
    osm[best].used = true;
    pairs.push({ p, o: osm[best] });
  }
}

// ---- 集計 ----
const q = (xs: number[], f: number) => {
  const s = [...xs].sort((u, w) => u - w);
  return s.length ? +s[Math.min(s.length - 1, Math.floor(s.length * f))].toFixed(1) : null;
};
const sum = (xs: number[]) => Math.round(xs.reduce((s, x) => s + x, 0));
const hp = pairs.filter((x) => x.p.height !== null);
const dh = hp.map((x) => x.o.h - x.p.height!);
const sp = pairs.filter((x) => x.p.storeys !== null);
const byUsage: Record<string, number> = {};
for (const p of pl) byUsage[USAGE[p.usage] ?? p.usage] = (byUsage[USAGE[p.usage] ?? p.usage] ?? 0) + 1;
// 今の型 × PLATEAU の用途
const cross: Record<string, Record<string, number>> = {};
for (const { p, o } of pairs) {
  const u = USAGE[p.usage] ?? p.usage;
  cross[o.style] ??= {};
  cross[o.style][u] = (cross[o.style][u] ?? 0) + 1;
}
const isHouse = (u: string) => u === "411";
const isShopUse = (u: string) => u === "402" || u === "404" || u === "413" || u === "414";
const houseStyle = (s: string) => s === "house" || s === "oldhouse";
const shopStyle = (o: OB) => o.style === "shop" || o.style === "oldshop";
const conf = (pred: (p: PB) => boolean, mine: (o: OB) => boolean) => {
  let tp = 0, fp = 0, fn = 0;
  for (const { p, o } of pairs) {
    const a1 = pred(p);
    const b1 = mine(o);
    if (a1 && b1) tp++;
    else if (!a1 && b1) fp++;
    else if (a1 && !b1) fn++;
  }
  return { both: tp, onlyMine: fp, onlyPlateau: fn, precision: +(tp / Math.max(1, tp + fp)).toFixed(2), recall: +(tp / Math.max(1, tp + fn)).toFixed(2) };
};
const matchedSet = new Set(pairs.map((x) => x.p));
const unmatchedP = pl.filter((p) => !matchedSet.has(p));
const unmatchedO = osm.filter((o) => !o.used);
const report = {
  area: { rect, km2: +(((rect.x1 - rect.x0) * (rect.z1 - rect.z0)) / 1e6).toFixed(2) },
  plateau: {
    buildings: pl.length,
    noFootprint: noFoot,
    footprintM2: sum(pl.map((p) => p.area)),
    withHeight: pl.filter((p) => p.height !== null).length,
    withStoreys: pl.filter((p) => p.storeys !== null).length,
    withYear: pl.filter((p) => p.year !== null).length,
    lod2: pl.filter((p) => p.lod2).length,
    byUsage,
    /** 用途ごとの外形の面積の中央値 (m²) と、OSM に無い棟の数 */
    usageArea: Object.fromEntries(
      Object.keys(USAGE).flatMap((u) => {
        const xs = pl.filter((p) => p.usage === u);
        return xs.length ? [[USAGE[u], { median: q(xs.map((p) => p.area), 0.5), notInOsm: xs.filter((p) => !matchedSet.has(p)).length }]] : [];
      }),
    ),
    height: { p10: q(pl.flatMap((p) => (p.height !== null ? [p.height] : [])), 0.1), p50: q(pl.flatMap((p) => (p.height !== null ? [p.height] : [])), 0.5), p90: q(pl.flatMap((p) => (p.height !== null ? [p.height] : [])), 0.9) },
  },
  osm: { buildings: osm.length, footprintM2: sum(osm.map((o) => o.area)), byStyle: Object.fromEntries(BUILDING_STYLES.map((s) => [s, osm.filter((o) => o.style === s).length])) },
  matched: {
    pairs: pairs.length,
    plateauOnly: unmatchedP.length,
    plateauOnlyM2: sum(unmatchedP.map((p) => p.area)),
    plateauOnlySmall: unmatchedP.filter((p) => p.area < 30).length,
    osmOnly: unmatchedO.length,
    osmOnlyM2: sum(unmatchedO.map((o) => o.area)),
    // 今の壁の高さ − PLATEAU の計測高さ（計測高さは屋根の最高点まで）
    heightDiff: { n: dh.length, p10: q(dh, 0.1), p50: q(dh, 0.5), p90: q(dh, 0.9), within3m: +(dh.filter((x) => Math.abs(x) <= 3).length / Math.max(1, dh.length)).toFixed(2) },
    floorsExact: +(sp.filter((x) => x.o.floors === x.p.storeys).length / Math.max(1, sp.length)).toFixed(2),
    floorsWithin1: +(sp.filter((x) => Math.abs(x.o.floors - x.p.storeys!) <= 1).length / Math.max(1, sp.length)).toFixed(2),
    tallMiss: hp.filter((x) => x.p.height! >= 30 && x.o.h < x.p.height! * 0.6).length,
    tall: hp.filter((x) => x.p.height! >= 30).length,
    house: conf((p) => isHouse(p.usage), (o) => houseStyle(o.style)),
    shop: conf((p) => isShopUse(p.usage), (o) => shopStyle(o)),
    cross,
  },
};
mkdirSync(OUT, { recursive: true });
writeFileSync(`${OUT}/${process.env.NAME ?? "compare"}.json`, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
