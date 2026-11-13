// 種と整数の格子番号から作るハッシュ（モック仕様 4.2【固定】）。Math.random は使わない。

function fmix(h: number): number {
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

/** 種と最大3つの整数から 32bit の符号なし整数を作る */
export function hash(seed: number, a: number, b = 0, c = 0): number {
  let h = fmix((seed | 0) ^ 0x9e3779b9);
  h = fmix(h ^ Math.imul(a | 0, 0x27d4eb2d));
  h = fmix(h ^ Math.imul(b | 0, 0x165667b1));
  h = fmix(h ^ Math.imul(c | 0, 0x61c88647));
  return h;
}

/** [0, 1) の数 */
export function hashUnit(seed: number, a: number, b = 0, c = 0): number {
  return hash(seed, a, b, c) / 4294967296;
}

/** 文字列を 32bit に畳む（道路の識別子から種を作る時に使う） */
export function hashString(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return fmix(h);
}
