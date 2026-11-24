// 長距離の便と放置（配達の草案 5.4・6.6・6.7・22 章、D5）。DOM・Three.js に依存しない（D6 でサーバーへ移す）。
// 荷主と契約し、トラックを付けると、荷が出るたびに空いたトラックが積んで行き先の市町へ走る。走る時間は現実の時間（22.1 の 40）。
// 便の結果は荷の番号と契約から決まるハッシュと、行き先の天候で決まり、閉じていた間もまとめて同じ結果になる。
// 分岐に関わる計算は加減乗除と floor・min・max だけ（モック 4.2）。

import { type Company, type Contract, type EconomyState, type FreightDay, kindOf, MONTH, ownCompany, runsOf, runsOfKind, TRUCK_KINDS, type TruckKind, VEHICLES, WEEK } from "./economy.ts";
import { hash, hashString, hashUnit } from "./world/hash.ts";
import { DAY_MS, weatherAt, worldDay } from "./world/weather.ts";

/** 積み・降ろし (ms)、期限の余裕（片道の 1.5 倍 + 60 分）、遅れた時の運賃の割合【初期値】 */
const LOAD_MS = 20 * 60_000;
const DUE_FACTOR = 1.5;
const DUE_EXTRA_MS = 60 * 60_000;
const LATE_PAY = 0.7;
/** 落とした荷の違約金（運賃に対する割合） */
const DROP_FEE = 0.5;
/** 運賃 (円/分。1 往復の分数に掛ける。2 トン分の荷の時） */
const RATE_PER_MIN = 220;
/** 荷の量（トン）の候補。運賃は 2 トンを 1 倍として 0.5 + 0.25 × 量 倍（22.6 の 51）【初期値】 */
const TONS = [0.5, 1, 1.5, 2, 2, 3, 3, 5, 8];
export const tonsFactor = (tons: number) => 0.5 + 0.25 * tons;
/** 霧の時の遅さ、事故の割合と遅れ (分) */
const FOG_SLOW = 1.25;
const ACCIDENT = 0.03;
/** 信頼: 期限内 +、遅れ −、落とした荷 − */
const TRUST_ON_TIME = 0.001;
const TRUST_LATE = -0.005;
const TRUST_DROP = -0.01;
/** 世界の 1 日の申し込みの数 */
const OFFERS = 3;
/** 留守とみなす間（これより長く進めなかった分を「留守の間の便」にまとめる） */
export const AWAY_MS = 10 * 60_000;

/** 荷主（架空）と荷 */
const SHIPPERS: [string, string][] = [
  ["あかしあ製菓", "菓子"],
  ["ポプラ乳業", "乳製品"],
  ["つばめ精機", "機械の部品"],
  ["雪原ファーム", "野菜"],
  ["みずなら木材", "建材"],
  ["くるみ書房", "本・雑誌"],
  ["北斗冷凍食品", "冷凍食品"],
  ["はるにれ薬品", "医薬品"],
  ["ひばり印刷", "印刷物"],
  ["こまどり衣料", "衣料"],
  ["いしかり水産加工", "水産加工品"],
  ["やまぶどう酒造", "酒"],
];

/** 行き先の候補（市町の中心と、本店からの道のり・時間。game が Worker の経路から作る） */
export interface FreightDest {
  town: string;
  x: number;
  z: number;
  km: number;
  min: number;
}

export interface FreightOffer {
  id: string;
  shipper: string;
  cargo: string;
  town: string;
  x: number;
  z: number;
  km: number;
  min: number;
  loads: number;
  rate: number;
  tons: number;
}

/** 契約の数の上限（6.7・22.1 の 44）。個人は 0 */
export const contractMax = (staff: number) => (kindOf(staff) === "large" ? 5 : kindOf(staff) === "mid" ? 2 : 0);
/** 1 往復にかかる時間 (ms。晴れ、積み・降ろしを含む) */
export const cycleMs = (min: number) => 2 * min * 60_000 + 2 * LOAD_MS;
/** 荷の出る間隔 (ms) */
const periodOf = (k: Contract) => DAY_MS / k.loads;
/** 契約の終わり（最後の荷が出る時刻の次） */
export const contractEnd = (k: Contract) => k.t0 + k.total * periodOf(k);

