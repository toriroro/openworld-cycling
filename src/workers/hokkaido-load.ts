// 北海道の世界の変換データを読む（北海道の草案 2.2・20 章）。Worker とメインスレッドの両方から使う。
// 読み先は base（既定 HOKKAIDO_BASE）の 1 か所で、アプリでは同梱分と配信分を切り替える（概要仕様 9.5 #6）。
// 最初に読むのは world.json（道路・地名）・roads.bin・overview.bin（地形の縮図）だけで、
// 地形・建物・走らない道・歩道の 2km 四方の頁は、使う側が ensure で近くの分だけ読む。

import {
  HokkaidoBuildings,
  type HokkaidoMeta,
  type HokkaidoPageLoader,
  HokkaidoSidewalks,
  HokkaidoStreets,
  HokkaidoTerrain,
  HokkaidoWorld,
} from "../shared/world/hokkaido.ts";

/** 建物・走らない道・歩道の区画の一辺 (m)（scripts/hokkaido/build.ts と同じ） */
const CITY_CELL = 250;

async function get(base: string, name: string): Promise<Response> {
  const res = await fetch(base + name);
  if (!res.ok) throw new Error(`${base}${name} ${res.status}`);
  return res;
}

/** 頁を読む関数（無い頁は null） */
export function pageLoader(base: string): HokkaidoPageLoader {
  return async (path) => {
    const res = await fetch(base + path);
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`${base}${path} ${res.status}`);
    return res.arrayBuffer();
  };
}

type TerrainMeta = Pick<HokkaidoMeta, "grid" | "pages" | "overview">;

/** 道路・地名・地点まで（道路の Worker・メインスレッド）。withCity なら建物・走らない道・歩道の頁の入れ物も作る（メインスレッド） */
export async function loadHokkaidoWorld(base: string, seed: number, withCity = false): Promise<HokkaidoWorld> {
  const [meta, overview, roads] = await Promise.all([
    get(base, "world.json").then((r) => r.json() as Promise<HokkaidoMeta>),
    get(base, "overview.bin").then((r) => r.arrayBuffer()),
    get(base, "roads.bin").then((r) => r.arrayBuffer()),
  ]);
  if (meta.version !== 2) throw new Error(`変換データの版が古い（${meta.version}）。npx tsx scripts/hokkaido/build.ts で作り直す`);
  const load = pageLoader(base);
  const w = new HokkaidoWorld(meta, overview, roads, seed, load);
  if (withCity) {
    const c = cityStores(meta, load);
    w.buildings = c.buildings;
    w.streets = c.streets;
    w.sidewalks = c.sidewalks;
  }
  return w;
}

export function cityStores(meta: TerrainMeta, load: HokkaidoPageLoader) {
  return {
    buildings: new HokkaidoBuildings(CITY_CELL, meta.grid, meta.pages, load),
    streets: new HokkaidoStreets(CITY_CELL, meta.grid, meta.pages, load),
    sidewalks: new HokkaidoSidewalks(CITY_CELL, meta.grid, meta.pages, load),
  };
}

/** 地形の格子と頁の並びだけ（地形・建物の Worker） */
export async function loadTerrainMeta(base: string): Promise<TerrainMeta> {
  const meta = await get(base, "terrain.json").then((r) => r.json() as Promise<TerrainMeta & { version: number }>);
  if (meta.version !== 2) throw new Error(`変換データの版が古い（${meta.version}）。npx tsx scripts/hokkaido/build.ts で作り直す`);
  return meta;
}

/** 地形だけ（地形の Worker・建物の Worker） */
export async function loadHokkaidoTerrain(base: string, seed: number, meta?: TerrainMeta): Promise<HokkaidoTerrain> {
  const [m, overview] = await Promise.all([meta ?? loadTerrainMeta(base), get(base, "overview.bin").then((r) => r.arrayBuffer())]);
  return new HokkaidoTerrain(m, overview, seed, pageLoader(base));
}
