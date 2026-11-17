// 北海道の世界の変換（北海道の草案 4 章・7 章・18.1・20 章）。
//   npx tsx scripts/hokkaido/build.ts h2   札幌圏 約 60km 四方（既定）
//   npx tsx scripts/hokkaido/build.ts h0   札幌の中心 約 20km 四方（比べる用）
// 入力: assets-source/hokkaido/ の標高タイル（h0/dem・h2/dem）と北海道の PBF（pbf/）
// 出力: public/data/hokkaido/{h0,h2}/（world.json・roads.bin・overview.bin・pages/）と artifacts/hokkaido/{h0,h2}-report.json
//
// 変換データは OSM の派生データベース（ODbL 1.0）。標高は国土地理院の標高タイルを加工したもの。

import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { convertBuildings, type Seg } from "./buildings.ts";
import { buildSidewalks, buildingCoverage, coverageAt } from "./sidewalks.ts";
import { buildStreets } from "./streets.ts";
import { H0_BOX, H2_BOX, type LatLonBox, SOURCE_DIR } from "./area.ts";
import { buildGrid, type Grid, gridAt } from "./dem.ts";
import { areasOf, lineOf, type Tags } from "./osm.ts";
import { writeBuildingPages, writeSidewalkPages, writeStreetPages, writeTerrainPages } from "./pages.ts";
import { loadPbfArea } from "./pbf-area.ts";
import { project } from "./projection.ts";
import { fillRings, type Raster, strokeLine } from "./raster.ts";
import { type BuiltJunction, type BuiltRoad, buildRoads, DEFAULT_ROAD_OPTIONS } from "./roads.ts";
import { ROAD_CLASSES } from "../../src/shared/world/constants.ts";
import { HOKKAIDO_LANDUSE, HOKKAIDO_WATER, type HokkaidoMeta } from "../../src/shared/world/hokkaido.ts";

const AREA = process.argv[2] ?? "h2";
if (AREA !== "h0" && AREA !== "h2") throw new Error(`範囲は h0 か h2（${AREA}）`);
const BOX = AREA === "h2" ? H2_BOX : H0_BOX;
const OUT = `public/data/hokkaido/${AREA}`;
const REPORT = "artifacts/hokkaido";
const log = (...a: unknown[]) => console.log(...a);
let t0 = performance.now();
const lap = (what: string) => {
  log(`${what} ${((performance.now() - t0) / 1000).toFixed(1)}s`);
  t0 = performance.now();
};

// ---- 範囲（世界座標で、元データが全部ある内側の矩形。10m に丸める） ----
function worldRect(b: LatLonBox) {
  const sw = project(b.south, b.west);
  const se = project(b.south, b.east);
  const nw = project(b.north, b.west);
  const ne = project(b.north, b.east);
  return {
    x0: Math.ceil(Math.max(sw.x, nw.x) / 10) * 10,
    x1: Math.floor(Math.min(se.x, ne.x) / 10) * 10,
    z0: Math.ceil(Math.max(nw.z, ne.z) / 10) * 10,
    z1: Math.floor(Math.min(sw.z, se.z) / 10) * 10,
  };
}
const { x0: X0, x1: X1, z0: Z0, z1: Z1 } = worldRect(BOX);
log(`${AREA}: 範囲 x ${X0}〜${X1}、z ${Z0}〜${Z1}（${((X1 - X0) / 1000).toFixed(1)} × ${((Z1 - Z0) / 1000).toFixed(1)} km）`);

