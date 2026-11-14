// 街区の中身を決める: 敷地の使い道（店・住宅・集合住宅・駐車場・空き地・畑）、建物の位置と大きさ、電柱、街路樹。
// 計画（plan）と地面の面（surface）だけから決まる（同じ場所なら同じ街並み）。Three.js に依存しない。

import { hash } from "../../shared/world/hash.ts";
import type { Building, BuildingStyle, Cafe } from "../town-layout.ts";
import { type Block, buildBlocks, buildGraph, buildLots, halfWidth, type Lot, type StreetGraph } from "./blocks.ts";
import { centroid, type P2, pointInPoly, segDist } from "./geom.ts";
import type { DistrictPlan } from "./plan.ts";
import { sampleSurface, type SurfaceGrid } from "./surface.ts";

/** green = 木の植わった緑地（街区の内側の公園・境内） */
export type LotUse = "shop" | "house" | "apartment" | "parking" | "vacant" | "field" | "green" | "reserved";

export interface LotInfo {
  lot: Lot;
  use: LotUse;
}

/** 街路の、網に残った部分をつないだ折れ線 */
export interface StreetRun {
  street: number;
  pts: P2[];
  /** 両端で路面を縮める長さ（端が幹線に当たる時、幹線の路面の端まで。そうでなければ 0） */
  trim: [number, number];
}

export interface Pole {
  x: number;
  y: number;
  z: number;
  /** 通りの向き */
  tx: number;
  tz: number;
  /** 変圧器・街灯の有無 */
  transformer: boolean;
  lamp: boolean;
  /** 同じ通りの次の電柱の番号（電線を張る。なければ −1） */
  next: number;
}

export interface StreetTree {
  x: number;
  y: number;
  z: number;
  scale: number;
  rot: number;
}

export interface DistrictLayout {
  plan: DistrictPlan;
  surface: SurfaceGrid;
  graph: StreetGraph;
  runs: StreetRun[];
  blocks: Block[];
  lots: LotInfo[];
  buildings: Building[];
  poles: Pole[];
  trees: StreetTree[];
  /** 緑地と庭の木（面の上に直に立つ） */
  gardenTrees: StreetTree[];
  /** 造成した面の高さ */
  height(x: number, z: number): number;
  /** 街として使える所か（外周の中で、水際でない） */
  dry(x: number, z: number): boolean;
  stats: { blocks: number; voidBlocks: number; lots: number; buildings: number; ms: number };
}

/** 面からの高さ【初期値】: 街路、敷地、歩道 */
export const Y_STREET = -0.02;
export const Y_LOT = 0.12;
export const Y_WALK = 0.15;

const unit = (seed: number, a: number, b = 0, c = 0) => hash(seed, a, b, c) / 4294967296;

/**
 * road は、点からいちばん近い世界の道路の、路面の端までの距離 e と路面の高さ y（あれば）。
 * 面は 8m の格子なので路面と最大 0.2m ほどずれる。幹線の端から 2.8m 以内（歩道の幅）は路面の高さそのものを使い、5m までで面へ戻す。
 */
