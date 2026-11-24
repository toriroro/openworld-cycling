// 建物の外形 → 描画用の建物（向きのある長方形・型・階数・屋根・道路の側）（北海道の草案 15 章）。
// 外形は、面積を保つように縮めた最小の外接長方形にする（L 字などは少しはみ出す・欠ける）。
// 札は「building=yes」がほとんど（H0 で 97%）なので、型と階数は札・面積・中心からの距離で決める。高さの札があればそれを使う。

import type { BuildingStyle } from "../../src/render/town-layout.ts";
import { BUILDING_REC, BUILDING_STYLES, type HokkaidoBuildingIndex } from "../../src/shared/world/hokkaido.ts";
import { type Grid, gridAt } from "./dem.ts";

export interface RawBuilding {
  id: string;
  ring: number[];
  tags: Record<string, string>;
}

/** 道路の線分（建物の向きと、走る道との重なりの判定に使う） */
export interface Seg {
  ax: number;
  az: number;
  bx: number;
  bz: number;
  /** 路面の半幅 */
  hw: number;
  /** 走る道（重なる建物を捨てる） */
  ride: boolean;
}

class SegIndex {
  private cells = new Map<string, number[]>();
  constructor(
    readonly segs: Seg[],
    private cell = 50,
  ) {
    segs.forEach((s, i) => {
      for (let cx = Math.floor(Math.min(s.ax, s.bx) / cell); cx <= Math.floor(Math.max(s.ax, s.bx) / cell); cx++)
        for (let cz = Math.floor(Math.min(s.az, s.bz) / cell); cz <= Math.floor(Math.max(s.az, s.bz) / cell); cz++) {
          const k = `${cx},${cz}`;
          (this.cells.get(k) ?? this.cells.set(k, []).get(k)!).push(i);
        }
    });
  }
  /** (x, z) から maxD 以内で、路面の端までが一番近い線分 */
  nearest(x: number, z: number, maxD: number, onlyRide = false) {
    let best: { s: Seg; e: number; px: number; pz: number } | null = null;
    const r = Math.ceil(maxD / this.cell);
    const cx = Math.floor(x / this.cell);
    const cz = Math.floor(z / this.cell);
    for (let a = -r; a <= r; a++)
      for (let b = -r; b <= r; b++)
        for (const i of this.cells.get(`${cx + a},${cz + b}`) ?? []) {
          const s = this.segs[i];
          if (onlyRide && !s.ride) continue;
          const dx = s.bx - s.ax;
          const dz = s.bz - s.az;
          const l2 = dx * dx + dz * dz || 1;
          const t = Math.max(0, Math.min(1, ((x - s.ax) * dx + (z - s.az) * dz) / l2));
          const px = s.ax + dx * t;
          const pz = s.az + dz * t;
          const e = Math.hypot(px - x, pz - z) - s.hw;
          if (e <= maxD && (!best || e < best.e)) best = { s, e, px, pz };
        }
    return best;
  }
}

/** 凸包（単調連鎖法） */
function hull(pts: [number, number][]): [number, number][] {
  const p = pts.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (p.length < 3) return p;
  const cross = (o: number[], a: number[], b: number[]) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lo: [number, number][] = [];
  for (const q of p) {
    while (lo.length >= 2 && cross(lo[lo.length - 2], lo[lo.length - 1], q) <= 0) lo.pop();
    lo.push(q);
  }
  const up: [number, number][] = [];
  for (let i = p.length - 1; i >= 0; i--) {
    const q = p[i];
    while (up.length >= 2 && cross(up[up.length - 2], up[up.length - 1], q) <= 0) up.pop();
    up.push(q);
  }
  return lo.slice(0, -1).concat(up.slice(0, -1));
}

