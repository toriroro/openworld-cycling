// 町の中の仕事の出どころ（配達の草案 14.3・16 章、D2）: 店（受け取り）、旗の立つ家（家からの発送）、道端の頼み事の人。
// どれも世界のデータ（建物の記録・走る道）と時刻から決まる。同じ時刻に同じ所を見れば同じ物が出る（後でサーバーでも同じ計算をする）。
// DOM・Three.js に依存しない。分岐に関わる計算は加減乗除と sqrt・floor だけ（モック 4.2）。

import { hash, hashString, hashUnit } from "./world/hash.ts";
import { BUILDING_REC, BUILDING_STYLES, type HokkaidoBuildings } from "./world/hokkaido.ts";
import type { Road } from "./world/types.ts";

/**
 * 店の看板の業種（src/render/building/atlas-layout.ts の SIGN_TEXT と同じ並び。tests/work-places.test.ts で揃っているか確かめる）。
 * 建物の看板の番号は (種 >>> 6) % 32（src/render/city-build.ts の recordBuilding）
 */
export const SHOP_SIGNS = [
  "酒店", "薬局", "書店", "理容室", "美容室", "食堂", "そば処", "電器店", "金物店", "生花店", "歯科医院", "内科医院", "学習塾", "寿司", "焼肉", "居酒屋",
  "米穀店", "青果店", "茶舗", "ラーメン", "スナック", "クリーニング", "精肉店", "鮮魚店", "洋品店", "時計・眼鏡", "文具店", "自転車店", "写真館", "燃料店", "釣具店", "種苗店",
] as const;
/** 出前を出す店（食堂・そば処・寿司・焼肉・ラーメン） */
export const MEAL_SIGNS: readonly number[] = [5, 6, 13, 14, 19];
/** 買い物を頼める店（酒店・薬局・書店・生花店・米穀店・青果店・茶舗・精肉店・鮮魚店・文具店） */
export const GOODS_SIGNS: readonly number[] = [0, 1, 2, 9, 16, 17, 18, 22, 23, 26];

const STYLE_SHOP = BUILDING_STYLES.indexOf("shop");
const STYLE_OLDSHOP = BUILDING_STYLES.indexOf("oldshop");
const STYLE_HOUSE = BUILDING_STYLES.indexOf("house");
const STYLE_OLDHOUSE = BUILDING_STYLES.indexOf("oldhouse");

export interface Rect {
  x0: number;
  z0: number;
  x1: number;
  z1: number;
}

/** 建物 1 棟（店か家） */
export interface WorkBuilding {
  /** 建物の種（記録の 15 番。店・家の識別子にする） */
  id: string;
  seed: number;
  x: number;
  z: number;
  /** 店なら看板の業種の番号、家なら −1 */
  sign: number;
}

export const signOf = (seed: number) => (seed >>> 6) % 32;

function scan(b: HokkaidoBuildings, cx: number, cz: number, r: number, keep: (style: number, seed: number) => number | null, inside?: (x: number, z: number) => boolean): WorkBuilding[] {
  const cell = b.index.cell;
  const out: WorkBuilding[] = [];
  const D = b.data;
  const r2 = r * r;
  for (let gz = Math.floor((cz - r) / cell); gz <= Math.floor((cz + r) / cell); gz++)
    for (let gx = Math.floor((cx - r) / cell); gx <= Math.floor((cx + r) / cell); gx++) {
      const c = b.cell(gx, gz);
      if (!c) continue;
      for (let k = c[0]; k < c[0] + c[1]; k++) {
        const o = k * BUILDING_REC;
        const x = D[o];
        const z = D[o + 1];
        if ((x - cx) * (x - cx) + (z - cz) * (z - cz) > r2) continue;
        if (inside && !inside(x, z)) continue;
        const seed = D[o + 15] >>> 0;
        const sign = keep(D[o + 12], seed);
        if (sign === null) continue;
        out.push({ id: String(seed), seed, x, z, sign });
      }
    }
  // 頁を読んだ順に依らないように並べる
  out.sort((a, b) => a.seed - b.seed || a.x - b.x || a.z - b.z);
  return out;
}

/** (x, z) から r 以内の店のうち、看板の業種が signs に入る物 */
export function shopsNear(b: HokkaidoBuildings, x: number, z: number, r: number, signs: readonly number[], inside?: (x: number, z: number) => boolean): WorkBuilding[] {
  const want = new Set(signs);
  return scan(b, x, z, r, (style, seed) => ((style === STYLE_SHOP || style === STYLE_OLDSHOP) && want.has(signOf(seed)) ? signOf(seed) : null), inside);
}

