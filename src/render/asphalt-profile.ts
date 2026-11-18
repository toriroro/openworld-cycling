// 舗装路の路面の断面と色、補修跡。
// - 道路ごと・工区ごとの舗装の古さ（新しいほど黒く、古いほど灰色で少し黄みがかる）
// - 轍のすり減り（車輪の通る所は明るくなめらか、車線の中ほどは油で少し暗い、端は土で暗い）
// - 補修跡（四角い打ち替え。古さの違う舗装として少し暗い/明るい）
// 色は sRGB で決めて線形に直し、アスファルトの模様に掛ける。

import { gradNoise } from "../shared/world/noise.ts";
import { hash } from "../shared/world/hash.ts";
import type { StripBuilder } from "./gravel-profile.ts";

export interface QuadBuilder {
  quad(a: number[], b: number[], c: number[], d: number[], color: number[], uvs?: number[][], both?: boolean): void;
}

const toLinear = (v: number) => Math.pow(Math.max(0, v), 2.2);

/** 断面の点（中心からの距離 m）と明るさ。2 車線は車線ごとに轍、1 車線（中央線なし）は道の中央に轍 */
function profile(hw: number, twoLane: boolean): { off: number; k: number }[] {
  const pts: { off: number; k: number }[] = [];
  const add = (off: number, k: number) => {
    if (off > -hw && off < hw) pts.push({ off, k });
  };
  pts.push({ off: -hw, k: 0.8 });
  add(-hw + 0.35, 0.93);
  const lanes = twoLane ? [-hw / 2, hw / 2] : [0];
  for (const c of lanes) {
    for (const w of [-0.85, 0.85]) {
      add(c + w - 0.4, 1.0);
      add(c + w, 1.32);
      add(c + w + 0.4, 1.0);
    }
    add(c, 0.84);
  }
  add(hw - 0.35, 0.93);
  pts.push({ off: hw, k: 0.8 });
  pts.sort((a, b) => a.off - b.off);
  // 近すぎる点をまとめる
  const out: typeof pts = [];
  for (const p of pts) if (!out.length || p.off - out[out.length - 1].off > 0.12) out.push(p);
  return out;
}

export function buildAsphaltSurface(
  b: StripBuilder,
  patches: QuadBuilder,
  at: (j: number, off: number, dy: number) => number[],
  cnt: number,
  sOf: (j: number) => number,
  hw: number,
  twoLane: boolean,
  seed: number,
  ext: (j: number) => number,
  /** 遠くの段: 断面を両端の 2 点にし、補修跡を作らない（北海道の草案 23 章） */
  simple = false,
) {
  // 工区: 120〜520m ごとに古さが変わる
  const age = (s: number) => {
    let start = 0;
    let k = 0;
    // 区切りの位置はハッシュで決める（s までの工区を順にたどる）
    for (;;) {
      const len = 120 + (hash(seed, k, 1) % 400);
      if (start + len > s) break;
      start += len;
      k++;
    }
    const base = (hash(seed, 7, 3) % 1000) / 1000; // 道路ごとの基調
    const sec = (hash(seed, k, 2) % 1000) / 1000;
    return Math.min(1, Math.max(0, 0.35 * base + 0.65 * sec));
  };
  const prof = simple ? [{ off: -hw, k: 0.97 }, { off: hw, k: 0.97 }] : profile(hw, twoLane);
  const toneAt = new Array<number[]>(cnt);
  const patchK = new Array<number>(cnt);
  const a01 = new Array<number>(cnt);
  const off = (seed % 9973) * 2.3;
  for (let j = 0; j < cnt; j++) {
    const a = age(sOf(j));
    // 新しい: 黒っぽい、古い: 灰色で黄み
    const t = 0.66 + 0.72 * a;
    toneAt[j] = [t * (1 + 0.02 * a), t * (1 + 0.01 * a), t * (1 - 0.04 * a)];
    a01[j] = a;
    patchK[j] = 1 + 0.05 * gradNoise(seed + 9, (sOf(j) + off) / 30, 0.3);
  }
  for (let k = 0; k < prof.length - 1; k++) {
    const p = prof[k];
    const q = prof[k + 1];
    const L: number[][] = [];
    const R: number[][] = [];
    for (let j = 0; j < cnt; j++) {
      const e = ext(j);
      L.push(at(j, k === 0 ? p.off - e : p.off, 0));
      R.push(at(j, k === prof.length - 2 ? q.off + e : q.off, 0));
    }
    const colorAt = (pt: { off: number; k: number }, j: number) => {
      // 轍のすり減りは古いほどはっきり
      const wear = 1 + (pt.k - 1) * (0.45 + 0.55 * a01[j]);
      const m = 1 + 0.05 * gradNoise(seed + 11, (sOf(j) + off) / 7, pt.off * 0.8);
      return toneAt[j].map((v) => toLinear(v * wear * patchK[j] * m));
    };
    b.strip(L, R, (j, side) => colorAt(side ? q : p, j), (j, side) => {
      const o = side ? q.off : p.off;
      return [o / 4, sOf(j) / 4];
    });
  }
  if (simple) return;
  // 補修跡: 40〜160m ごとに1つ、長さ 1.5〜8m、幅 1〜3m
  const s0 = sOf(0);
  const s1 = sOf(cnt - 1);
  let s = 0;
  let k = 0;
  while (s < s1) {
    const h = hash(seed, k, 5);
    s += 40 + (h % 120);
    k++;
    if (s < s0 || s > s1 - 1) continue;
    const len = 1.5 + ((h >>> 8) % 65) / 10;
    const wid = Math.min(2 * hw - 0.4, 1 + ((h >>> 16) % 20) / 10);
    const lat = -hw + 0.2 + (((h >>> 20) % 100) / 100) * (2 * hw - 0.4 - wid);
    const dark = (h >>> 27) & 1;
    // 周りの舗装より暗い（新しい打ち替え）か明るい（古い打ち替え）
    const jm = Math.min(cnt - 1, Math.max(0, Math.round((s - s0) / ((s1 - s0) / Math.max(1, cnt - 1)))));
    const f = dark ? 0.68 : 1.25;
    const col = toneAt[jm].map((v) => toLinear(v * f));
    // 道なりに沿わせるため、補修跡の前後を断面の位置で取る
    const ds = (s1 - s0) / Math.max(1, cnt - 1);
    const ja = Math.round((s - s0) / ds);
    const jb = Math.min(cnt - 1, Math.round((s + len - s0) / ds));
    if (jb <= ja) continue;
    for (let j = ja; j < jb; j++) {
      const a1 = at(j, lat, 0.004), b1 = at(j, lat + wid, 0.004);
      const a2 = at(j + 1, lat, 0.004), b2 = at(j + 1, lat + wid, 0.004);
      patches.quad(a1, b1, b2, a2, col, [
        [lat / 4, sOf(j) / 4],
        [(lat + wid) / 4, sOf(j) / 4],
        [(lat + wid) / 4, sOf(j + 1) / 4],
        [lat / 4, sOf(j + 1) / 4],
      ]);
    }
  }
}