export function layoutDistrict(plan: DistrictPlan, surface: SurfaceGrid, cafes: Cafe[], now: () => number = () => 0, road?: (x: number, z: number) => { e: number; y: number }): DistrictLayout {
  const t0 = now();
  const tmp = { h: 0, m: 0 };
  const height = (x: number, z: number) => {
    const s = sampleSurface(surface, x, z, tmp) ? tmp.h : 0;
    if (!road) return s;
    const r = road(x, z);
    if (!(r.e < 5)) return s;
    let k = (r.e - 2.8) / 2.2;
    k = k < 0 ? 0 : k * k * (3 - 2 * k);
    return r.y * (1 - k) + s * k;
  };
  // 面の高さは幹線の近くで路面に合わせてあるので、水際かどうかは地形から作った重み（surface.m）で見る
  const dry = (x: number, z: number) => sampleSurface(surface, x, z, tmp) && tmp.m > 0.6;
  const graph = buildGraph(plan);
  const blocks = buildBlocks(plan, graph);
  const lots = buildLots(plan, blocks);
  const runs = streetRuns(plan, graph);

  const infos: LotInfo[] = [];
  const buildings: Building[] = [];
  lots.forEach((lot, li) => {
    const [cx, cz] = centroid(lot.poly);
    const c = Math.hypot(cx - plan.cx, cz - plan.cz) / plan.radius;
    const u = (k: number) => unit(plan.seed, li, k, 21);
    const onEdge = lot.tags.some((t) => t >= 0 && plan.streets[t].kind === "edge");
    let use: LotUse;
    // 水際の敷地は使わない
    if (lot.poly.some((q) => !dry(q[0], q[1]))) use = "reserved";
    else if (cafes.some((cf) => Math.hypot(cf.x - cx, cf.z - cz) < Math.hypot(cf.w, cf.d + 14) / 2 + Math.sqrt(lot.area) * 0.6)) use = "reserved";
    else if (lot.inner) use = unit(plan.seed, lot.block, 24) < 0.5 ? "green" : c < 0.5 ? "parking" : "field";
    else if (lot.front < 0) use = c < 0.45 ? "parking" : onEdge || c > 0.7 ? "field" : "vacant";
    else if (lot.mainStreet && c < 0.7 ? u(1) > 0.96 : u(1) > 0.97 - 0.55 * c * c - (onEdge ? 0.25 : 0)) use = c < 0.6 && u(2) < 0.55 ? "parking" : onEdge || c > 0.75 ? "field" : "vacant";
    else if (lot.mainStreet && c < 0.7) use = "shop";
    else use = "house";
    if (use === "shop" || use === "house") {
      const b = fitBuilding(plan, lot, li, use, c, height);
      if (b) {
        if (b.style === "apartment" || b.style === "mansion") use = "apartment";
        buildings.push(b);
      } else use = c > 0.7 ? "field" : "vacant";
    }
    // 空き地の 4 割は木の植わった緑地にする（幹線沿いを除く）
    if (use === "vacant" && !lot.mainStreet && u(8) < 0.4) use = "green";
    infos.push({ lot, use });
  });

  const { poles, trees } = placeProps(plan, graph, runs, height, dry);
  // 緑地の木（敷地の中にハッシュで数本）と、住宅の庭木（建物の裏の隅に 1 本、4 割の家）
  const gardenTrees: StreetTree[] = [];
  infos.forEach((info, li) => {
    if (info.use !== "green") return;
    const P = info.lot.poly;
    const n = Math.max(2, Math.round(info.lot.area / 70));
    const [cx, cz] = centroid(P);
    for (let k = 0; k < n; k++) {
      // 多角形の中の点: 重心と、隣り合う頂点 2 つの間
      const i = Math.floor(unit(plan.seed, li, k, 41) * P.length);
      const a = P[i], b = P[(i + 1) % P.length];
      let w1 = unit(plan.seed, li, k, 42), w2 = unit(plan.seed, li, k, 43);
      if (w1 + w2 > 1) {
        w1 = 1 - w1;
        w2 = 1 - w2;
      }
      const x = cx + (a[0] - cx) * w1 * 0.85 + (b[0] - cx) * w2 * 0.85, z = cz + (a[1] - cz) * w1 * 0.85 + (b[1] - cz) * w2 * 0.85;
      gardenTrees.push({ x, y: height(x, z), z, scale: 1.1 + 0.7 * unit(plan.seed, li, k, 44), rot: unit(plan.seed, li, k, 45) * 6.283 });
    }
  });
  for (const b of buildings) {
    if ((b.style !== "house" && b.style !== "oldhouse") || hash(plan.seed, b.seed, 46) % 10 >= 4) continue;
    // 建物の裏（道路と反対）の隅から 1.6m 外
    const c = Math.cos(b.angle), s = Math.sin(b.angle);
    const sd = hash(plan.seed, b.seed, 47) & 1 ? 1 : -1;
    const x = b.x + c * sd * (b.w / 2 - 1) - s * (b.d / 2 + 1.6), z = b.z + s * sd * (b.w / 2 - 1) + c * (b.d / 2 + 1.6);
    if (!lots.some((l) => pointInPoly(l.poly, x, z))) continue;
    gardenTrees.push({ x, y: height(x, z), z, scale: 0.7 + 0.35 * unit(plan.seed, b.seed, 48), rot: unit(plan.seed, b.seed, 49) * 6.283 });
  }
  return {
    plan,
    surface,
    graph,
    runs,
    blocks,
    lots: infos,
    buildings,
    poles,
    trees,
    gardenTrees,
    height,
    dry,
    stats: { blocks: blocks.length, voidBlocks: blocks.filter((b) => !b.lotLine).length, lots: lots.length, buildings: buildings.length, ms: now() - t0 },
  };
}

