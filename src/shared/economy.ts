// 業者・シェア・縄張り・順位（配達の草案 6 章・14.5・17 章・18 章、D3）。一人用の段階では端末で回し、オンライン（D6）で同じ計算をサーバーへ移す。
// DOM・Three.js に依存しない。乱数はハッシュ、分岐に関わる計算は加減乗除と sqrt・floor・min・max だけ（モック 4.2）。
//
// 1 日（世界の時計の 1 日 = 現実の約 3 時間 26 分）ごとに:
//   1. 丁目ごとの注文の量を決め、業者の取りやすさ（信頼 × 営業所からの近さ × 配達員の数 × 値段）の比で分ける（6.3）
//   2. 配達員の数で運べる分だけ運び（あふれた分は失い、信頼が下がる）、売上と費用から資金が動く
//   3. 儲かれば配達員・営業所を増やし、運びきれなければ減らす。資金がマイナス、またはシェア 0.5% 未満が 1 か月（28 日）続けば廃業（17.1）
//   4. 業者が少なければ新しい個人業者が開業する（6.7 のスリザリオの形。上限あり）
// 縄張り: 丁目ごとに、直近 1 か月の配達の件数がいちばん多い業者が持つ（14.5・17.2）。プレイヤーの配達は所属の業者（無ければ「個人」）の件数に入る。

import { hash, hashString, hashUnit } from "./world/hash.ts";

/** 1 か月（日） */
export const MONTH = 28;
/** 1 週（日） */
export const WEEK = 7;
/** 開いた時にまとめて細かく計算する上限（日）。それより前は営業所・配達員を変えずに資金だけ平均で進める（6.5・17.2） */
export const CATCHUP_FULL = 7;

/** 配達員 1 人が 1 日に運べる件数、日給 (円)、営業所 1 つの 1 日の費用 (円)、営業所からの 1km あたりの費用 (円)、標準の値段 (円)【初期値】 */
const PER_STAFF = 22;
const WAGE = 7000;
const DEPOT_COST = 6000;
const DIST_COST = 30;
export const BASE_PRICE = 520;
/** 業者の数の目安と上限（6.7）、廃業の基準（17.1）【初期値】 */
const TARGET_COMPANIES = 8;
const MAX_COMPANIES = 12;
const LOW_SHARE = 0.005;

export type CompanyKind = "large" | "mid" | "solo";
export type Policy = "cheap" | "fast" | "wide";
export const KIND_LABELS: Record<CompanyKind, string> = { large: "大手", mid: "中堅", solo: "個人" };
export const POLICY_LABELS: Record<Policy, string> = { cheap: "安さ", fast: "速さ", wide: "広さ" };

/** 業者の名前（架空。北海道の草花・生き物の名前と「便」「配送」などを組み合わせた造語）と色 */
const NAMES = [
  "すずらん配送", "はまなす便", "ななかまど急便", "えぞりす運輸", "しらかば便", "こぶし配送", "ハスカップ便", "雪あかり便",
  "ルピナス配送", "きたきつね急送", "オオワシ便", "ふきのとう配送", "ライラック便", "えぞまつ運輸", "シマエナガ便", "流氷急便",
];
/** 地図で見分けやすい 12 色（開いている業者どうしで重ならないように選ぶ） */
const COLORS = ["#e6194b", "#3c78d8", "#f2c200", "#3cb44b", "#911eb4", "#f58231", "#42d4f4", "#f032e6", "#8b5a2b", "#bfef45", "#000075", "#469990"];

export interface Company {
  id: string;
  name: string;
  color: string;
  policy: Policy;
  /** 営業所のある丁目の名前 */
  depots: string[];
  staff: number;
  cash: number;
  /** 信頼（0.5〜1.5） */
  trust: number;
  price: number;
  opened: number;
  /** 廃業した日（無ければ null） */
  closed: number | null;
  /** 1 日の利益のならし（直近の日ほど重い平均。円） */
  profit: number;
  /** 資金がマイナスの日、シェアが低い日が続いた数 */
  negDays: number;
  lowDays: number;
}

/** 1 日の割り振りに使う、業者のその日の形 */
export interface Snap {
  id: string;
  depots: string[];
  staff: number;
  trust: number;
  price: number;
  policy: Policy;
}

/** プレイヤーの 1 日の配達: 件数（"所属の業者の id|丁目の名前" → 件数。個人は "self"）と売上（業者の id → 円） */
export interface PlayerDay {
  day: number;
  counts: Record<string, number>;
  sales: Record<string, number>;
}

