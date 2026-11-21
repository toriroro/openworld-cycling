// 保存データの形（モック仕様 7.3）。版番号つきの純粋なデータ。読み込む時は信用せず、壊れた項目は既定値で埋める。
// 保存先は platform の storage（ここでは扱わない）。

import { DEFAULT_OUTFIT, type Outfit, sanitizeOutfit } from "./outfit.ts";
import { POWER_MAX, POWER_MIN } from "../sim/power.ts";
import { AdventureLedger } from "../sim/adventure.ts";

export const SAVE_VERSION = 1;
export const SAVE_KEY = "save";

export interface Stamp {
  /** 立ち寄り地点の識別子 */
  poi: string;
  name: string;
  /** 初めて来た日（YYYY-MM-DD） */
  date: string;
  /** 来た回数 */
  visits: number;
  x: number;
  z: number;
  elevation: number;
  /** 店の前の道路上の位置（再開地点に使う） */
  road: string;
  s: number;
}

export interface SaveSettings {
  power: number;
  /** ペダリングで体がぶれ始める出力 (W) */
  sway: number;
  quality: "standard" | "light" | null;
  /** 時刻: 世界の時計 / 画面だけ固定（固定の時は hour） */
  clock: "world" | "fixed";
  hour: number;
  /** 天候: 世界の天候 / 画面だけ固定 */
  weather: "world" | "clear" | "cloudy" | "fog";
  /** 交通量: なし / 少ない / 標準 */
  traffic: "off" | "few" | "normal";
  camera: string;
  volume: number;
  muted: boolean;
  /** 眺める乗り方でフレームレートを 30 に抑える */
  fps30: boolean;
  /** 眺める乗り方の進路: 道なり / 未走行の道を優先 */
  watchRoute: "follow" | "unridden";
  /** 体重 (kg)・機材の重さ (kg)（トレーナー連携の草案 3.2） */
  bodyMass: number;
  bikeMass: number;
  /** トレーナーの勾配の効き 0〜1（草案 4.1） */
  trainerEffect: number;
  /** トレーナーで走る時の分岐: 自分で選ぶ / 道なり / 未走行の道を優先（草案 11 章の 4） */
  trainerRoute: "manual" | "follow" | "unridden";
}

export interface SaveData {
  version: number;
  /** 保存した時の世界生成の版（違えば道路の識別子が合わないことがある） */
  generator: number;
  savedAt: string;
  /** 現在地: 道路・道のり・向きと、道路が見つからない時のための世界座標 */
  pos: { road: string; s: number; dir: 1 | -1; x: number; z: number } | null;
  odometer: number;
  climb: number;
  time: number;
  ridden: Record<string, number[]>;
  stamps: Stamp[];
  settings: SaveSettings;
  outfit: Outfit;
  watching: boolean;
  /** 冒険の乗り方の帳簿（冒険の草案 6 章）。自由で始めた世界は null */
  adventure: ReturnType<AdventureLedger["toJSON"]> | null;
}

export const DEFAULT_SETTINGS: SaveSettings = {
  power: 180,
  // 体がぶれ始める出力 (W)。今までの既定（FTP 250W の 1.2 倍）と同じ
  sway: 300,
  quality: null,
  clock: "world",
  hour: 14.5,
  weather: "world",
  traffic: "normal",
  camera: "chase",
  volume: 0.3,
  muted: false,
  fps30: true,
  watchRoute: "unridden",
  bodyMass: 75,
  bikeMass: 8,
  trainerEffect: 0.5,
  trainerRoute: "manual",
};

/** 体重・機材の重さの範囲（草案 3.2【初期値】） */
export const BODY_MASS = { min: 30, max: 150 } as const;
export const BIKE_MASS = { min: 5, max: 20 } as const;

const num = (v: unknown, d: number, lo = -Infinity, hi = Infinity) => (typeof v === "number" && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d);
const str = (v: unknown, d: string, max = 200) => (typeof v === "string" && v.length <= max ? v : d);
const rec = (v: unknown): Record<string, unknown> => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

export function sanitizeSettings(value: unknown): SaveSettings {
  const s = rec(value);
  const d = DEFAULT_SETTINGS;
  return {
    power: num(s.power, d.power, POWER_MIN, POWER_MAX),
    sway: num(s.sway, d.sway, 100, POWER_MAX),
    quality: s.quality === "standard" || s.quality === "light" ? s.quality : null,
    clock: s.clock === "fixed" ? "fixed" : "world",
    hour: num(s.hour, d.hour, 0, 24),
    weather: s.weather === "clear" || s.weather === "cloudy" || s.weather === "fog" ? s.weather : "world",
    traffic: s.traffic === "off" || s.traffic === "few" ? s.traffic : "normal",
    camera: str(s.camera, d.camera, 20),
    volume: num(s.volume, d.volume, 0, 1),
    muted: typeof s.muted === "boolean" ? s.muted : d.muted,
    fps30: typeof s.fps30 === "boolean" ? s.fps30 : d.fps30,
    watchRoute: s.watchRoute === "follow" || s.watchRoute === "unridden" ? s.watchRoute : d.watchRoute,
    bodyMass: num(s.bodyMass, d.bodyMass, BODY_MASS.min, BODY_MASS.max),
    bikeMass: num(s.bikeMass, d.bikeMass, BIKE_MASS.min, BIKE_MASS.max),
    trainerEffect: Math.round(num(s.trainerEffect, d.trainerEffect, 0, 1) * 10) / 10,
    trainerRoute: s.trainerRoute === "follow" || s.trainerRoute === "unridden" ? s.trainerRoute : "manual",
  };
}

function sanitizeStamp(v: unknown): Stamp | null {
  const s = rec(v);
  if (typeof s.poi !== "string" || typeof s.name !== "string") return null;
  return {
    poi: str(s.poi, "", 200),
    name: str(s.name, "", 100),
    date: str(s.date, "", 10),
    visits: Math.round(num(s.visits, 1, 1, 1e6)),
    x: num(s.x, 0),
    z: num(s.z, 0),
    elevation: num(s.elevation, 0),
    road: str(s.road, "", 200),
    s: num(s.s, 0, 0),
  };
}

/** 保存データを読む。版が新しすぎる・壊れている時も、読める項目だけで作る。何もなければ null */
export function parseSave(text: string | null): SaveData | null {
  if (!text) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  const r = rec(raw);
  if (typeof r.version !== "number") return null;
  const p = rec(r.pos);
  const pos =
    typeof p.road === "string" && (p.dir === 1 || p.dir === -1)
      ? { road: str(p.road, "", 200), s: num(p.s, 0, 0), dir: p.dir as 1 | -1, x: num(p.x, 0), z: num(p.z, 0) }
      : null;
  return {
    version: SAVE_VERSION,
    generator: num(r.generator, 0),
    savedAt: str(r.savedAt, "", 40),
    pos,
    odometer: num(r.odometer, 0, 0),
    climb: num(r.climb, 0, 0),
    time: num(r.time, 0, 0),
    ridden: rec(r.ridden) as Record<string, number[]>,
    stamps: Array.isArray(r.stamps) ? r.stamps.map(sanitizeStamp).filter((s): s is Stamp => s !== null) : [],
    settings: sanitizeSettings(r.settings),
    outfit: r.outfit ? sanitizeOutfit(r.outfit) : DEFAULT_OUTFIT,
    watching: r.watching === true,
    adventure: AdventureLedger.fromJSON(r.adventure)?.toJSON() ?? null,
  };
}
