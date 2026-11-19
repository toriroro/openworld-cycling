// 北海道の世界の建物・敷地・走らない道の形を作る（北海道の草案 16・17 章）。DOM・Three.js を使わない（city.worker.ts で動かす）。
// 出来るのは型付きの配列（MeshArrays）だけ。メインスレッドがそれを描画の形にする（real-buildings.ts・real-streets.ts）。

import { insidePolygon } from "../shared/world/landmarks.ts";
import { BUILDING_REC, BUILDING_ROOFS, BUILDING_STYLES, type HokkaidoBuildings, type HokkaidoSidewalks, type HokkaidoStreets, type StreetPiece } from "../shared/world/hokkaido.ts";
import type { TerrainLike } from "../shared/world/terrain.ts";
import { atlasLayout } from "./building/atlas-layout.ts";
import type { Kit, Out, SurfaceKind } from "./building/kit.ts";
import { boundingSphere, hex, Mesher, type MeshArrays, type Rgb, v3 } from "./building/mesher.ts";
import { buildBuilding } from "./building/styles.ts";
import type { Building, BuildingStyle } from "./town-layout.ts";

/** 細部のある建物の材質の並び（buildings.ts の材質と同じ順） */
export const BUILDING_KINDS = ["siding", "plaster", "cedar", "metal", "tile", "seam", "mortar", "tilewall", "lap", "trim", "atlas"] as const;
export type BuildingKind = (typeof BUILDING_KINDS)[number];
/** 写真・模様の 1 枚が覆う長さ (m)（buildings.ts の材質と同じ値） */
export const SURFACE_TEX: Record<SurfaceKind, number> = { siding: 1.96, plaster: 1.6, cedar: 1.85, metal: 1.12, tile: 3.0, seam: 1.6, mortar: 3.2, tilewall: 1.1, lap: 1.2 };

const WALL: Record<BuildingStyle, Rgb[]> = {
  house: ["#d9d3c6", "#c9c3b6", "#e3ded4", "#b8b3a8", "#a3abaf", "#cbbca4", "#d6cfc1"].map(hex),
  oldhouse: ["#b9ab93", "#a89a84", "#c4b9a6", "#9a948a"].map(hex),
  apartment: ["#dcd8d0", "#c9c5bd", "#c2bbae", "#e2dfd8"].map(hex),
  mansion: ["#d8d5ce", "#c6c1b8", "#b9b3a9", "#e0ddd6", "#a9a6a0"].map(hex),
  shop: ["#cfc8bb", "#bfb6a8", "#d8d2c6"].map(hex),
  oldshop: ["#b4a68e", "#a39782"].map(hex),
  tenant: ["#b8b5af", "#a8a49d", "#c6c2ba", "#93908b", "#d0ccc4"].map(hex),
  strip: ["#d0ccc3", "#bebab1", "#c8c8c4"].map(hex),
};
/** 家の金属の屋根（青・赤茶・緑・灰）と、陸屋根の灰 */
const ROOF_HOME = ["#3d4e60", "#5e3a32", "#33503f", "#4b4b4b", "#6b6a66"].map(hex);
const ROOF_FLAT = ["#7d7c78", "#6e6d6a", "#8a8884"].map(hex);
/** 敷地: 庭（砂利・芝・コンクリート）と、正面の駐車場（アスファルト・コンクリート） */
const YARD = ["#8e897e", "#857f73", "#6d7650", "#77805a", "#9a978e"].map(hex);
const APRON = ["#5d5d5a", "#666663", "#a19f98", "#8f8d86"].map(hex);
/** 敷地を地面より浮かせる高さ (m)。隣の敷地と重なってちらつかないよう、建物ごとに少しずらす */
const PAD_LIFT = 0.07;
/**
 * 建物の基礎を土台の高さから地中へ伸ばす深さ (m)。土台は外形の 4 隅の標高の低い方だが、描く地形（8m の格子・道へのなじませ）は
 * 標高より低い所があり、斜面で建物の低い側が浮いて見えたため（2026-11-17）
 */
const FOUNDATION = 3;
const C_FOUNDATION: Rgb = hex("#8a8780");