export interface EconomyState {
  v: 1;
  seed: number;
  /** 計算済みの最後の日（世界の日の通し番号） */
  day: number;
  /** 業者の通し番号 */
  serial: number;
  lastOpen: number;
  companies: Company[];
  /** 直近 1 か月の日ごとの業者の形（縄張り・順位を計算し直すため） */
  history: { day: number; snaps: Snap[] }[];
  player: { company: string | null; days: PlayerDay[] };
}

export const kindOf = (staff: number): CompanyKind => (staff >= 25 ? "large" : staff >= 7 ? "mid" : "solo");

// ---- 経済の場（丁目の並び） ----

export interface ArenaChome {
  name: string;
  x: number;
  z: number;
  /** 1 日の注文の量の基本（件） */
  base: number;
  /** 面積 (m²。いちばん近い点で分けた領域を 20m の升で数える) */
  area: number;
}

/** 丁目の点を引く関数（AddressBook.at と同じ形） */
export type NearestChome = (x: number, z: number) => { name: string } | null;

/** 縄張りを塗る升（升ごとの丁目の番号。−1 は場の外） */
export interface ArenaRaster {
  x0: number;
  z0: number;
  cell: number;
  nx: number;
  nz: number;
  idx: Int32Array;
}

export class Arena {
  readonly chomes: ArenaChome[];
  readonly index = new Map<string, number>();
  readonly raster: ArenaRaster;

  /** points は場の中の丁目の点、rect は場の範囲、center は町の中心（注文が多い） */
  constructor(points: { name: string; x: number; z: number }[], rect: { x0: number; z0: number; x1: number; z1: number }, center: { x: number; z: number }, nearest: NearestChome, seed: number, cell = 20) {
    const inside = points.filter((p) => p.x >= rect.x0 && p.x <= rect.x1 && p.z >= rect.z0 && p.z <= rect.z1).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    this.chomes = inside.map((p, i) => {
      const d = Math.sqrt((p.x - center.x) * (p.x - center.x) + (p.z - center.z) * (p.z - center.z));
      const near = Math.max(0, 1 - d / 3500);
      return { name: p.name, x: p.x, z: p.z, base: (0.8 + 4.2 * near) * (0.7 + 0.6 * hashUnit(seed ^ 0xa7e, i)), area: 0 };
    });
    this.chomes.forEach((c, i) => this.index.set(c.name, i));
    const nx = Math.ceil((rect.x1 - rect.x0) / cell);
    const nz = Math.ceil((rect.z1 - rect.z0) / cell);
    const idx = new Int32Array(nx * nz).fill(-1);
    for (let j = 0; j < nz; j++)
      for (let i = 0; i < nx; i++) {
        const p = nearest(rect.x0 + (i + 0.5) * cell, rect.z0 + (j + 0.5) * cell);
        const k = p ? this.index.get(p.name) : undefined;
        if (k === undefined) continue;
        idx[j * nx + i] = k;
        this.chomes[k].area += cell * cell;
      }
    this.raster = { x0: rect.x0, z0: rect.z0, cell, nx, nz, idx };
  }
}

// ---- 1 日の割り振り ----

export interface DayAlloc {
  day: number;
  ids: string[];
  /** 運んだ件数 [丁目 × 業者]（期待値。小数） */
  served: Float64Array;
  /** 業者ごとの売上・費用・運んだ件数・あふれた件数 */
  revenue: number[];
  cost: number[];
  total: number[];
  lost: number[];
  /** 場の注文の合計 */
  demand: number;
}

const weekdayFactor = (day: number) => {
  const w = day - Math.floor(day / 7) * 7;
  return w >= 5 ? 1.25 : 1;
};
const reachOf = (p: Policy) => (p === "wide" ? 600 : 400);

