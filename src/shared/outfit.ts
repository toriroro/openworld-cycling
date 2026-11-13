// 自転車と装いの設定。端末内の保存（M4 の platform 層）にそのまま載せる、版番号つきの純粋なデータ。
// DOM・Three.js に依存しない。色は "#rrggbb" の文字列、選択肢は文字列の列挙で持つ。

export const OUTFIT_VERSION = 1;

export const FRAME_SHAPES = ["aero", "climb", "steel"] as const;
export const RIM_DEPTHS = ["low", "mid", "deep"] as const;
export const TIRE_WALLS = ["black", "tan"] as const;
export const JERSEY_PATTERNS = ["plain", "band", "shoulder", "stripes"] as const;
export const HELMET_SHAPES = ["road", "aero"] as const;
export const SOCK_LENGTHS = ["short", "long"] as const;

export type FrameShape = (typeof FRAME_SHAPES)[number];
export type RimDepth = (typeof RIM_DEPTHS)[number];
export type TireWall = (typeof TIRE_WALLS)[number];
export type JerseyPattern = (typeof JERSEY_PATTERNS)[number];
export type HelmetShape = (typeof HELMET_SHAPES)[number];
export type SockLength = (typeof SOCK_LENGTHS)[number];

export interface BikeOutfit {
  frame: FrameShape;
  frameColor: string;
  accentColor: string;
  wheels: RimDepth;
  rimColor: string;
  tireWall: TireWall;
  tapeColor: string;
  saddleColor: string;
}

export interface RiderOutfit {
  jerseyPattern: JerseyPattern;
  jerseyColor: string;
  jerseyAccent: string;
  bibColor: string;
  helmet: HelmetShape;
  helmetColor: string;
  lensColor: string;
  shoeColor: string;
  sockLength: SockLength;
  sockColor: string;
  skinColor: string;
  hairColor: string;
}

export interface Outfit {
  version: typeof OUTFIT_VERSION;
  bike: BikeOutfit;
  rider: RiderOutfit;
}

/** 画面で選べる色。name は画面の読み上げ用の色の名前。 */
export interface Swatch {
  hex: string;
  name: string;
}

export const PAINT_COLORS: readonly Swatch[] = [
  { hex: "#bc512f", name: "朱" },
  { hex: "#c8323f", name: "赤" },
  { hex: "#e0b13a", name: "黄" },
  { hex: "#9cb85e", name: "黄緑" },
  { hex: "#2e6b4c", name: "緑" },
  { hex: "#3f9aa8", name: "青緑" },
  { hex: "#5d9fd2", name: "空色" },
  { hex: "#2b4f8e", name: "青" },
  { hex: "#6b4a8c", name: "紫" },
  { hex: "#d98ea6", name: "桃" },
  { hex: "#e9e7e0", name: "白" },
  { hex: "#8e989c", name: "銀" },
  { hex: "#3c4448", name: "灰" },
  { hex: "#16191c", name: "黒" },
];

export const PART_COLORS: readonly Swatch[] = [
  { hex: "#16191c", name: "黒" },
  { hex: "#e9e7e0", name: "白" },
  { hex: "#8e989c", name: "銀" },
  { hex: "#7a5a3a", name: "茶" },
  { hex: "#bc512f", name: "朱" },
  { hex: "#c8323f", name: "赤" },
  { hex: "#e0b13a", name: "黄" },
  { hex: "#2e6b4c", name: "緑" },
  { hex: "#5d9fd2", name: "空色" },
  { hex: "#2b4f8e", name: "青" },
];

export const LENS_COLORS: readonly Swatch[] = [
  { hex: "#1a2a30", name: "スモーク" },
  { hex: "#5b3a24", name: "ブラウン" },
  { hex: "#2e6fb0", name: "ブルーミラー" },
  { hex: "#c0602a", name: "オレンジミラー" },
  { hex: "#c8c070", name: "イエロー" },
  { hex: "#b8c4c8", name: "クリア" },
];