/** 近くの建物の基礎（土台の下の 4 面。上は建物の壁が始まる高さ） */
function foundation(m: Mesher, data: HokkaidoBuildings, k: number, ox: number, oz: number) {
  const D = data.data;
  const o = k * BUILDING_REC;
  const a = D[o + 5];
  const X = v3(Math.cos(a), 0, Math.sin(a));
  const Z = v3(-X.z, 0, X.x);
  const cx = D[o] - ox;
  const cz = D[o + 1] - oz;
  const hw = D[o + 2] / 2;
  const hd = D[o + 3] / 2;
  const y0 = D[o + 6] - FOUNDATION;
  const at = (p: number, q: number) => v3(cx + X.x * p + Z.x * q, y0, cz + X.z * p + Z.z * q);
  m.wall(at(-hw, hd), Z, 2 * hw, FOUNDATION, C_FOUNDATION, 1);
  m.wall(at(hw, -hd), v3(-Z.x, 0, -Z.z), 2 * hw, FOUNDATION, C_FOUNDATION, 1);
  m.wall(at(hw, hd), X, 2 * hd, FOUNDATION, C_FOUNDATION, 1);
  m.wall(at(-hw, -hd), v3(-X.x, 0, -X.z), 2 * hd, FOUNDATION, C_FOUNDATION, 1);
}

/** 記録 → 生成の世界と同じ形の建物 */
export function recordBuilding(data: HokkaidoBuildings, k: number): Building {
  const D = data.data;
  const o = k * BUILDING_REC;
  const seed = D[o + 15] >>> 0;
  const flags = D[o + 14];
  return {
    x: D[o],
    z: D[o + 1],
    w: D[o + 2],
    d: D[o + 3],
    h: D[o + 4],
    angle: D[o + 5],
    base: D[o + 6],
    top: D[o + 7],
    roadY: D[o + 8],
    gap: D[o + 9],
    front: D[o + 10] > 0 ? 1 : -1,
    floors: D[o + 11],
    style: BUILDING_STYLES[D[o + 12]],
    roof: BUILDING_ROOFS[D[o + 13]],
    roofMat: flags & 1 ? "tile" : "metal",
    wallMat: flags & 2 ? "plaster" : "siding",
    shop: (flags & 4) !== 0,
    fence: false,
    seed,
    tone: seed % 7,
    sign: (seed >>> 6) % 32,
  };
}

/**
 * 建物の敷地の地面。建物の周り（横と裏）を庭、正面から道路の手前までを駐車場にする。
 * 雪の多い土地の家は正面に車を止める舗装の場所を取ることが多い。店・集合住宅は正面を広い駐車場にする。
 */
function pad(m: Mesher, data: HokkaidoBuildings, heights: TerrainLike, k: number, ox: number, oz: number) {
  const D = data.data;
  const o = k * BUILDING_REC;
  const style = BUILDING_STYLES[D[o + 12]];
  const seed = D[o + 15] >>> 0;
  const home = style === "house" || style === "oldhouse";
  const a = D[o + 5];
  const X = v3(Math.cos(a), 0, Math.sin(a));
  const Zs = D[o + 10] > 0 ? 1 : -1;
  const F = v3(-X.z * Zs, 0, X.x * Zs);
  const cx = D[o];
  const cz = D[o + 1];
  const hw = D[o + 2] / 2;
  const hd = D[o + 3] / 2;
  const side = home ? 1.2 : 2;
  const back = home ? 1 : 2;
  const front = Math.max(0, Math.min(D[o + 9] - 0.6, home ? 7 : style === "strip" ? 14 : 9));
  const lift = PAD_LIFT + (seed % 5) * 0.012;
  const at = (u: number, v: number) => {
    const x = cx + X.x * u + F.x * v;
    const z = cz + X.z * u + F.z * v;
    return v3(x - ox, heights.height(x, z) + lift, z - oz);
  };
  const yard = YARD[(seed >>> 4) % YARD.length];
  // 上から見て反時計回りにする（X × F は道路の側によって上向き・下向きが変わる）
  const quad = (u0: number, u1: number, v0: number, v1: number, c: Rgb) => {
    const p = [at(u0, v0), at(u1, v0), at(u1, v1), at(u0, v1)];
    m.quad(Zs > 0 ? p.reverse() : p, [[0, 0], [1, 0], [1, 1], [0, 1]], c);
  };
  // 横と裏（建物の下を含む。建物が上に立つ）
  quad(-hw - side, hw + side, -hd - back, hd, yard);
  if (front > 0.5) quad(-hw - side, hw + side, hd, hd + front, APRON[(seed >>> 7) % APRON.length]);
}