// ---- 標高: 10m 格子（地形）と、H0 の範囲の 5m 格子（道路の縦断。dem5.fine） ----
// H2 では H0 の範囲の外は DEM10B だけ。H0 の縁 300m で 5A から 10B へなめらかに移す（北海道の草案 20 章）。
// 欠け（海）は海にする: 水 = 海、高さは岸からの距離で 1m から 16m まで深くする。陸は 0.3m より下げない（海面 0 の平面に沈めない）。
const H0R = worldRect(H0_BOX);
const LAND_MIN = 0.3;
const manifests = [`${SOURCE_DIR}/h0/dem/manifest.json`, ...(AREA === "h2" ? [`${SOURCE_DIR}/h2/dem/manifest.json`] : [])];
const fineArea = AREA === "h2" ? { ...H0R, blend: 300 } : undefined;
const dem10 = buildGrid(manifests, X0, Z0, X1, Z1, 10, { fine: fineArea, allowMissing: AREA === "h2" });
const nx = dem10.nx;
const nz = dem10.nz;
const seaMask = new Uint8Array(nx * nz);
for (let i = 0; i < nx * nz; i++) if (Number.isNaN(dem10.heights[i])) seaMask[i] = 1;
{
  // 岸からの距離（格子の数、8 近傍の 2 回なめ）
  const INF = 1e9;
  const d = new Float32Array(nx * nz);
  for (let i = 0; i < nx * nz; i++) d[i] = seaMask[i] ? INF : 0;
  for (let j = 0; j < nz; j++)
    for (let i = 0; i < nx; i++) {
      const k = j * nx + i;
      if (!d[k]) continue;
      if (i > 0) d[k] = Math.min(d[k], d[k - 1] + 1);
      if (j > 0) d[k] = Math.min(d[k], d[k - nx] + 1, i > 0 ? d[k - nx - 1] + 1.414 : INF, i < nx - 1 ? d[k - nx + 1] + 1.414 : INF);
    }
  for (let j = nz - 1; j >= 0; j--)
    for (let i = nx - 1; i >= 0; i--) {
      const k = j * nx + i;
      if (!d[k]) continue;
      if (i < nx - 1) d[k] = Math.min(d[k], d[k + 1] + 1);
      if (j < nz - 1) d[k] = Math.min(d[k], d[k + nx] + 1, i < nx - 1 ? d[k + nx + 1] + 1.414 : INF, i > 0 ? d[k + nx - 1] + 1.414 : INF);
    }
  for (let i = 0; i < nx * nz; i++) dem10.heights[i] = seaMask[i] ? -Math.min(16, 1 + d[i] * 10 * 0.03) : Math.max(LAND_MIN, dem10.heights[i]);
}
lap(`標高 10m 格子（海 ${((dem10.missing * 100) / 1e6).toFixed(1)}km²）`);
const fine = buildGrid(manifests, Math.max(X0, H0R.x0), Math.max(Z0, H0R.z0), Math.min(X1, H0R.x1), Math.min(Z1, H0R.z1), 5, { fine: fineArea });
for (let i = 0; i < fine.heights.length; i++) fine.heights[i] = Math.max(LAND_MIN, fine.heights[i]);
if (AREA === "h0") {
  // H0 だけの時は 10m 格子も 5m 格子から取る（今までと同じ値）
  for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) dem10.heights[j * nx + i] = fine.heights[j * 2 * fine.nx + i * 2];
}
/** 道路・建物などの高さ（H0 の範囲は 5m、外は 10m） */
const dem5: Grid = { ...dem10, fine };
lap("標高 5m 格子（H0 の範囲）");

// ---- OSM（北海道の PBF から範囲を取り出す） ----
const pbfName = readdirSync(`${SOURCE_DIR}/pbf`).filter((f) => f.endsWith(".osm.pbf")).sort().at(-1);
if (!pbfName) throw new Error(`${SOURCE_DIR}/pbf に .osm.pbf が無い`);
const osm = loadPbfArea(`${SOURCE_DIR}/pbf/${pbfName}`, BOX);
lap(`PBF ${pbfName}（${JSON.stringify(osm.stats)}）`);

