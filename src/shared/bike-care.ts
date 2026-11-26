// 自転車の傷みと整備（配達の草案 29 章）。走った距離でタイヤの空気・チェーン・ブレーキが傷み、走りが重く・止まりにくくなる。
// 自転車店で直す。値段・かかる時間・効き目もここに置く（お金の計算は src/shared の純粋な関数。配達の草案 7.1）。
// DOM・Three.js に依存しない。

export type CarePart = "tire" | "chain" | "brake";
export const CARE_PARTS: CarePart[] = ["tire", "chain", "brake"];
export const CARE_LABELS: Record<CarePart, string> = { tire: "タイヤの空気", chain: "チェーン", brake: "ブレーキ" };

/** 傷みの具合（1 = 整備したて、0 = いちばん傷んだ） */
export type BikeCare = Record<CarePart, number>;
export const FRESH_CARE: BikeCare = { tire: 1, chain: 1, brake: 1 };

/**
 * 1km 走るごとに減る量【初期値】。配達で 1 時間に約 25km 走ると、空気 63%・チェーン 80%・ブレーキ 88% になる。
 * 空気は数時間でいちばん重くなり、こまめに入れる物。チェーンとブレーキはその数倍もつ
 */
export const WEAR_PER_KM: BikeCare = { tire: 0.015, chain: 0.008, brake: 0.005 };

/** 傷みの効き目【初期値】: 転がりの抵抗の倍率（空気が 0 で 4 倍）、推進に使える割合（チェーンが 0 で 0.8）、ブレーキの効き（0 で 0.55） */
export function careEffects(c: BikeCare): { crr: number; drive: number; brake: number } {
  return { crr: 1 + 3 * (1 - c.tire), drive: 1 - 0.2 * (1 - c.chain), brake: 0.55 + 0.45 * c.brake };
}

/** 走った距離 (m) の分だけ傷める（0 より下にはならない） */
export function wear(c: BikeCare, meters: number): BikeCare {
  const km = Math.max(0, meters) / 1000;
  return { tire: Math.max(0, c.tire - WEAR_PER_KM.tire * km), chain: Math.max(0, c.chain - WEAR_PER_KM.chain * km), brake: Math.max(0, c.brake - WEAR_PER_KM.brake * km) };
}

/** いちばん傷んだ所 */
export function worstPart(c: BikeCare): { part: CarePart; share: number } {
  let part: CarePart = "tire";
  for (const p of CARE_PARTS) if (c[p] < c[part]) part = p;
  return { part, share: c[part] };
}

export interface CareService {
  id: string;
  name: string;
  /** 直す所 */
  parts: CarePart[];
  /** 値段 (円) */
  price: number;
  /** かかる時間 (s)。持っている注文の経った時間に足す */
  seconds: number;
}

/** 自転車店でできること【初期値】。空気入れは店先で無料（日本の自転車店によくある形） */
export const CARE_SERVICES: CareService[] = [
  { id: "air", name: "空気を入れる", parts: ["tire"], price: 0, seconds: 60 },
  { id: "chain", name: "チェーンの掃除と油差し", parts: ["chain"], price: 600, seconds: 180 },
  { id: "brake", name: "ブレーキの調整", parts: ["brake"], price: 800, seconds: 300 },
  { id: "all", name: "まとめて点検", parts: ["tire", "chain", "brake"], price: 1200, seconds: 600 },
];

/** 頼めるか。頼めなければ理由 */
export function careBlock(s: CareService, c: BikeCare, money: number): string | null {
  if (s.parts.every((p) => c[p] >= 0.995)) return "直す所が無い";
  if (money < s.price) return "所持金が足りない";
  return null;
}

/** 頼んだ後の具合 */
export function serviceCare(s: CareService, c: BikeCare): BikeCare {
  const out = { ...c };
  for (const p of s.parts) out[p] = 1;
  return out;
}

/** 保存から読む（壊れた値は整備したてにする） */
export function careFromJSON(v: unknown): BikeCare {
  const r = typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {};
  const n = (x: unknown) => (typeof x === "number" && Number.isFinite(x) ? Math.min(1, Math.max(0, x)) : 1);
  return { tire: n(r.tire), chain: n(r.chain), brake: n(r.brake) };
}