/** 遠くの建物: 壁と屋根の色の付いた箱（三角形 10） */
function box(m: Mesher, data: HokkaidoBuildings, k: number, ox: number, oz: number) {
  const D = data.data;
  const o = k * BUILDING_REC;
  const style = BUILDING_STYLES[D[o + 12]];
  const seed = D[o + 15] >>> 0;
  const walls = WALL[style];
  const wall = walls[seed % walls.length];
  const home = style === "house" || style === "oldhouse";
  const flat = BUILDING_ROOFS[D[o + 13]] === "flat";
  const roof = home && !flat ? ROOF_HOME[(seed >>> 3) % ROOF_HOME.length] : ROOF_FLAT[(seed >>> 3) % ROOF_FLAT.length];
  const a = D[o + 5];
  const X = v3(Math.cos(a), 0, Math.sin(a));
  const Z = v3(-X.z, 0, X.x);
  const cx = D[o] - ox;
  const cz = D[o + 1] - oz;
  const hw = D[o + 2] / 2;
  const hd = D[o + 3] / 2;
  // 地中へ基礎の分だけ伸ばす（FOUNDATION）
  const y0 = D[o + 6] - FOUNDATION;
  // 三角屋根は壁の上に屋根の半分の高さを足して箱にする（遠くでは形を出さない）
  const y1 = D[o + 7] + D[o + 4] + (home && !flat ? 1.2 : 0.3);
  const at = (p: number, q: number, y: number) => v3(cx + X.x * p + Z.x * q, y, cz + X.z * p + Z.z * q);
  const H = y1 - y0;
  m.wall(at(-hw, hd, y0), Z, 2 * hw, H, wall, 1);
  m.wall(at(hw, -hd, y0), v3(-Z.x, 0, -Z.z), 2 * hw, H, wall, 1);
  m.wall(at(hw, hd, y0), X, 2 * hd, H, wall, 1);
  m.wall(at(-hw, -hd, y0), v3(-X.x, 0, -X.z), 2 * hd, H, wall, 1);
  m.quad([at(-hw, hd, y1), at(hw, hd, y1), at(hw, -hd, y1), at(-hw, -hd, y1)], [[0, 0], [1, 0], [1, 1], [0, 1]], roof);
}

let layout: ReturnType<typeof atlasLayout> | null = null;

/** 近くの建物（細部まで）と敷地。材質ごとの配列（BUILDING_KINDS の順） */
/** 外形（世界座標の [x, z, ...]）の中に中心がある建物を除く（名所の模型で置き換える建物。名所の草案） */
export function withoutExcluded(data: HokkaidoBuildings, list: number[], polys: number[][]): number[] {
  const D = data.data;
  const boxes = polys.map((p) => {
    let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
    for (let i = 0; i < p.length; i += 2) {
      x0 = Math.min(x0, p[i]);
      x1 = Math.max(x1, p[i]);
      z0 = Math.min(z0, p[i + 1]);
      z1 = Math.max(z1, p[i + 1]);
    }
    return { p, x0, z0, x1, z1 };
  });
  return list.filter((k) => {
    const x = D[k * BUILDING_REC], z = D[k * BUILDING_REC + 1];
    return !boxes.some((b) => x >= b.x0 && x <= b.x1 && z >= b.z0 && z <= b.z1 && insidePolygon(b.p, x, z));
  });
}

/**
 * 細部まで作る区画の外の建物で省く部品の細さ (m)（Mesher.minPart）。柱・脚・看板の腕・庇の縁・屋根の縁など。
 * 近くの建物の三角形の多くは頂点色の部品で、100m より離れると 1〜2 画素にしかならないため（北海道の草案 24 章）
 */
const MID_PART = 0.3;

