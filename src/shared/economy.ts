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

/** 配達員 1 人が 1 日に運べる件数、日給 (円)、営業所 1 つの 1 日の費用 (円。25.3 の 61 で 6,000 → 4,000)、営業所からの 1km あたりの費用 (円)、標準の値段 (円)【初期値】 */
const PER_STAFF = 22;
const WAGE = 7000;
const DEPOT_COST = 4000;
const DIST_COST = 30;
export const BASE_PRICE = 520;
/** 業者の数の目安と上限（6.7）、廃業の基準（17.1）【初期値】 */
const TARGET_COMPANIES = 8;
const MAX_COMPANIES = 12;
const LOW_SHARE = 0.005;

/**
 * 釣り合いの数値（草案 24・25 章で見直す物）。既定は D3〜D5 の値。試算（scripts/balance-sim.mjs）はここを書き換えて比べる。
 * staffRoot: 配達員の数の効き（4 = 4 乗根、2 = 平方根）。npcStaffMax: NPC 業者 1 社の配達員の上限。
 * npcDepotGap: NPC が営業所を開く時に、ほかの業者の営業所から離す距離 (m)。playerDepotGap: プレイヤーの業者の営業所からは、この距離 (m)。
 * shrinkUtil: NPC が配達員を減らし始める、運べる件数に対する使った割合。closeDays: 資金のマイナス・シェアの低さが続くと廃業する日数
 * playerDepotMax: プレイヤーの業者の営業所の上限（個人・中堅・大手。25.3 の 62 で 2・4・8 → 4・6・8）
 */
export const BALANCE = { depotCost: DEPOT_COST, staffRoot: 4, npcStaffMax: Infinity, npcDepotGap: 300, playerDepotGap: 300, shrinkUtil: 0.6, closeDays: MONTH, playerDepotMax: [4, 6, 8] };

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
  /** プレイヤーが経営する業者（D4。配達の草案 21 章）。NPC の業者では無い */
  player?: boolean;
  crew?: Crew[];
  fleet?: Fleet;
  /** 日ごとの収支（直近 14 日） */
  ledger?: Ledger[];
  /** 経営者が最後に来た日 */
  seen?: number;
  /** 次の配達員の番号 */
  nextNo?: number;
  /** 今日・昨日に雇った・辞めてもらった応募の id（同じ人を応募に出し直さない） */
  taken?: string[];
  /** 廃業の理由 */
  reason?: string;
  /** 長距離の便の契約（D5。配達の草案 22 章。計算は freight.ts） */
  contracts?: Contract[];
  /** 便の日ごとの結果（締める前の分。締めると収支へ移す） */
  freight?: FreightDay[];
  /** 便を最後に進めた時刻（Unix ミリ秒） */
  freightAt?: number;
}

/** 長距離の便の契約（22 章） */
export interface Contract {
  /** 申し込みの id（k<日>-<番号>） */
  id: string;
  shipper: string;
  cargo: string;
  /** 行き先の市町と、その中心の位置 */
  town: string;
  x: number;
  z: number;
  /** 出る営業所の丁目 */
  from: string;
  /** 片道の道のり (km) と時間（分。晴れ） */
  km: number;
  min: number;
  /** 世界の 1 日の便数と 1 便の運賃 (円)、1 便の荷の量（トン。22.6 の 51） */
  loads: number;
  rate: number;
  tons: number;
  /** 最初の荷が出る時刻（Unix ミリ秒）と、契約の荷の数（更新で増える） */
  t0: number;
  total: number;
  /** 次に積む荷の番号 */
  next: number;
  /** 付けたトラック（1 台に運転手 1 人） */
  runs: Run[];
  /** 走っている便（着いたら運賃が入る） */
  pending: Trip[];
  /** この契約の通算 */
  sum: { trips: number; late: number; dropped: number; sales: number };
}

/** トラック 1 台（車の段）の今の便: 出た時刻・着く時刻・営業所へ戻る時刻（Unix ミリ秒） */
export interface Run {
  v: TruckKind;
  out: number;
  arr: number;
  free: number;
}

export interface Trip {
  load: number;
  arrive: number;
  due: number;
  pay: number;
  late: boolean;
  accident: boolean;
}

/** 便の 1 日の結果 */
export interface FreightDay {
  day: number;
  sales: number;
  fuel: number;
  /** 落とした荷の違約金 */
  fee: number;
  trips: number;
  late: number;
  dropped: number;
}