export function allocate(arena: Arena, snaps: Snap[], day: number, seed: number): DayAlloc {
  const C = arena.chomes.length;
  const K = snaps.length;
  const served = new Float64Array(C * K);
  const revenue = new Array<number>(K).fill(0);
  const cost = new Array<number>(K).fill(0);
  const total = new Array<number>(K).fill(0);
  const lost = new Array<number>(K).fill(0);
  const distKm = new Float64Array(C * K);
  const depotPts = snaps.map((s) => s.depots.map((n) => arena.chomes[arena.index.get(n) ?? -1]).filter(Boolean));
  const wk = weekdayFactor(day);
  let demand = 0;
  for (let c = 0; c < C; c++) {
    const ch = arena.chomes[c];
    const D = ch.base * wk * (0.8 + 0.4 * hashUnit(seed ^ 0xde3, c, day));
    demand += D;
    let sum = 0;
    for (let k = 0; k < K; k++) {
      const s = snaps[k];
      let best = Infinity;
      for (const d of depotPts[k]) {
        const dd = (d.x - ch.x) * (d.x - ch.x) + (d.z - ch.z) * (d.z - ch.z);
        if (dd < best) best = dd;
      }
      if (best === Infinity) continue;
      const dist = Math.sqrt(best);
      distKm[c * K + k] = dist / 1000;
      const r = dist / reachOf(s.policy);
      const pr = BASE_PRICE / s.price;
      // 配達員の数は 4 乗根で効かせる（大きいほど小回りが利かない。6.7）
      // 近さは距離の 4 乗で落とす（営業所の周りが地元になる）
      const r2 = r * r;
      const a = s.trust * (1 / (1 + r2 * r2)) * Math.sqrt(Math.sqrt(s.staff)) * pr * pr;
      served[c * K + k] = a;
      sum += a;
    }
    if (sum <= 0) continue;
    for (let k = 0; k < K; k++) {
      const n = (D * served[c * K + k]) / sum;
      served[c * K + k] = n;
      total[k] += n;
    }
  }
  // 運べる分だけ、営業所に近い丁目から運ぶ（あふれた遠い分は失う）
  for (let k = 0; k < K; k++) {
    const cap = snaps[k].staff * PER_STAFF;
    if (total[k] > cap) {
      lost[k] = total[k] - cap;
      const order: number[] = [];
      for (let c = 0; c < C; c++) if (served[c * K + k] > 0) order.push(c);
      order.sort((p, q) => distKm[p * K + k] - distKm[q * K + k] || p - q);
      let left = cap;
      for (const c of order) {
        const n = served[c * K + k];
        const take = n < left ? n : left;
        served[c * K + k] = take;
        left -= take;
      }
      total[k] = cap;
    }
    let far = 0;
    for (let c = 0; c < C; c++) far += served[c * K + k] * distKm[c * K + k];
    revenue[k] = total[k] * snaps[k].price;
    cost[k] = snaps[k].staff * WAGE + snaps[k].depots.length * DEPOT_COST + far * DIST_COST;
  }
  return { day, ids: snaps.map((s) => s.id), served, revenue, cost, total, lost, demand };
}

// ---- 1 日進める ----

const snapOf = (c: Company): Snap => ({ id: c.id, depots: [...c.depots], staff: c.staff, trust: c.trust, price: c.price, policy: c.policy });
const active = (s: EconomyState) => s.companies.filter((c) => c.closed === null);

/** 営業所を置く丁目を選ぶ: 注文が多く、自分の営業所から 800m 以上、ほかの業者の営業所から 300m 以上離れた所 */
function pickDepot(arena: Arena, s: EconomyState, own: string[], salt: number): string | null {
  const taken = new Set(active(s).flatMap((c) => c.depots));
  const at = (n: string) => arena.chomes[arena.index.get(n) ?? -1];
  const pts = own.map(at).filter(Boolean);
  const others = [...taken].filter((n) => !own.includes(n)).map(at).filter(Boolean);
  let best: string | null = null;
  let bs = -Infinity;
  arena.chomes.forEach((ch, i) => {
    if (taken.has(ch.name)) return;
    let near = Infinity;
    for (const p of pts) near = Math.min(near, (p.x - ch.x) * (p.x - ch.x) + (p.z - ch.z) * (p.z - ch.z));
    // 自分の営業所から 800m 以上離す。最初の 1 つはどこでもよい
    if (pts.length && near < 800 * 800) return;
    for (const o of others) if ((o.x - ch.x) * (o.x - ch.x) + (o.z - ch.z) * (o.z - ch.z) < 300 * 300) return;
    const score = ch.base * (0.6 + 0.8 * hashUnit(s.seed ^ 0xd3f, i, salt));
    if (score > bs) {
      bs = score;
      best = ch.name;
    }
  });
  return best;
}

