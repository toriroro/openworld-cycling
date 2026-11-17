// 入口。起動画面から走るゲームを始める。
// 世界: ?world=hokkaido|generated（省くと最後に選んだ世界。北海道の草案 2.1）。
// 開発・検証用: ?mode=m2（M2 の道路に沿って進むカメラ）、?notitle=1（起動画面を出さない）、?fresh=1（保存を使わない）、?x=&z=（場所を指定）、?time=&weather=（時刻・天候を決める）。
// 計測・検証用の窓口 window.__dev は、開発サーバー・?dev=1・自動操作のブラウザ（navigator.webdriver）の時だけ置く。

import "./ui/game.css";
import { startM2 } from "./dev/m2-camera.ts";
import { Game } from "./game.ts";
import { platform } from "./platform/index.ts";
import { rayCheck } from "./render/raycheck.ts";
import { type Quality, WorldView } from "./render/world-view.ts";
import { WORLD_SEED } from "./shared/world/constants.ts";
import { RoadClient } from "./workers/road-client.ts";
import { generatedWorld, hokkaidoWorld, WORLD_KEY, type WorldChoice, type WorldId } from "./world-choice.ts";

const q = new URLSearchParams(location.search);
const num = (k: string, d: number) => (q.has(k) ? Number(q.get(k)) : d);
const seed = num("seed", WORLD_SEED);

async function chooseWorld(): Promise<WorldChoice> {
  const qw = q.get("world");
  const id = qw === "hokkaido" || qw === "generated" ? qw : await platform.storage.load(WORLD_KEY);
  if (id === "hokkaido") {
    try {
      return await hokkaidoWorld(seed);
    } catch (e) {
      // 変換データが無い（scripts/hokkaido/build-h0.ts を実行していない）時は生成の世界で始める
      console.error("北海道の世界を読めない", e);
    }
  }
  return generatedWorld(seed);
}

/** 世界を選び直す: 覚えて読み込み直す（URL の ?world= は外す） */
async function switchWorld(id: WorldId) {
  await platform.storage.save(WORLD_KEY, id);
  const u = new URL(location.href);
  u.searchParams.delete("world");
  location.href = u.toString();
}

const world = await chooseWorld();
const startX = num("x", world.origin.x);
const startZ = num("z", world.origin.z);

const canvas = document.getElementById("view") as HTMLCanvasElement;
const roads = new RoadClient(seed, 10000, world);
const view = new WorldView(canvas, seed, roads, world);
if (q.get("quality") === "light" || q.get("quality") === "standard") view.setQuality(q.get("quality") as Quality);
view.env.setHour(num("time", 14.5));
const skyWeather = q.get("weather");

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
  // ?title=1 は自動操作のブラウザでも起動画面を出す（確認用）
  const title = (q.get("title") === "1" || !navigator.webdriver) && q.get("notitle") !== "1" && resume;
  const game = new Game(view, roads, { x: startX, z: startZ }, { resume, title });
  game.title.onWorld = (id) => void switchWorld(id);
  // 検証用: ?time= と ?weather=clear|cloudy|fog で時刻・天候を決める（保存しない）
  if (q.has("time") || skyWeather) {
    const w = skyWeather === "clear" || skyWeather === "cloudy" || skyWeather === "fog" ? skyWeather : undefined;
    game.setForcedSky({ hour: q.has("time") ? num("time", 14.5) : undefined, weather: w });
  }
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
    /** 時刻・天候を決める（null で世界のものに戻す） */
    setSky(f: { hour?: number; weather?: "clear" | "cloudy" | "fog" } | null) {
      game.setForcedSky(f);
    },
    /** 世界の時計をずらす (ms) */
    setClockOffset(ms: number) {
      game.clockOffset = ms;
    },
    trafficInfo() {
      const t = game.traffic;
      return {
        level: t.level,
        count: t.vehicles.length,
        stats: { ...t.stats },
        view: { ...view.trafficView.stats },
        vehicles: t.vehicles.map((v) => ({ id: v.id, type: v.type, road: v.pos.road, s: v.pos.s, x: v.x, z: v.z, speed: v.speed, passing: !!v.passing, turn: !!v.turn })),
      };
    },
    skyInfo() {
      const e = view.env;
      return { hour: e.hour, weather: game.weatherNow, cloud: e.cloud, mist: e.mist, fogNear: e.fog.near, fogFar: e.fog.far, sun: e.sun.intensity, hemi: e.hemi.intensity };
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
