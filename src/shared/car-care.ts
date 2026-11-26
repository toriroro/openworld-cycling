// 自分の車の燃料と傷み（D7b。配達の草案 34 章）。走った距離で燃料を使い、タイヤの空気・オイル・ブレーキが傷む。
// 燃料店で給油・整備する。燃料が尽きると止まり、呼んで届けてもらう。値段・効き目もここに置く（お金の計算は src/shared。7.1）。
// DOM・Three.js に依存しない。

import type { DriveKind } from "./economy.ts";

export type CarPart = "tire" | "oil" | "brake";
export const CAR_PARTS: CarPart[] = ["tire", "oil", "brake"];
export const CAR_PART_LABELS: Record<CarPart, string> = { tire: "タイヤの空気", oil: "オイル", brake: "ブレーキ" };

/** 車 1 台の具合: 燃料 (L) と、傷み（1 = 整備したて） */
export interface CarCare {
  fuel: number;
  tire: number;
  oil: number;
  brake: number;
}

/** 燃料の入る量 (L)・1L で走る距離 (km)【初期値】。軽自動車 30L・18km、軽バン 35L・14km */
export const TANK: Record<DriveKind, number> = { kei: 30, van: 35 };
export const KM_PER_L: Record<DriveKind, number> = { kei: 18, van: 14 };
/** 燃料 1L の値段 (円)【初期値】 */
export const FUEL_PRICE = 170;
/** 1km 走るごとに減る量【初期値】。自転車（29 章）の約 1/10。配達で 1 日 80km 走ると空気 88%・オイル 94%・ブレーキ 96% */
export const CAR_WEAR_PER_KM: Record<CarPart, number> = { tire: 0.0015, oil: 0.0008, brake: 0.0005 };

export const freshCar = (k: DriveKind): CarCare => ({ fuel: TANK[k], tire: 1, oil: 1, brake: 1 });

/** 走った距離 (m) の分だけ燃料を使い、傷める（0 より下にはならない） */
export function driveWear(c: CarCare, k: DriveKind, meters: number): CarCare {
  const km = Math.max(0, meters) / 1000;
  return {
    fuel: Math.max(0, c.fuel - km / KM_PER_L[k]),
    tire: Math.max(0, c.tire - CAR_WEAR_PER_KM.tire * km),
    oil: Math.max(0, c.oil - CAR_WEAR_PER_KM.oil * km),
    brake: Math.max(0, c.brake - CAR_WEAR_PER_KM.brake * km),
  };
}

/** 傷みの効き目【初期値】: 加速の倍率（空気が 0 で 0.75、オイルが 0 でさらに 0.7）、ブレーキの倍率（0 で 0.55） */
export function carEffects(c: CarCare): { accel: number; brake: number } {
  return { accel: (0.75 + 0.25 * c.tire) * (0.7 + 0.3 * c.oil), brake: 0.55 + 0.45 * c.brake };
}

/** いちばん傷んだ所（燃料は含めない） */
export function worstCarPart(c: CarCare): { part: CarPart; share: number } {
  let part: CarPart = "tire";
  for (const p of CAR_PARTS) if (c[p] < c[part]) part = p;
  return { part, share: c[part] };
}

export interface CarService {
  id: "fuel" | "air" | "oil" | "brake" | "all";
  name: string;
  /** 直す所（給油は燃料） */
  parts: CarPart[];
  /** 値段 (円)。給油は入れる量で決まる（carServicePrice） */
  price: number;
  /** かかる時間 (s)。持っている注文の経った時間に足す */
  seconds: number;
}

/** 燃料店でできること【初期値】 */
export const CAR_SERVICES: CarService[] = [
  { id: "fuel", name: "満タンに給油", parts: [], price: 0, seconds: 180 },
  { id: "air", name: "タイヤに空気を入れる", parts: ["tire"], price: 0, seconds: 120 },
  { id: "oil", name: "オイル交換", parts: ["oil"], price: 4_000, seconds: 900 },
  { id: "brake", name: "ブレーキの点検と調整", parts: ["brake"], price: 6_000, seconds: 1200 },
  { id: "all", name: "まとめて点検（給油も）", parts: ["tire", "oil", "brake"], price: 9_000, seconds: 1800 },
];

/** 頼んだ時の値段（給油は満タンまでの量 × 1L の値段。まとめて点検は給油の分も足す） */
export function carServicePrice(s: CarService, c: CarCare, k: DriveKind): number {
  const fuel = Math.ceil(Math.max(0, TANK[k] - c.fuel) * FUEL_PRICE);
  if (s.id === "fuel") return fuel;
  if (s.id === "all") return s.price + fuel;
  return s.price;
}