/** 最小の外接長方形（凸包の辺の向きを順に試す） */
function obb(ring: number[]) {
  const pts: [number, number][] = [];
  for (let i = 0; i < ring.length; i += 2) pts.push([ring[i], ring[i + 1]]);
  const h = hull(pts);
  let best = { area: Infinity, angle: 0, cx: 0, cz: 0, w: 0, d: 0 };
  for (let i = 0; i < h.length; i++) {
    const a = h[i];
    const b = h[(i + 1) % h.length];
    const l = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (l < 1e-6) continue;
    const ux = (b[0] - a[0]) / l;
    const uz = (b[1] - a[1]) / l;
    let u0 = Infinity;
    let u1 = -Infinity;
    let v0 = Infinity;
    let v1 = -Infinity;
    for (const p of h) {
      const u = p[0] * ux + p[1] * uz;
      const v = -p[0] * uz + p[1] * ux;
      if (u < u0) u0 = u;
      if (u > u1) u1 = u;
      if (v < v0) v0 = v;
      if (v > v1) v1 = v;
    }
    const area = (u1 - u0) * (v1 - v0);
    if (area < best.area) {
      const um = (u0 + u1) / 2;
      const vm = (v0 + v1) / 2;
      best = { area, angle: Math.atan2(uz, ux), cx: um * ux - vm * uz, cz: um * uz + vm * ux, w: u1 - u0, d: v1 - v0 };
    }
  }
  return best;
}

function polyArea(ring: number[]): number {
  let a = 0;
  const n = ring.length / 2;
  for (let i = 0, j = n - 1; i < n; j = i++) a += ring[j * 2] * ring[i * 2 + 1] - ring[i * 2] * ring[j * 2 + 1];
  return Math.abs(a) / 2;
}

/** 文字列の番号から決まる 0〜2^24 の種 */
function seedOf(id: string): number {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619);
  return (h >>> 8) & 0xffffff;
}
const unit = (seed: number, k: number) => ((Math.imul(seed ^ (k * 0x9e3779b1), 0x85ebca6b) >>> 0) % 10007) / 10007;

/** 札幌の中心（札幌駅と大通の間）。ここから近いほど高い建物にする */
const DOWNTOWN = { x: 150, z: -450 };

const HOME = new Set(["house", "detached", "semidetached_house", "bungalow", "farm", "terrace"]);
const FLATS = new Set(["apartments", "residential", "dormitory"]);
const BIG = new Set(["commercial", "office", "hotel", "public", "civic", "government", "hospital", "school", "university", "college", "kindergarten", "train_station", "transportation"]);
const LOW = new Set(["retail", "supermarket", "industrial", "warehouse", "factory", "manufacture", "parking", "garages", "sports_hall", "greenhouse"]);
const TINY = new Set(["garage", "shed", "hut", "roof", "carport", "kiosk", "toilets", "service", "cabin"]);
/** 建物にしない札 */
const SKIP = new Set(["construction", "ruins", "collapsed", "demolished", "no", "bridge"]);

export interface BuildingStats {
  input: number;
  kept: number;
  tooSmall: number;
  onRoad: number;
  skipped: number;
  byStyle: Record<string, number>;
  withLevels: number;
  /** PLATEAU から作った棟と、用途不明の小さな物置として省いた棟 */
  plateau: number;
  plateauSheds: number;
}

/** PLATEAU の用途（bldg:usage）で物置として省く: 用途不明・その他で外形 40m² 未満（配達の草案 20 章） */
const PLATEAU_SHED = 40;

/**
 * PLATEAU の用途・階数・計測高さ → 型・階数・店の印（配達の草案 19.3・20 章）。
 * storeys・height は不明なら 0。tall は計測高さを壁の高さにする型（平らな屋根）。
 */
function plateauPick(usage: string, fa: number, storeys: number, height: number, year: number, r: (i: number) => number) {
  const guess = (per: number, fallback: number) => (storeys > 0 ? storeys : height > 0 ? Math.max(1, Math.round(height / per)) : fallback);
  const old = year > 0 ? year < 1975 || r(1) < 0.06 : r(1) < 0.2;
  let style: BuildingStyle;
  let floors: number;
  let shopUse = false;
  switch (usage) {
    case "411": // 住宅
    case "415": // 作業所併用住宅
      floors = storeys > 0 ? storeys : height > 0 ? (height < 5.2 ? 1 : 2) : r(2) < 0.85 ? 2 : 1;
      if (floors >= 3) style = "apartment";
      else style = old ? "oldhouse" : "house";
      break;
    case "412": // 共同住宅
      floors = guess(2.95, fa < 250 ? 2 : 3);
      style = floors >= 4 ? "mansion" : "apartment";
      break;
    case "413": // 店舗等併用住宅
    case "414": // 店舗等併用共同住宅
      shopUse = true;
      floors = guess(3.1, 2);
      style = floors <= 3 && fa < 400 ? (old ? "oldshop" : "shop") : "tenant";
      break;
    case "402": // 商業施設
    case "404": // 商業系複合施設
      shopUse = true;
      floors = guess(3.4, 2);
      style = floors <= 2 && fa > 1200 ? "strip" : floors <= 2 && fa < 300 ? (old ? "oldshop" : "shop") : "tenant";
      break;
    case "401": // 業務施設
    case "403": // 宿泊施設
      floors = guess(3.3, 3);
      style = floors <= 1 && fa > 300 ? "strip" : "tenant";
      break;
    case "421": // 官公庁施設
    case "422": // 文教厚生施設
      floors = guess(3.6, 3);
      style = floors <= 1 ? "strip" : "mansion";
      break;
    case "431": // 運輸倉庫施設
    case "441": // 工場
    case "451": // 農林漁業用施設
    case "452": // 供給処理施設
    case "453": // 防衛施設
      floors = Math.min(2, guess(5, 1));
      style = "strip";
      break;
    default: // その他・不明
      return null;
  }
  return { style, floors, shopUse };
}

