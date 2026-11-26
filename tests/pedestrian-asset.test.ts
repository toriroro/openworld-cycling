// リアルな歩く人の形と動きのファイル（scripts/build-pedestrians.py が書く。町の見た目の草案 3 章）の中身を確かめる。
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { lookOf, ROWS, SLOT } from "../src/render/pedestrian-real.ts";

const buf = readFileSync(new URL("../public/assets/pedestrians/pedestrians-v2.bin", import.meta.url));
const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
const dv = new DataView(ab);
const hl = dv.getUint32(4, true);
const header = JSON.parse(new TextDecoder().decode(new Uint8Array(ab, 8, hl)));
const body = 8 + hl;

describe("歩く人のファイル", () => {
  it("組が 2 つ、体が 3 体ずつ、髪型が 5・6 種、歩き 24 コマと立ち 1 コマ、色の番号は描く側と同じ", () => {
    expect(dv.getUint32(0, true)).toBe(0x32444550);
    expect(header.groups.map((g: { variants: unknown[] }) => g.variants.length)).toEqual([3, 3]);
    expect(header.groups.map((g: { styles: unknown[] }) => g.styles.length)).toEqual([5, 6]);
    expect(header.walkFrames).toBe(24);
    expect(header.stride).toBe(1.25);
    expect(header.slots).toEqual(SLOT);
  });

  it("体: 番号が範囲の中で、どの体も各コマで足が地面に着き、背の高さが合う", () => {
    for (const g of header.groups) {
      const idx = new Uint16Array(ab, body + g.index, g.triangles * 3);
      for (const i of idx) expect(i).toBeLessThan(g.vertices);
      const vars = new Uint8Array(ab, body + g.variant, g.vertices);
      // 三角形は 1 つの体の中で閉じる（体ごとに隠すので）
      for (let t = 0; t < g.triangles; t++) expect(vars[idx[t * 3]] === vars[idx[t * 3 + 1]] && vars[idx[t * 3]] === vars[idx[t * 3 + 2]]).toBe(true);
      const frames = header.walkFrames + 1;
      const pos = new Uint16Array(ab, body + g.position, g.vertices * 3 * frames);
      g.variants.forEach((v: { height: number }, vi: number) => {
        for (let f = 0; f < frames; f++) {
          let lo = Infinity, hi = -Infinity;
          for (let i = 0; i < g.vertices; i++) {
            if (vars[i] !== vi) continue;
            const y = g.lo[1] + (pos[(f * g.vertices + i) * 3 + 1] / 65535) * (g.hi[1] - g.lo[1]);
            lo = Math.min(lo, y);
            hi = Math.max(hi, y);
          }
          expect(lo).toBeCloseTo(0, 2);
          // 髪の無い体の高さ（立ちの姿勢で脚をまっすぐにする分、指定より 3% ほど高い）
          expect(hi).toBeGreaterThan(v.height * 0.95);
          expect(hi).toBeLessThan(v.height * 1.05);
        }
      });
    }
  });

  it("髪: 髪型の番号が範囲の中で、三角形は 1 つの髪型の中で閉じ、頭の行列で動かすと頭の高さにある", () => {
    for (const g of header.groups) {
      const h = g.hair;
      const idx = new Uint16Array(ab, body + h.index, h.triangles * 3);
      const st = new Uint8Array(ab, body + h.style, h.vertices);
      for (let t = 0; t < h.triangles; t++) expect(st[idx[t * 3]] === st[idx[t * 3 + 1]] && st[idx[t * 3]] === st[idx[t * 3 + 2]]).toBe(true);
      for (const s of st) expect(s).toBeLessThan(g.styles.length);
      const P = new Float32Array(ab, body + h.position, h.vertices * 3);
      const frames = header.walkFrames + 1;
      const M = new Float32Array(ab, body + g.heads, g.variants.length * frames * 12);
      g.variants.forEach((v: { height: number }, vi: number) => {
        for (const f of [0, frames - 1]) {
          const m = M.subarray((vi * frames + f) * 12, (vi * frames + f + 1) * 12);
          let top = -Infinity;
          for (let i = 0; i < h.vertices; i++) top = Math.max(top, m[4] * P[i * 3] + m[5] * P[i * 3 + 1] + m[6] * P[i * 3 + 2] + m[7]);
          // 髪の頂は背の高さの少し上（帽子・お団子を含めて +10% まで）
          expect(top).toBeGreaterThan(v.height * 0.98);
          expect(top).toBeLessThan(v.height * 1.1);
        }
      });
    }
  });

  it("種から選ぶ見た目は範囲の中で、どの体・髪型もよく出る", () => {
    const looks = header.groups;
    const seen = new Set<string>();
    for (let s = 0; s < 20000; s++) {
      const seed = Math.imul(s, 0x9e3779b1) >>> 0;
      const l = lookOf(seed, looks);
      expect(l.row).toBeLessThan(ROWS);
      seen.add(`${l.group}:${l.variant}:${l.style}`);
    }
    // 3 体 × 5 髪型 + 3 体 × 6 髪型 = 33 通り
    expect(seen.size).toBe(33);
  });
});
