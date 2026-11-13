// 近景・中景・遠景の地形タイルの頂点を計算する Worker（モック仕様 5.1）。結果は転送できる ArrayBuffer で返す。

import { now } from "../shared/world/clock.ts";
import { Terrain } from "../shared/world/terrain.ts";
import { buildTile, type TileInput, type TileOutput } from "./terrain-tile.ts";

export type TerrainRequest = { type: "init"; seed: number } | { type: "tile"; id: number; input: TileInput };
export type TerrainResponse =
  | { type: "tile"; id: number; out: TileOutput; ms: number }
  | { type: "error"; id: number; message: string };

let terrain: Terrain | null = null;

self.onmessage = (ev: MessageEvent<TerrainRequest>) => {
  const req = ev.data;
  if (req.type === "init") {
    terrain = new Terrain(req.seed);
    return;
  }
  try {
    const t0 = now();
    const out = buildTile(terrain!, req.input);
    const msg: TerrainResponse = { type: "tile", id: req.id, out, ms: now() - t0 };
    (self as unknown as Worker).postMessage(msg, [out.position.buffer, out.normal.buffer, out.color.buffer, out.uv.buffer, out.index.buffer, out.veg.buffer]);
  } catch (e) {
    (self as unknown as Worker).postMessage({ type: "error", id: req.id, message: String(e) } satisfies TerrainResponse);
  }
};