// ---- 水と土地利用（10m 格子の格子点で判定） ----
const newRaster = (): Raster => ({ x0: X0, z0: Z0, step: 10, nx, nz, data: new Uint8Array(nx * nz) });
const water = newRaster();
const wd = osm.water;
const isRiverArea = (t: Tags) => (t.natural === "water" && (t.water === "river" || t.water === "canal" || t.water === "stream")) || t.waterway === "riverbank";
for (const a of areasOf(wd, (t) => t.natural === "water" || t.waterway === "riverbank")) {
  if (a.tags.water === "wastewater") continue;
  fillRings(water, a.rings, isRiverArea(a.tags) ? HOKKAIDO_WATER.river : HOKKAIDO_WATER.lake);
}
const LINE_HALF: Record<string, number> = { river: 8, canal: 4, stream: 2, drain: 1, ditch: 1 };
for (const w of wd.ways.values()) {
  const half = LINE_HALF[w.tags.waterway ?? ""];
  if (!half || w.tags.tunnel === "culvert" || w.tags.tunnel === "yes") continue;
  const line = lineOf(wd, w);
  if (line) strokeLine(water, line, half, HOKKAIDO_WATER.river, true);
}
// 標高の欠け（海）は、川・湖の多角形より優先して海にする
for (let i = 0; i < nx * nz; i++) if (seaMask[i]) water.data[i] = HOKKAIDO_WATER.sea;
const landuse = newRaster();
const ld = osm.landuse;
const LANDUSE: [(t: Tags) => boolean, number][] = [
  [(t) => ["grassland", "scrub", "heath", "bare_rock"].includes(t.natural ?? "") || ["grass", "recreation_ground", "greenfield"].includes(t.landuse ?? ""), HOKKAIDO_LANDUSE.open],
  [(t) => ["farmland", "meadow", "orchard", "farmyard", "vineyard"].includes(t.landuse ?? ""), HOKKAIDO_LANDUSE.farm],
  [
    (t) => ["residential", "commercial", "retail", "industrial", "construction", "brownfield", "railway", "military", "religious", "cemetery", "garages"].includes(t.landuse ?? ""),
    HOKKAIDO_LANDUSE.urban,
  ],
  [(t) => t.landuse === "forest" || t.natural === "wood", HOKKAIDO_LANDUSE.forest],
];
for (const [accept, v] of LANDUSE) for (const a of areasOf(ld, accept)) fillRings(landuse, a.rings, v);
lap("水・土地利用");

// ---- 道路 ----
const rd = osm.roads;
// 走る道は等級 2・3（unclassified・track）を除く（決定 2026-11-17、北海道の草案 13.1 #8）。入れた版は数字だけ
const built = buildRoads(rd, dem5, { ...DEFAULT_ROAD_OPTIONS, includeMinor: false });
lap("道路");
const builtAll = buildRoads(rd, dem5, DEFAULT_ROAD_OPTIONS);
lap("道路（等級 2・3 を入れた版。数字だけ）");

// ---- 地名・立ち寄り地点 ----
const pd = osm.places;
const PLACE: Record<string, { kind: "town" | "village"; importance: number }> = {
  city: { kind: "town", importance: 1 },
  suburb: { kind: "town", importance: 0.9 },
  town: { kind: "town", importance: 0.85 },
  quarter: { kind: "village", importance: 0.6 },
  village: { kind: "village", importance: 0.6 },
  hamlet: { kind: "village", importance: 0.5 },
};
const inside = (x: number, z: number) => x >= X0 && x <= X1 && z >= Z0 && z <= Z1;
const nodes = [...pd.nodes.values()]
  .filter((n) => n.tags?.place && PLACE[n.tags.place] && n.tags.name && inside(n.x, n.z))
  .map((n) => ({
    id: `hn${n.id}`,
    cx: Math.floor(n.x / 4000),
    cz: Math.floor(n.z / 4000),
    x: n.x,
    y: gridAt(dem5, n.x, n.z),
    z: n.z,
    importance: PLACE[n.tags!.place].importance,
    kind: PLACE[n.tags!.place].kind,
    name: n.tags!.name,
    reading: n.tags!["name:ja-Hira"] ?? n.tags!["name:ja_kana"] ?? "",
  }));
const quarters = nodes.filter((n) => n.importance <= 0.6);
/** 丁目などの細かい地名（喫茶店の一般名に使う。地図の結節点には入れない） */
const neighbourhoods = [...pd.nodes.values()]
  .filter((n) => n.tags?.place === "neighbourhood" && n.tags.name && inside(n.x, n.z))
  .map((n) => ({ ...nodes[0], x: n.x, z: n.z, name: n.tags!.name }));
const suburbs = nodes.filter((n) => n.kind === "town");