/** (x, z) から r 以内の家（一戸建て） */
export function housesNear(b: HokkaidoBuildings, x: number, z: number, r: number, inside?: (x: number, z: number) => boolean): WorkBuilding[] {
  return scan(b, x, z, r, (style) => (style === STYLE_HOUSE || style === STYLE_OLDHOUSE ? -1 : null), inside);
}

// ---- 走る道の上の止まる所 ----

const bboxCache = new WeakMap<Road, Rect>();
function bboxOf(r: Road): Rect {
  let b = bboxCache.get(r);
  if (b) return b;
  const P = r.points;
  let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
  for (let i = 0; i < P.length; i += 3) {
    x0 = Math.min(x0, P[i]);
    x1 = Math.max(x1, P[i]);
    z0 = Math.min(z0, P[i + 2]);
    z1 = Math.max(z1, P[i + 2]);
  }
  b = { x0: x0 + r.origin[0], z0: z0 + r.origin[1], x1: x1 + r.origin[0], z1: z1 + r.origin[1] };
  bboxCache.set(r, b);
  return b;
}

/** 走る道の上の点 */
export interface RoadSpot {
  road: string;
  s: number;
  x: number;
  y: number;
  z: number;
  /** 探した点からの距離 (m) */
  d: number;
}

/** (x, z) にいちばん近い走る道の上の点（reach m 以内。つながっていない切れ端の道は除く） */
export function roadSpot(roads: Iterable<Road>, x: number, z: number, reach: number): RoadSpot | null {
  let best: RoadSpot | null = null;
  let bd = reach * reach;
  for (const r of roads) {
    if (r.island) continue;
    const b = bboxOf(r);
    if (x < b.x0 - reach || x > b.x1 + reach || z < b.z0 - reach || z > b.z1 + reach) continue;
    const P = r.points;
    const n = P.length / 3;
    const ds = r.length / (n - 1);
    for (let i = 0; i < n; i++) {
      const px = P[i * 3] + r.origin[0];
      const pz = P[i * 3 + 2] + r.origin[1];
      const d = (px - x) * (px - x) + (pz - z) * (pz - z);
      if (d < bd) {
        bd = d;
        best = { road: r.id, s: i * ds, x: px, y: P[i * 3 + 1], z: pz, d: 0 };
      }
    }
  }
  if (best) best.d = Math.sqrt(bd);
  return best;
}

/**
 * 丁目に届ける時に止まる所: 走る道の上で、左右（9m）のどちらかがその丁目になる点のうち、丁目の点にいちばん近い所。
 * 丁目の点が大きな敷地の中にあると、点にいちばん近い道の脇が隣の丁目になることがあるため（配達の草案 18.4）
 */
export function chomeSpot(roads: Iterable<Road>, at: (x: number, z: number) => { name: string } | null, chome: { name: string; x: number; z: number }, reach = 300): RoadSpot | null {
  let best: RoadSpot | null = null;
  let bd = reach * reach;
  for (const r of roads) {
    if (r.island) continue;
    const b = bboxOf(r);
    if (chome.x < b.x0 - reach || chome.x > b.x1 + reach || chome.z < b.z0 - reach || chome.z > b.z1 + reach) continue;
    const P = r.points;
    const n = P.length / 3;
    const ds = r.length / (n - 1);
    for (let i = 1; i < n - 1; i += 2) {
      const px = P[i * 3] + r.origin[0];
      const pz = P[i * 3 + 2] + r.origin[1];
      const d = (px - chome.x) * (px - chome.x) + (pz - chome.z) * (pz - chome.z);
      if (d >= bd) continue;
      let dx = P[(i + 1) * 3] - P[(i - 1) * 3];
      let dz = P[(i + 1) * 3 + 2] - P[(i - 1) * 3 + 2];
      const l = Math.sqrt(dx * dx + dz * dz) || 1;
      dx /= l;
      dz /= l;
      const off = 9;
      const left = at(px + dz * off, pz - dx * off);
      const right = at(px - dz * off, pz + dx * off);
      if (left?.name !== chome.name && right?.name !== chome.name) continue;
      bd = d;
      best = { road: r.id, s: i * ds, x: px, y: P[i * 3 + 1], z: pz, d: 0 };
    }
  }
  if (best) best.d = Math.sqrt(bd);
  return best;
}

// ---- 旗の立つ家（家からの発送） ----

/** 旗の立つ割合（1 棟・1 回の窓あたり）と窓の長さ (s)【初期値】 */
const FLAG_SHARE = 0.02;
export const FLAG_WINDOW = 1800;

