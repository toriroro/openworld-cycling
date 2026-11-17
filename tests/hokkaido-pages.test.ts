// 北海道の変換データの頁（北海道の草案 20 章）: 書いた頁を読んで、元の格子・索引と同じ値になるか。
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { writeBuildingPages, writeSidewalkPages, writeStreetPages, writeTerrainPages } from "../scripts/hokkaido/pages.ts";
import { BUILDING_REC, HOKKAIDO_PAGE, HokkaidoBuildings, HokkaidoSidewalks, HokkaidoStreets, HokkaidoTerrain, type HokkaidoPages } from "../src/shared/world/hokkaido.ts";

const dir = mkdtempSync(join(tmpdir(), "hokkaido-pages-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const load = async (path: string) => {
  try {
    const b = readFileSync(join(dir, path));
    return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
  } catch {
    return null;
  }
};

// 頁の縁がそろわない格子（原点 -3010、点の数は頁の倍数でない）
const g = { x0: -3010, z0: -2990, step: 10, nx: 523, nz: 431 };
const n = g.nx * g.nz;
const h = new Int16Array(n);
const water = new Uint8Array(n);
const landuse = new Uint8Array(n);
const cov = new Uint8Array(n);
const com = new Uint8Array(n);
for (let j = 0; j < g.nz; j++)
  for (let i = 0; i < g.nx; i++) {
    const k = j * g.nx + i;
    h[k] = (i * 7 + j * 13) % 2000;
    water[k] = (i + j) % 4;
    landuse[k] = (i * 3 + j) % 5;
    cov[k] = (i * j) % 256;
    com[k] = (i + 2 * j) % 256;
  }
const info = writeTerrainPages(dir, g, h, [water, landuse, cov, com]);
const pages: HokkaidoPages = { ...info.pages, buildings: [], streets: [], sidewalks: [] };
const meta = { grid: g, pages, overview: info.overview };

function direct(x: number, z: number) {
  const fx = (x - g.x0) / g.step;
  const fz = (z - g.z0) / g.step;
  const i = Math.min(g.nx - 2, Math.floor(fx));
  const j = Math.min(g.nz - 2, Math.floor(fz));
  const u = fx - i;
  const v = fz - j;
  const k = j * g.nx + i;
  return ((h[k] * (1 - u) + h[k + 1] * u) * (1 - v) + (h[k + g.nx] * (1 - u) + h[k + g.nx + 1] * u) * v) * 0.1;
}

describe("地形の頁", () => {
  it("頁を読めば元の 10m 格子と同じ高さ・水・土地利用（頁の縁と格子の端を含む）", async () => {
    const t = new HokkaidoTerrain(meta, (await load("overview.bin"))!, 1, load);
    await t.ensure({ x0: g.x0, z0: g.z0, x1: g.x0 + g.nx * g.step, z1: g.z0 + g.nz * g.step });
    const xs = [g.x0, g.x0 + 5, g.x0 + 1995, g.x0 + 2000, g.x0 + 2003.7, g.x0 + 4000, g.x0 + (g.nx - 1) * g.step - 0.01, g.x0 + (g.nx - 1) * g.step];
    const zs = [g.z0, g.z0 + 2000, g.z0 + 2001.2, g.z0 + 3999.9, g.z0 + (g.nz - 1) * g.step];
    for (const x of xs)
      for (const z of zs) {
        expect(t.height(x, z)).toBeCloseTo(direct(x, z), 5);
        const i = Math.round((x - g.x0) / g.step);
        const j = Math.round((z - g.z0) / g.step);
        expect(t.sample(x, z, false).water).toBe(water[j * g.nx + i]);
        expect(t.coverage(x, z)).toBeCloseTo(cov[j * g.nx + i] / 255, 6);
      }
  });

  it("読んでいない所は縮図で答え、遠い頁は捨てられる", async () => {
    const t = new HokkaidoTerrain(meta, (await load("overview.bin"))!, 1, load);
    // 縮図の格子点では元の値と同じ
    const x = g.x0 + 50 * 7;
    const z = g.z0 + 50 * 3;
    expect(t.loadedPages).toBe(0);
    expect(t.height(x, z)).toBeCloseTo(h[3 * 5 * g.nx + 7 * 5] * 0.1, 5);
    await t.ensure({ x0: x, z0: z, x1: x, z1: z });
    expect(t.loadedPages).toBe(1);
    t.evict(x + 20000, z, 3000);
    expect(t.loadedPages).toBe(0);
  });
});

describe("建物・走らない道・歩道の頁", () => {
  // 区画 250m。2 つの頁にまたがる区画
  const cell = 250;
  const keys = ["-12,-11", "-5,-3", "0,0", "3,1"];
  const recs = new Float32Array(keys.length * 2 * BUILDING_REC);
  const cells: Record<string, [number, number]> = {};
  keys.forEach((k, q) => {
    cells[k] = [q * 2, 2];
    const [cx, cz] = k.split(",").map(Number);
    for (let r = 0; r < 2; r++) {
      recs[(q * 2 + r) * BUILDING_REC] = cx * cell + 10 + r;
      recs[(q * 2 + r) * BUILDING_REC + 1] = cz * cell + 20;
      recs[(q * 2 + r) * BUILDING_REC + 15] = q * 10 + r;
    }
  });

  it("建物: どの頁から読んでも区画の記録が同じ", async () => {
    const w = writeBuildingPages(dir, g, recs, { cell, rec: BUILDING_REC, cells });
    expect(w.pages.length).toBeGreaterThan(1);
    const b = new HokkaidoBuildings(cell, g, { ...pages, buildings: w.pages }, load);
    // 遠い頁から先に読む
    await b.ensure({ x0: 0, z0: 0, x1: 1000, z1: 500 });
    await b.ensure({ x0: -3010, z0: -2990, x1: 0, z1: 0 });
    for (const [q, k] of keys.entries()) {
      const c = b.index.cells[k];
      expect(c[1]).toBe(2);
      for (let r = 0; r < 2; r++) expect(b.data[(c[0] + r) * BUILDING_REC + 15]).toBe(q * 10 + r);
    }
    expect(b.count).toBe(keys.length * 2);
  });

  it("走らない道・歩道・木: 位置をずらしても点が同じ", async () => {
    const pts = new Float32Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    const pieces: Record<string, [number, number, number, number][]> = { "-12,-11": [[0, 2, 50, 0]], "3,1": [[2, 4, 40, 1]] };
    const ws = writeStreetPages(dir, g, pts, { cell, kinds: ["street", "path"], pieces });
    const s = new HokkaidoStreets(cell, g, { ...pages, streets: ws.pages }, load);
    await s.ensure({ x0: 0, z0: 0, x1: 1000, z1: 500 });
    await s.ensure({ x0: -3010, z0: -2990, x1: 0, z1: 0 });
    for (const [k, list] of Object.entries(pieces))
      list.forEach(([off, cnt, wd, kind], q) => {
        const [o2, c2, w2, k2] = s.index.pieces[k][q];
        expect([c2, w2, k2]).toEqual([cnt, wd, kind]);
        expect([...s.pts.subarray(o2 * 2, (o2 + c2) * 2)]).toEqual([...pts.subarray(off * 2, (off + cnt) * 2)]);
      });

    const swPts = new Float32Array(Array.from({ length: 30 }, (_, i) => i));
    const trees = new Float32Array(Array.from({ length: 15 }, (_, i) => 100 + i));
    const sw = writeSidewalkPages(dir, g, swPts, trees, { cell, rec: 5, sidewalks: { "-5,-3": [[0, 2]], "3,1": [[2, 4]] }, trees: { "-5,-3": [2], "3,1": [0, 1] } });
    const w = new HokkaidoSidewalks(cell, g, { ...pages, sidewalks: sw.pages }, load);
    await w.ensure({ x0: 0, z0: 0, x1: 1000, z1: 500 });
    await w.ensure({ x0: -3010, z0: -2990, x1: 0, z1: 0 });
    const [o, c] = w.index.sidewalks["3,1"][0];
    expect([...w.pts.subarray(o * 5, (o + c) * 5)]).toEqual([...swPts.subarray(10, 30)]);
    const t = w.index.trees["-5,-3"][0];
    expect([...w.trees.subarray(t * 5, t * 5 + 5)]).toEqual([...trees.subarray(10, 15)]);
  });
});

it("頁の一辺は区画（250m）の倍数", () => {
  expect(HOKKAIDO_PAGE % 250).toBe(0);
});
