// 北海道の世界の名所（名所の草案 docs/history/specs/2026-11-18-landmarks-draft.md）を PBF から取り出す。
// 名所ごとに、区域（公園・敷地・建物の外形）と、その中の木・並木・林・芝・花壇・噴水・水面・建物・鳥居・像・ジャンプ台などを
// 世界座標の多角形・折れ線・点にして public/data/hokkaido/landmarks-<範囲>.json に書く。
// 出力は build.ts の出力フォルダ（public/data/hokkaido/<範囲>/、作り直す時に消える）の外に置く。
//
// npx tsx scripts/hokkaido/landmarks.ts [h2]
// 名前は、公共の物は OSM の名前、会社の施設は一般名（決定 2026-11-18）。

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { H0_BOX, H2_BOX, SOURCE_DIR, type LatLonBox } from "./area.ts";
import { readPbf } from "./pbf.ts";
import { project } from "./projection.ts";
import type { LandmarkFeature, LandmarkFile, LandmarkKind } from "../../src/shared/world/landmarks.ts";

const AREA = process.argv[2] ?? "h2";
const BOX: LatLonBox = AREA === "h0" ? H0_BOX : H2_BOX;
const PBF = `${SOURCE_DIR}/pbf/hokkaido-261116.osm.pbf`;
const OUT = `public/data/hokkaido/landmarks-${AREA}.json`;

interface Def {
  id: string;
  name: string;
  kind: LandmarkKind;
  /** 区域の OSM の道（閉じた多角形） */
  way: number;
  /** 区域の外も、この距離 (m) までは中の物を拾う */
  margin?: number;
  /** 見える距離 (m)。高い物は遠くから見える */
  view?: number;
  /** 模型で置き換える建物（OSM の道の番号）。無ければ kind ごとの既定 */
  replace?: number[];
  /** 名前がこれに合う建物も置き換える */
  replaceName?: RegExp;
  /** 区域の中の建物を全部置き換える（神社の境内） */
  replaceAll?: boolean;
  /** 区域にこの名前の要素があれば、そこを行き先にする */
  goalName?: RegExp;
}

const DEFS: Def[] = [
  { id: "tvtower", name: "テレビ塔", kind: "tvtower", way: 199758828, view: 9000, replace: [199758828] },
  { id: "odori", name: "大通公園", kind: "odori", way: 64733385, view: 2600 },
  { id: "clocktower", name: "札幌市時計台", kind: "clocktower", way: 64747104, replace: [64747104], margin: 30 },
  { id: "akarenga", name: "北海道庁旧本庁舎", kind: "akarenga", way: 36331476, replace: [36331476], margin: 90, view: 3000 },
  { id: "hokudai", name: "北海道大学", kind: "hokudai", way: 162657842, view: 2600, goalName: /^北海道大学南門$/ },
  { id: "nakajima", name: "中島公園", kind: "nakajima", way: 64747102, replace: [352271889], goalName: /^豊平館$/ },
  { id: "jingu", name: "北海道神宮", kind: "jingu", way: 146432491, replaceAll: true, margin: 40, goalName: /^令和の鳥居$/ },
  { id: "asahiyama", name: "旭山記念公園", kind: "asahiyama", way: 146995819, replace: [597525084, 597525086], goalName: /^レストハウス$/ },
  { id: "moiwa", name: "藻岩山展望台", kind: "moiwa", way: 342426740, replace: [342426740], margin: 120, view: 9000 },
  { id: "moere", name: "モエレ沼公園", kind: "moere", way: 474102038, view: 4000, goalName: /^ガラスのピラミッド/, replaceName: /^ガラスのピラミッド/, replace: [1161013184, 404340298] },
  { id: "okurayama", name: "大倉山ジャンプ競技場", kind: "okurayama", way: 267873727, margin: 80, view: 6000, replace: [194307798] },
  { id: "hitsujigaoka", name: "羊ヶ丘展望台", kind: "hitsujigaoka", way: 480234020, goalName: /^クラーク博士像$/ },
];