/**
 * 建物を変換して、250m 四方の区画の順に並べた Float32Array（1 棟 BUILDING_REC 個）と区画の索引を返す。
 */
export function convertBuildings(raw: RawBuilding[], dem: Grid, segs: Seg[], cell: number) {
  const idx = new SegIndex(segs);
  const st: BuildingStats = { input: raw.length, kept: 0, tooSmall: 0, onRoad: 0, skipped: 0, byStyle: {}, withLevels: 0, plateau: 0, plateauSheds: 0 };
  const recs: { key: string; v: number[] }[] = [];
  for (const b of raw) {
    const tag = b.tags.building ?? "yes";
    if (SKIP.has(tag)) {
      st.skipped++;
      continue;
    }
    const area = polyArea(b.ring);
    if (area < 12) {
      st.tooSmall++;
      continue;
    }
    const usage = b.tags["plateau:usage"];
    if (usage && (usage === "461" || usage === "454") && area < PLATEAU_SHED) {
      st.plateauSheds++;
      continue;
    }
    const o = obb(b.ring);
    // 面積を保つように縮める（L 字などで外接長方形が道路へはみ出しすぎないように）
    const fill = Math.min(1, area / o.area);
    const k = Math.sqrt(Math.max(0.55, fill));
    let w = o.w * k;
    let d = o.d * k;
    const cx = o.cx;
    const cz = o.cz;
    let angle = o.angle;
    // 走る道に重なる建物は捨てる（長方形の上に 4m 以下の間隔で並べた点のどれかが路面の端から 0.5m 以内）。
    // 前は角・辺の中点・中心の 9 点だけで、長い建物（365m の商店街の屋根など）が、点の間を横切る道を塞いでいた（北海道の草案 30 章）
    const ca = Math.cos(angle);
    const sa = Math.sin(angle);
    const probe: [number, number][] = [];
    const nu = Math.max(2, Math.ceil(w / 4) + 1), nv = Math.max(2, Math.ceil(d / 4) + 1);
    for (let iu = 0; iu < nu; iu++) for (let iv = 0; iv < nv; iv++) probe.push([-w / 2 + (w * iu) / (nu - 1), -d / 2 + (d * iv) / (nv - 1)]);
    probe.push([0, 0]);
    let hit = false;
    for (const [u, v] of probe) {
      const n = idx.nearest(cx + u * ca - v * sa, cz + u * sa + v * ca, 0.5, true);
      if (n) {
        hit = true;
        break;
      }
    }
    if (hit) {
      st.onRoad++;
      continue;
    }
    // 向き: 一番近い道路（走らない道を含む）に沿う辺を幅にする。道路のある側が正面
    const near = idx.nearest(cx, cz, 40);
    let front: 1 | -1 = 1;
    let gap = 3;
    let roadY = gridAt(dem, cx, cz);
    let mainRoad = false;
    if (near) {
      const s = near.s;
      const rx = s.bx - s.ax;
      const rz = s.bz - s.az;
      const rl = Math.hypot(rx, rz) || 1;
      const along = Math.abs((rx / rl) * ca + (rz / rl) * sa);
      if (along < Math.SQRT1_2) {
        // 奥行きの向きが道路に沿う: 幅と奥行きを入れ替える
        angle += Math.PI / 2;
        [w, d] = [d, w];
      }
      const zx = -Math.sin(angle);
      const zz = Math.cos(angle);
      front = (near.px - cx) * zx + (near.pz - cz) * zz > 0 ? 1 : -1;
      gap = Math.max(0.3, Math.hypot(near.px - cx, near.pz - cz) - s.hw - d / 2);
      roadY = gridAt(dem, near.px, near.pz);
      mainRoad = s.ride && near.e < 12;
    }
    // 高さ: 角と中心の地面の低い方・高い方
    let lo = Infinity;
    let hi = -Infinity;
    const c2 = Math.cos(angle);
    const s2 = Math.sin(angle);
    for (const [u, v] of [
      [0, 0],
      [w / 2, d / 2],
      [-w / 2, d / 2],
      [w / 2, -d / 2],
      [-w / 2, -d / 2],
    ]) {
      const g = gridAt(dem, cx + u * c2 - v * s2, cz + u * s2 + v * c2);
      lo = Math.min(lo, g);
      hi = Math.max(hi, g);
    }
    const seed = seedOf(b.id);
    const r = (i: number) => unit(seed, i);
    const dc = Math.hypot(cx - DOWNTOWN.x, cz - DOWNTOWN.z);
    const downtown = 1 - Math.min(1, Math.max(0, (dc - 800) / 2200)); // 0.8km まで 1、3km で 0
    // 型と階数
    let style: BuildingStyle;
    let floors: number;
    const levels = Number(b.tags["building:levels"]);
    const height = Number.parseFloat(b.tags.height ?? "");
    const fa = w * d;
    // PLATEAU: 用途・階数・計測高さから（不明な用途は下の building=yes と同じ決め方で、階数だけ PLATEAU から）
    const pStoreys = Number(b.tags["plateau:storeys"] ?? 0);
    const pHeight = Number(b.tags["plateau:height"] ?? 0);
    const pick = usage ? plateauPick(usage, fa, pStoreys, pHeight, Number(b.tags["plateau:year"] ?? 0), r) : null;
    let shopUse = false;
    if (pick) {
      style = pick.style;
      floors = pick.floors;
      shopUse = pick.shopUse;
    } else if (TINY.has(tag) || fa < 30) {
      style = "strip";
      floors = 1;
    } else if (HOME.has(tag)) {
      style = r(1) < 0.25 ? "oldhouse" : "house";
      floors = r(2) < 0.85 ? 2 : 1;
    } else if (FLATS.has(tag)) {
      floors = fa < 250 ? 3 : 3 + Math.floor(r(3) * (2 + 8 * downtown));
      style = floors >= 4 ? "mansion" : "apartment";
    } else if (BIG.has(tag)) {
      style = "tenant";
      floors = 3 + Math.floor(r(3) * (3 + 7 * downtown));
    } else if (LOW.has(tag)) {
      style = "strip";
      floors = fa > 1500 ? 2 : 1;
    } else if (b.tags.shop || b.tags.amenity) {
      style = fa > 600 ? "strip" : "shop";
      floors = style === "strip" ? 1 : 2;
    } else {
      // building=yes: 面積と場所から
      if (fa < 160) {
        if (mainRoad && r(5) < 0.3 + 0.4 * downtown) {
          style = r(6) < 0.3 ? "oldshop" : "shop";
          floors = 2;
        } else {
          style = r(1) < 0.2 ? "oldhouse" : "house";
          floors = r(2) < 0.82 ? 2 : 1;
        }
      } else if (fa < 450) {
        if (mainRoad && r(5) < 0.5) {
          style = downtown > 0.5 || r(6) < 0.4 ? "tenant" : "shop";
          floors = style === "tenant" ? 3 + Math.floor(r(3) * (2 + 5 * downtown)) : 2;
        } else {
          floors = 2 + Math.floor(r(3) * (2 + 4 * downtown));
          style = floors >= 4 ? "mansion" : "apartment";
        }
      } else if (fa < 2500) {
        if (downtown > 0.3 || mainRoad) {
          style = r(7) < 0.4 * (1 - downtown) ? "mansion" : "tenant";
          floors = 4 + Math.floor(r(3) * (3 + 9 * downtown));
        } else {
          style = r(7) < 0.6 ? "mansion" : "strip";
          floors = style === "mansion" ? 4 + Math.floor(r(3) * 6) : 1;
        }
      } else {
        style = downtown > 0.5 ? "tenant" : "strip";
        floors = style === "tenant" ? 5 + Math.floor(r(3) * 10) : 2;
      }
    }
    if (usage) {
      // 用途の不明な物も、階数・計測高さがあればそれで決める
      if (!pick && pStoreys > 0) floors = pStoreys;
      else if (!pick && pHeight > 0) floors = Math.max(1, Math.round(pHeight / 3.2));
      if (!pick && floors >= 4 && (style === "apartment" || style === "house" || style === "oldhouse")) style = "mansion";
      if (!pick && floors <= 2 && style === "mansion") style = "apartment";
      if (pStoreys > 0 || pHeight > 0) st.withLevels++;
      st.plateau++;
    } else if (levels > 0) {
      floors = Math.round(levels);
      st.withLevels++;
    } else if (height > 0) {
      floors = Math.max(1, Math.round(height / 3.2));
      st.withLevels++;
    }
    // 一軒家・店の形は 2 階まで
    if (style === "house" || style === "oldhouse" || style === "shop" || style === "oldshop") floors = Math.min(2, floors);
    floors = Math.max(1, Math.min(60, floors));
    // 型ごとの寸法（district/layout.ts と同じ考え方）
    let h: number;
    if (style === "house" || style === "oldhouse") h = floors === 2 ? 6.2 : 3.9;
    else if (style === "shop" || style === "oldshop") h = floors === 2 ? 6.6 : 4.0;
    else if (style === "strip") h = floors === 1 ? 4.2 : 3.6 + (floors - 1) * 3.4;
    else if (style === "apartment") h = floors * 2.95;
    else if (style === "mansion") h = floors * 2.95;
    else h = 3.6 + (floors - 1) * 3.2;
    if (height > 0) h = height;
    // PLATEAU の計測高さは屋根の最高点まで。平らな屋根の型（集合住宅・マンション・テナント・平屋の店舗）はそのまま壁の高さにする。
    // 一軒家・店は屋根を上に載せるので、階数からの高さのまま
    const flat = style === "apartment" || style === "mansion" || style === "tenant" || style === "strip";
    if (usage && flat && pHeight > 0) {
      h = Math.max(3, pHeight);
      // 計測高さが階数に比べて高すぎる（1 階あたり 6m 超。塔屋・広告塔などまで）物は、階数から
      if (pStoreys > 0 && h / pStoreys > 6) h = 3.6 + pStoreys * 3.6;
      // 低層部の上に塔が載る大きな複合建物（札幌駅の 2.3 万 m² で 174m など）は、外形全体を塔の高さの箱にしないよう 50m までにする。
      // 塔の形は LOD2 を使う時に直す（配達の草案 20 章）
      if (fa > 6000 && h > 50) h = 50;
      // 1 階の高さが 2.6m 未満にならない階数に抑える（テナントは 1 階 3.6m）
      const maxFloors = style === "tenant" ? 1 + Math.floor(Math.max(0, h - 3.6) / 2.6) : Math.max(1, Math.floor(h / 2.6));
      floors = Math.max(1, Math.min(floors, maxFloors));
    }
    // 屋根: 北海道の家は無落雪（箱形）が多い
    const v = r(8);
    const roof = style === "house" ? (v < 0.55 ? 3 : v < 0.8 ? 0 : v < 0.92 ? 2 : 1) : style === "oldhouse" || style === "oldshop" ? (v < 0.85 ? 0 : 1) : style === "shop" && v < 0.4 ? 0 : 3;
    const tile = (style === "oldhouse" || style === "oldshop") && r(9) < 0.2;
    const plaster = r(10) > 0.7;
    const shop = style === "shop" || style === "oldshop" || (style === "tenant" && (usage ? shopUse : mainRoad));
    st.byStyle[style] = (st.byStyle[style] ?? 0) + 1;
    const flags = (tile ? 1 : 0) | (plaster ? 2 : 0) | (shop ? 4 : 0);
    const v16 = [cx, cz, w, d, h, angle, lo - 0.3, hi + 0.15, roadY + 0.1, gap, front, floors, BUILDING_STYLES.indexOf(style), roof, flags, seed];
    recs.push({ key: `${Math.floor(cx / cell)},${Math.floor(cz / cell)}`, v: v16 });
    st.kept++;
  }
  recs.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const data = new Float32Array(recs.length * BUILDING_REC);
  const index: HokkaidoBuildingIndex = { cell, rec: BUILDING_REC, cells: {} };
  recs.forEach((r, i) => {
    data.set(r.v, i * BUILDING_REC);
    const c = index.cells[r.key];
    if (c) c[1]++;
    else index.cells[r.key] = [i, 1];
  });
  return { data, index, stats: st };
}