/** 家にいま旗が立っているか。立っていれば窓の番号（受けた・断った記録の鍵にする）、無ければ null */
export function houseFlag(seed: number, unix: number): number | null {
  const w = Math.floor((unix + (hash(0x40ce, seed) % FLAG_WINDOW)) / FLAG_WINDOW);
  return hashUnit(0x40cf, seed, w) < FLAG_SHARE ? w : null;
}

// ---- 道端の頼み事 ----

export type ErrandKind = "forgot" | "shopping" | "papers";
export const ERRAND_LABELS: Record<ErrandKind, string> = { forgot: "忘れ物を届ける", shopping: "買い物", papers: "急ぎの書類" };

/** 頼み事の人を置く道の区切り (m)、出る割合（1 区切り・1 回の窓あたり）、窓の長さ (s)【初期値】 */
const ERRAND_STEP = 120;
const ERRAND_SHARE = 0.08;
export const ERRAND_WINDOW = 600;
/** 道の端から人の立つ所までの間 (m) */
const ERRAND_SIDE = 1.3;

export interface Errand {
  /** 道路・区切り・窓から作る識別子 */
  id: string;
  kind: ErrandKind;
  /** 人の立つ所（道の脇） */
  x: number;
  y: number;
  z: number;
  /** 止まる所（道の上） */
  roadX: number;
  roadZ: number;
  /** 道の向き（人の向きを決めるため。描く時だけ使う） */
  dx: number;
  dz: number;
  road: string;
  s: number;
  /** 窓の終わり（UNIX 秒） */
  until: number;
}

/** (x, z) から r 以内の頼み事の人。inside で出してよい範囲（配達の範囲）を絞る */
export function errandsNear(roads: Iterable<Road>, x: number, z: number, r: number, unix: number, inside?: (x: number, z: number) => boolean): Errand[] {
  const out: Errand[] = [];
  const r2 = r * r;
  for (const rd of roads) {
    if (rd.island || rd.length < ERRAND_STEP) continue;
    const b = bboxOf(rd);
    if (x < b.x0 - r || x > b.x1 + r || z < b.z0 - r || z > b.z1 + r) continue;
    const hr = hashString(rd.id);
    const P = rd.points;
    const n = P.length / 3;
    const ds = rd.length / (n - 1);
    const slots = Math.floor(rd.length / ERRAND_STEP);
    for (let k = 0; k < slots; k++) {
      const phase = hash(0xe77a, hr, k) % ERRAND_WINDOW;
      const w = Math.floor((unix + phase) / ERRAND_WINDOW);
      const h = hash(0xe77b, hr, k, w);
      if (h / 4294967296 >= ERRAND_SHARE) continue;
      const i = Math.min(n - 2, Math.max(1, Math.round(((k + 0.5) * ERRAND_STEP) / ds)));
      const px = P[i * 3] + rd.origin[0];
      const pz = P[i * 3 + 2] + rd.origin[1];
      if ((px - x) * (px - x) + (pz - z) * (pz - z) > r2) continue;
      if (inside && !inside(px, pz)) continue;
      let dx = P[(i + 1) * 3] - P[(i - 1) * 3];
      let dz = P[(i + 1) * 3 + 2] - P[(i - 1) * 3 + 2];
      const l = Math.sqrt(dx * dx + dz * dz) || 1;
      dx /= l;
      dz /= l;
      // 道の左（進む向きに対して）か右に立つ
      const side = (h & 1) === 0 ? 1 : -1;
      const off = rd.width / 2 + ERRAND_SIDE;
      const kindRoll = (h >>> 8) % 100;
      out.push({
        id: `${rd.id}#${k}@${w}`,
        kind: kindRoll < 40 ? "forgot" : kindRoll < 75 ? "shopping" : "papers",
        x: px + dz * off * side,
        y: P[i * 3 + 1],
        z: pz - dx * off * side,
        roadX: px,
        roadZ: pz,
        dx,
        dz,
        road: rd.id,
        s: i * ds,
        until: (w + 1) * ERRAND_WINDOW - phase,
      });
    }
  }
  out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return out;
}

/**
 * 丁目ごとの止まる所（chomeSpot）をまとめて求める。面した走れる道の無い丁目（大学の構内など）は入れない。
 * 注文の届け先はこの中から選ぶ（通しの試しで、届けられない注文が出た。配達の草案 24.4）。
 * roads は丁目の周りを含む道路の全部（読み込んだ所だけだと、遠い丁目が「無い」になる）
 */
export function chomeSpots(roads: Road[], at: (x: number, z: number) => { name: string } | null, chomes: { name: string; x: number; z: number }[]): Map<string, RoadSpot> {
  const out = new Map<string, RoadSpot>();
  for (const c of chomes) {
    const s = chomeSpot(roads, at, c);
    if (s) out.set(c.name, s);
  }
  return out;
}