/** 便を始められるか（できなければ理由） */
export function freightCheck(c: Company): string | null {
  if (contractMax(c.staff) === 0) return `長距離の便は中堅（配達員 7 人）から。今 ${c.staff} 人`;
  if ((c.contracts ?? []).length >= contractMax(c.staff)) return `契約の数が上限（${contractMax(c.staff)} 本）`;
  return null;
}

/** その日の申し込み（世界の 1 日に 3 件。荷主・行き先・便数・運賃が違う。契約した物は出さない） */
export function freightOffers(s: EconomyState, c: Company, day: number, dests: FreightDest[]): FreightOffer[] {
  if (!dests.length) return [];
  const taken = new Set([...(c.taken ?? []), ...(c.contracts ?? []).map((k) => k.id)]);
  const out: FreightOffer[] = [];
  for (let i = 0; i < OFFERS; i++) {
    const id = `k${day}-${i}`;
    if (taken.has(id)) continue;
    const u = (k: number) => hashUnit(s.seed ^ 0xf4e, day, i, k);
    const d = dests[hash(s.seed ^ 0xf4f, day, i) % dests.length];
    const [shipper, cargo] = SHIPPERS[hash(s.seed ^ 0xf50, day, i) % SHIPPERS.length];
    const loads = 1 + Math.floor(u(1) * 3);
    const tons = TONS[hash(s.seed ^ 0xf51, day, i) % TONS.length];
    const rate = Math.round((RATE_PER_MIN * (2 * d.min + (2 * LOAD_MS) / 60_000) * tonsFactor(tons) * (0.85 + 0.3 * u(2))) / 100) * 100;
    out.push({ id, shipper, cargo, town: d.town, x: d.x, z: d.z, km: d.km, min: d.min, loads, rate, tons });
  }
  return out;
}

/** 契約する（荷は今から出始める。期間は世界の 1 か月） */
export function takeContract(s: EconomyState, c: Company, day: number, now: number, dests: FreightDest[], id: string): Contract | null {
  const o = freightOffers(s, c, day, dests).find((x) => x.id === id);
  if (!o || freightCheck(c)) return null;
  const k: Contract = { ...o, from: c.depots[0] ?? "", t0: now, total: o.loads * MONTH, next: 0, runs: [], pending: [], sum: { trips: 0, late: 0, dropped: 0, sales: 0 } };
  c.contracts = [...(c.contracts ?? []), k];
  c.freightAt ??= now;
  return k;
}

/** 更新できるか（終わりの 1 週の間だけ） */
export const canRenew = (k: Contract, now: number) => contractEnd(k) - now <= WEEK * DAY_MS && contractEnd(k) > now;

/** 更新する（世界の 1 か月延ばす。22.1 の 42） */
export function renewContract(k: Contract, now: number): boolean {
  if (!canRenew(k, now)) return false;
  k.total += k.loads * MONTH;
  return true;
}

/** 荷の量を積めるいちばん小さい段 */
export const truckFor = (tons: number): TruckKind | null => TRUCK_KINDS.find((v) => (VEHICLES[v].tons ?? 0) >= tons) ?? null;

/** 空いている（便に付けていない）トラックのうち、荷の量を積めるいちばん小さい段 */
export function freeTruckFor(c: Company, tons: number): TruckKind | null {
  return TRUCK_KINDS.find((v) => (VEHICLES[v].tons ?? 0) >= tons && (c.fleet?.[v] ?? 0) > runsOfKind(c, v)) ?? null;
}

/** トラックを付けられるか（できなければ理由） */
export function truckCheck(c: Company, k: { tons: number }): string | null {
  if (!freeTruckFor(c, k.tons)) return `${k.tons} トンを積める空いたトラックが無い（${VEHICLES[truckFor(k.tons) ?? "t10"].label}から）`;
  if ((c.crew?.length ?? 0) <= runsOf(c)) return "運転手に回せる配達員がいない";
  return null;
}