/**
 * 近くの建物（細部まで）と敷地。材質ごとの配列（BUILDING_KINDS の順）。
 * detail を渡すと、その中の建物だけ細部まで作り、他は細い部品を省く
 */
export function buildNear(data: HokkaidoBuildings, heights: TerrainLike, list: number[], ox: number, oz: number, detail?: Set<number>): { kinds: (MeshArrays | null)[]; triangles: number } {
  layout ??= atlasLayout();
  const out = Object.fromEntries(BUILDING_KINDS.map((k) => [k, new Mesher()])) as Out;
  const kit: Kit = { out, tex: SURFACE_TEX, atlas: layout };
  for (const k of list) {
    kit.mid = !!detail && !detail.has(k);
    out.trim.minPart = kit.mid ? MID_PART : 0;
    const b = recordBuilding(data, k);
    buildBuilding(kit, b, v3(b.x - ox, 0, b.z - oz));
    out.trim.minPart = 0;
    kit.mid = false;
    foundation(out.trim, data, k, ox, oz);
    pad(out.trim, data, heights, k, ox, oz);
  }
  let triangles = 0;
  const kinds = BUILDING_KINDS.map((k) => {
    triangles += out[k].triangles;
    return out[k].arrays();
  });
  return { kinds, triangles };
}

/** 遠くの建物をまとめる四角の一辺 (m)。まとまりごとに視野の外を省く（北海道の草案 24 章） */
export const FAR_BLOCK = 500;
/** これより三角形の少ないまとまりは 1 つにまとめる（描画命令を増やさないため） */
const FAR_BLOCK_MIN = 1500;

/**
 * 遠くの建物（箱）と敷地。FAR_BLOCK 四方のまとまりごとに 1 つの配列にする（1 つにすると視野の外の分も描くため）。
 * 敷地は (ox, oz) から padRange 以内の建物だけ（遠くでは見えない。北海道の草案 24 章）
 */
export function buildFar(data: HokkaidoBuildings, heights: TerrainLike, list: number[], ox: number, oz: number, padRange = 600): { meshes: MeshArrays[]; triangles: number } {
  const D = data.data;
  const blocks = new Map<string, Mesher>();
  for (const k of list) {
    const x = D[k * BUILDING_REC], z = D[k * BUILDING_REC + 1];
    const key = `${Math.floor(x / FAR_BLOCK)},${Math.floor(z / FAR_BLOCK)}`;
    let m = blocks.get(key);
    if (!m) blocks.set(key, (m = new Mesher()));
    box(m, data, k, ox, oz);
    if ((x - ox) * (x - ox) + (z - oz) * (z - oz) < padRange * padRange) pad(m, data, heights, k, ox, oz);
  }
  // 小さなまとまりは 1 つにまとめる
  const rest = new Mesher();
  const big: Mesher[] = [];
  for (const m of blocks.values()) {
    if (m.triangles >= FAR_BLOCK_MIN) {
      big.push(m);
      continue;
    }
    const base = rest.pos.length / 3;
    rest.pos.push(...m.pos);
    rest.nor.push(...m.nor);
    rest.uv.push(...m.uv);
    rest.col.push(...m.col);
    for (const i of m.idx) rest.idx.push(i + base);
  }
  const meshes: MeshArrays[] = [];
  let triangles = 0;
  for (const m of [...big, rest]) {
    const a = m.arrays();
    if (!a) continue;
    meshes.push(a);
    triangles += m.triangles;
  }
  return { meshes, triangles };
}

// ---- 走らない道 ----

/** 路面を地形より浮かせる高さ (m) */
const STREET_LIFT = 0.04;
const STREET_STEP = 4;
const C_STREET = [0.64, 0.64, 0.62];
const C_PATH = [0.74, 0.73, 0.7];