/** 道路の点の索引（100m 格子、5 点ごと） */
const index = new Map<string, { road: BuiltRoad; i: number }[]>();
for (const r of built.roads) {
  const n = r.points.length / 3;
  for (let i = 0; i < n; i += 5) {
    const k = `${Math.floor((r.points[i * 3] + r.origin[0]) / 100)},${Math.floor((r.points[i * 3 + 2] + r.origin[1]) / 100)}`;
    const l = index.get(k) ?? [];
    l.push({ road: r, i });
    index.set(k, l);
  }
}
function nearestRoad(x: number, z: number, maxD: number) {
  let best: { road: BuiltRoad; s: number; side: 1 | -1; d: number } | null = null;
  const cx = Math.floor(x / 100);
  const cz = Math.floor(z / 100);
  for (let a = -1; a <= 1; a++)
    for (let b = -1; b <= 1; b++)
      for (const { road, i } of index.get(`${cx + a},${cz + b}`) ?? []) {
        const n = road.points.length / 3;
        for (let k = Math.max(0, i - 4); k <= Math.min(n - 1, i + 4); k++) {
          const px = road.points[k * 3] + road.origin[0];
          const pz = road.points[k * 3 + 2] + road.origin[1];
          const d = Math.hypot(px - x, pz - z);
          if (d <= maxD && (!best || d < best.d)) {
            const k2 = Math.min(n - 1, k + 1);
            const k1 = k2 - 1;
            const tx = road.points[k2 * 3] - road.points[k1 * 3];
            const tz = road.points[k2 * 3 + 2] - road.points[k1 * 3 + 2];
            // 進む向きに対して左が -1（types.ts の Poi.side）
            const cross = tx * (z - pz) - tz * (x - px);
            best = { road, s: (k * road.length) / (n - 1), side: cross > 0 ? 1 : -1, d };
          }
        }
      }
  return best;
}
const nearestName = (x: number, z: number, list: typeof nodes, maxD: number) => {
  let best: (typeof nodes)[number] | null = null;
  let bd = maxD;
  for (const n of list) {
    const d = Math.hypot(n.x - x, n.z - z);
    if (d < bd) {
      bd = d;
      best = n;
    }
  }
  return best?.name ?? null;
};
const pois: { id: string; kind: "cafe" | "viewpoint" | "pass"; road: string; s: number; side: 1 | -1; name: string }[] = [];
const usedNames = new Map<string, number>();
let cafesFar = 0;
const placeElements = [...pd.nodes.values()].filter((n) => n.tags && inside(n.x, n.z));
// way の喫茶店は中心（点の平均）を使う
for (const w of pd.ways.values()) {
  if (w.tags.amenity !== "cafe" && w.tags.tourism !== "viewpoint") continue;
  const ps = w.nodes.map((id) => pd.nodes.get(id)).filter((p) => !!p);
  if (!ps.length) continue;
  const x = ps.reduce((a, p) => a + p!.x, 0) / ps.length;
  const z = ps.reduce((a, p) => a + p!.z, 0) / ps.length;
  if (inside(x, z)) placeElements.push({ id: w.id, x, z, tags: w.tags });
}
let cafeCount = 0;
/** 喫茶店は CAFE_CELL 四方に 1 軒（決定 2026-11-17、北海道の草案 13.1 #9）。升目の中心に一番近い店を残す */
const CAFE_CELL = 1500;
const cafeKeep = new Set<number>();
{
  const best = new Map<string, { id: number; d: number }>();
  for (const p of placeElements) {
    if (p.tags!.amenity !== "cafe") continue;
    if (!nearestRoad(p.x, p.z, 60)) {
      cafesFar++;
      continue;
    }
    const cx = Math.floor(p.x / CAFE_CELL);
    const cz = Math.floor(p.z / CAFE_CELL);
    const d = Math.hypot(p.x - (cx + 0.5) * CAFE_CELL, p.z - (cz + 0.5) * CAFE_CELL);
    const k = `${cx},${cz}`;
    const b = best.get(k);
    if (!b || d < b.d || (d === b.d && p.id < b.id)) best.set(k, { id: p.id, d });
  }
  for (const b of best.values()) cafeKeep.add(b.id);
}
let cafesThinned = 0;
for (const p of placeElements.sort((a, b) => a.id - b.id)) {
  const t = p.tags!;
  const kind = t.amenity === "cafe" ? "cafe" : t.tourism === "viewpoint" ? "viewpoint" : t.mountain_pass === "yes" ? "pass" : null;
  if (!kind) continue;
  if (kind === "cafe") cafeCount++;
  if (kind === "cafe" && !cafeKeep.has(p.id)) {
    cafesThinned++;
    continue;
  }
  const near = nearestRoad(p.x, p.z, kind === "cafe" ? 60 : 150);
  if (!near) continue;
  // 名前は一般名（決定 2026-11-17）。店名は使わない
  const area =
    (kind === "cafe" ? nearestName(p.x, p.z, neighbourhoods, 400) : null) ?? nearestName(p.x, p.z, quarters, 3000) ?? nearestName(p.x, p.z, suburbs, 20000) ?? "札幌";
  const base = kind === "cafe" ? `喫茶店（${area}）` : kind === "viewpoint" ? `展望地（${area}）` : (t.name ?? `峠（${area}）`);
  const k = (usedNames.get(base) ?? 0) + 1;
  usedNames.set(base, k);
  pois.push({ id: `hp${p.id}`, kind, road: near.road.id, s: near.s, side: near.side, name: k === 1 ? base : `${base} ${k}` });
}
lap("地名・地点");