function newCompany(arena: Arena, s: EconomyState, day: number, kind: CompanyKind): Company | null {
  const used = new Set(active(s).map((c) => c.name));
  const usedColors = new Set(active(s).map((c) => c.color));
  const serial = s.serial++;
  const start = hash(s.seed ^ 0x4a3e, serial) % NAMES.length;
  let name: string | null = null;
  for (let i = 0; i < NAMES.length; i++) {
    const k = (start + i) % NAMES.length;
    if (!used.has(NAMES[k])) {
      name = NAMES[k];
      break;
    }
  }
  const color = COLORS.find((c) => !usedColors.has(c)) ?? null;
  if (!name || !color) return null;
  const u = (a: number) => hashUnit(s.seed ^ 0x4a3f, serial, a);
  const policy: Policy = u(1) < 0.34 ? "cheap" : u(1) < 0.67 ? "fast" : "wide";
  const [depotN, staff, cash] = kind === "large" ? [4, 24 + Math.floor(u(2) * 7), 3_000_000] : kind === "mid" ? [2, 8 + Math.floor(u(2) * 4), 800_000] : [1, 2 + Math.floor(u(2) * 2), 300_000];
  const c: Company = {
    id: `c${serial}`,
    name,
    color,
    policy,
    depots: [],
    staff,
    cash,
    trust: policy === "fast" ? 1.1 : 1,
    price: Math.round(BASE_PRICE * (policy === "cheap" ? 0.9 : policy === "fast" ? 1.1 : 1)),
    opened: day,
    closed: null,
    profit: 0,
    negDays: 0,
    lowDays: 0,
  };
  for (let i = 0; i < depotN; i++) {
    const d = pickDepot(arena, s, c.depots, serial * 16 + i);
    if (d) c.depots.push(d);
  }
  return c.depots.length ? c : null;
}

/** 新しい経済を作る。始めの日の 1 か月前から進めて、始めから縄張りがある状態にする */
export function createEconomy(arena: Arena, seed: number, today: number): EconomyState {
  const s: EconomyState = { v: 1, seed, day: today - MONTH - 1, serial: 0, lastOpen: -1e9, companies: [], history: [], player: { company: null, days: [] } };
  for (const kind of ["large", "large", "mid", "mid", "mid", "solo", "solo", "solo"] as CompanyKind[]) {
    const c = newCompany(arena, s, s.day, kind);
    if (c) s.companies.push(c);
  }
  advance(arena, s, today - 1);
  return s;
}

/** 1 日進める（その日の割り振りを返す） */
export function stepDay(arena: Arena, s: EconomyState, frozen = false): DayAlloc {
  const day = s.day + 1;
  const list = active(s);
  const snaps = list.map(snapOf);
  const a = allocate(arena, snaps, day, s.seed);
  list.forEach((c, k) => {
    const profit = a.revenue[k] - a.cost[k];
    c.cash = Math.round(c.cash + profit);
    c.profit = Math.round(c.profit * 0.7 + profit * 0.3);
    const cap = c.staff * PER_STAFF;
    const util = (a.total[k] + a.lost[k]) / Math.max(1, cap);
    // あふれると遅れが出て信頼が下がる。余裕があれば少しずつ戻る
    c.trust = Math.min(1.5, Math.max(0.5, c.trust + (a.lost[k] > 0 ? -0.03 * Math.min(1, a.lost[k] / Math.max(1, a.total[k])) : 0.004)));
    const share = a.total[k] / Math.max(1, a.demand);
    c.negDays = c.cash < 0 ? c.negDays + 1 : 0;
    c.lowDays = share < LOW_SHARE ? c.lowDays + 1 : 0;
    if (c.negDays >= MONTH || c.lowDays >= MONTH) {
      c.closed = day;
      return;
    }
    if (frozen) return;
    const u = (salt: number) => hashUnit(s.seed ^ 0x9c0, hashString(c.id), day, salt);
    // 配達員: 運びきれない・余裕がない時は増やし、暇なら減らす
    // 配達員: 忙しくて儲かっていれば増やし、暇か赤字なら減らす
    if (util > 0.9 && c.profit > 0 && c.cash > WAGE * 20) c.staff += kindOf(c.staff) === "large" && u(1) < 0.5 ? 2 : 1;
    else if ((util < 0.6 || c.profit < 0) && c.staff > 1 && u(2) < 0.5) c.staff -= 1;
    // 営業所: 資金に余裕があり忙しければ増やす。資金が尽きたら、2 つ以上あれば 1 つ閉じる
    const kind = kindOf(c.staff);
    const depotCash = kind === "large" ? 1_500_000 : kind === "mid" ? 600_000 : 400_000;
    const depotMax = kind === "large" ? 8 : kind === "mid" ? 4 : 2;
    if (c.cash > depotCash && util > 0.8 && c.profit > 0 && c.depots.length < depotMax && u(3) < 0.15) {
      const d = pickDepot(arena, s, c.depots, day);
      if (d) {
        c.depots.push(d);
        c.cash -= 200_000;
      }
    } else if (c.cash < 0 && c.depots.length > 1 && u(4) < 0.2) c.depots.pop();
  });
  // 新しい業者（数が目安より少なく、前の開業から 2 週あいていれば）
  if (!frozen && active(s).length < Math.min(MAX_COMPANIES, TARGET_COMPANIES) && day - s.lastOpen >= 2 * WEEK && hashUnit(s.seed ^ 0x0be, day) < 0.3) {
    const c = newCompany(arena, s, day, "solo");
    if (c) {
      s.companies.push(c);
      s.lastOpen = day;
    }
  }
  s.history.push({ day, snaps });
  while (s.history.length > MONTH) s.history.shift();
  // 廃業して 2 か月たった業者は記録から外す
  s.companies = s.companies.filter((c) => c.closed === null || day - c.closed < 2 * MONTH);
  s.day = day;
  return a;
}

