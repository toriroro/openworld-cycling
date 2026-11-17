// 近景・中景・遠景の地形タイルの頂点を計算する Worker（モック仕様 5.1）。結果は転送できる ArrayBuffer で返す。

import { now } from "../shared/world/clock.ts";
import { HOKKAIDO_BASE } from "../shared/world/hokkaido.ts";
import { Terrain, type TerrainLike } from "../shared/world/terrain.ts";
import { loadHokkaidoTerrain } from "./hokkaido-load.ts";
import { buildTile, type TileInput, type TileOutput } from "./terrain-tile.ts";

/** world を省くと生成の世界。"hokkaido" なら base から変換データを読む（北海道の草案 2.2） */
export type TerrainRequest = { type: "init"; seed: number; world?: "hokkaido"; base?: string } | { type: "tile"; id: number; input: TileInput };
export type TerrainResponse =
  | { type: "tile"; id: number; out: TileOutput; ms: number }
  | { type: "error"; id: number; message: string };

let terrain: TerrainLike | null = null;
/** 北海道の変換データを読み終えるまで、後の依頼を待たせる */
let ready: Promise<void> = Promise.resolve();

self.onmessage = (ev: MessageEvent<TerrainRequest>) => {
  const req = ev.data;
  if (req.type === "init") {
    if (req.world === "hokkaido")
      ready = loadHokkaidoTerrain(req.base ?? HOKKAIDO_BASE, req.seed).then(
        (t) => {
          terrain = t;
        },
        (e) => (self as unknown as Worker).postMessage({ type: "error", id: -1, message: String(e) } satisfies TerrainResponse),
      );
    else terrain = new Terrain(req.seed);
    return;
  }
  void ready.then(() => handle(req));
};

function handle(req: Extract<TerrainRequest, { type: "tile" }>) {
  try {
    const t0 = now();
    const out = buildTile(terrain!, req.input);
    const msg: TerrainResponse = { type: "tile", id: req.id, out, ms: now() - t0 };
    (self as unknown as Worker).postMessage(msg, [out.position.buffer, out.normal.buffer, out.color.buffer, out.uv.buffer, out.field.buffer, out.index.buffer, out.veg.buffer]);
  } catch (e) {
    (self as unknown as Worker).postMessage({ type: "error", id: req.id, message: String(e) } satisfies TerrainResponse);
  }
}
