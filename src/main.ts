// ゲームの入口。M2: 3D の地形と道路を描き、道路に沿ってカメラが自動で進む。

import "./ui/game.css";
import { ORIGIN, WORLD_SEED } from "./shared/world/constants.ts";
import { sampleRoad } from "./sim/road-network.ts";
import { type Leg, RouteFollower } from "./sim/route-follower.ts";
import { rayCheck } from "./render/raycheck.ts";
import { type Quality, WorldView } from "./render/world-view.ts";
import { RoadClient } from "./workers/road-client.ts";

const q = new URLSearchParams(location.search);
const num = (k: string, d: number) => (q.has(k) ? Number(q.get(k)) : d);
const seed = num("seed", WORLD_SEED);
const startX = num("x", ORIGIN.x);
const startZ = num("z", ORIGIN.z);

const canvas = document.getElementById("view") as HTMLCanvasElement;
const statusEl = document.getElementById("status")!;
const hudEl = document.getElementById("hud")!;

const roads = new RoadClient(seed, 10000);
const view = new WorldView(canvas, seed, roads);
if (q.get("quality") === "light" || q.get("quality") === "standard") view.setQuality(q.get("quality") as Quality);
view.env.setHour(num("time", 14.5));

let speed = num("speed", 12);
let paused = false;
let follower: RouteFollower | null = null;
const eye = { x: startX, y: view.heights.height(startX, startZ) + 40, z: startZ };
const look = { x: startX + 10, y: eye.y - 5, z: startZ };
let smoothEye: { x: number; y: number; z: number } | null = null;
/** 撮影用にカメラを固定する（世界座標） */
let camOverride: { eye: { x: number; y: number; z: number }; target: { x: number; y: number; z: number } } | null = null;
/** 自動で進む位置が決まるまで、カメラはこの点の上で待つ */
let anchor = { x: startX, z: startZ };

function resize() {
  const r = canvas.getBoundingClientRect();
  view.resize(Math.max(1, Math.round(r.width)), Math.max(1, Math.round(r.height)));
}
new ResizeObserver(resize).observe(canvas);
resize();

/** anchor の近くの道路に乗せる */
function placeFollower(): boolean {
  let best: { road: string; s: number; d: number } | null = null;
  for (const e of roads.roadEntries()) {
    const r = e.road;
    const n = r.points.length / 3;
    const ds = r.length / (n - 1);
    for (let i = 0; i < n; i += 5) {
      const dx = r.points[i * 3] + r.origin[0] - anchor.x;
      const dz = r.points[i * 3 + 2] + r.origin[1] - anchor.z;
      const d = dx * dx + dz * dz;
      if (!best || d < best.d) best = { road: r.id, s: i * ds, d };
    }
  }
  if (!best || best.d > 3000 * 3000) return false;
  follower = new RouteFollower(roads.net, { road: best.road, s: best.s, dir: 1 });
  smoothEye = null;
  return true;
}

// フレーム間隔の記録（計測用）
const frameDt: number[] = [];
let lastT = performance.now();
let fpsAcc = 0;
let fpsN = 0;
let fps = 0;

function tick(t: number) {
  requestAnimationFrame(tick);
  const dt = Math.min(0.1, (t - lastT) / 1000);
  frameDt.push(t - lastT);
  if (frameDt.length > 20000) frameDt.splice(0, 10000);
  lastT = t;
  fpsAcc += dt;
  fpsN++;
  if (fpsAcc > 0.5) {
    fps = fpsN / fpsAcc;
    fpsAcc = 0;
    fpsN = 0;
  }

  if (!follower && roads.ready({ x0: anchor.x - 500, z0: anchor.z - 500, x1: anchor.x + 500, z1: anchor.z + 500 })) placeFollower();
  if (follower && !paused) follower.advance(speed * dt);

  if (follower && roads.net.roads.has(follower.pos.road)) {
    const road = roads.net.roads.get(follower.pos.road)!;
    const p = follower.pos;
    const here = sampleRoad(road, p.s);
    const tdx = here.dx * p.dir, tdz = here.dz * p.dir;
    // 左側通行: 進行方向の左車線の中央
    const lane = road.width / 4;
    const lx = tdz * lane, lz = -tdx * lane;
    const back = sampleRoad(road, p.s - p.dir * 9);
    const ahead = sampleRoad(road, p.s + p.dir * 30);
    const want = { x: back.x + lx, y: back.y + 3.0, z: back.z + lz };
    if (!smoothEye) smoothEye = { ...want };
    const k = 1 - Math.exp(-dt * 6);
    smoothEye.x += (want.x - smoothEye.x) * k;
    smoothEye.y += (want.y - smoothEye.y) * k;
    smoothEye.z += (want.z - smoothEye.z) * k;
    eye.x = smoothEye.x;
    eye.z = smoothEye.z;
    // 地形にめり込まない
    eye.y = Math.max(smoothEye.y, view.heights.height(eye.x, eye.z) + 1.5);
    look.x = ahead.x + lx;
    look.y = ahead.y + 1.2;
    look.z = ahead.z + lz;
    anchor = { x: here.x, z: here.z };
  }
  if (camOverride) {
    Object.assign(eye, camOverride.eye);
    Object.assign(look, camOverride.target);
  }
  view.frame(eye, look);
  updateHud();
}

