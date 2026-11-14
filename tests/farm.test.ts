// 農地（src/render/farm）: 区画と作物の決め方、地形タイルへ持たせる値。
import { describe, expect, it } from "vitest";
import { BLOCK_U, BLOCK_V, blockOpen, CROP_MOWN, CROP_PADDY, fieldAt, fieldSeed, fieldShader, openAt } from "../src/render/farm/fields.ts";
import { WORLD_SEED } from "../src/shared/world/constants.ts";
import { Terrain } from "../src/shared/world/terrain.ts";
import { buildTile } from "../src/workers/terrain-tile.ts";
import { VEG_STRIDE, VEG_TREE } from "../src/workers/vegetation-place.ts";

const seed = fieldSeed(WORLD_SEED);

describe("農地の区画", () => {
  it("区画の 5〜9 割が農地で、残りが林になる", () => {
    let open = 0;
    for (let v = 0; v < 100; v++) for (let u = 0; u < 100; u++) if (blockOpen(seed, u, v)) open++;
    expect(open / 10000).toBeGreaterThan(0.5);
    expect(open / 10000).toBeLessThan(0.9);
  });

  it("同じ場所は同じ圃場になり、区画の中の位置で圃場が分かれる", () => {
    const a = fieldAt(seed, 1234.5, -678.9, 0.5), b = fieldAt(seed, 1234.5, -678.9, 0.5);
    expect(a).toEqual(b);
    // 負の座標でも区画番号は 0 以上
    expect(a.bu).toBeGreaterThanOrEqual(0);
    expect(a.bv).toBeGreaterThanOrEqual(0);
    expect(openAt(seed, 1234.5, -678.9)).toBe(blockOpen(seed, a.bu, a.bv));
    // 縁までの距離は圃場の幅の半分以下
    expect(a.edge).toBeGreaterThanOrEqual(0);
    expect(a.edge).toBeLessThanOrEqual(BLOCK_U / 2);
  });

  it("田の帯は大半が水田、牧草地の帯には刈り取った牧草地がある", () => {
    const count = (kind: number, crop: number) => {
      let n = 0, all = 0;
      for (let v = 0; v < 60; v++)
        for (let u = 0; u < 60; u++) {
          all++;
          if (fieldAt(seed, (u + 0.37) * 31, (v + 0.5) * BLOCK_V, kind).crop === crop) n++;
        }
      return n / all;
    };
    expect(count(0.1, CROP_PADDY)).toBeGreaterThan(0.7);
    expect(count(0.9, CROP_MOWN)).toBeGreaterThan(0.15);
    expect(count(0.9, CROP_PADDY)).toBe(0);
  });

  it("材質へ足す GLSL に、欠けた値が入っていない", () => {
    const g = fieldShader(seed);
    expect(g).not.toMatch(/undefined|NaN|\$\{/);
    expect(g).toContain("vec3 farmColor");
    expect(g).toContain("float blockOpen");
  });
});

describe("地形タイルの農地の値", () => {
  const terrain = new Terrain(WORLD_SEED);
  // 起点の南の畑（scripts/farm-report.ts で調べた場所）
  const out = buildTile(terrain, { x0: -32512, z0: 12544, size: 256, cells: 32, skirt: 6, roads: null, uvRepeat: 16, vegDetail: 2, vegDensity: 1 });

  it("頂点ごとに区画の座標・重み・寄りを持つ", () => {
    expect(out.field.length).toBe((out.position.length / 3) * 4);
    let farmed = 0;
    for (let i = 0; i < out.field.length; i += 4) {
      expect(out.field[i]).toBeGreaterThanOrEqual(0);
      expect(out.field[i + 1]).toBeGreaterThanOrEqual(0);
      expect(out.field[i + 2]).toBeGreaterThanOrEqual(0);
      expect(out.field[i + 2]).toBeLessThanOrEqual(1);
      expect(out.field[i + 3]).toBeGreaterThanOrEqual(0);
      expect(out.field[i + 3]).toBeLessThanOrEqual(1);
      if (out.field[i + 2] > 0.5) farmed++;
    }
    expect(farmed).toBeGreaterThan(200);
  });

  it("農地の区画の中には、防風林の並木のほかに木を置かない", () => {
    let inField = 0;
    for (let i = 0; i < out.veg.length; i += VEG_STRIDE) {
      if (out.veg[i + 5] !== VEG_TREE) continue;
      const wx = -32512 + out.veg[i], wz = 12544 + out.veg[i + 2];
      if (!openAt(seed, wx, wz)) continue;
      // 並木は区画の西の縁から 5m（±1.2m）
      const off = wx - Math.floor(wx / BLOCK_U) * BLOCK_U;
      if (Math.abs(off - 5) > 1.3) inField++;
    }
    // 重みが小さい所（道路や水のそば）には木が残る。農地の真ん中に林ができていないこと
    expect(inField).toBeLessThan(12);
  });
});