/**
 * until の日まで進める。CATCHUP_FULL より前の分は、営業所・配達員を変えずに進める（資金・信頼・廃業だけ動く）
 */
export function advance(arena: Arena, s: EconomyState, until: number): number {
  let n = 0;
  while (s.day < until) {
    stepDay(arena, s, until - s.day > CATCHUP_FULL);
    n++;
  }
  return n;
}

// ---- プレイヤーの配達 ----

/** プレイヤーが届けた（届け先の丁目・報酬）を記録する */
export function recordPlayer(s: EconomyState, day: number, chome: string, reward: number) {
  let d = s.player.days.find((x) => x.day === day);
  if (!d) {
    d = { day, counts: {}, sales: {} };
    s.player.days.push(d);
    s.player.days.sort((a, b) => a.day - b.day);
    while (s.player.days.length && s.player.days[0].day <= day - MONTH) s.player.days.shift();
  }
  const co = s.player.company ?? "self";
  const key = `${co}|${chome}`;
  d.counts[key] = (d.counts[key] ?? 0) + 1;
  d.sales[co] = (d.sales[co] ?? 0) + reward;
}

// ---- 縄張りと順位 ----

export const SELF = "self";

export interface Entity {
  id: string;
  name: string;
  color: string;
  kind: CompanyKind | "player";
  staff: number;
  /** 直近 1 週・1 か月の売上 (円) */
  salesWeek: number;
  salesMonth: number;
  /** 持っている丁目の数と面積 (m²) */
  chomes: number;
  area: number;
}

export interface Territory {
  /** 窓の終わりの日 */
  day: number;
  /** 丁目ごとの持ち主（entities の番号。−1 は無し） */
  owner: Int16Array;
  entities: Entity[];
}

/**
 * 縄張りと順位を計算する。end の日までの直近 1 か月（end も含む）。allocs は日ごとの割り振り（無い日は history から作る）。
 * プレイヤーの配達は所属の業者（無ければ「あなた（個人）」）に足す
 */
export function territory(arena: Arena, s: EconomyState, end: number, cache: Map<number, DayAlloc>, playerName = "あなた（個人）"): Territory {
  const ents: Entity[] = [];
  const at = new Map<string, number>();
  const add = (id: string, name: string, color: string, kind: Entity["kind"], staff: number) => {
    at.set(id, ents.length);
    ents.push({ id, name, color, kind, staff, salesWeek: 0, salesMonth: 0, chomes: 0, area: 0 });
  };
  for (const c of active(s)) add(c.id, c.name, c.color, kindOf(c.staff), c.staff + (s.player.company === c.id ? 1 : 0));
  add(SELF, playerName, "#ffffff", "player", 0);
  const C = arena.chomes.length;
  const E = ents.length;
  const count = new Float64Array(C * E);
  for (const h of s.history) {
    if (h.day > end || h.day <= end - MONTH) continue;
    let a = cache.get(h.day);
    if (!a) {
      a = allocate(arena, h.snaps, h.day, s.seed);
      cache.set(h.day, a);
    }
    a.ids.forEach((id, k) => {
      const e = at.get(id);
      if (e === undefined) return;
      for (let c = 0; c < C; c++) count[c * E + e] += a.served[c * a.ids.length + k];
      ents[e].salesMonth += a.revenue[k];
      if (h.day > end - WEEK) ents[e].salesWeek += a.revenue[k];
    });
  }
  for (const d of s.player.days) {
    if (d.day > end || d.day <= end - MONTH) continue;
    for (const [key, n] of Object.entries(d.counts)) {
      const bar = key.indexOf("|");
      const e = at.get(key.slice(0, bar));
      const c = arena.index.get(key.slice(bar + 1));
      if (e === undefined || c === undefined) continue;
      count[c * E + e] += n;
    }
    for (const [id, yen] of Object.entries(d.sales)) {
      const e = at.get(id);
      if (e === undefined) continue;
      ents[e].salesMonth += yen;
      if (d.day > end - WEEK) ents[e].salesWeek += yen;
    }
  }
  const owner = new Int16Array(C).fill(-1);
  for (let c = 0; c < C; c++) {
    let best = -1;
    let bv = 0;
    for (let e = 0; e < E; e++) {
      const v = count[c * E + e];
      if (v > bv) {
        bv = v;
        best = e;
      }
    }
    owner[c] = best;
    if (best >= 0) {
      ents[best].chomes++;
      ents[best].area += arena.chomes[c].area;
    }
  }
  for (const e of ents) {
    e.salesWeek = Math.round(e.salesWeek);
    e.salesMonth = Math.round(e.salesMonth);
  }
  return { day: end, owner, entities: ents };
}

