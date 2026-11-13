import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ROAD_CLASSES } from "../src/shared/world/constants.ts";
import { hash } from "../src/shared/world/hash.ts";
import { checkConnectivity, checkGrades, checkRadius, roadHash, roadsHash } from "../src/shared/world/inspect.ts";
import { gradNoise } from "../src/shared/world/noise.ts";
import { computeProfile } from "../src/shared/world/shape.ts";
import { Terrain } from "../src/shared/world/terrain.ts";
import { type Rect, World } from "../src/shared/world/world.ts";

const RECT: Rect = { x0: 20000, z0: -50000, x1: 32000, z1: -38000 };

describe("shared/world の規則", () => {
  it("分岐に関わる計算に超越関数・Math.random を使わない（モック仕様 4.2）", () => {
    const dir = "src/shared/world";
    for (const f of readdirSync(dir)) {
      const src = readFileSync(`${dir}/${f}`, "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/\/\/.*$/gm, "");
      expect(src, f).not.toMatch(/Math\.(sin|cos|tan|asin|acos|atan|atan2|exp|expm1|pow|log|log2|log10|random|hypot|cbrt|sinh|cosh|tanh)\b/);
      expect(src, f).not.toMatch(/\*\*/);
    }
  });

  it("DOM・Three.js・platform を読み込まない（モック仕様 3.3）", () => {
    const dir = "src/shared/world";
    for (const f of readdirSync(dir)) {
      const src = readFileSync(`${dir}/${f}`, "utf8");
      for (const m of src.matchAll(/from\s+"([^"]+)"/g)) expect(m[1], f).toMatch(/^\.\/[\w-]+\.ts$/);
      expect(src, f).not.toMatch(/\b(document|window|localStorage|indexedDB)\b/);
    }
  });
});

describe("ハッシュと高さ", () => {
  it("同じ入力から同じ値（生成器の変更を検出する固定値。変わったら GENERATOR_VERSION を上げて値を更新する）", () => {
    expect(hash(1, 2, 3, 4)).toBe(hash(1, 2, 3, 4));
    expect([hash(1, 0, 0, 0), hash(7, -3, 12, 5)]).toMatchInlineSnapshot(`
      [
        504418101,
        3313387842,
      ]
    `);
    expect(gradNoise(3, 1.25, -7.5).toFixed(12)).toMatchInlineSnapshot(`"-0.412832345215"`);
    const t = new Terrain(1);
    expect([t.height(1234.5, -6789.25), t.routeHeight(30000, -45000)].map((v) => v.toFixed(9))).toMatchInlineSnapshot(`
      [
        "197.726097841",
        "665.550116104",
      ]
    `);
  });

  it("標高は海底 −200m 〜 山頂 1,800m 程度に収まる", () => {
    const t = new Terrain(2);
    let lo = Infinity;
    let hi = -Infinity;
    for (let x = -150000; x < 150000; x += 3000)
      for (let z = -150000; z < 150000; z += 3000) {
        const h = t.height(x, z);
        lo = Math.min(lo, h);
        hi = Math.max(hi, h);
      }
    expect(lo).toBeGreaterThan(-230);
    expect(hi).toBeLessThan(1900);
    expect(hi).toBeGreaterThan(900);
  });
});

describe("縦断", () => {
  it("両端の高さに合い、各区間が上限の勾配以内、接続点の前後 30m は 3% 以内", () => {
    const n = 2001;
    const xz = new Float64Array(n * 2);
    const ground = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      xz[i * 2] = i * 2;
      ground[i] = 100 + 80 * Math.sin(i / 60) + (i > 1000 ? 300 : 0);
    }
    const y = computeProfile({ xz, routeGround: ground, water: new Uint8Array(n), maxGrade: 0.1, startY: 90, endY: 420 });
    expect(y[0]).toBe(90);
    expect(y[n - 1]).toBe(420);
    for (let i = 1; i < n; i++) {
      const g = Math.abs(y[i] - y[i - 1]) / 2;
      const nearEnd = i * 2 <= 30 || (n - 1 - (i - 1)) * 2 <= 30;
      expect(g).toBeLessThanOrEqual((nearEnd ? 0.03 : 0.1) + 1e-9);
    }
  });
});

describe("道路網（12km 四方）", () => {
  const w = new World(1);
  const roads = w.roadsInRect(RECT);

  it("道路ができる", () => {
    expect(roads.length).toBeGreaterThan(10);
  });

  it("別の順序・別の起点から生成しても点列が一致する", () => {
    const w2 = new World(1);
    w2.roadsInRect({ x0: RECT.x1 - 3000, z0: RECT.z1 - 3000, x1: RECT.x1 + 9000, z1: RECT.z1 + 9000 });
    w2.roadsInRect({ x0: RECT.x0, z0: RECT.z0, x1: RECT.x0 + 4000, z1: RECT.z0 + 4000 });
    const r2 = new Map(w2.roadsInRect(RECT).map((r) => [r.id, r]));
    for (const r of roads) expect(roadHash(r2.get(r.id)!), r.id).toBe(roadHash(r));
  });

  it("点列のハッシュ（生成器の変更を検出する固定値）", () => {
    expect(roadsHash(roads)).toMatchInlineSnapshot(`"63b49c98"`);
  });

  it("すべての道路が等級の最大勾配以内", () => {
    expect(checkGrades(roads).over).toBe(0);
  });

  it("最小曲線半径を大きく下回る点がない", () => {
    const r = checkRadius(roads, 6, 0.8);
    expect(r.under).toBe(0);
  });

  it("範囲内の結節点がつながる", () => {
    const c = checkConnectivity(w, RECT, w.roadsInRect({ x0: RECT.x0 - 8000, z0: RECT.z0 - 8000, x1: RECT.x1 + 8000, z1: RECT.z1 + 8000 }));
    expect(c.isolated).toEqual([]);
    expect(c.detached).toEqual([]);
  });

  it("道路の点の間隔は ROAD_STEP 以下、幅と路面は等級どおり", () => {
    for (const r of roads) {
      const n = r.points.length / 3;
      expect(r.length / (n - 1)).toBeLessThanOrEqual(2 + 1e-9);
      expect(r.width).toBe(ROAD_CLASSES[r.cls].width);
      expect(r.surface).toBe(ROAD_CLASSES[r.cls].surface);
    }
  });
});