/** 配達員（プレイヤーの業者。21.2） */
export interface Crew {
  id: string;
  no: number;
  /** 速さ（0.8〜1.25 倍） */
  speed: number;
  /** 日給 (円) */
  wage: number;
  /** 勤め始めた日 */
  since: number;
  /** リアキャリアを渡した（自転車の配達員だけ件数が増える。22.6 の 49） */
  carrier?: boolean;
}

/** 町: 電動自転車・バイク・軽自動車・軽バン。長距離の便: truck（2 トン）・3 トン・10 トン（22.6 の 50） */
export type Vehicle = "ebike" | "moto" | "kei" | "van" | "truck" | "t3" | "t10";
export type TruckKind = "truck" | "t3" | "t10";
export type Fleet = Partial<Record<Vehicle, number>>;

/** 日ごとの収支 */
export interface Ledger {
  day: number;
  /** 配達員が運んだ売上と件数、あふれた件数 */
  sales: number;
  served: number;
  lost: number;
  /** 自分で届けた売上と件数 */
  own: number;
  ownCount: number;
  wages: number;
  depots: number;
  vehicles: number;
  dist: number;
  /** 長距離の便: 運賃、燃料、違約金、着いた便・遅れ・落とした荷の数（D5） */
  fsales: number;
  fuel: number;
  fee: number;
  trips: number;
  late: number;
  dropped: number;
  /** 締めた後の資金 */
  cash: number;
}

/** 1 日の割り振りに使う、業者のその日の形 */
export interface Snap {
  id: string;
  depots: string[];
  staff: number;
  trust: number;
  price: number;
  policy: Policy;
  /** プレイヤーの業者だけ: 1 日に運べる件数、届く距離の倍率、給料と乗り物の 1 日の費用 (円) */
  cap?: number;
  reach?: number;
  daily?: number;
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
      const r = dist / (reachOf(s.policy) * (s.reach ?? 1));
      const pr = BASE_PRICE / s.price;
      // 配達員の数は 4 乗根で効かせる（大きいほど小回りが利かない。6.7）
      // 近さは距離の 4 乗で落とす（営業所の周りが地元になる）
      const r2 = r * r;
      const a = s.trust * (1 / (1 + r2 * r2)) * (BALANCE.staffRoot === 2 ? Math.sqrt(s.staff) : Math.sqrt(Math.sqrt(s.staff))) * pr * pr;
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
    const cap = snaps[k].cap ?? snaps[k].staff * PER_STAFF;
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
    cost[k] = (snaps[k].daily ?? snaps[k].staff * WAGE) + snaps[k].depots.length * BALANCE.depotCost + far * DIST_COST;
  }
  return { day, ids: snaps.map((s) => s.id), served, revenue, cost, total, lost, demand };
}

// ---- 1 日進める ----

function snapOf(c: Company, day: number): Snap {
  const s: Snap = { id: c.id, depots: [...c.depots], staff: c.staff, trust: c.trust, price: c.price, policy: c.policy };
  if (!c.player) return s;
  const p = crewPlan(c, day);
  return { ...s, staff: c.crew?.length ?? 0, cap: Math.round(p.cap * 100) / 100, reach: Math.round(p.reach * 1000) / 1000, daily: p.wages + p.vehicles };
}
const active = (s: EconomyState) => s.companies.filter((c) => c.closed === null);

