// 入口。既定は走るゲーム（M3）。?mode=m2 で M2 の確認用（道路に沿って自動で進むカメラ）。

import "./ui/game.css";
import { startM2 } from "./dev/m2-camera.ts";
import { Game } from "./game.ts";
import { rayCheck } from "./render/raycheck.ts";
import { type Quality, WorldView } from "./render/world-view.ts";
import { ORIGIN, WORLD_SEED } from "./shared/world/constants.ts";
import { RoadClient } from "./workers/road-client.ts";

const q = new URLSearchParams(location.search);
const num = (k: string, d: number) => (q.has(k) ? Number(q.get(k)) : d);
const seed = num("seed", WORLD_SEED);
const startX = num("x", ORIGIN.x);
const startZ = num("z", ORIGIN.z);

const canvas = document.getElementById("view") as HTMLCanvasElement;
const roads = new RoadClient(seed, 10000);
const view = new WorldView(canvas, seed, roads);
if (q.get("quality") === "light" || q.get("quality") === "standard") view.setQuality(q.get("quality") as Quality);
view.env.setHour(num("time", 14.5));

function resize() {
  const r = canvas.getBoundingClientRect();
  view.resize(Math.max(1, Math.round(r.width)), Math.max(1, Math.round(r.height)));
}
new ResizeObserver(resize).observe(canvas);
resize();

if (q.get("mode") === "m2") {
  startM2(view, roads, q, startX, startZ);
} else {
  document.getElementById("hud")!.hidden = true;
  const game = new Game(view, roads, { x: startX, z: startZ });
  // 計測・検証用の窓口（scripts/m3-*.mjs から使う）
  const dev = {
    view,
    roads,
    game,
    state() {
      const r = game.ride;
      return {
        ready: !!r,
        settled: view.settled(),
        pos: r ? { ...r.pos } : null,
        speed: r?.speed ?? 0,
        odometer: r?.odometer ?? 0,
        upcoming: r?.upcoming ? { distance: r.upcoming.distance, choices: r.upcoming.choices.length } : null,
        stats: view.stats(),
      };
    },
    teleport(x: number, z: number) {
      game.teleport(x, z);
    },
    setPaused(p: boolean) {
      game.paused = p;
    },
    rayCheck(radius = 600) {
      const a = game.ride ? game.ride.pose() : { x: startX, z: startZ };
      return rayCheck(view, a.x, a.z, radius);
    },
    frames(reset = false) {
      const out = game.frameDt.slice();
      if (reset) game.frameDt.length = 0;
      return out;
    },
  };
  (window as unknown as { __dev: typeof dev }).__dev = dev;
}