/** トラックを 1 台付ける（積めるいちばん小さい段の空いたトラック。運転手は遅い配達員から） */
export function addTruck(c: Company, k: Contract, now: number): boolean {
  const v = freeTruckFor(c, k.tons);
  if (!v || truckCheck(c, k)) return false;
  k.runs.push({ v, out: now, arr: now, free: now });
  return true;
}

/** トラックを 1 台外す（走っている便は着くまで走り、運賃は入る） */
export function removeTruck(k: Contract): boolean {
  if (!k.runs.length) return false;
  // 営業所にいる・いちばん早く戻るトラックを外す
  let i = 0;
  for (let j = 1; j < k.runs.length; j++) if (k.runs[j].free < k.runs[i].free) i = j;
  k.runs.splice(i, 1);
  return true;
}

/** 契約をやめる（まだ出ていない荷は落とさない。走っている便は着いて運賃が入るまで残す） */
export function cancelContract(k: Contract) {
  k.total = Math.min(k.total, k.next);
  k.runs = [];
}

function bucket(c: Company, ms: number): FreightDay {
  const day = worldDay(ms).day;
  let b = c.freight?.find((x) => x.day === day);
  if (!b) {
    b = { day, sales: 0, fuel: 0, fee: 0, trips: 0, late: 0, dropped: 0 };
    c.freight = [...(c.freight ?? []), b].sort((a, x) => a.day - x.day);
  }
  return b;
}

const trust = (c: Company, d: number) => {
  c.trust = Math.min(1.5, Math.max(0.5, c.trust + d));
};

export interface FreightSummary {
  /** 進めた時間の始まりと終わり（Unix ミリ秒） */
  from: number;
  to: number;
  trips: number;
  late: number;
  accidents: number;
  dropped: number;
  sales: number;
  fuel: number;
  /** 落とした荷の違約金 */
  fee: number;
  /** 期間が終わった契約（行き先と荷主） */
  ended: string[];
}

/**
 * 経営している業者の便を now まで進める。荷が出る → 空いたトラックが積んで出る（燃料を払う）→ 着くと運賃が入る。
 * トラックが空かないまま世界の 1 日たった荷は落とす。運転手（配達員）が足りなければトラックを外す
 */
