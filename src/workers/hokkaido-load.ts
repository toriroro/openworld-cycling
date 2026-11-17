// 北海道の世界の変換データを読む（北海道の草案 2.2）。Worker とメインスレッドの両方から使う。
// 読み先は base（既定 HOKKAIDO_BASE）の 1 か所で、アプリでは同梱分と配信分を切り替える（概要仕様 9.5 #6）。

import {
  HokkaidoBuildings,
  type HokkaidoBuildingIndex,
  type HokkaidoMeta,
  type HokkaidoStreetIndex,
  HokkaidoStreets,
  HokkaidoTerrain,
  HokkaidoWorld,
  type HokkaidoSidewalkIndex,
  HokkaidoSidewalks,
} from "../shared/world/hokkaido.ts";

async function get(base: string, name: string): Promise<Response> {
  const res = await fetch(base + name);
  if (!res.ok) throw new Error(`${base}${name} ${res.status}`);
  return res;
}

/** 道路・地名・地点まで全部（道路の Worker・メインスレッド）。建物はメインスレッドだけ読む（無ければ null） */
export async function loadHokkaidoWorld(base: string, seed: number, withBuildings = false): Promise<HokkaidoWorld> {
  const [meta, terrain, roads, buildings, streets, sidewalks] = await Promise.all([
    get(base, "world.json").then((r) => r.json() as Promise<HokkaidoMeta>),
    get(base, "terrain.bin").then((r) => r.arrayBuffer()),
    get(base, "roads.bin").then((r) => r.arrayBuffer()),
    withBuildings ? loadBuildings(base) : Promise.resolve(null),
    withBuildings ? loadStreets(base) : Promise.resolve(null),
    withBuildings ? loadSidewalks(base) : Promise.resolve(null),
  ]);
  const w = new HokkaidoWorld(meta, terrain, roads, seed);
  w.buildings = buildings;
  w.streets = streets;
  w.sidewalks = sidewalks;
  return w;
}

export async function loadSidewalks(base: string): Promise<HokkaidoSidewalks | null> {
  try {
    const [index, pts, trees] = await Promise.all([
      get(base, "sidewalks.json").then((r) => r.json() as Promise<HokkaidoSidewalkIndex>),
      get(base, "sidewalks.bin").then((r) => r.arrayBuffer()),
      get(base, "trees.bin").then((r) => r.arrayBuffer()),
    ]);
    return new HokkaidoSidewalks(index, pts, trees);
  } catch {
    return null;
  }
}

export async function loadStreets(base: string): Promise<HokkaidoStreets | null> {
  try {
    const [index, data] = await Promise.all([
      get(base, "streets.json").then((r) => r.json() as Promise<HokkaidoStreetIndex>),
      get(base, "streets.bin").then((r) => r.arrayBuffer()),
    ]);
    return new HokkaidoStreets(index, data);
  } catch {
    return null;
  }
}

export async function loadBuildings(base: string): Promise<HokkaidoBuildings | null> {
  try {
    const [index, data] = await Promise.all([
      get(base, "buildings.json").then((r) => r.json() as Promise<HokkaidoBuildingIndex>),
      get(base, "buildings.bin").then((r) => r.arrayBuffer()),
    ]);
    return new HokkaidoBuildings(index, data);
  } catch {
    return null;
  }
}

/** 地形だけ（地形の Worker） */
export async function loadHokkaidoTerrain(base: string, seed: number): Promise<HokkaidoTerrain> {
  const [meta, terrain] = await Promise.all([
    get(base, "terrain.json").then((r) => r.json() as Promise<{ grid: HokkaidoMeta["grid"] }>),
    get(base, "terrain.bin").then((r) => r.arrayBuffer()),
  ]);
  return new HokkaidoTerrain(meta.grid, terrain, seed);
}