// ---- 建物（北海道の草案 15 章。PBF から取り出したもの） ----
let buildingOut: ReturnType<typeof convertBuildings> | null = null;
// 走る道（2m の点を 5 つおきに線分にする）
const rideSegs: Seg[] = [];
for (const r of built.roads) {
  const n = r.points.length / 3;
  for (let i = 0; i + 5 < n + 4; i += 5) {
    const j = Math.min(n - 1, i + 5);
    if (j === i) break;
    rideSegs.push({ ax: r.points[i * 3] + r.origin[0], az: r.points[i * 3 + 2] + r.origin[1], bx: r.points[j * 3] + r.origin[0], bz: r.points[j * 3 + 2] + r.origin[1], hw: r.width / 2, ride: true });
  }
}
{
  const segs: Seg[] = [...rideSegs];
  // 走らない道（住宅街の道など。建物の向きを決めるのに使う）
  const STREET_W: Record<string, number> = { residential: 5, living_street: 4, service: 3.5, unclassified: 5.5, track: 3, pedestrian: 4 };
  for (const w of rd.ways.values()) {
    const hwTag = w.tags.highway;
    const width = STREET_W[hwTag ?? ""];
    if (!width || w.tags.area === "yes") continue;
    for (let i = 0; i + 1 < w.nodes.length; i++) {
      const a = rd.nodes.get(w.nodes[i]);
      const b = rd.nodes.get(w.nodes[i + 1]);
      if (a && b) segs.push({ ax: a.x, az: a.z, bx: b.x, bz: b.z, hw: width / 2, ride: false });
    }
  }
  buildingOut = convertBuildings(osm.buildings, dem5, segs, 250);
  lap(`建物 ${buildingOut.stats.kept}`);
}
// 建物の込み具合（市街地・郊外。北海道の草案 19 章）
const coverage = buildingCoverage(buildingOut?.data ?? new Float32Array(0), { x0: X0, z0: Z0, step: 10, nx, nz });
// 店・ビル・集合住宅・低い店舗だけの込み具合（舗装の多い街の中心。家の多い所は庭と草地にする）
const commercial = buildingCoverage(buildingOut?.data ?? new Float32Array(0), { x0: X0, z0: Z0, step: 10, nx, nz }, 110, new Set([2, 3, 4, 5, 6, 7]));
// 走らない道（見た目だけ。北海道の草案 17 章）
const streetOut = buildStreets(rd, dem5, rideSegs, new Set(built.roads.flatMap((r) => r.ways)), 250, (x, z) => coverageAt(coverage, x, z));
lap(`走らない道 ${streetOut.stats.km.join("km・")}km`);
// 幹線の歩道と街路樹
const sidewalkOut = buildSidewalks(built.roads, buildingOut?.data ?? new Float32Array(0), coverage, 250, streetOut);
lap(`歩道 ${sidewalkOut.stats.km}km、街路樹 ${sidewalkOut.stats.trees}`);