/** 敷地に建物の長方形を収める。間口の辺に平行で、通りに面して建てる */
function fitBuilding(plan: DistrictPlan, lot: Lot, li: number, use: "shop" | "house", c: number, height: (x: number, z: number) => number): Building | null {
  const P = lot.poly;
  const p = P[lot.front], q = P[(lot.front + 1) % P.length];
  let tx = q[0] - p[0], tz = q[1] - p[1];
  const fl = Math.hypot(tx, tz);
  tx /= fl;
  tz /= fl;
  const nx = -tz, nz = tx; // 敷地の内側
  let t0 = Infinity, t1 = -Infinity, n1 = -Infinity;
  for (const [x, z] of P) {
    const a = (x - p[0]) * tx + (z - p[1]) * tz;
    const b = (x - p[0]) * nx + (z - p[1]) * nz;
    t0 = Math.min(t0, a);
    t1 = Math.max(t1, a);
    n1 = Math.max(n1, b);
  }
  const u = (k: number) => unit(plan.seed, li, k, 22);
  const hh = hash(plan.seed, li, 23);
  // 街区ごとの古さ（0 = 古い建物が多い、1 = 新しい建物が多い）
  const age = unit(plan.seed, lot.block, 25, 3);
  const width = t1 - t0;
  let style: BuildingStyle;
  let side: number, n0: number, depth: number, maxW = 40;
  let floors: number, h: number;
  let roof: Building["roof"] = "flat";
  if (use === "shop") {
    const central = c < 0.32;
    const pTenant = (central ? 0.42 : 0.1) * (0.6 + 0.8 * age);
    const pOld = (central ? 0.14 : 0.3) * (1.6 - 1.2 * age);
    const v = u(9);
    if (width > 11.5 && u(10) < 0.5) style = "strip";
    else if (v < pTenant) style = "tenant";
    else if (v < pTenant + pOld) style = "oldshop";
    else style = "shop";
    if (style === "strip") {
      side = 0.4;
      n0 = 1.4;
      depth = 8 + 3 * u(1);
      floors = 1;
      h = 4.1;
    } else if (style === "tenant") {
      side = 0.2;
      n0 = 0.4;
      depth = 11 + 5 * u(1);
      floors = central ? 3 + Math.floor(u(3) * 3) : 3;
      h = 3.6 + (floors - 1) * 3.1;
    } else if (style === "oldshop") {
      side = 0.2;
      n0 = 1.1;
      depth = 10 + 5 * u(1);
      floors = u(2) < 0.8 ? 2 : 1;
      h = floors === 2 ? 5.9 : 3.7;
      roof = "gable";
    } else {
      side = 0.15;
      n0 = 0.4;
      depth = 10 + 5 * u(1);
      floors = u(2) < 0.85 ? 2 : 1;
      h = floors === 2 ? 7.0 : 4.0;
      roof = u(3) < 0.45 ? "flat" : "gable";
    }
  } else {
    // 広い敷地の一部は集合住宅
    if (width > 13 && n1 > 16 && u(6) < 0.3) style = u(10) < 0.6 ? "apartment" : "mansion";
    else style = u(9) < 0.3 * (1.5 - age) ? "oldhouse" : "house";
    if (style === "apartment") {
      side = 1.2;
      n0 = 3.5;
      depth = 7.2;
      maxW = 26;
      floors = 2;
      h = 6.0;
      roof = u(3) < 0.55 ? "flat" : "gable";
    } else if (style === "mansion") {
      side = 1.5;
      n0 = 3.2;
      depth = 9.5;
      maxW = 30;
      floors = 3 + (u(3) < 0.4 ? 1 : 0) + (c < 0.4 && u(4) < 0.5 ? 1 : 0);
      h = floors * 2.95;
    } else {
      const old = style === "oldhouse";
      // 間口の狭い敷地では隣との間を詰める
      side = Math.max(0.35, Math.min(0.9 + 0.7 * u(1), (width - 5.2) / 2));
      n0 = old ? 2 + 2.5 * u(2) : 1.6 + 2.8 * u(2);
      depth = 7.5 + 2.5 * u(3);
      maxW = (old ? 8.5 : 9) + 3 * u(4);
      floors = u(5) < (old ? 0.55 : 0.82) ? 2 : 1;
      h = floors === 2 ? (old ? 6.0 : 6.3) : old ? 3.8 : 3.9;
      // 屋根: 三角屋根、無落雪屋根（箱形）、片流れ、寄棟
      const v = u(8);
      roof = old ? (v < 0.85 ? "gable" : "hip") : v < 0.5 ? "gable" : v < 0.84 ? "flat" : v < 0.92 ? "shed" : "hip";
    }
  }
  let a0 = t0 + side, a1 = t1 - side;
  if (a1 - a0 > maxW) {
    // 片側へ寄せて、空いた側を車や庭の場所にする
    if (u(7) < 0.5) a1 = a0 + maxW;
    else a0 = a1 - maxW;
  }
  let b0 = n0, b1 = Math.min(n1 - 1.2, n0 + depth);
  const inside = (a: number, b: number) => pointInPoly(P, p[0] + tx * a + nx * b, p[1] + tz * a + nz * b);
  // はみ出した角・辺の側だけを縮める（台形や斜めの敷地でも、収まる最大に近い長方形になる）
  const e = 0.08;
  for (let k = 0; ; k++) {
    if (k === 60 || a1 - a0 < 4 || b1 - b0 < 4.5) return null;
    const am = (a0 + a1) / 2, bm = (b0 + b1) / 2;
    const fl = inside(a0 - e, b0 - e), fr = inside(a1 + e, b0 - e), bl = inside(a0 - e, b1 + e), br = inside(a1 + e, b1 + e);
    const ml = inside(a0 - e, bm), mr = inside(a1 + e, bm), mf = inside(am, b0 - e), mb = inside(am, b1 + e);
    if (fl && fr && bl && br && ml && mr && mf && mb) break;
    const deep = b1 - b0 > 7.5;
    if (!mf || (!fl && !fr)) b0 += 0.3;
    else {
      if (!fl) a0 += 0.35;
      if (!fr) a1 -= 0.35;
    }
    if (!mb || (!bl && !br)) b1 -= 0.5;
    else {
      if (!bl) deep ? (b1 -= 0.5) : (a0 += 0.35);
      if (!br) deep ? (b1 -= 0.5) : (a1 -= 0.35);
    }
    if (!ml && fl && bl) a0 += 0.35;
    if (!mr && fr && br) a1 -= 0.35;
  }
  const w = a1 - a0, d = b1 - b0;
  if (w < 4.2 || d < 5) return null;
  const am = (a0 + a1) / 2, bm = (b0 + b1) / 2;
  const x = p[0] + tx * am + nx * bm, z = p[1] + tz * am + nz * bm;
  let lo = Infinity, hi = -Infinity;
  for (const [a, b] of [[a0, b0], [a1, b0], [a1, b1], [a0, b1], [am, bm]]) {
    const g = height(p[0] + tx * a + nx * b, p[1] + tz * a + nz * b);
    lo = Math.min(lo, g);
    hi = Math.max(hi, g);
  }
  // 傾きの大きすぎる敷地には建てない
  if (hi - lo > Math.max(2.2, Math.min(w, d) * 0.3)) return null;
  const shop = use === "shop";
  // 集合住宅は間口が要る。収まらなければ家にする
  if ((style === "apartment" || style === "mansion") && w < 10) {
    style = "house";
    floors = 2;
    h = 6.3;
    roof = "gable";
  }
  const home = style === "house" || style === "oldhouse";
  const frontY = height(p[0] + tx * am, p[1] + tz * am);
  return {
    x,
    z,
    w,
    d,
    h,
    angle: Math.atan2(tz, tx),
    tone: hh % 7,
    base: lo - 0.4,
    top: hi + Y_LOT + 0.03,
    front: -1,
    gap: b0 + 0.5,
    roadY: frontY + Y_LOT + 0.25,
    floors,
    roof,
    // 屋根は金属が基本。瓦は古い建物の一部だけ
    roofMat: (style === "oldhouse" || style === "oldshop") && (hh >>> 4) % 10 < 2 ? "tile" : "metal",
    wallMat: ((hh >>> 8) % 10) < 7 ? "siding" : "plaster",
    // 雪の多い土地では塀を立てない家が多い
    fence: home && b0 > 1.6 && (hh >>> 10) % 20 < 3,
    seed: hh >>> 12,
    shop,
    style,
    sign: (hh >>> 6) % 32,
  };
}