let hudVisible = q.get("hud") !== "0";
let hudT = 0;
function updateHud() {
  const now = performance.now();
  if (now - hudT < 250) return;
  hudT = now;
  const loading = !follower;
  statusEl.textContent = loading ? `道路を生成中（残り ${roads.pending} 区画）` : "";
  statusEl.hidden = !loading;
  hudEl.hidden = !hudVisible;
  if (!hudVisible) return;
  const s = view.stats();
  const road = follower ? roads.net.roads.get(follower.pos.road) : null;
  const w = view.heights.landscape(eye.x, eye.z);
  hudEl.textContent = [
    `${fps.toFixed(0)} fps  三角形 ${(s.triangles / 1000).toFixed(0)}k  描画命令 ${s.calls}  形状 ${s.geometries}  画像 ${s.textures}${s.heapMB ? `  ヒープ ${s.heapMB.toFixed(0)}MB` : ""}`,
    `地形 表示 ${s.terrain.visible}（近 ${s.terrain.byLevel[0]}・中 ${s.terrain.byLevel[1]}・遠 ${s.terrain.byLevel[2]}） 待ち ${s.terrain.pending + s.terrain.queued}  道路 ${s.roads.chunks} 区間  画質 ${s.quality === "light" ? "軽量" : "標準"}`,
    road ? `${road.name}  ${follower!.pos.s.toFixed(0)} / ${road.length.toFixed(0)} m  標高 ${sampleRoad(road, follower!.pos.s).y.toFixed(0)} m` : "",
    `x ${eye.x.toFixed(0)}  z ${eye.z.toFixed(0)}  時刻 ${view.env.hour.toFixed(1)}  速度 ${speed} m/s  走行 ${follower ? (follower.travelled / 1000).toFixed(2) : "0"} km`,
    `海岸 ${w.coast.toFixed(2)} 平野 ${w.plain.toFixed(2)} 山岳 ${w.mountain.toFixed(2)} その他 ${w.other.toFixed(2)}`,
    `Q 画質  T 時刻  H 表示  P 停止  +/− 速度`,
  ].join("\n");
}

addEventListener("keydown", (e) => {
  if (e.key === "q" || e.key === "Q") view.setQuality(view.quality === "light" ? "standard" : "light");
  else if (e.key === "t" || e.key === "T") view.env.setHour(view.env.hour + 1);
  else if (e.key === "h" || e.key === "H") hudVisible = !hudVisible;
  else if (e.key === "p" || e.key === "P") paused = !paused;
  else if (e.key === "+" || e.key === "=") speed = Math.min(400, speed * 2);
  else if (e.key === "-") speed = Math.max(3, speed / 2);
});

// 計測・検証用の窓口（scripts/m2-*.mjs から使う）
const dev = {
  view,
  roads,
  get follower() {
    return follower;
  },
  state() {
    return {
      ready: !!follower,
      settled: view.settled(),
      pos: follower ? { ...follower.pos } : null,
      travelled: follower?.travelled ?? 0,
      planDone: follower?.planDone ?? false,
      eye: { ...eye },
      stats: view.stats(),
    };
  },
  setSpeed(v: number) {
    speed = v;
  },
  setPaused(p: boolean) {
    paused = p;
  },
  setHour(h: number) {
    view.env.setHour(h);
  },
  setQuality(qq: Quality) {
    view.setQuality(qq);
  },
  startRecording() {
    follower?.startRecording();
  },
  legs(): Leg[] {
    return follower ? follower.legs.map((l) => ({ ...l })) : [];
  },
  followPlan(legs: Leg[], reverse: boolean) {
    follower?.followPlan(legs, reverse);
    smoothEye = null;
  },
  teleport(x: number, z: number) {
    camOverride = null;
    anchor = { x, z };
    follower = null;
    smoothEye = null;
    eye.x = x;
    eye.z = z;
    eye.y = view.heights.height(x, z) + 40;
    look.x = x + 10;
    look.z = z;
    look.y = eye.y - 5;
  },
  /** 道路の上の位置へ（road の s、向き dir） */
  placeOn(road: string, s: number, dir: 1 | -1) {
    if (!roads.net.roads.has(road)) return false;
    follower = new RouteFollower(roads.net, { road, s, dir });
    smoothEye = null;
    return true;
  },
  setCameraOverride(e: { x: number; y: number; z: number } | null, t: { x: number; y: number; z: number } | null) {
    camOverride = e && t ? { eye: { ...e }, target: { ...t } } : null;
  },
  rayCheck(radius = 600) {
    return rayCheck(view, eye.x, eye.z, radius);
  },
  /** 今の画面を描いて、縮小した明るさの配列を返す（同じ場所の見た目の比較用） */
  signature(w = 96, h = 54) {
    const gl = view.renderer.getContext();
    view.frame(eye, look);
    const W = gl.drawingBufferWidth, H = gl.drawingBufferHeight;
    const px = new Uint8Array(W * H * 4);
    gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, px);
    const out: number[] = [];
    for (let j = 0; j < h; j++)
      for (let i = 0; i < w; i++) {
        let sum = 0;
        let n = 0;
        const x0 = Math.floor((i * W) / w), x1 = Math.floor(((i + 1) * W) / w);
        const y0 = Math.floor((j * H) / h), y1 = Math.floor(((j + 1) * H) / h);
        for (let y = y0; y < y1; y += 2)
          for (let x = x0; x < x1; x += 2) {
            const o = (y * W + x) * 4;
            sum += px[o] * 0.299 + px[o + 1] * 0.587 + px[o + 2] * 0.114;
            n++;
          }
        out.push(Math.round(sum / Math.max(1, n)));
      }
    return out;
  },
  frames(reset = false) {
    const out = frameDt.slice();
    if (reset) frameDt.length = 0;
    return out;
  },
};
(window as unknown as { __dev: typeof dev }).__dev = dev;

requestAnimationFrame(tick);
