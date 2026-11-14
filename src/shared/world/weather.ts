// 世界の時計と天候（概要仕様 3.7）。時刻は世界共通、天候は場所と時刻から決まり、同じ場所・同じ時刻なら誰でも同じになる。
// 端末間で一致させるため、加減乗除と floor とハッシュだけで計算する（モック仕様 4.2。sin・cos・exp・pow を通さない）。
// 入力の時刻は Unix 時刻のミリ秒。モックでは端末の時計を使う（サーバーができたらサーバーの時刻に合わせる）。

import { hashUnit } from "./hash.ts";

/** 世界の 1 日の長さ（実時間のミリ秒）。1 日 = 実時間 4 時間【初期値】 */
export const DAY_MS = 4 * 3600 * 1000;

/** 世界の時刻（時、0 以上 24 未満） */
export function worldHour(ms: number): number {
  const r = ms - Math.floor(ms / DAY_MS) * DAY_MS;
  return (r / DAY_MS) * 24;
}

export type WeatherKind = "clear" | "cloudy" | "fog";

export const WEATHER_LABELS: Record<WeatherKind, string> = { clear: "晴れ", cloudy: "曇り", fog: "霧" };

export interface Weather {
  kind: WeatherKind;
  /** 雲の量 0〜1（描画に使う連続値） */
  cloud: number;
  /** 霧の濃さ 0〜1（描画に使う連続値） */
  fog: number;
}

/** 決めた天候にする時の値（眺める乗り方などで画面だけ固定する時） */
export const FIXED_WEATHER: Record<WeatherKind, Weather> = {
  clear: { kind: "clear", cloud: 0.3, fog: 0 },
  cloudy: { kind: "cloudy", cloud: 0.92, fog: 0 },
  fog: { kind: "fog", cloud: 0.7, fog: 0.85 },
};

/** 曇り・霧に分ける境目 */
export const CLOUDY_AT = 0.6;
export const FOG_AT = 0.5;

// 雲: 24km の模様が東へ 5m/s で流れ、90 分で形を変える
const CLOUD_SCALE = 24000;
const CLOUD_PERIOD = 90 * 60 * 1000;
const WIND_X = 5 / 1000; // m/ms
const WIND_Z = 1.5 / 1000;
// 霧: 12km の模様、60 分で形を変える。朝に出やすい
const FOG_SCALE = 12000;
const FOG_PERIOD = 60 * 60 * 1000;

const SEED_CLOUD = 0x5eed01;
const SEED_FOG = 0x5eed02;

function fade(t: number): number {
  return t * t * t * (t * (t * 6 - 15) + 10);
}

/** 3 次元の値ノイズ。-1〜1 */
function valueNoise3(seed: number, x: number, y: number, z: number): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const iz = Math.floor(z);
  const u = fade(x - ix);
  const v = fade(y - iy);
  const w = fade(z - iz);
  const c = (a: number, b: number, d: number) => hashUnit(seed, ix + a, iy + b, iz + d);
  const x00 = c(0, 0, 0) + (c(1, 0, 0) - c(0, 0, 0)) * u;
  const x10 = c(0, 1, 0) + (c(1, 1, 0) - c(0, 1, 0)) * u;
  const x01 = c(0, 0, 1) + (c(1, 0, 1) - c(0, 0, 1)) * u;
  const x11 = c(0, 1, 1) + (c(1, 1, 1) - c(0, 1, 1)) * u;
  const y0 = x00 + (x10 - x00) * v;
  const y1 = x01 + (x11 - x01) * v;
  return (y0 + (y1 - y0) * w) * 2 - 1;
}

/** 2 段の重ね合わせ。-1〜1 */
function field(seed: number, x: number, z: number, t: number): number {
  return (valueNoise3(seed, x, z, t) * 2 + valueNoise3(seed + 77, x * 2.03 + 5.1, z * 2.03 - 3.7, t * 1.7 + 0.37)) / 3;
}

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** 霧の出やすさ（時刻）: 深夜から朝 8 時までが 1、昼は 0、夕方から少しずつ上がる */
export function fogHourFactor(hour: number): number {
  if (hour < 8) return 1;
  if (hour < 11) return 1 - (hour - 8) / 3;
  if (hour < 18) return 0;
  return ((hour - 18) / 6) * 0.6;
}

/** 世界座標 (x, z) の、時刻 ms の天候 */
export function weatherAt(x: number, z: number, ms: number): Weather {
  const cx = (x - WIND_X * ms) / CLOUD_SCALE;
  const cz = (z - WIND_Z * ms) / CLOUD_SCALE;
  const cloud = clamp01(0.5 + 1.15 * field(SEED_CLOUD, cx, cz, ms / CLOUD_PERIOD));
  const fx = (x - WIND_X * 0.4 * ms) / FOG_SCALE;
  const fz = (z - WIND_Z * 0.4 * ms) / FOG_SCALE;
  const pot = field(SEED_FOG, fx, fz, ms / FOG_PERIOD);
  // 雲が多いほど、朝ほど霧が出やすい
  const fog = clamp01((pot + 0.35 * fogHourFactor(worldHour(ms)) + 0.15 * cloud - 0.45) * 3);
  const kind: WeatherKind = fog >= FOG_AT ? "fog" : cloud >= CLOUDY_AT ? "cloudy" : "clear";
  return { kind, cloud, fog };
}