/** 網に残った辺を、街路ごとにつないで折れ線にする */
function streetRuns(plan: DistrictPlan, g: StreetGraph): StreetRun[] {
  // 幹線が通る点と、そこでの幹線の辺
  const arterialNode = new Map<number, { a: number; b: number; street: number }>();
  for (const e of g.edges)
    if (plan.streets[e.street].kind === "arterial") {
      arterialNode.set(e.a, e);
      arterialNode.set(e.b, e);
    }
  /** 点 n で終わる通り（n の手前の点が from）を、幹線の路面の端まで縮める長さ */
  const trimAt = (n: number, from: number): number => {
    const e = arterialNode.get(n);
    if (!e) return 0;
    const a = g.nodes[e.a], b = g.nodes[e.b], p = g.nodes[n], q = g.nodes[from];
    const al = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1, sl = Math.hypot(q[0] - p[0], q[1] - p[1]) || 1;
    const sin = Math.abs(((b[0] - a[0]) * (q[1] - p[1]) - (b[1] - a[1]) * (q[0] - p[0])) / (al * sl));
    return Math.max(0, halfWidth(plan.streets[e.street]) / Math.max(0.5, sin) - 0.35);
  };
  const byStreet = new Map<number, { a: number; b: number }[]>();
  for (const e of g.edges) {
    if (plan.streets[e.street].kind === "edge") continue;
    const l = byStreet.get(e.street);
    if (l) l.push(e);
    else byStreet.set(e.street, [e]);
  }
  const runs: StreetRun[] = [];
  for (const [street, edges] of [...byStreet.entries()].sort((a, b) => a[0] - b[0])) {
    const adj = new Map<number, number[]>();
    edges.forEach((e, i) => {
      for (const n of [e.a, e.b]) {
        const l = adj.get(n);
        if (l) l.push(i);
        else adj.set(n, [i]);
      }
    });
    const used = new Set<number>();
    const isArterial = plan.streets[street].kind === "arterial";
    const starts = [...adj.entries()].filter(([, l]) => l.length === 1).map(([n]) => n).sort((a, b) => a - b);
    for (const s of [...starts, ...adj.keys()]) {
      let n = s;
      const chain = [n];
      for (;;) {
        const ei = (adj.get(n) ?? []).find((i) => !used.has(i));
        if (ei === undefined) break;
        used.add(ei);
        n = edges[ei].a === n ? edges[ei].b : edges[ei].a;
        chain.push(n);
        // 幹線を横切る通りは、幹線の所で切る（幹線の路面の下に路面を作らない）
        if (!isArterial && arterialNode.has(n)) break;
      }
      if (chain.length < 2) continue;
      const m = chain.length - 1;
      runs.push({
        street,
        pts: chain.map((i) => g.nodes[i]),
        trim: isArterial ? [0, 0] : [trimAt(chain[0], chain[1]), trimAt(chain[m], chain[m - 1])],
      });
    }
  }
  return runs;
}

