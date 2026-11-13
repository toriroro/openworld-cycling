// 格子ハッシュから勾配を選ぶ 2D 勾配ノイズ。加減乗除と floor だけで計算する（モック仕様 4.2）。

import { hash } from "./hash.ts";

// 16 方向の勾配。定数として書き、三角関数は使わない
const GX = [
  1, 0.92388, 0.70711, 0.38268, 0, -0.38268, -0.70711, -0.92388, -1, -0.92388, -0.70711, -0.38268, 0, 0.38268,
  0.70711, 0.92388,
];
const GZ = [
  0, 0.38268, 0.70711, 0.92388, 1, 0.92388, 0.70711, 0.38268, 0, -0.38268, -0.70711, -0.92388, -1, -0.92388,
  -0.70711, -0.38268,
];

function fade(t: number): number {
  return t * t * t * (t * (t * 6 - 15) + 10);
}

/** 勾配ノイズ。おおむね [-1, 1] */
export function gradNoise(seed: number, x: number, z: number): number {
  const ix = Math.floor(x);
  const iz = Math.floor(z);
  const fx = x - ix;
  const fz = z - iz;
  const h00 = hash(seed, ix, iz) & 15;
  const h10 = hash(seed, ix + 1, iz) & 15;
  const h01 = hash(seed, ix, iz + 1) & 15;
  const h11 = hash(seed, ix + 1, iz + 1) & 15;
  const n00 = GX[h00] * fx + GZ[h00] * fz;
  const n10 = GX[h10] * (fx - 1) + GZ[h10] * fz;
  const n01 = GX[h01] * fx + GZ[h01] * (fz - 1);
  const n11 = GX[h11] * (fx - 1) + GZ[h11] * (fz - 1);
  const u = fade(fx);
  const v = fade(fz);
  const a = n00 + (n10 - n00) * u;
  const b = n01 + (n11 - n01) * u;
  return (a + (b - a) * v) * 1.4;
}

/** 重ね合わせ。wavelength (m) の波長から octaves 段、波長を半分・振幅を gain 倍にして足す */
export function fbm(seed: number, x: number, z: number, wavelength: number, octaves: number, gain = 0.5): number {
  let sum = 0;
  let amp = 1;
  let norm = 0;
  let f = 1 / wavelength;
  for (let o = 0; o < octaves; o++) {
    // 段ごとに位置をずらして格子の重なりを避ける
    sum += amp * gradNoise(seed + o * 1013, x * f + o * 17.31, z * f - o * 9.73);
    norm += amp;
    amp *= gain;
    f *= 2;
  }
  return sum / norm;
}

/** 尾根型。0〜1。値が大きいほど稜線 */
export function ridged(seed: number, x: number, z: number, wavelength: number, octaves: number): number {
  let sum = 0;
  let amp = 1;
  let norm = 0;
  let f = 1 / wavelength;
  let weight = 1;
  for (let o = 0; o < octaves; o++) {
    let n = 1 - Math.abs(gradNoise(seed + o * 7919, x * f + o * 31.7, z * f + o * 11.3));
    n = n * n;
    n *= weight;
    weight = n < 0 ? 0 : n > 1 ? 1 : n;
    sum += amp * n;
    norm += amp;
    amp *= 0.5;
    f *= 2;
  }
  return sum / norm;
}

export function smoothstep(e0: number, e1: number, x: number): number {
  let t = (x - e0) / (e1 - e0);
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return t * t * (3 - 2 * t);
}

export function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}
