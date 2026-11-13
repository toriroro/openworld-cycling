// 保存データの形（モック仕様 7.3）。版番号つきの純粋なデータ。読み込む時は信用せず、壊れた項目は既定値で埋める。
// 保存先は platform の storage（ここでは扱わない）。

import { DEFAULT_OUTFIT, type Outfit, sanitizeOutfit } from "./outfit.ts";

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
  quality: "standard" | "light" | null;
  hour: number;
  camera: string;
  volume: number;
  muted: boolean;
  /** 眺める乗り方でフレームレートを 30 に抑える */
  fps30: boolean;
  /** 眺める乗り方の進路: 道なり / 未走行の道を優先 */
  watchRoute: "follow" | "unridden";
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
}

export const DEFAULT_SETTINGS: SaveSettings = {
  power: 180,
  quality: null,
  hour: 14.5,
  camera: "chase",
  volume: 0.7,
  muted: false,
  fps30: true,
  watchRoute: "unridden",
};

const num = (v: unknown, d: number, lo = -Infinity, hi = Infinity) => (typeof v === "number" && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d);
const str = (v: unknown, d: string, max = 200) => (typeof v === "string" && v.length <= max ? v : d);
const rec = (v: unknown): Record<string, unknown> => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

export function sanitizeSettings(value: unknown): SaveSettings {
  const s = rec(value);
  const d = DEFAULT_SETTINGS;
  return {
    power: num(s.power, d.power, 50, 400),
    quality: s.quality === "standard" || s.quality === "light" ? s.quality : null,
    hour: num(s.hour, d.hour, 0, 24),
    camera: str(s.camera, d.camera, 20),
    volume: num(s.volume, d.volume, 0, 1),
    muted: typeof s.muted === "boolean" ? s.muted : d.muted,
    fps30: typeof s.fps30 === "boolean" ? s.fps30 : d.fps30,
    watchRoute: s.watchRoute === "follow" || s.watchRoute === "unridden" ? s.watchRoute : d.watchRoute,
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
  };
}