/** 営業所を置く丁目を選ぶ: 注文が多く、自分の営業所から 800m 以上、ほかの業者の営業所から BALANCE.npcDepotGap（プレイヤーの業者からは playerDepotGap）以上離れた所 */
function pickDepot(arena: Arena, s: EconomyState, own: string[], salt: number): string | null {
  const taken = new Set(active(s).flatMap((c) => c.depots));
  const at = (n: string) => arena.chomes[arena.index.get(n) ?? -1];
  const pts = own.map(at).filter(Boolean);
  const mine = new Set(active(s).filter((c) => c.player).flatMap((c) => c.depots));
  const gapOf = (n: string) => (mine.has(n) ? BALANCE.playerDepotGap : BALANCE.npcDepotGap);
  const others = [...taken].filter((n) => !own.includes(n)).map((n) => ({ p: at(n), g: gapOf(n) })).filter((o) => o.p);
  let best: string | null = null;
  let bs = -Infinity;
  arena.chomes.forEach((ch, i) => {
    if (taken.has(ch.name)) return;
    let near = Infinity;
    for (const p of pts) near = Math.min(near, (p.x - ch.x) * (p.x - ch.x) + (p.z - ch.z) * (p.z - ch.z));
    // 自分の営業所から 800m 以上離す。最初の 1 つはどこでもよい
    if (pts.length && near < 800 * 800) return;
    for (const { p: o, g } of others) if ((o.x - ch.x) * (o.x - ch.x) + (o.z - ch.z) * (o.z - ch.z) < g * g) return;
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
  const snaps = list.map((c) => snapOf(c, day));
  const a = allocate(arena, snaps, day, s.seed);
  const pd = s.player.days.find((x) => x.day === day);
  list.forEach((c, k) => {
    const profit = a.revenue[k] - a.cost[k];
    c.cash = Math.round(c.cash + profit);
    c.profit = Math.round(c.profit * 0.7 + profit * 0.3);
    const cap = snaps[k].cap ?? c.staff * PER_STAFF;
    const util = (a.total[k] + a.lost[k]) / Math.max(1, cap);
    // あふれると遅れが出て信頼が下がる。余裕があれば少しずつ戻る
    if (a.total[k] + a.lost[k] > 0) c.trust = Math.min(1.5, Math.max(0.5, c.trust + (a.lost[k] > 0 ? -0.03 * Math.min(1, a.lost[k] / Math.max(1, a.total[k])) : 0.004)));
    // プレイヤーが自分で届けた分もシェアに入れる
    let ownCount = 0;
    if (pd) for (const [key, n] of Object.entries(pd.counts)) if (key.startsWith(`${c.id}|`)) ownCount += n;
    const share = (a.total[k] + ownCount) / Math.max(1, a.demand);
    c.negDays = c.cash < 0 ? c.negDays + 1 : 0;
    c.lowDays = share < LOW_SHARE ? c.lowDays + 1 : 0;
    if (c.player) {
      const p = crewPlan(c, day);
      const f = c.freight?.find((x) => x.day === day);
      c.freight = (c.freight ?? []).filter((x) => x.day > day);
      c.ledger = [
        ...(c.ledger ?? []),
        {
          day,
          sales: Math.round(a.revenue[k]),
          served: Math.round(a.total[k]),
          lost: Math.round(a.lost[k]),
          own: Math.round(pd?.sales[c.id] ?? 0),
          ownCount,
          wages: p.wages,
          depots: c.depots.length * BALANCE.depotCost,
          vehicles: p.vehicles,
          dist: Math.round(a.cost[k] - p.wages - p.vehicles - c.depots.length * BALANCE.depotCost),
          fsales: Math.round(f?.sales ?? 0),
          fuel: Math.round(f?.fuel ?? 0),
          fee: Math.round(f?.fee ?? 0),
          trips: f?.trips ?? 0,
          late: f?.late ?? 0,
          dropped: f?.dropped ?? 0,
          cash: c.cash,
        },
      ].slice(-LEDGER_DAYS);
      c.taken = (c.taken ?? []).filter((id) => applicantDay(id) >= day);
      // 経営者が来ない（17.5・21.1 の 39）: 1 か月で配達員が減り始め、2 か月で廃業
      const away = day - (c.seen ?? day);
      if (away > MONTH && c.crew?.length) {
        c.crew.pop();
        c.staff = c.crew.length;
      }
      if (away > 2 * MONTH) c.reason = "経営者が 2 か月来なかった";
    }
    if (c.negDays >= BALANCE.closeDays) c.reason = `資金がマイナスのまま ${BALANCE.closeDays === MONTH ? "1 か月" : `${BALANCE.closeDays} 日`}`;
    else if (c.lowDays >= BALANCE.closeDays) c.reason = `シェア 0.5% 未満のまま ${BALANCE.closeDays === MONTH ? "1 か月" : `${BALANCE.closeDays} 日`}`;
    if (c.reason) {
      c.closed = day;
      return;
    }
    if (frozen || c.player) return;
    const u = (salt: number) => hashUnit(s.seed ^ 0x9c0, hashString(c.id), day, salt);
    // 配達員: 運びきれない・余裕がない時は増やし、暇なら減らす
    // 配達員: 忙しくて儲かっていれば増やし、暇か赤字なら減らす
    if (util > 0.9 && c.profit > 0 && c.cash > WAGE * 20 && c.staff < BALANCE.npcStaffMax) c.staff += kindOf(c.staff) === "large" && u(1) < 0.5 ? 2 : 1;
    else if ((util < BALANCE.shrinkUtil || c.profit < 0 || c.staff > BALANCE.npcStaffMax) && c.staff > 1 && u(2) < 0.5) c.staff -= 1;
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
export function advance(arena: Arena, s: EconomyState, until: number, before?: (day: number) => void): number {
  let n = 0;
  while (s.day < until) {
    before?.(s.day + 1);
    stepDay(arena, s, until - s.day > CATCHUP_FULL);
    n++;
  }
  return n;
}

// ---- プレイヤーの配達 ----

/** プレイヤーが届けた（届け先の丁目・報酬）を記録する。所属・経営の業者があれば、期限内なら信頼が少し上がり、遅れると下がる（21.2） */
export function recordPlayer(s: EconomyState, day: number, chome: string, reward: number, late = false) {
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
  const c = s.companies.find((x) => x.id === s.player.company && x.closed === null);
  if (c) c.trust = Math.min(1.5, Math.max(0.5, c.trust + (late ? -0.01 : 0.002)));
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
  // 経営している間は「あなた（個人）」を並べない
  if (!ownCompany(s)) add(SELF, playerName, "#ffffff", "player", 0);
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

// ---- プレイヤーの業者（D4。配達の草案 21 章） ----

/** 開業の条件（21.1 の 31）、営業所を開く費用、収支を残す日数、値段の幅【初期値】 */
export const OPEN_MONEY = 30_000;
export const OPEN_DELIVERED = 30;
export const DEPOT_OPEN = 20_000;
const LEDGER_DAYS = 14;
export const PRICE_MIN = 420;
export const PRICE_MAX = 680;
export const PRICE_STEP = 20;
const APPLICANTS = 3;
const MAX_CREW = 60;

/**
 * 乗り物（21.2・22.6）。own は配達員の自前の自転車。cap・reach は町の配達（1 人 1 日の件数・届く距離）。
 * トラックは長距離の便だけ: tons は積める量（トン）、fuel は 1 km の燃料 (円)
 */
export const VEHICLES: Record<Vehicle | "own", { label: string; price: number; daily: number; cap: number; reach: number; tons?: number; fuel?: number }> = {
  own: { label: "自前の自転車", price: 0, daily: 0, cap: PER_STAFF, reach: 1 },
  ebike: { label: "電動自転車", price: 80_000, daily: 300, cap: 28, reach: 1.15 },
  moto: { label: "バイク", price: 200_000, daily: 900, cap: 34, reach: 1.4 },
  kei: { label: "軽自動車", price: 600_000, daily: 1_500, cap: 32, reach: 1.3 },
  van: { label: "軽バン", price: 900_000, daily: 2_500, cap: 40, reach: 1.3 },
  truck: { label: "2 トン", price: 1_000_000, daily: 2_500, cap: 0, reach: 1, tons: 2, fuel: 40 },
  t3: { label: "3 トン", price: 1_600_000, daily: 3_500, cap: 0, reach: 1, tons: 3, fuel: 50 },
  t10: { label: "10 トン", price: 5_000_000, daily: 9_000, cap: 0, reach: 1, tons: 10, fuel: 80 },
};
/** 町の配達で割り当てる順（運べる件数の多い順） */
export const VEHICLE_KINDS: Vehicle[] = ["van", "moto", "kei", "ebike"];
/** 長距離の便のトラック（積める量の少ない順） */
export const TRUCK_KINDS: TruckKind[] = ["truck", "t3", "t10"];
/** トラックも含めた全部（費用・売る・保存） */
export const ALL_VEHICLES: Vehicle[] = [...VEHICLE_KINDS, ...TRUCK_KINDS];
/** リアキャリア（配達員に渡す。自前の自転車・電動自転車の件数が 1.15 倍）【初期値】 */
export const CARRIER_PRICE = 15_000;
export const CARRIER_FACTOR = 1.15;

export const ownCompany = (s: EconomyState): Company | null => s.companies.find((c) => c.player && c.closed === null && c.id === s.player.company) ?? null;
/** プレイヤーの業者の営業所の上限（BALANCE.playerDepotMax: 個人・中堅・大手） */
export const depotMax = (staff: number) => BALANCE.playerDepotMax[kindOf(staff) === "large" ? 2 : kindOf(staff) === "mid" ? 1 : 0];
/** 土地勘（勤めた日数で 28 日までに +20%） */
export const skillOf = (c: Crew, day: number) => Math.min(0.2, (Math.max(0, day - c.since) * 0.2) / MONTH);

export interface CrewSlot {
  crew: Crew;
  vehicle: Vehicle | "own";
  skill: number;
  /** 1 日に運べる件数 */
  cap: number;
}

/** 便に付けたトラックの数（= 運転手の数） */
export const runsOf = (c: Company) => (c.contracts ?? []).reduce((a, k) => a + k.runs.length, 0);

/**
 * 乗り物を速い配達員から割り当て、運べる件数・届く距離・1 日の費用を出す。
 * 便のトラックの運転手は、遅い配達員から回す（町の配達から外れる。22.1 の 43）
 */
export function crewPlan(c: Company, day: number): { slots: CrewSlot[]; drivers: Crew[]; cap: number; reach: number; wages: number; vehicles: number } {
  const all = [...(c.crew ?? [])].sort((a, b) => b.speed - a.speed || a.no - b.no);
  const nd = Math.min(all.length, runsOf(c));
  const crew = all.slice(0, all.length - nd);
  const drivers = all.slice(all.length - nd);
  const left: Record<Vehicle, number> = { ebike: c.fleet?.ebike ?? 0, moto: c.fleet?.moto ?? 0, kei: c.fleet?.kei ?? 0, van: c.fleet?.van ?? 0, truck: 0, t3: 0, t10: 0 };
  const slots: CrewSlot[] = crew.map((m) => {
    const v = VEHICLE_KINDS.find((k) => left[k] > 0) ?? "own";
    if (v !== "own") left[v]--;
    const skill = skillOf(m, day);
    const bag = m.carrier && (v === "own" || v === "ebike") ? CARRIER_FACTOR : 1;
    return { crew: m, vehicle: v, skill, cap: VEHICLES[v].cap * bag * m.speed * (1 + skill) };
  });
  let cap = 0;
  let reach = 0;
  for (const sl of slots) {
    cap += sl.cap;
    reach += sl.cap * VEHICLES[sl.vehicle].reach;
  }
  let vehicles = 0;
  for (const k of ALL_VEHICLES) vehicles += (c.fleet?.[k] ?? 0) * VEHICLES[k].daily;
  return { slots, drivers, cap, reach: cap > 0 ? reach / cap : 1, wages: all.reduce((a, m) => a + m.wage, 0), vehicles };
}

/** 応募の id（a<日>-<番号>）の日 */
function applicantDay(id: string): number {
  const bar = id.indexOf("-", 2);
  const d = Number(id.slice(1, bar));
  return id[0] === "a" && bar > 1 && Number.isFinite(d) ? d : -Infinity;
}

/** その日の応募（世界の 1 日に 3 人。速さと日給が違う。雇った・辞めてもらった人は出さない） */
export function applicants(s: EconomyState, c: Company, day: number): Crew[] {
  const out: Crew[] = [];
  const taken = new Set([...(c.taken ?? []), ...(c.crew ?? []).map((m) => m.id)]);
  for (let i = 0; i < APPLICANTS; i++) {
    const id = `a${day}-${i}`;
    if (taken.has(id)) continue;
    const u = (k: number) => hashUnit(s.seed ^ 0x5a1, day, i, k);
    const speed = Math.round((0.8 + 0.45 * u(1)) * 100) / 100;
    const wage = Math.round((6000 + (3000 * (speed - 0.8)) / 0.45 + 500 * u(2)) / 100) * 100;
    out.push({ id, no: 0, speed, wage, since: day });
  }
  return out;
}

/** 開業できるか（できなければ理由） */
export function openCheck(arena: Arena, s: EconomyState, chome: string | null, money: number, delivered: number): string | null {
  if (ownCompany(s)) return "経営中";
  if (money < OPEN_MONEY) return `所持金が ${OPEN_MONEY.toLocaleString("ja-JP")} 円に届いていない`;
  if (delivered < OPEN_DELIVERED) return `届けた数が ${OPEN_DELIVERED} 件に届いていない`;
  if (active(s).length >= MAX_COMPANIES) return `業者の数が上限（${MAX_COMPANIES} 社）`;
  return depotCheck(arena, s, chome, null);
}

/** 営業所を開けるか（できなければ理由） */
export function depotCheck(arena: Arena, s: EconomyState, chome: string | null, c: Company | null): string | null {
  if (!chome || !arena.index.has(chome)) return "配達の範囲の外";
  for (const o of active(s)) if (o.depots.includes(chome)) return o === c ? "この丁目には営業所がある" : `${o.name}の営業所がある丁目`;
  if (c) {
    if (c.depots.length >= depotMax(c.staff)) return `営業所の数が上限（配達員 ${c.staff} 人で ${depotMax(c.staff)} か所）`;
    if (c.cash < DEPOT_OPEN) return "資金が足りない";
  }
  return null;
}

/** 名前の候補（使われていない造語から 3 つ） */
export function nameChoices(s: EconomyState, day: number): string[] {
  const used = new Set(active(s).map((c) => c.name));
  const free = NAMES.filter((n) => !used.has(n));
  const start = free.length ? hash(s.seed ^ 0x6e3, day) % free.length : 0;
  const out: string[] = [];
  for (let i = 0; i < free.length && out.length < 3; i++) out.push(free[(start + i) % free.length]);
  return out;
}

/** 開業する: 今いる丁目に営業所を開き、所持金を業者の資金にする（21.1 の 32・33）。開業の時の営業所は費用を取らない（25.3 の 63） */
export function openCompany(arena: Arena, s: EconomyState, day: number, chome: string, name: string, money: number): Company | null {
  if (depotCheck(arena, s, chome, null) || !nameChoices(s, day).includes(name)) return null;
  const usedColors = new Set(active(s).map((c) => c.color));
  const color = COLORS.find((x) => !usedColors.has(x));
  if (!color) return null;
  const c: Company = {
    id: `c${s.serial++}`,
    name,
    color,
    policy: "fast",
    depots: [chome],
    staff: 0,
    cash: Math.round(money),
    trust: 1,
    price: BASE_PRICE,
    opened: day,
    closed: null,
    profit: 0,
    negDays: 0,
    lowDays: 0,
    player: true,
    crew: [],
    fleet: {},
    ledger: [],
    seen: day,
    nextNo: 1,
    taken: [],
  };
  s.companies.push(c);
  s.player.company = c.id;
  return c;
}

export function hire(s: EconomyState, c: Company, day: number, id: string): boolean {
  const a = applicants(s, c, day).find((x) => x.id === id);
  if (!a || c.cash < 0 || (c.crew?.length ?? 0) >= MAX_CREW) return false;
  const no = c.nextNo ?? 1;
  c.nextNo = no + 1;
  c.crew = [...(c.crew ?? []), { ...a, no }];
  c.staff = c.crew.length;
  return true;
}

/** 配達員に辞めてもらう */
export function dismiss(c: Company, id: string): boolean {
  const m = c.crew?.find((x) => x.id === id);
  if (!m || !c.crew) return false;
  c.crew = c.crew.filter((x) => x !== m);
  c.staff = c.crew.length;
  c.taken = [...(c.taken ?? []), id];
  return true;
}

/** 乗り物を買えるか（できなければ理由）。10 トンは大手から（22.6 の 52） */
export function vehicleCheck(c: Company, v: Vehicle): string | null {
  if (v === "t10" && kindOf(c.staff) !== "large") return `10 トンは大手（配達員 25 人）から。今 ${c.staff} 人`;
  if (c.cash < VEHICLES[v].price) return "資金が足りない";
  return null;
}

/** 配達員にリアキャリアを渡す */
export function giveCarrier(c: Company, id: string): boolean {
  const m = c.crew?.find((x) => x.id === id);
  if (!m || m.carrier || c.cash < CARRIER_PRICE) return false;
  c.cash -= CARRIER_PRICE;
  m.carrier = true;
  return true;
}

export function buyVehicle(c: Company, v: Vehicle): boolean {
  if (vehicleCheck(c, v)) return false;
  c.cash -= VEHICLES[v].price;
  c.fleet = { ...c.fleet, [v]: (c.fleet?.[v] ?? 0) + 1 };
  return true;
}

/** 便に付けているその段のトラックの数 */
export const runsOfKind = (c: Company, v: Vehicle) => (c.contracts ?? []).reduce((a, k) => a + k.runs.filter((r) => r.v === v).length, 0);

/** 乗り物を売る（半値）。便に付けているトラックは売らない */
export function sellVehicle(c: Company, v: Vehicle): boolean {
  if (!(c.fleet?.[v] ?? 0) || (c.fleet?.[v] ?? 0) <= runsOfKind(c, v)) return false;
  c.cash += VEHICLES[v].price / 2;
  c.fleet = { ...c.fleet, [v]: (c.fleet?.[v] ?? 0) - 1 };
  return true;
}

export function openDepot(arena: Arena, s: EconomyState, c: Company, chome: string): boolean {
  if (depotCheck(arena, s, chome, c)) return false;
  c.cash -= DEPOT_OPEN;
  c.depots = [...c.depots, chome];
  return true;
}

/** 営業所を閉じる（最後の 1 つは閉じない） */
export function closeDepot(c: Company, chome: string): boolean {
  if (c.depots.length <= 1 || !c.depots.includes(chome)) return false;
  c.depots = c.depots.filter((d) => d !== chome);
  return true;
}

export function setPrice(c: Company, price: number) {
  c.price = Math.min(PRICE_MAX, Math.max(PRICE_MIN, Math.round(price / PRICE_STEP) * PRICE_STEP));
}

/** 畳む・廃業の後の所持金: 乗り物を半値で売り、資金がプラスならそれ、マイナスなら 0 円（21.1 の 37） */
export function windUp(s: EconomyState, c: Company, day: number, reason = "畳んだ"): number {
  c.contracts = [];
  for (const v of ALL_VEHICLES) while (sellVehicle(c, v));
  if (c.closed === null) {
    c.closed = day;
    c.reason = reason;
  }
  c.crew = [];
  c.staff = 0;
  if (s.player.company === c.id) s.player.company = null;
  return Math.max(0, Math.round(c.cash));
}

/** 今日の見込み: 今の形で今日 1 日分を割り振った時の、業者の運ぶ件数・あふれ・売上・費用。alt を渡すと、c をその形に置き換えて見積もる */
export function estimate(arena: Arena, s: EconomyState, c: Company, day: number, alt?: Company): { served: number; lost: number; revenue: number; cost: number; demand: number } {
  const list = active(s);
  const k = list.indexOf(c);
  const a = allocate(
    arena,
    list.map((x) => snapOf(x === c && alt ? alt : x, day)),
    day,
    s.seed,
  );
  return { served: a.total[k] ?? 0, lost: a.lost[k] ?? 0, revenue: a.revenue[k] ?? 0, cost: a.cost[k] ?? 0, demand: a.demand };
}

/** 応募の人を雇った時の、今日の見込みの差（運ぶ件数・売上・費用。25.3 の 66） */
export function hireDelta(arena: Arena, s: EconomyState, c: Company, day: number, a: Crew): { served: number; revenue: number; cost: number } {
  const now = estimate(arena, s, c, day);
  const crew = [...(c.crew ?? []), { ...a, no: c.nextNo ?? 1 }];
  const next = estimate(arena, s, c, day, { ...c, crew, staff: crew.length });
  return { served: next.served - now.served, revenue: next.revenue - now.revenue, cost: next.cost - now.cost };
}

/** 丁目の 1 日の注文の量（平日の基本）と、いちばん近いほかの業者の営業所 */
export function chomeInfo(arena: Arena, s: EconomyState, chome: string, self: Company | null): { base: number; nearest: { name: string; m: number } | null } | null {
  const i = arena.index.get(chome);
  if (i === undefined) return null;
  const ch = arena.chomes[i];
  let nearest: { name: string; m: number } | null = null;
  for (const c of active(s)) {
    if (c === self) continue;
    for (const d of c.depots) {
      const p = arena.chomes[arena.index.get(d) ?? -1];
      if (!p) continue;
      const m = Math.sqrt((p.x - ch.x) * (p.x - ch.x) + (p.z - ch.z) * (p.z - ch.z));
      if (!nearest || m < nearest.m) nearest = { name: c.name, m };
    }
  }
  return { base: ch.base, nearest };
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
  const s: Snap = { id: o.id, depots: strs(o.depots), staff: Math.max(0, num(o.staff, 1)), trust: num(o.trust, 1), price: num(o.price, BASE_PRICE), policy: pol(o.policy) };
  if (typeof o.cap === "number") s.cap = Math.max(0, num(o.cap, 0));
  if (typeof o.reach === "number") s.reach = Math.min(2, Math.max(0.5, num(o.reach, 1)));
  if (typeof o.daily === "number") s.daily = Math.max(0, num(o.daily, 0));
  return s;
}

function sanitizeCrew(v: unknown): Crew[] {
  return (Array.isArray(v) ? v : [])
    .slice(0, 80)
    .map((x) => {
      const o = obj(x);
      if (typeof o.id !== "string" || o.id.length >= 40) return null;
      const m: Crew = { id: o.id, no: Math.round(num(o.no, 0)), speed: Math.min(1.5, Math.max(0.5, num(o.speed, 1))), wage: Math.max(0, Math.round(num(o.wage, WAGE))), since: num(o.since, 0) };
      if (o.carrier === true) m.carrier = true;
      return m;
    })
    .filter((x): x is Crew => !!x);
}

function sanitizeLedger(v: unknown): Ledger[] {
  const keys = ["sales", "served", "lost", "own", "ownCount", "wages", "depots", "vehicles", "dist", "fsales", "fuel", "fee", "trips", "late", "dropped", "cash"] as const;
  return (Array.isArray(v) ? v : [])
    .slice(-LEDGER_DAYS)
    .map((x) => {
      const o = obj(x);
      if (typeof o.day !== "number") return null;
      const l = { day: o.day } as Ledger;
      for (const k of keys) l[k] = Math.round(num(o[k], 0));
      return l;
    })
    .filter((x): x is Ledger => !!x);
}

function sanitizeContracts(v: unknown): Contract[] {
  const out: Contract[] = [];
  for (const x of (Array.isArray(v) ? v : []).slice(0, 8)) {
    const o = obj(x);
    if (typeof o.id !== "string" || typeof o.town !== "string") continue;
    const sum = obj(o.sum);
    out.push({
      id: str(o.id, ""),
      shipper: str(o.shipper, "荷主"),
      cargo: str(o.cargo, "荷"),
      town: str(o.town, ""),
      x: num(o.x, 0),
      z: num(o.z, 0),
      from: str(o.from, ""),
      km: Math.max(0, num(o.km, 0)),
      min: Math.max(1, num(o.min, 60)),
      loads: Math.min(3, Math.max(1, Math.round(num(o.loads, 1)))),
      rate: Math.max(0, Math.round(num(o.rate, 0))),
      tons: Math.min(10, Math.max(0.1, num(o.tons, 2))),
      t0: num(o.t0, 0),
      total: Math.max(0, Math.round(num(o.total, 0))),
      next: Math.max(0, Math.round(num(o.next, 0))),
      runs: (Array.isArray(o.runs) ? o.runs : []).slice(0, 12).map((r) => {
        const y = obj(r);
        const v: TruckKind = y.v === "t3" || y.v === "t10" ? y.v : "truck";
        return { v, out: num(y.out, 0), arr: num(y.arr, 0), free: num(y.free, 0) };
      }),
      pending: (Array.isArray(o.pending) ? o.pending : []).slice(0, 40).map((t) => {
        const y = obj(t);
        return { load: Math.round(num(y.load, 0)), arrive: num(y.arrive, 0), due: num(y.due, 0), pay: Math.round(num(y.pay, 0)), late: y.late === true, accident: y.accident === true };
      }),
      sum: { trips: Math.round(num(sum.trips, 0)), late: Math.round(num(sum.late, 0)), dropped: Math.round(num(sum.dropped, 0)), sales: Math.round(num(sum.sales, 0)) },
    });
  }
  return out;
}

function sanitizeFreight(v: unknown): FreightDay[] {
  return (Array.isArray(v) ? v : [])
    .slice(-MONTH)
    .map((x) => {
      const o = obj(x);
      return typeof o.day === "number" ? { day: o.day, sales: Math.round(num(o.sales, 0)), fuel: Math.round(num(o.fuel, 0)), fee: Math.round(num(o.fee, 0)), trips: Math.round(num(o.trips, 0)), late: Math.round(num(o.late, 0)), dropped: Math.round(num(o.dropped, 0)) } : null;
    })
    .filter((x): x is FreightDay => !!x);
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
    const co = companies[companies.length - 1];
    if (typeof c.reason === "string") co.reason = str(c.reason, "");
    if (c.player === true) {
      co.player = true;
      co.crew = sanitizeCrew(c.crew);
      co.staff = co.crew.length;
      const f = obj(c.fleet);
      co.fleet = {};
      for (const k of ALL_VEHICLES) if (typeof f[k] === "number") co.fleet[k] = Math.max(0, Math.min(200, Math.round(num(f[k], 0))));
      co.ledger = sanitizeLedger(c.ledger);
      co.seen = num(c.seen, o.day);
      co.nextNo = Math.max(1, Math.round(num(c.nextNo, co.crew.length + 1)));
      co.taken = strs(c.taken);
      if (Array.isArray(c.contracts)) co.contracts = sanitizeContracts(c.contracts);
      if (Array.isArray(c.freight)) co.freight = sanitizeFreight(c.freight);
      if (typeof c.freightAt === "number") co.freightAt = num(c.freightAt, 0);
    }
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