/** 折れ線を step m ごとの点にする（高さは地形から） */
export function resampleStreet(streets: HokkaidoStreets, heights: TerrainLike, off: number, count: number, step: number): number[] {
  const P = streets.pts;
  const out: number[] = [];
  for (let i = 0; i + 1 < count; i++) {
    const ax = P[(off + i) * 2], az = P[(off + i) * 2 + 1];
    const bx = P[(off + i + 1) * 2], bz = P[(off + i + 1) * 2 + 1];
    const l = Math.hypot(bx - ax, bz - az);
    const k = Math.max(1, Math.ceil(l / step));
    for (let q = i === 0 ? 0 : 1; q <= k; q++) {
      const x = ax + ((bx - ax) * q) / k;
      const z = az + ((bz - az) * q) / k;
      out.push(x, heights.height(x, z), z);
    }
  }
  return out;
}

const C_WALK: Rgb = [0.86, 0.85, 0.82];
const C_CURB: Rgb = [0.7, 0.69, 0.66];

/**
 * 幹線の歩道（北海道の草案 19 章）: 上面（舗装ブロックの材質）、道路側の縁石の面、外側の面（敷地・地面へ下りる）。
 * 歩道の点は [内側 x, z, 外側 x, z, 高さ]
 */
function sidewalkStrip(walk: Mesher, curb: Mesher, P: Float32Array, off: number, count: number, ox: number, oz: number) {
  const base = walk.pos.length / 3;
  let s = 0;
  for (let i = 0; i < count; i++) {
    const k = (off + i) * 5;
    const ix = P[k] - ox, iz = P[k + 1] - oz, ex = P[k + 2] - ox, ez = P[k + 3] - oz, y = P[k + 4];
    if (i > 0) s += Math.hypot(P[k] - P[k - 5], P[k + 1] - P[k - 4]);
    const w = Math.hypot(ex - ix, ez - iz);
    walk.pos.push(ix, y, iz, ex, y, ez);
    walk.nor.push(0, 1, 0, 0, 1, 0);
    walk.col.push(C_WALK[0], C_WALK[1], C_WALK[2], C_WALK[0], C_WALK[1], C_WALK[2]);
    walk.uv.push(0, s / 2, w / 2, s / 2);
    if (i > 0) {
      const q = base + (i - 1) * 2;
      // 内側→外側の向きは道路の左右で変わる。上から見て反時計回りになる方で張る
      const ax = P[k - 5] - ox, az = P[k - 4] - oz;
      const crossY = (ex - ix) * (iz - az) - (ez - iz) * (ix - ax);
      // (外側 − 内側) × (進む向き) の上下成分が −crossY。上向きになる張り方を選ぶ
      if (crossY < 0) walk.idx.push(q, q + 1, q + 2, q + 1, q + 3, q + 2);
      else walk.idx.push(q, q + 2, q + 1, q + 1, q + 2, q + 3);
    }
  }
  // 縁石（道路側、0.3m 下まで）と外側の面（0.6m 下まで）。どちらも歩道の外へ向けた片面
  const edges: [number, number, number, number][] = [
    [0, 1, 0.3, -1],
    [2, 3, 0.6, 1],
  ];
  for (const [a, b, drop, out] of edges) {
    for (let i = 0; i + 1 < count; i++) {
      const k0 = (off + i) * 5, k1 = k0 + 5;
      const p0 = v3(P[k0 + a] - ox, P[k0 + 4], P[k0 + b] - oz);
      const p1 = v3(P[k1 + a] - ox, P[k1 + 4], P[k1 + b] - oz);
      // この並びの面の向きは (dz, 0, −dx)。外向き（内側の縁なら道路の方、外側の縁なら敷地の方）でなければ逆に張る
      const dx = p1.x - p0.x, dz = p1.z - p0.z;
      const wx = (P[k0 + 2] - P[k0]) * out, wz = (P[k0 + 3] - P[k0 + 1]) * out;
      const q = [p0, p1, v3(p1.x, p1.y - drop, p1.z), v3(p0.x, p0.y - drop, p0.z)];
      curb.quad(dz * wx - dx * wz >= 0 ? q : q.reverse(), [[0, 0], [1, 0], [1, 1], [0, 1]], C_CURB);
    }
  }
}

