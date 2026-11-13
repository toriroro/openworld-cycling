// 未舗装路の路面の断面と色。横断方向: 草に溶ける端・2本の轍（締まって明るい）・中央の草の混じる筋。
// 道なり: 濡れた暗い所、乾いた明るい所、道ごとの色味。色は頂点色で付け、砂利の模様（gravel-texture）に掛ける。

import { gradNoise } from "../shared/world/noise.ts";

export interface StripBuilder {
  strip(
    left: number[][],
    right: number[][],
    color: number[] | ((i: number, side: 0 | 1) => number[]),
    uv?: (i: number, side: 0 | 1) => [number, number],
  ): void;
}

/** 断面の位置（半幅に対する割合）と、その位置の基本の色・高さ (m) */
const PROFILE: { u: number; color: number[]; dy: number }[] = [
  { u: -1.0, color: [0.5, 0.56, 0.34], dy: -0.03 }, // 端（草まじり）
  { u: -0.8, color: [0.78, 0.74, 0.62], dy: -0.01 },
  { u: -0.55, color: [0.95, 0.9, 0.78], dy: 0 }, // 轍
  { u: -0.3, color: [0.86, 0.82, 0.7], dy: 0.01 },
  { u: 0.0, color: [0.62, 0.64, 0.46], dy: 0.025 }, // 中央の筋
  { u: 0.3, color: [0.86, 0.82, 0.7], dy: 0.01 },
  { u: 0.55, color: [0.95, 0.9, 0.78], dy: 0 }, // 轍
  { u: 0.8, color: [0.78, 0.74, 0.62], dy: -0.01 },
  { u: 1.0, color: [0.5, 0.56, 0.34], dy: -0.03 },
];

/** 道ごとの色味（赤みのある土・灰色の砕石・黄土）。seed は道路の識別子のハッシュ */
const TINTS = [
  [1.0, 0.97, 0.9],
  [0.93, 0.93, 0.92],
  [1.03, 0.95, 0.82],
  [0.98, 0.92, 0.86],
];

export function buildGravelSurface(
  b: StripBuilder,
  at: (j: number, off: number, dy: number) => number[],
  cnt: number,
  sOf: (j: number) => number,
  hw: number,
  seed: number,
) {
  const tint = TINTS[(seed >>> 0) % TINTS.length];
  // 道なりの明暗（濡れた所・乾いた所）。道路ごとに位置をずらす
  const off = (seed % 9973) * 3.7;
  const along: number[] = [];
  const grassy: number[] = [];
  for (let j = 0; j < cnt; j++) {
    const s = sOf(j) + off;
    // 濡れた所は 20m ほどの間隔でまばらに、乾いた明るさは 40m ほどでゆるく
    const wet = Math.max(0, gradNoise(seed, s / 20, 0.5) - 0.25) * 0.4;
    const dust = gradNoise(seed + 1, s / 40, 0.5) * 0.1;
    along.push(1 - wet + dust);
    // 中央の草の筋は所々で濃く、所々で消える
    grassy.push(Math.max(0, Math.min(1, 0.5 + gradNoise(seed + 3, s / 22, 0.5) * 0.8)));
  }
  for (let k = 0; k < PROFILE.length - 1; k++) {
    const a = PROFILE[k];
    const c = PROFILE[k + 1];
    const L: number[][] = [];
    const R: number[][] = [];
    for (let j = 0; j < cnt; j++) {
      L.push(at(j, a.u * hw, a.dy));
      R.push(at(j, c.u * hw, c.dy));
    }
    const colorAt = (p: { u: number; color: number[] }, j: number) => {
      const centre = 1 - Math.min(1, Math.abs(p.u) / 0.3);
      const g = centre * grassy[j];
      // 道幅の中でも場所ごとに違うむら（縞にならないよう横方向にも変える）
      const patch = 1 + 0.14 * gradNoise(seed + 5, (sOf(j) + off) / 6, p.u * 1.7) + 0.08 * gradNoise(seed + 6, (sOf(j) + off) / 2.5, p.u * 3.1);
      // 色は sRGB で決め、材質の頂点色（線形）に直す
      return [
        (p.color[0] * (1 - g) + 0.5 * g) * tint[0] * along[j] * patch,
        (p.color[1] * (1 - g) + 0.58 * g) * tint[1] * along[j] * patch,
        (p.color[2] * (1 - g) + 0.32 * g) * tint[2] * along[j] * patch,
      ].map((v) => Math.pow(Math.max(0, v), 2.2));
    };
    b.strip(L, R, (j, side) => colorAt(side ? c : a, j), (j, side) => [((side ? c.u : a.u) * hw) / 2, sOf(j) / 2]);
  }
}
