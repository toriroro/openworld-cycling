// 入口。起動画面から走るゲームを始める。
// 開発・検証用: ?mode=m2（M2 の道路に沿って進むカメラ）、?notitle=1（起動画面を出さない）、?fresh=1（保存を使わない）、?x=&z=（場所を指定）。
// 計測・検証用の窓口 window.__dev は、開発サーバー・?dev=1・自動操作のブラウザ（navigator.webdriver）の時だけ置く。

import "./ui/game.css";
import { startM2 } from "./dev/m2-camera.ts";
import { Game } from "./game.ts";
import { platform } from "./platform/index.ts";
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

const devTools = import.meta.env.DEV || q.get("dev") === "1" || navigator.webdriver;

if (q.get("mode") === "m2" && devTools) {
  startM2(view, roads, q, startX, startZ);
} else {
  document.getElementById("hud")!.hidden = true;
  // 保存データがあれば続きから（?x= ?z= で場所を指定した時と ?fresh=1 の時は使わない。検証用）
  const resume = !q.has("x") && !q.has("z") && q.get("fresh") !== "1";
  // 自動操作のブラウザ（検証スクリプト）と場所を指定した時は起動画面を出さない
  const title = !navigator.webdriver && q.get("notitle") !== "1" && resume;
  const game = new Game(view, roads, { x: startX, z: startZ }, { resume, title });
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
    /** 行き先を指定する（地図からの指定は M4） */
    setGoal(x: number, z: number) {
      return game.ride?.setGoal(x, z) ?? false;
    },
    rideInfo() {
      const r = game.ride;
      if (!r || !r.road) return null;
      const p = r.pose();
      return { x: p.x, y: p.y, z: p.z, goalReached: r.goalReached, planSteps: r.plan?.steps.length ?? null, odometer: r.odometer, climb: r.climb, time: r.time, speed: r.speed, landscape: view.heights.landscape(p.x, p.z) };
    },
    watchInfo() {
      return {
        watching: game.watching,
        camera: game.camera,
        cameraLog: game.watchCameraLog.slice(),
        hudFaded: game.hud.root.classList.contains("faded"),
        awake: platform.awake,
      };
    },
    soundInfo() {
      return game.sound.stats();
    },
    stopInfo() {
      return { stop: game.stop ? game.stop.cafe.poi.id : null, stamps: game.stamps.map((st) => ({ ...st })) };
    },
    depart() {
      game.depart();
    },
    cafes(range = 20000) {
      const p = game.ride?.road ? game.ride.pose() : { x: 0, z: 0 };
      return view.towns.cafesNear(p.x, p.z, range).map((c) => ({ id: c.poi.id, name: c.poi.name, x: c.roadX, z: c.roadZ, road: c.poi.road, s: c.poi.s, d: Math.hypot(c.roadX - p.x, c.roadZ - p.z) }));
    },
    snapshot() {
      return game.snapshot();
    },
    async save() {
      await game.save();
      return game.lastSaved;
    },
    setTimeScale(k: number) {
      game.timeScale = k;
    },
    frames(reset = false) {
      const out = game.frameDt.slice();
      if (reset) game.frameDt.length = 0;
      return out;
    },
  };
  if (devTools) (window as unknown as { __dev: typeof dev }).__dev = dev;
}
