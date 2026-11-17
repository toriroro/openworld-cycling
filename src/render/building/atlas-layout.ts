// 窓・扉・看板の絵の表の並び（atlas.ts が描く）。並びだけで DOM・Three.js を使わない（Worker でも建物の形を作れるように）。

import { hex, type Rect, type Rgb } from "./mesher.ts";

export const W = 2048, H = 1024;

/** 横の看板の文字（業種）。先頭の 16 は縦の看板もある */
export const SIGN_TEXT = [
  "酒店", "薬局", "書店", "理容室", "美容室", "食堂", "そば処", "電器店", "金物店", "生花店", "歯科医院", "内科医院", "学習塾", "寿司", "焼肉", "居酒屋",
  "米穀店", "青果店", "茶舗", "ラーメン", "スナック", "クリーニング", "精肉店", "鮮魚店", "洋品店", "時計・眼鏡", "文具店", "自転車店", "写真館", "燃料店", "釣具店", "種苗店",
];
export const VSIGN_TEXT = ["酒", "薬", "本", "理容", "美容", "食堂", "そば", "電器", "金物", "生花", "歯科", "医院", "塾", "寿司", "焼肉", "居酒屋"];
/** 看板の地の色と文字の色 */
const SIGN_PAIRS: [string, string][] = [
  ["#f2f0e8", "#1d2530"],
  ["#f2f0e8", "#a8261d"],
  ["#f2f0e8", "#1b4a86"],
  ["#1f3f6e", "#ffffff"],
  ["#a3271f", "#ffffff"],
  ["#1f6a47", "#ffffff"],
  ["#e8c22e", "#1a1a1a"],
  ["#3a2b20", "#efe2c4"],
];
export const pairOf = (i: number) => SIGN_PAIRS[(i * 5 + (i >> 2)) % SIGN_PAIRS.length];

export const CELLS = {
  winA: [0, 0, 256, 256],
  winB: [256, 0, 256, 256],
  tallA: [512, 0, 256, 256],
  tallB: [768, 0, 256, 256],
  small: [1024, 0, 256, 256],
  wood: [1280, 0, 256, 256],
  shutter: [1536, 0, 256, 256],
  vest: [1792, 0, 256, 256],
  shopA: [0, 256, 512, 256],
  shopB: [512, 256, 512, 256],
  doorA: [1024, 256, 128, 256],
  doorB: [1152, 256, 128, 256],
  doorApt: [1280, 256, 128, 256],
  doorGlass: [1408, 256, 128, 256],
  doorSlide: [1536, 256, 128, 256],
  stair: [1664, 256, 128, 256],
  ac: [1792, 256, 128, 128],
  vent: [1792, 384, 128, 128],
  glassPanel: [1920, 256, 128, 256],
  bldg: [1024, 768, 256, 256],
  ribbon: [1280, 768, 256, 256],
  shopWood: [1536, 768, 256, 256],
  winFilm: [1792, 768, 256, 256],
} as const;
export type CellName = keyof typeof CELLS;

export interface AtlasLayout {
  cell: Record<CellName, Rect>;
  /** 横の看板（4:1）、縦の看板（1:4。番号は横と同じ業種） */
  sign: Rect[];
  vsign: Rect[];
  /** 横の看板の地の色（看板の箱を同じ色で塗る） */
  signBg: Rgb[];
}

export const uv = (x: number, y: number, w: number, h: number): Rect => {
  const i = 1.5;
  return [(x + i) / W, 1 - (y + h - i) / H, (x + w - i) / W, 1 - (y + i) / H];
};

/** 絵の表の四角の uv（絵を描かずに求める） */
export function atlasLayout(): AtlasLayout {
  const sign: Rect[] = [], vsign: Rect[] = [], signBg: Rgb[] = [];
  SIGN_TEXT.forEach((_, i) => {
    const x = (i % 4) * 256, y = 512 + Math.floor(i / 4) * 64;
    sign.push(uv(x, y, 256, 64));
    signBg.push(hex(pairOf(i)[0]));
  });
  VSIGN_TEXT.forEach((_, i) => vsign.push(uv(1024 + i * 64, 512, 64, 256)));
  const cell = {} as Record<CellName, Rect>;
  for (const k of Object.keys(CELLS) as CellName[]) cell[k] = uv(...(CELLS[k] as readonly [number, number, number, number]));
  return { cell, sign, vsign, signBg };
}