type Tags = Record<string, string>;
const r1 = (v: number) => Math.round(v * 10) / 10;

// ---- 1 回目: 区域の道 ----
const t0 = performance.now();
const areaRefs = new Map<number, number[]>();
const areaIds = new Set(DEFS.map((d) => d.way));
readPbf(PBF, {
  nodeTags: false,
  way: (w) => {
    if (areaIds.has(w.id)) areaRefs.set(w.id, w.refs);
  },
});
const need = new Set<number>();
for (const r of areaRefs.values()) for (const n of r) need.add(n);
const areaPt = new Map<number, { x: number; z: number }>();
readPbf(PBF, {
  nodeTags: false,
  node: (n) => {
    if (need.has(n.id)) areaPt.set(n.id, project(n.lat, n.lon));
  },
});

interface Zone {
  def: Def;
  poly: { x: number; z: number }[];
  x0: number;
  z0: number;
  x1: number;
  z1: number;
}
const zones: Zone[] = DEFS.map((def) => {
  const refs = areaRefs.get(def.way);
  if (!refs) throw new Error(`${def.id}: 道 ${def.way} が無い`);
  const poly = refs.map((r) => areaPt.get(r)!).filter(Boolean);
  if (poly.length > 1 && poly[0].x === poly[poly.length - 1].x && poly[0].z === poly[poly.length - 1].z) poly.pop();
  const m = def.margin ?? 20;
  return {
    def,
    poly,
    x0: Math.min(...poly.map((p) => p.x)) - m,
    x1: Math.max(...poly.map((p) => p.x)) + m,
    z0: Math.min(...poly.map((p) => p.z)) - m,
    z1: Math.max(...poly.map((p) => p.z)) + m,
  };
});

function inside(p: { x: number; z: number }[], x: number, z: number): boolean {
  let c = false;
  for (let i = 0, j = p.length - 1; i < p.length; j = i++) {
    if (p[i].z > z !== p[j].z > z && x < ((p[j].x - p[i].x) * (z - p[i].z)) / (p[j].z - p[i].z) + p[i].x) c = !c;
  }
  return c;
}
function distToPoly(p: { x: number; z: number }[], x: number, z: number): number {
  if (inside(p, x, z)) return 0;
  let best = Infinity;
  for (let i = 0, j = p.length - 1; i < p.length; j = i++) {
    const ax = p[j].x, az = p[j].z, bx = p[i].x, bz = p[i].z;
    const dx = bx - ax, dz = bz - az;
    const l2 = dx * dx + dz * dz || 1;
    const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / l2));
    best = Math.min(best, Math.hypot(ax + dx * t - x, az + dz * t - z));
  }
  return best;
}
/** (x, z) を拾う区域 */
const zonesAt = (x: number, z: number) => zones.filter((zn) => x >= zn.x0 && x <= zn.x1 && z >= zn.z0 && z <= zn.z1 && distToPoly(zn.poly, x, z) <= (zn.def.margin ?? 20));

// ---- 3 回目: 区域の周りの点（座標と札） ----
const pos = new Map<number, { x: number; z: number }>();
const pointFeats: { id: number; x: number; z: number; tags: Tags }[] = [];
const [la0, la1, lo0, lo1] = [BOX.south, BOX.north, BOX.west, BOX.east];
readPbf(PBF, {
  nodeTags: true,
  node: (n) => {
    if (n.lat < la0 || n.lat > la1 || n.lon < lo0 || n.lon > lo1) return;
    const q = project(n.lat, n.lon);
    // 区域の外接矩形（余白 200m）の点は全部持つ（区域の端にかかる道の形のため）
    if (!zones.some((zn) => q.x >= zn.x0 - 200 && q.x <= zn.x1 + 200 && q.z >= zn.z0 - 200 && q.z <= zn.z1 + 200)) return;
    pos.set(n.id, q);
    if (n.tags && Object.keys(n.tags).length) pointFeats.push({ id: n.id, x: q.x, z: q.z, tags: n.tags });
  },
});