/** 走らない道の路面（車の道・歩道と小道・幹線の歩道の 3 つ。ox, oz からの相対） */
export function buildStreets(
  streets: HokkaidoStreets,
  heights: TerrainLike,
  pieces: StreetPiece[],
  ox: number,
  oz: number,
  sidewalks?: { data: HokkaidoSidewalks; runs: [number, number][] },
): { mesh: MeshArrays | null; groups: [number, number, number][]; triangles: number } {
  const g = [new Mesher(), new Mesher(), new Mesher()];
  if (sidewalks) for (const [off, count] of sidewalks.runs) sidewalkStrip(g[2], g[1], sidewalks.data.pts, off, count, ox, oz);
  for (const [off, count, w10, kind, ends = 0] of pieces) {
    const p = resampleStreet(streets, heights, off, count, STREET_STEP);
    const n = p.length / 3;
    if (n < 2) continue;
    const m = g[kind === 0 ? 0 : 1];
    const col = kind === 0 ? C_STREET : C_PATH;
    const hw = w10 / 20;
    // 端は半幅だけ伸ばして、交わる所の隙間をなくす。走る道に出る端は伸ばさない（走る道の上に住宅街の道がはみ出した。北海道の草案 31 章）
    const ext = kind === 0 ? hw : 0.3;
    const ext0 = ends & 1 ? 0 : ext, ext1 = ends & 2 ? 0 : ext;
    // 交わる所で同じ高さの路面が重なってちらつかないよう、折れ線ごとに少しずらす
    const lift = STREET_LIFT + ((off * 2654435761) % 4) * 0.008;
    const base = m.pos.length / 3;
    let s = -ext0;
    for (let i = 0; i < n; i++) {
      const a = Math.max(0, i - 1);
      const b = Math.min(n - 1, i + 1);
      let tx = p[b * 3] - p[a * 3];
      let tz = p[b * 3 + 2] - p[a * 3 + 2];
      const tl = Math.hypot(tx, tz) || 1;
      tx /= tl;
      tz /= tl;
      if (i > 0) s += Math.hypot(p[i * 3] - p[(i - 1) * 3], p[i * 3 + 2] - p[(i - 1) * 3 + 2]);
      const e = i === 0 ? -ext0 : i === n - 1 ? ext1 : 0;
      const x = p[i * 3] + tx * e - ox;
      const z = p[i * 3 + 2] + tz * e - oz;
      const y = p[i * 3 + 1] + lift;
      const v = (s + (i === n - 1 ? ext1 : 0)) / 4;
      m.pos.push(x - tz * hw, y, z + tx * hw, x + tz * hw, y, z - tx * hw);
      m.nor.push(0, 1, 0, 0, 1, 0);
      m.col.push(col[0], col[1], col[2], col[0], col[1], col[2]);
      m.uv.push(0, v, (2 * hw) / 4, v);
      if (i > 0) {
        const q = base + (i - 1) * 2;
        // 上から見て反時計回り（左右の点の並びでは下向きになるので逆に張る）
        m.idx.push(q, q + 2, q + 1, q + 1, q + 2, q + 3);
      }
    }
  }
  // 1 つの配列にまとめる（材質は groups で分ける: 0 車の道、1 歩道と小道・縁石、2 幹線の歩道の上面）
  const V = g.reduce((a, m) => a + m.pos.length / 3, 0);
  const triangles = g.reduce((a, m) => a + m.triangles, 0);
  if (!V) return { mesh: null, groups: [], triangles: 0 };
  const I = g.reduce((a, m) => a + m.idx.length, 0);
  const pos = new Float32Array(V * 3);
  const nor = new Float32Array(V * 3);
  const uv = new Float32Array(V * 2);
  const col = new Float32Array(V * 3);
  const idx = V > 65535 ? new Uint32Array(I) : new Uint16Array(I);
  const groups: [number, number, number][] = [];
  let v = 0;
  let i = 0;
  g.forEach((m, mi) => {
    pos.set(m.pos, v * 3);
    nor.set(m.nor, v * 3);
    uv.set(m.uv, v * 2);
    col.set(m.col, v * 3);
    for (let k = 0; k < m.idx.length; k++) idx[i + k] = m.idx[k] + v;
    if (m.idx.length) groups.push([i, m.idx.length, mi]);
    v += m.pos.length / 3;
    i += m.idx.length;
  });
  return { mesh: { pos, nor, uv, col, idx, sphere: boundingSphere(pos) }, groups, triangles };
}