// ---- 書き出し（北海道の草案 20 章: 地形・建物・走らない道・歩道は 2km 四方の頁に分ける） ----
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
const gridInfo = { x0: X0, z0: Z0, step: 10, nx, nz };
const hv = new Int16Array(nx * nz);
for (let i = 0; i < nx * nz; i++) hv[i] = Math.round(dem10.heights[i] * 10);
const cov8 = new Uint8Array(nx * nz);
const com8 = new Uint8Array(nx * nz);
for (let i = 0; i < nx * nz; i++) {
  cov8[i] = Math.round(coverage.v[i] * 255);
  com8[i] = Math.round(commercial.v[i] * 255);
}
const terrainPages = writeTerrainPages(OUT, gridInfo, hv, [water.data, landuse.data, cov8, com8]);
let total = 0;
for (const r of built.roads) total += r.points.length;
const all = new Float32Array(total);
let off = 0;
const roadMeta = built.roads.map((r) => {
  all.set(r.points, off);
  const m = { ...r, points: undefined, offset: off, count: r.points.length / 3, length: +r.length.toFixed(3) };
  off += r.points.length;
  return m;
});
writeFileSync(`${OUT}/roads.bin`, new Uint8Array(all.buffer));
const streetPages = writeStreetPages(OUT, gridInfo, streetOut.pts, streetOut.index);
const sidewalkPages = writeSidewalkPages(OUT, gridInfo, sidewalkOut.pts, sidewalkOut.trees, sidewalkOut.index);
const buildingPages = buildingOut ? writeBuildingPages(OUT, gridInfo, buildingOut.data, buildingOut.index) : { pages: [], MB: 0 };
const meta: HokkaidoMeta = {
  version: 2,
  area: AREA,
  attribution: [
    "© OpenStreetMap contributors（ODbL 1.0）",
    "出典：国土地理院ウェブサイト 標高タイル（https://maps.gsi.go.jp/development/ichiran.html）を加工して作成",
  ],
  builtAt: new Date().toISOString(),
  grid: { x0: X0, z0: Z0, step: 10, nx, nz },
  pages: { ...terrainPages.pages, buildings: buildingPages.pages, streets: streetPages.pages, sidewalks: sidewalkPages.pages },
  overview: terrainPages.overview,
  roads: roadMeta.map(({ points: _p, ...r }) => r),
  junctions: built.junctions,
  nodes,
  pois,
};
writeFileSync(`${OUT}/world.json`, JSON.stringify(meta));
// 地形・建物の Worker が読む小さい方（格子と頁だけ）
writeFileSync(`${OUT}/terrain.json`, JSON.stringify({ version: 2, area: meta.area, grid: meta.grid, pages: meta.pages, overview: meta.overview }));
lap("書き出し");