/** 頼めるか。頼めなければ理由 */
export function carServiceBlock(s: CarService, c: CarCare, k: DriveKind, money: number): string | null {
  const fuelFull = c.fuel >= TANK[k] - 0.05;
  if (s.id === "fuel" ? fuelFull : s.id === "all" ? fuelFull && s.parts.every((p) => c[p] >= 0.995) : s.parts.every((p) => c[p] >= 0.995)) return "直す所が無い";
  if (money < carServicePrice(s, c, k)) return "資金が足りない";
  return null;
}

/** 頼んだ後の具合 */
export function serviceCar(s: CarService, c: CarCare, k: DriveKind): CarCare {
  const out = { ...c };
  if (s.id === "fuel" || s.id === "all") out.fuel = TANK[k];
  for (const p of s.parts) out[p] = 1;
  return out;
}

/** 燃料が尽きた時に、呼んで届けてもらう: 値段 (円)・待つ時間 (s)・入れてもらう量 (L)【初期値】 */
export const RESCUE = { price: 3_000, seconds: 600, liters: 10 };

/** 呼んで届けてもらった後の具合 */
export function rescueCar(c: CarCare, k: DriveKind): CarCare {
  return { ...c, fuel: Math.min(TANK[k], c.fuel + RESCUE.liters) };
}

/** 保存から読む（壊れた値は満タン・整備したてにする） */
export function carFromJSON(v: unknown, k: DriveKind): CarCare {
  const r = typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {};
  const n = (x: unknown, d: number, hi: number) => (typeof x === "number" && Number.isFinite(x) ? Math.min(hi, Math.max(0, x)) : d);
  return { fuel: n(r.fuel, TANK[k], TANK[k]), tire: n(r.tire, 1, 1), oil: n(r.oil, 1, 1), brake: n(r.brake, 1, 1) };
}

// ---- 付け替え（D7c。配達の草案 35 章） ----

/** 車 1 台の付け替え: 荷室の棚・冬タイヤ・塗装の色（null は業者の色） */
export interface CarMods {
  shelf: boolean;
  winter: boolean;
  paint: string | null;
}
export const NO_MODS: CarMods = { shelf: false, winter: false, paint: null };

/** 値段 (円)・かかる時間 (s)【初期値】 */
export const SHELF = { price: 50_000, seconds: 1200, carry: 1 };
export const WINTER = { price: 80_000, seconds: 1800 };
export const PAINT = { price: 20_000, seconds: 3600 };
/** 塗れる色（null は業者の色） */
export const PAINT_CHOICES: { color: string | null; name: string }[] = [
  { color: null, name: "業者の色" },
  { color: "#f2f2ee", name: "白" },
  { color: "#b9bdc0", name: "銀" },
  { color: "#1d1f22", name: "黒" },
  { color: "#c8323f", name: "赤" },
  { color: "#2b4f8e", name: "青" },
];

/** 冬タイヤが効く天候があるか（今の天候は晴れ・曇り・霧だけで、雪は無い） */
export const SNOW_WEATHER = false;

export type ModId = "shelf" | "winter" | `paint:${string}`;

/** 付け替えられるか。できなければ理由 */
export function modBlock(id: ModId, m: CarMods, money: number): string | null {
  if (id === "shelf") {
    if (m.shelf) return "付いている";
    return money < SHELF.price ? "資金が足りない" : null;
  }
  if (id === "winter") {
    if (!SNOW_WEATHER) return "雪の天候が入ってから";
    if (m.winter) return "付いている";
    return money < WINTER.price ? "資金が足りない" : null;
  }
  const color = id.slice(6) || null;
  if ((m.paint ?? null) === color) return "この色に塗ってある";
  return money < PAINT.price ? "資金が足りない" : null;
}

/** 付け替えの値段・時間 */
export function modCost(id: ModId): { price: number; seconds: number } {
  return id === "shelf" ? SHELF : id === "winter" ? WINTER : PAINT;
}

/** 付け替えた後 */
export function applyMod(id: ModId, m: CarMods): CarMods {
  if (id === "shelf") return { ...m, shelf: true };
  if (id === "winter") return { ...m, winter: true };
  return { ...m, paint: id.slice(6) || null };
}

/** 保存から読む */
export function modsFromJSON(v: unknown): CarMods {
  const r = typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {};
  const paint = typeof r.paint === "string" && PAINT_CHOICES.some((p) => p.color === r.paint) ? r.paint : null;
  return { shelf: r.shelf === true, winter: r.winter === true, paint };
}
