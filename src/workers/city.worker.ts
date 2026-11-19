// 北海道の世界の建物・敷地・走らない道の形を作る Worker（北海道の草案 18 章）。
// メインスレッドで作ると 1 フレームに 10〜50ms かかったため。結果は転送できる配列で返す（概要仕様 9.5 #3）。

import { HOKKAIDO_BASE, type HokkaidoBuildings, type HokkaidoSidewalks, type HokkaidoStreets, type HokkaidoTerrain, rectOfCells, type StreetPiece } from "../shared/world/hokkaido.ts";
import { buildFar, buildNear, buildStreets, withoutExcluded } from "../render/city-build.ts";
import type { MeshArrays } from "../render/building/mesher.ts";
import { cityStores, loadHokkaidoTerrain, loadTerrainMeta, pageLoader } from "./hokkaido-load.ts";

export type CityRequest =
  | { type: "init"; base?: string; seed: number }
  /** 描かない建物（名所の模型で置き換える外形。世界座標の [x, z, ...]） */
  | { type: "exclude"; polys: number[][] }
  /** subCells: 狭い方の区画。走らない道では幹線の歩道を描く区画、近くの建物では細部まで作る区画 */
  | { type: "near" | "far" | "streets"; id: number; cells: string[]; subCells?: string[]; ox: number; oz: number };

export type CityResponse =
  | { type: "near"; id: number; kinds: (MeshArrays | null)[]; triangles: number; buildings: number; ms: number }
  | { type: "far"; id: number; meshes: MeshArrays[]; triangles: number; buildings: number; ms: number }
  | { type: "streets"; id: number; mesh: MeshArrays | null; groups: [number, number, number][]; triangles: number; pieces: number; ms: number }
  | { type: "error"; id: number; message: string };

let buildings: HokkaidoBuildings | null = null;
let streets: HokkaidoStreets | null = null;
let sidewalks: HokkaidoSidewalks | null = null;
let terrain: HokkaidoTerrain | null = null;
let ready: Promise<void> = Promise.resolve();
let excluded: number[][] = [];

const post = (msg: CityResponse, transfer: Transferable[] = []) => (self as unknown as Worker).postMessage(msg, transfer);
const buffers = (list: (MeshArrays | null)[]) => list.flatMap((a) => (a ? [a.pos.buffer, a.nor.buffer, a.uv.buffer, a.col.buffer, a.idx.buffer] : []));

self.onmessage = (ev: MessageEvent<CityRequest>) => {
  const req = ev.data;
  if (req.type === "init") {
    const base = req.base ?? HOKKAIDO_BASE;
    ready = loadTerrainMeta(base).then(async (meta) => {
      terrain = await loadHokkaidoTerrain(base, req.seed, meta);
      const c = cityStores(meta, pageLoader(base));
      buildings = c.buildings;
      streets = c.streets;
      sidewalks = c.sidewalks;
    });
    return;
  }
  if (req.type === "exclude") {
    excluded = req.polys;
    return;
  }
  void ready.then(() => prepare(req)).then(() => handle(req));
};

/** 依頼の区画の頁（建物・道・歩道・地形）を読む（北海道の草案 20 章）。地形の頁は 60 枚（約 15MB）まで持つ */
async function prepare(req: Exclude<CityRequest, { type: "init" | "exclude" }>) {
  const cells = [...req.cells, ...(req.subCells ?? [])];
  if (!cells.length || !terrain) return;
  const r = rectOfCells(cells, 250);
  const pad = { x0: r.x0 - 20, z0: r.z0 - 20, x1: r.x1 + 20, z1: r.z1 + 20 };
  terrain.evict((r.x0 + r.x1) / 2, (r.z0 + r.z1) / 2, Infinity, 60);
  await Promise.all([
    terrain.ensure(pad),
    req.type === "streets" ? streets?.ensure(r) : buildings?.ensure(r),
    req.type === "streets" ? sidewalks?.ensure(r) : undefined,
  ]);
}

/** 細部まで作る建物（区画の組が無ければ全部） */
function detailOf(data: HokkaidoBuildings, cells: string[] | undefined): Set<number> | undefined {
  if (!cells) return undefined;
  const out = new Set<number>();
  for (const k of cells) {
    const c = data.index.cells[k];
    if (c) for (let i = c[0]; i < c[0] + c[1]; i++) out.add(i);
  }
  return out;
}

function handle(req: Exclude<CityRequest, { type: "init" | "exclude" }>) {
  const t0 = performance.now();
  try {
    if (!terrain) throw new Error("地形を読めていない");
    if (req.type === "streets") {
      if (!streets) throw new Error("走らない道を読めていない");
      const pieces: StreetPiece[] = [];
      for (const k of req.cells) for (const p of streets.index.pieces[k] ?? []) pieces.push(p);
      const runs: [number, number][] = [];
      if (sidewalks) for (const k of req.subCells ?? req.cells) for (const p of sidewalks.index.sidewalks[k] ?? []) runs.push(p);
      const r = buildStreets(streets, terrain, pieces, req.ox, req.oz, sidewalks ? { data: sidewalks, runs } : undefined);
      post({ type: "streets", id: req.id, mesh: r.mesh, groups: r.groups, triangles: r.triangles, pieces: pieces.length, ms: performance.now() - t0 }, buffers([r.mesh]));
      return;
    }
    if (!buildings) throw new Error("建物を読めていない");
    let list: number[] = [];
    for (const k of req.cells) {
      const c = buildings.index.cells[k];
      if (c) for (let i = c[0]; i < c[0] + c[1]; i++) list.push(i);
    }
    if (excluded.length) list = withoutExcluded(buildings, list, excluded);
    if (req.type === "near") {
      const r = buildNear(buildings, terrain, list, req.ox, req.oz, detailOf(buildings, req.subCells));
      post({ type: "near", id: req.id, kinds: r.kinds, triangles: r.triangles, buildings: list.length, ms: performance.now() - t0 }, buffers(r.kinds));
    } else {
      const r = buildFar(buildings, terrain, list, req.ox, req.oz);
      post({ type: "far", id: req.id, meshes: r.meshes, triangles: r.triangles, buildings: list.length, ms: performance.now() - t0 }, buffers(r.meshes));
    }
  } catch (e) {
    post({ type: "error", id: req.id, message: String(e) });
  }
}