export const SKIN_COLORS: readonly Swatch[] = [
  { hex: "#f0c8a8", name: "明るい" },
  { hex: "#d9a47e", name: "やや明るい" },
  { hex: "#b07850", name: "やや濃い" },
  { hex: "#6e4630", name: "濃い" },
];

export const HAIR_COLORS: readonly Swatch[] = [
  { hex: "#141210", name: "黒" },
  { hex: "#3b2a1e", name: "焦げ茶" },
  { hex: "#7a5434", name: "茶" },
  { hex: "#c09a62", name: "金" },
  { hex: "#8c8a86", name: "灰" },
  { hex: "#e2e0da", name: "白" },
];

export const DEFAULT_OUTFIT: Outfit = {
  version: OUTFIT_VERSION,
  bike: {
    frame: "climb",
    frameColor: "#bc512f",
    accentColor: "#16191c",
    wheels: "mid",
    rimColor: "#16191c",
    tireWall: "tan",
    tapeColor: "#16191c",
    saddleColor: "#16191c",
  },
  rider: {
    jerseyPattern: "shoulder",
    jerseyColor: "#3f9aa8",
    jerseyAccent: "#16191c",
    bibColor: "#16191c",
    helmet: "road",
    helmetColor: "#e9e7e0",
    lensColor: "#1a2a30",
    shoeColor: "#e9e7e0",
    sockLength: "long",
    sockColor: "#e9e7e0",
    skinColor: "#b07850",
    hairColor: "#141210",
  },
};

const HEX = /^#[0-9a-f]{6}$/;

function pick<T extends string>(value: unknown, options: readonly T[], fallback: T): T {
  return typeof value === "string" && (options as readonly string[]).includes(value) ? (value as T) : fallback;
}

function color(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  const v = value.toLowerCase();
  return HEX.test(v) ? v : fallback;
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/**
 * 保存データなど信用できない値から設定を作る。足りない項目・壊れた項目は既定値で埋める。
 * 版番号が今より新しいデータは読めない項目があり得るので、読める項目だけ使う。
 */
export function sanitizeOutfit(value: unknown): Outfit {
  const root = record(value);
  const b = record(root.bike);
  const r = record(root.rider);
  const db = DEFAULT_OUTFIT.bike;
  const dr = DEFAULT_OUTFIT.rider;
  return {
    version: OUTFIT_VERSION,
    bike: {
      frame: pick(b.frame, FRAME_SHAPES, db.frame),
      frameColor: color(b.frameColor, db.frameColor),
      accentColor: color(b.accentColor, db.accentColor),
      wheels: pick(b.wheels, RIM_DEPTHS, db.wheels),
      rimColor: color(b.rimColor, db.rimColor),
      tireWall: pick(b.tireWall, TIRE_WALLS, db.tireWall),
      tapeColor: color(b.tapeColor, db.tapeColor),
      saddleColor: color(b.saddleColor, db.saddleColor),
    },
    rider: {
      jerseyPattern: pick(r.jerseyPattern, JERSEY_PATTERNS, dr.jerseyPattern),
      jerseyColor: color(r.jerseyColor, dr.jerseyColor),
      jerseyAccent: color(r.jerseyAccent, dr.jerseyAccent),
      bibColor: color(r.bibColor, dr.bibColor),
      helmet: pick(r.helmet, HELMET_SHAPES, dr.helmet),
      helmetColor: color(r.helmetColor, dr.helmetColor),
      lensColor: color(r.lensColor, dr.lensColor),
      shoeColor: color(r.shoeColor, dr.shoeColor),
      sockLength: pick(r.sockLength, SOCK_LENGTHS, dr.sockLength),
      sockColor: color(r.sockColor, dr.sockColor),
      skinColor: color(r.skinColor, dr.skinColor),
      hairColor: color(r.hairColor, dr.hairColor),
    },
  };
}

/** 一部だけ変えた新しい設定を返す（元は変えない）。 */
export function withOutfit(o: Outfit, change: { bike?: Partial<BikeOutfit>; rider?: Partial<RiderOutfit> }): Outfit {
  return sanitizeOutfit({ ...o, bike: { ...o.bike, ...change.bike }, rider: { ...o.rider, ...change.rider } });
}