// ---- 4 回目: 区域の中の道（建物・並木・林・芝・噴水・水面・ジャンプ台） ----
const wayFeats: { id: number; pts: { x: number; z: number }[]; tags: Tags }[] = [];
readPbf(PBF, {
  nodeTags: false,
  way: (w) => {
    if (!Object.keys(w.tags).length) return;
    if (!wayType(w.tags) && !areaIds.has(w.id)) return;
    const pts = w.refs.map((r) => pos.get(r)).filter((p): p is { x: number; z: number } => !!p);
    if (pts.length < 2 || pts.length < w.refs.length) return;
    wayFeats.push({ id: w.id, pts, tags: w.tags });
  },
});

/** 道の札 → 名所の部品の種類 */
function wayType(t: Tags): LandmarkFeature["t"] | null {
  if (t.building && t.building !== "no") return "building";
  if (t.natural === "tree_row") return "row";
  if (t.natural === "wood" || t.landuse === "forest") return "wood";
  if (t.amenity === "fountain") return "fountain";
  if (t.natural === "water") return "water";
  if (t.leisure === "garden" && t["garden:type"] !== "botanical") return "garden";
  if (t.landuse === "grass" || t.leisure === "park" || t.leisure === "common" || t.landuse === "meadow" || t.natural === "grassland") return "grass";
  if (t.barrier === "gate" && t.name) return "gate";
  if (t.man_made === "ski_jump" || t["piste:type"] === "ski_jump") return "skijump";
  if (t.aerialway && t.aerialway !== "station" && t.aerialway !== "pylon") return "lift";
  if (t.man_made === "ceremonial_gate") return "torii";
  if (t.highway === "footway" || t.highway === "path" || t.highway === "pedestrian" || t.highway === "steps") return "path";
  return null;
}
/** 点の札 → 名所の部品の種類 */
function nodeType(t: Tags): LandmarkFeature["t"] | null {
  if (t.natural === "tree") return "tree";
  if (t.man_made === "ceremonial_gate") return "torii";
  if (t.historic === "monument" || t.artwork_type === "bust" || t.artwork_type === "statue") return "statue";
  if (t.natural === "peak") return "peak";
  if (t.tourism === "viewpoint") return "viewpoint";
  if (t.amenity === "fountain") return "fountain";
  if (t["piste:takeoff"] === "yes") return "takeoff";
  if (t.aerialway === "station") return "station";
  if (t.highway === "street_lamp" || t.man_made === "lamp") return "lamp";
  if (t.barrier === "gate" && t.name) return "gate";
  return null;
}
const KEEP = ["name", "species", "species:ja", "height", "building", "building:levels", "material", "ceremonial_gate", "ele", "leaf_type", "artwork_type", "highway", "man_made", "piste:type", "leisure"];
const keepTags = (t: Tags) => {
  const o: Record<string, string> = {};
  for (const k of KEEP) if (t[k]) o[k] = t[k];
  return o;
};