// ---- 保存 ----

const num = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) ? v : d);
const str = (v: unknown, d: string) => (typeof v === "string" && v.length < 80 ? v : d);
const strs = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.length < 80).slice(0, 40) : []);
const obj = (v: unknown): Record<string, unknown> => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const pol = (v: unknown): Policy => (v === "cheap" || v === "fast" || v === "wide" ? v : "fast");
const counts = (v: unknown) => {
  const o: Record<string, number> = {};
  for (const [k, x] of Object.entries(obj(v))) if (k.length < 120 && typeof x === "number" && Number.isFinite(x) && x > 0) o[k] = x;
  return o;
};

function sanitizeSnap(v: unknown): Snap | null {
  const o = obj(v);
  if (typeof o.id !== "string") return null;
  return { id: o.id, depots: strs(o.depots), staff: Math.max(0, num(o.staff, 1)), trust: num(o.trust, 1), price: num(o.price, BASE_PRICE), policy: pol(o.policy) };
}

/** 保存データの経済を読む（壊れていれば null） */
export function sanitizeEconomy(v: unknown): EconomyState | null {
  const o = obj(v);
  if (o.v !== 1 || typeof o.day !== "number" || !Array.isArray(o.companies)) return null;
  const companies: Company[] = [];
  for (const x of o.companies.slice(0, 64)) {
    const c = obj(x);
    if (typeof c.id !== "string" || typeof c.name !== "string") continue;
    companies.push({
      id: c.id,
      name: str(c.name, "業者"),
      color: str(c.color, "#888888"),
      policy: pol(c.policy),
      depots: strs(c.depots),
      staff: Math.max(0, Math.round(num(c.staff, 1))),
      cash: Math.round(num(c.cash, 0)),
      trust: Math.min(1.5, Math.max(0.5, num(c.trust, 1))),
      price: num(c.price, BASE_PRICE),
      opened: num(c.opened, o.day),
      closed: typeof c.closed === "number" ? c.closed : null,
      profit: Math.round(num(c.profit, 0)),
      negDays: Math.max(0, Math.round(num(c.negDays, 0))),
      lowDays: Math.max(0, Math.round(num(c.lowDays, 0))),
    });
  }
  const history = (Array.isArray(o.history) ? o.history : [])
    .map((h) => {
      const x = obj(h);
      return typeof x.day === "number" && Array.isArray(x.snaps) ? { day: x.day, snaps: x.snaps.map(sanitizeSnap).filter((y): y is Snap => !!y) } : null;
    })
    .filter((h): h is { day: number; snaps: Snap[] } => !!h)
    .slice(-MONTH);
  const p = obj(o.player);
  const days = (Array.isArray(p.days) ? p.days : [])
    .map((d) => {
      const x = obj(d);
      return typeof x.day === "number" ? { day: x.day, counts: counts(x.counts), sales: counts(x.sales) } : null;
    })
    .filter((d): d is PlayerDay => !!d)
    .slice(-MONTH);
  return {
    v: 1,
    seed: num(o.seed, 1) >>> 0,
    day: o.day,
    serial: Math.max(companies.length, Math.round(num(o.serial, companies.length))),
    lastOpen: num(o.lastOpen, -1e9),
    companies,
    history,
    player: { company: typeof p.company === "string" ? p.company : null, days },
  };
}
