// 道路生成と地図タイルの Worker。World を1つ持ち、生成済みの道路を覚えておく。

import { now } from "../shared/world/clock.ts";
import { World } from "../shared/world/world.ts";
import { renderTile } from "./map-tile.ts";
import type { WorldRequest, WorldResponse } from "./world-protocol.ts";

let world: World | null = null;

const post = (msg: WorldResponse, transfer: Transferable[] = []) =>
  (self as unknown as Worker).postMessage(msg, transfer);

self.onmessage = (ev: MessageEvent<WorldRequest>) => {
  const req = ev.data;
  try {
    if (req.type === "init") {
      world = new World(req.seed);
      return;
    }
    if (!world) throw new Error("world not initialized");
    if (req.type === "tile") {
      const t0 = now();
      const pixels = renderTile(world.terrain, req.x0, req.z0, req.mpp);
      post({ type: "tile", id: req.id, pixels, ms: now() - t0 }, [pixels.buffer]);
      return;
    }
    if (req.type === "region") {
      const t0 = now();
      const before = world.timings.length;
      const reg = world.region(req.rect);
      const timings = world.timings.slice(before).map((t) => ({ id: t.id, ms: t.ms }));
      // 点列は複製して転送する（World の覚えている配列は残す）
      const roads = reg.roads.map((r) => ({ ...r, points: r.points.slice() }));
      post(
        { type: "region", id: req.id, data: { ...reg, roads, timings, ms: now() - t0 } },
        roads.map((r) => r.points.buffer),
      );
    }
  } catch (e) {
    post({ type: "error", id: "id" in req ? req.id : -1, message: String(e) });
  }
};