const file: LandmarkFile = { version: 1, area: AREA, builtAt: new Date().toISOString(), attribution: "© OpenStreetMap contributors", landmarks: [] };
const report: Record<string, unknown> = {};
for (const zn of zones) {
  const d = zn.def;
  const feats: LandmarkFeature[] = [];
  const counts: Record<string, number> = {};
  const add = (f: LandmarkFeature) => {
    feats.push(f);
    counts[f.t] = (counts[f.t] ?? 0) + 1;
  };
  for (const n of pointFeats) {
    const t = nodeType(n.tags);
    if (!t || !zonesAt(n.x, n.z).includes(zn)) continue;
    add({ t, id: n.id, pts: [r1(n.x), r1(n.z)], tags: keepTags(n.tags) });
  }
  const replace = new Set(d.replace ?? []);
  for (const w of wayFeats) {
    if (w.id === d.way && !replace.has(w.id)) continue;
    const t = w.id === d.way ? "building" : wayType(w.tags);
    if (!t) continue;
    const cx = w.pts.reduce((a, p) => a + p.x, 0) / w.pts.length;
    const cz = w.pts.reduce((a, p) => a + p.z, 0) / w.pts.length;
    // 道（歩道・並木・ジャンプ台）は点のどれかが区域にあれば、面は中心が区域にあれば拾う
    const linear = t === "row" || t === "path" || t === "skijump" || t === "lift";
    const hit = linear ? w.pts.some((p) => zonesAt(p.x, p.z).includes(zn)) : zonesAt(cx, cz).includes(zn);
    if (!hit) continue;
    const pts = w.pts.flatMap((p) => [r1(p.x), r1(p.z)]);
    const closed = pts.length >= 6 && pts[0] === pts[pts.length - 2] && pts[1] === pts[pts.length - 1];
    if (closed) pts.length -= 2;
    const f: LandmarkFeature = { t, id: w.id, pts, tags: keepTags(w.tags) };
    if (t === "building" && (replace.has(w.id) || d.replaceName?.test(w.tags.name ?? "") || (d.replaceAll && inside(zn.poly, cx, cz)))) f.replace = true;
    add(f);
  }
  // 行き先: 名前で決めた要素の位置、無ければ区域の中心
  const named = d.goalName ? feats.find((f) => d.goalName!.test(f.tags.name ?? "")) : undefined;
  const avg = (pts: number[], k: 0 | 1) => pts.filter((_, i) => i % 2 === k).reduce((a, v) => a + v, 0) / (pts.length / 2);
  const gx = named ? avg(named.pts, 0) : zn.poly.reduce((a, p) => a + p.x, 0) / zn.poly.length;
  const gz = named ? avg(named.pts, 1) : zn.poly.reduce((a, p) => a + p.z, 0) / zn.poly.length;
  if (d.goalName && !named) console.warn(`${d.id}: 行き先の ${d.goalName} が見つからない`);
  file.landmarks.push({
    id: d.id,
    name: d.name,
    kind: d.kind,
    osm: d.way,
    x: r1(gx),
    z: r1(gz),
    zone: zn.poly.flatMap((p) => [r1(p.x), r1(p.z)]),
    view: d.view ?? 2200,
    features: feats,
  });
  report[d.id] = { goal: [Math.round(gx), Math.round(gz)], zonePoints: zn.poly.length, replaced: feats.filter((f) => f.replace).length, counts };
}

// 走る道までの距離（行き先から一番近い走る道の点。変換済みの道路があれば）
try {
  const meta = JSON.parse(readFileSync(`public/data/hokkaido/${AREA}/world.json`, "utf8")) as { roads: { origin: [number, number]; offset: number; count: number; minor?: boolean }[] };
  const all = new Float32Array(readFileSync(`public/data/hokkaido/${AREA}/roads.bin`).buffer.slice(0));
  for (const lm of file.landmarks) {
    let best = Infinity;
    for (const r of meta.roads) {
      for (let i = 0; i < r.count; i++) {
        const x = all[r.offset + i * 3] + r.origin[0];
        const z = all[r.offset + i * 3 + 2] + r.origin[1];
        const dd = Math.hypot(x - lm.x, z - lm.z);
        if (dd < best) best = dd;
      }
    }
    (report[lm.id] as Record<string, unknown>).nearestRoad = Math.round(best);
  }
} catch (e) {
  console.warn("道路の変換データが無いので、走る道までの距離は数えない", String(e));
}

mkdirSync("public/data/hokkaido", { recursive: true });
writeFileSync(OUT, JSON.stringify(file));
mkdirSync("artifacts/hokkaido/landmarks", { recursive: true });
writeFileSync(`artifacts/hokkaido/landmarks/extract-${AREA}.json`, JSON.stringify({ out: OUT, bytes: JSON.stringify(file).length, seconds: Math.round((performance.now() - t0) / 100) / 10, landmarks: report }, null, 2));
console.log(JSON.stringify(report, null, 1));
