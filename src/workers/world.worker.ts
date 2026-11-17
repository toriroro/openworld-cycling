// 道路生成と地図タイルの Worker。World を1つ持ち、生成済みの道路を覚えておく。

import { now } from "../shared/world/clock.ts";
import { HOKKAIDO_BASE, type HokkaidoWorld } from "../shared/world/hokkaido.ts";
import { World } from "../shared/world/world.ts";
import { loadHokkaidoWorld } from "./hokkaido-load.ts";
import { renderTile } from "./map-tile.ts";
import type { WorldRequest, WorldResponse } from "./world-protocol.ts";

let world: World | HokkaidoWorld | null = null;
/** 北海道の変換データを読み終えるまで、後の依頼を待たせる */
let ready: Promise<void> = Promise.resolve();


const post = (msg: WorldResponse, transfer: Transferable[] = []) =>
  (self as unknown as Worker).postMessage(msg, transfer);

self.onmessage = (ev: MessageEvent<WorldRequest>) => {
  const req = ev.data;
  if (req.type === "init") {
    if (req.world === "hokkaido") {
      ready = loadHokkaidoWorld(req.base ?? HOKKAIDO_BASE, req.seed).then(
        (w) => {
          world = w;
        },
        (e) => post({ type: "error", id: -1, message: String(e) }),
      );
    } else world = new World(req.seed);
    return;
  }
  void ready.then(() => handle(req));
};

function handle(req: Exclude<WorldRequest, { type: "init" }>) {
  try {
    if (!world) throw new Error("world not initialized");
    if (req.type === "prune") {
      world.prune(req.keep);
      return;
    }
    if (req.type === "tile") {
      const t0 = now();
      const pixels = renderTile(world.terrain, req.x0, req.z0, req.mpp);
      post({ type: "tile", id: req.id, pixels, ms: now() - t0 }, [pixels.buffer]);
      return;
    }
    if (req.type === "rail") {
      const t0 = now();
      const lines = world.rail.inRect(req.rect).map((l) => ({ ...l, points: l.points.slice() }));
      post({ type: "rail", id: req.id, lines, ms: now() - t0 }, lines.map((l) => l.points.buffer));
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
}