// ---- 検査（北海道の草案 4.4） ----
function metrics(roads: BuiltRoad[], junctions: BuiltJunction[]) {
  const deg = new Map(junctions.map((j) => [j.id, j.arms.length]));
  const km = (rs: BuiltRoad[]) => +(rs.reduce((a, r) => a + r.length, 0) / 1000).toFixed(1);
  const byCls = ROAD_CLASSES.map((c, i) => ({ cls: i, name: c.name, roads: roads.filter((r) => r.cls === i).length, km: km(roads.filter((r) => r.cls === i)) }));
  const between = (rs: BuiltRoad[]) => {
    const l = rs.filter((r) => (deg.get(r.start) ?? 0) >= 3 && (deg.get(r.end) ?? 0) >= 3).map((r) => r.length).sort((a, b) => a - b);
    const q = (p: number) => Math.round(l[Math.floor(p * (l.length - 1))] ?? 0);
    return { count: l.length, p10: q(0.1), p25: q(0.25), median: q(0.5), p75: q(0.75), under50: l.filter((x) => x < 50).length, under150: l.filter((x) => x < 150).length };
  };
  // つながり
  const parent = new Map<string, string>();
  const find = (a: string): string => {
    let r = a;
    while (parent.get(r) && parent.get(r) !== r) r = parent.get(r)!;
    parent.set(a, r);
    return r;
  };
  for (const r of roads) {
    const a = find(r.start);
    const b = find(r.end);
    if (a !== b) parent.set(a, b);
  }
  const comp = new Map<string, number>();
  for (const r of roads) comp.set(find(r.start), (comp.get(find(r.start)) ?? 0) + r.length);
  const sizes = [...comp.values()].sort((a, b) => b - a);
  const totalLen = sizes.reduce((a, b) => a + b, 0);
  // 勾配（20m の区間）
  let overKm = 0;
  let steepRoads = 0;
  const overByCls = ROAD_CLASSES.map(() => 0);
  for (const r of roads) {
    const n = r.points.length / 3;
    const ds = r.length / (n - 1);
    const W = Math.max(1, Math.round(20 / ds));
    const lim = ROAD_CLASSES[r.cls].maxGrade;
    let mx = 0;
    for (let i = W; i < n; i++) {
      const g = Math.abs(r.points[i * 3 + 1] - r.points[(i - W) * 3 + 1]) / (W * ds);
      if (g > mx) mx = g;
      if (g > lim) {
        overKm += ds / 1000;
        overByCls[r.cls] += ds / 1000;
      }
    }
    if (mx > 0.15) steepRoads++;
  }
  // 道路と地面の差（橋・トンネルの外）
  const diffs: number[] = [];
  for (const r of roads) {
    const n = r.points.length / 3;
    const ds = r.length / (n - 1);
    for (let i = 0; i < n; i += 5) {
      const s = i * ds;
      if (r.spans.some((sp) => s >= sp.from && s <= sp.to)) continue;
      diffs.push(Math.abs(r.points[i * 3 + 1] - gridAt(dem5, r.points[i * 3] + r.origin[0], r.points[i * 3 + 2] + r.origin[1])));
    }
  }
  diffs.sort((a, b) => a - b);
  const dq = (p: number) => +diffs[Math.floor(p * (diffs.length - 1))].toFixed(2);
  const spanStat = (k: string) => {
    const l = roads.flatMap((r) => r.spans.filter((s) => s.kind === k));
    return { count: l.length, km: +(l.reduce((a, s) => a + s.to - s.from, 0) / 1000).toFixed(2) };
  };
  return {
    roads: roads.length,
    km: km(roads),
    byClass: byCls,
    junctions: { total: junctions.length, deg3plus: junctions.filter((j) => j.arms.length >= 3).length, deadEnds: junctions.filter((j) => j.arms.length === 1).length, deg2: junctions.filter((j) => j.arms.length === 2).length },
    junctionToJunction: { all: between(roads), main: between(roads.filter((r) => r.cls <= 1)) },
    components: { count: sizes.length, largestShare: +(sizes[0] / totalLen).toFixed(3) },
    grade: { overLimitKm: +overKm.toFixed(2), overLimitKmByClass: overByCls.map((v) => +v.toFixed(2)), roadsSteeperThan15: steepRoads },
    roadMinusGround: { p50: dq(0.5), p90: dq(0.9), p99: dq(0.99), max: dq(1) },
    bridges: spanStat("bridge"),
    tunnels: spanStat("tunnel"),
    onewayMainKm: km(roads.filter((r) => r.cls <= 1 && r.oneway)),
  };
}
const waterCells = [1, 2, 3].map((v) => water.data.filter((x) => x === v).length);
const luCells = [1, 2, 3, 4].map((v) => landuse.data.filter((x) => x === v).length);
const report = {
  builtAt: meta.builtAt,
  area: { x0: X0, x1: X1, z0: Z0, z1: Z1 },
  options: DEFAULT_ROAD_OPTIONS,
  withMinor: { ...metrics(builtAll.roads, builtAll.junctions), build: builtAll.stats },
  withoutMinor: { ...metrics(built.roads, built.junctions), build: built.stats },
  water: { riverKm2: +((waterCells[2] * 100) / 1e6).toFixed(2), lakeKm2: +((waterCells[1] * 100) / 1e6).toFixed(2) },
  landuseShare: Object.fromEntries(["urban", "farm", "forest", "open"].map((k, i) => [k, +(luCells[i] / (nx * nz)).toFixed(3)])),
  places: { nodes: nodes.length, cafes: cafeCount, cafesKept: pois.filter((p) => p.kind === "cafe").length, cafesThinned, cafesFarFromRoad: cafesFar, cafeCell: CAFE_CELL, viewpoints: pois.filter((p) => p.kind === "viewpoint").length, passes: pois.filter((p) => p.kind === "pass").length },
  buildings: buildingOut?.stats ?? null,
  streets: streetOut.stats,
  sidewalks: sidewalkOut.stats,
  coverage: {
    over06: +(coverage.v.filter((v) => v >= 0.06).length / coverage.v.length).toFixed(3),
    over25: +(coverage.v.filter((v) => v >= 0.25).length / coverage.v.length).toFixed(3),
    commercialOver15: +(commercial.v.filter((v) => v >= 0.15).length / commercial.v.length).toFixed(3),
  },
  files: {
    terrainPagesMB: terrainPages.pagesMB,
    overviewMB: terrainPages.overviewMB,
    terrainPages: terrainPages.pages.npx * terrainPages.pages.npz,
    buildingsMB: buildingPages.MB,
    buildingPages: buildingPages.pages.length,
    streetsMB: streetPages.MB,
    sidewalksMB: sidewalkPages.MB,
    roadsMB: +(all.byteLength / 1e6).toFixed(1),
    worldJsonMB: +(JSON.stringify(meta).length / 1e6).toFixed(1),
  },
};
mkdirSync(REPORT, { recursive: true });
writeFileSync(`${REPORT}/${AREA}-report.json`, JSON.stringify(report, null, 2));
log(JSON.stringify(report, null, 2));