export function runFreight(s: EconomyState, now: number): FreightSummary | null {
  const c = ownCompany(s);
  if (c && c.freightAt !== undefined && now < c.freightAt) return null;
  if (!c?.contracts?.length) {
    if (c) c.freightAt = now;
    return null;
  }
  const sum: FreightSummary = { from: c.freightAt ?? now, to: now, trips: 0, late: 0, accidents: 0, dropped: 0, sales: 0, fuel: 0, fee: 0, ended: [] };
  // 運転手が足りない（配達員が減った）・トラックが足りない分は外す
  const limit = c.crew?.length ?? 0;
  for (let i = c.contracts.length - 1; i >= 0 && runsOf(c) > limit; i--) while (c.contracts[i].runs.length && runsOf(c) > limit) removeTruck(c.contracts[i]);
  for (const v of TRUCK_KINDS)
    for (const k of c.contracts)
      while (runsOfKind(c, v) > (c.fleet?.[v] ?? 0)) {
        const j = k.runs.findIndex((r) => r.v === v);
        if (j < 0) break;
        k.runs.splice(j, 1);
      }
  for (const k of c.contracts) {
    const period = periodOf(k);
    const one = k.min * 60_000;
    const seed = s.seed ^ hashString(k.id);
    for (;;) {
      if (k.next >= k.total) break;
      const avail = k.t0 + k.next * period;
      if (avail > now) break;
      let i = -1;
      for (let j = 0; j < k.runs.length; j++) if (i < 0 || k.runs[j].free < k.runs[i].free) i = j;
      const start = i < 0 ? Infinity : Math.max(avail, k.runs[i].free);
      if (start >= avail + DAY_MS) {
        // 世界の 1 日待たせた荷は落とす
        if (avail + DAY_MS > now) break;
        const b = bucket(c, avail + DAY_MS);
        const fee = Math.round(k.rate * DROP_FEE);
        c.cash -= fee;
        b.fee += fee;
        sum.fee += fee;
        b.dropped++;
        sum.dropped++;
        k.sum.dropped++;
        trust(c, TRUST_DROP);
        k.next++;
        continue;
      }
      if (start > now) break;
      // 積んで出る。行き先が霧なら遅い。まれに事故で遅れる
      const depart = start + LOAD_MS;
      const fog = weatherAt(k.x, k.z, depart).kind === "fog";
      const slow = fog ? FOG_SLOW : 1;
      const accident = hashUnit(seed, k.next, 1) < ACCIDENT;
      const delay = accident ? (45 + 75 * hashUnit(seed, k.next, 2)) * 60_000 : 0;
      const arrive = depart + one * slow + delay;
      const free = arrive + LOAD_MS + one * slow;
      const v = k.runs[i].v;
      k.runs[i] = { v, out: depart, arr: arrive, free };
      const due = avail + one * DUE_FACTOR + DUE_EXTRA_MS;
      const late = arrive > due;
      const fuel = Math.round((VEHICLES[v].fuel ?? 40) * k.km * 2);
      c.cash -= fuel;
      bucket(c, depart).fuel += fuel;
      sum.fuel += fuel;
      k.pending.push({ load: k.next, arrive, due, pay: Math.round(k.rate * (late ? LATE_PAY : 1)), late, accident });
      k.next++;
    }
    // 着いた便の運賃
    k.pending.sort((a, b) => a.arrive - b.arrive);
    while (k.pending.length && k.pending[0].arrive <= now) {
      const t = k.pending.shift()!;
      c.cash += t.pay;
      const b = bucket(c, t.arrive);
      b.sales += t.pay;
      b.trips++;
      sum.trips++;
      sum.sales += t.pay;
      k.sum.trips++;
      k.sum.sales += t.pay;
      if (t.accident) sum.accidents++;
      if (t.late) {
        b.late++;
        sum.late++;
        k.sum.late++;
      }
      trust(c, t.late ? TRUST_LATE : TRUST_ON_TIME);
    }
  }
  // 終わった契約（荷が全部出て、走っている便も無い）を外す
  const live: Contract[] = [];
  for (const k of c.contracts) {
    if (k.next >= k.total && !k.pending.length && contractEnd(k) <= now) sum.ended.push(`${k.town}（${k.shipper}）`);
    else live.push(k);
  }
  c.contracts = live;
  c.freightAt = now;
  return sum;
}

/** トラックの今の様子: 営業所にいる・行き先へ向かう（進んだ割合）・戻る */
export function truckState(r: { out: number; arr: number; free: number }, now: number): { leg: "home" | "out" | "back"; f: number } {
  if (now < r.out || now >= r.free) return { leg: "home", f: 0 };
  if (now < r.arr) return { leg: "out", f: (now - r.out) / Math.max(1, r.arr - r.out) };
  const back0 = r.arr + LOAD_MS;
  if (now < back0) return { leg: "out", f: 1 };
  return { leg: "back", f: 1 - (now - back0) / Math.max(1, r.free - back0) };
}

/** 契約 1 本の見込み（世界の 1 日あたり。晴れ・事故なし。積めるいちばん小さい段のトラックの数で運べる便） */
export function contractEstimate(k: { loads: number; rate: number; km: number; min: number; tons: number }, trucks: number, wage: number): { trips: number; sales: number; fuel: number; trucks: number; wages: number; profit: number } {
  const v = VEHICLES[truckFor(k.tons) ?? "t10"];
  const trips = Math.min(k.loads, (trucks * DAY_MS) / cycleMs(k.min));
  const sales = trips * k.rate;
  const fuel = trips * (v.fuel ?? 40) * k.km * 2;
  const tr = trucks * v.daily;
  const wages = trucks * wage;
  return { trips, sales, fuel, trucks: tr, wages, profit: sales - fuel - tr - wages };
}

/** 契約の便数を運ぶのに要るトラックの数 */
export const trucksNeeded = (k: { loads: number; min: number }) => Math.ceil((k.loads * cycleMs(k.min)) / DAY_MS - 1e-9);