/** 電柱と街路樹。通りに沿って一定の間隔で置き、ほかの通りの車道にかかる所は飛ばす */
function placeProps(plan: DistrictPlan, g: StreetGraph, runs: StreetRun[], height: (x: number, z: number) => number, dry: (x: number, z: number) => boolean): { poles: Pole[]; trees: StreetTree[] } {
  const poles: Pole[] = [];
  const trees: StreetTree[] = [];
  const onRoadway = (x: number, z: number, self: number, margin: number): boolean => {
    for (const e of g.edges) {
      if (e.street === self) continue;
      const st = plan.streets[e.street];
      if (st.kind === "edge") continue;
      const a = g.nodes[e.a], b = g.nodes[e.b];
      if (segDist(x, z, a[0], a[1], b[0], b[1]).d < halfWidth(st) + margin) return true;
    }
    return false;
  };
  runs.forEach((run, ri) => {
    const st = plan.streets[run.street];
    const arterial = st.kind === "arterial";
    const hw = halfWidth(st);
    // 道のりに沿った点
    const at = (s: number) => {
      let acc = 0;
      for (let i = 0; i < run.pts.length - 1; i++) {
        const a = run.pts[i], b = run.pts[i + 1];
        const l = Math.hypot(b[0] - a[0], b[1] - a[1]);
        if (s <= acc + l || i === run.pts.length - 2) {
          const t = Math.max(0, Math.min(1, (s - acc) / (l || 1)));
          return { x: a[0] + (b[0] - a[0]) * t, z: a[1] + (b[1] - a[1]) * t, tx: (b[0] - a[0]) / (l || 1), tz: (b[1] - a[1]) / (l || 1) };
        }
        acc += l;
      }
      return { x: 0, z: 0, tx: 1, tz: 0 };
    };
    let len = 0;
    for (let i = 0; i < run.pts.length - 1; i++) len += Math.hypot(run.pts[i + 1][0] - run.pts[i][0], run.pts[i + 1][1] - run.pts[i][1]);
    if (len < 24) return;
    // 電柱: 片側。幹線は歩道の縁石寄り、ほかは車道の端
    const side = unit(plan.seed, run.street, 31) < 0.5 ? 1 : -1;
    const off = arterial ? hw + 0.45 : hw - 0.3;
    const pitch = arterial ? 32 : 34;
    let prev = -1;
    for (let s = 6 + unit(plan.seed, ri, 32) * 12; s < len - 4; s += pitch) {
      let placed = false;
      for (const shift of [0, 5, -5, 9]) {
        const f = at(s + shift);
        const x = f.x - f.tz * side * off, z = f.z + f.tx * side * off;
        if (!pointInPoly(plan.boundary, x, z) || onRoadway(x, z, run.street, 0.5) || !dry(x, z)) continue;
        const k = poles.length;
        poles.push({ x, y: height(x, z), z, tx: f.tx, tz: f.tz, transformer: hash(plan.seed, k, 33) % 4 === 0, lamp: hash(plan.seed, k, 34) % 3 !== 0, next: -1 });
        if (prev >= 0) poles[prev].next = k;
        prev = k;
        placed = true;
        break;
      }
      if (!placed) prev = -1;
    }
    // 街路樹: 幹線の両側の歩道、中心部だけ
    if (!arterial || st.sidewalk < 2) return;
    for (const sd of [-1, 1])
      for (let s = 9 + unit(plan.seed, ri, 35 + sd) * 6; s < len - 6; s += 15) {
        const f = at(s);
        const x = f.x - f.tz * sd * (hw + 0.75), z = f.z + f.tx * sd * (hw + 0.75);
        if (Math.hypot(x - plan.cx, z - plan.cz) > plan.radius * 0.7) continue;
        if (!pointInPoly(plan.boundary, x, z) || onRoadway(x, z, run.street, 2.5) || !dry(x, z)) continue;
        if (poles.some((p) => Math.hypot(p.x - x, p.z - z) < 4)) continue;
        trees.push({ x, y: height(x, z), z, scale: 0.85 + 0.25 * unit(plan.seed, trees.length, 36), rot: unit(plan.seed, trees.length, 37) * 6.283 });
      }
  });
  return { poles, trees };
}
