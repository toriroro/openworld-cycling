// 道路生成用 Worker とのやり取りの形。転送できる ArrayBuffer だけを使う（概要仕様 9.5 #3）。

import type { Junction, Poi, RailLine, Road, WorldNode } from "../shared/world/types.ts";
import type { CrossingInfo, Rect } from "../shared/world/world.ts";

export type WorldRequest =
  | { type: "init"; seed: number }
  | { type: "tile"; id: number; x0: number; z0: number; mpp: number }
  | { type: "region"; id: number; rect: Rect }
  /** 鉄道（鉄道の草案 L1。地図だけ） */
  | { type: "rail"; id: number; rect: Rect }
  | { type: "prune"; keep: Rect };

export interface RegionPayload {
  nodes: WorldNode[];
  roads: Road[];
  junctions: Junction[];
  pois: Poi[];
  crossings: CrossingInfo[];
  /** この依頼で生成した道路ごとの時間 */
  timings: { id: string; ms: number }[];
  ms: number;
}

export type WorldResponse =
  | { type: "tile"; id: number; pixels: Uint8ClampedArray; ms: number }
  | { type: "region"; id: number; data: RegionPayload }
  | { type: "rail"; id: number; lines: RailLine[]; ms: number }
  | { type: "error"; id: number; message: string };
