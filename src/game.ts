// 走るゲームの本体（M3）。走行（sim）を 120Hz で進め、描画・画面・入力をつなぐ。
// 描画と画面は sim の状態を読むだけ（モック仕様 3.3）。

import { ORIGIN } from "./shared/world/constants.ts";
import { DT } from "./sim/bicycle.ts";
import { AutoPower, ManualPower } from "./sim/power.ts";
import { Ride } from "./sim/ride.ts";
import { sampleRoad } from "./sim/road-network.ts";
import { CAMERA_MODES, type CameraMode, cameraPose } from "./render/camera-rig.ts";
import { PlayerModel } from "./render/player.ts";
import type { WorldView } from "./render/world-view.ts";
import { Hud, type Settings } from "./ui/hud.ts";
import { Input } from "./ui/input.ts";
import type { RoadClient } from "./workers/road-client.ts";

export class Game {
  readonly input = new Input();
  readonly hud: Hud;
  readonly player = new PlayerModel();
  readonly manual = new ManualPower();
  readonly auto = new AutoPower(150);
  ride: Ride | null = null;
  watching = false;
  paused = false;
  camera: CameraMode = "chase";
  /** 時間の倍率（検証用） */
  timeScale = 1;
  private acc = 0;
  private lastT = performance.now();
  private hudT = 0;
  private smoothEye: { x: number; y: number; z: number } | null = null;
  private anchor: { x: number; z: number };
  /** フレーム間隔（計測用） */
  readonly frameDt: number[] = [];
  private status: HTMLElement;

  constructor(
    private view: WorldView,
    private roads: RoadClient,
    start: { x: number; z: number } = { x: ORIGIN.x, z: ORIGIN.z },
  ) {
    this.anchor = { ...start };
    const settings: Settings = { power: this.manual.setting, quality: view.quality, hour: view.env.hour, camera: this.camera };
    this.hud = new Hud(this.input, settings);
    this.hud.onSettings = (s) => {
      if (s.power !== undefined) {
        this.manual.setting = s.power;
        this.auto.setting = s.power;
      }
      if (s.quality) view.setQuality(s.quality);
      if (s.hour !== undefined) view.env.setHour(s.hour);
      if (s.camera) this.camera = s.camera;
    };
    view.scene.add(this.player.group);
    this.status = document.getElementById("status")!;
    // タブが隠れたら一時停止（モック仕様 6.4）
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) this.paused = true;
    });
    requestAnimationFrame((t) => this.tick(t));
  }

  /** 起点の近くの道路に乗せる（起点の町から出る道を選ぶ） */
  private place(): boolean {
    const a = this.anchor;
    if (!this.roads.ready({ x0: a.x - 600, z0: a.z - 600, x1: a.x + 600, z1: a.z + 600 })) return false;
    let best: { road: string; s: number; d: number } | null = null;
    for (const e of this.roads.roadEntries()) {
      const r = e.road;
      const n = r.points.length / 3;
      const ds = r.length / (n - 1);
      for (let i = 0; i < n; i += 5) {
        const dx = r.points[i * 3] + r.origin[0] - a.x;
        const dz = r.points[i * 3 + 2] + r.origin[1] - a.z;
        const d = dx * dx + dz * dz;
        if (!best || d < best.d) best = { road: r.id, s: i * ds, d };
      }
    }
    if (!best) return false;
    const r = this.roads.net.roads.get(best.road)!;
    // 端に近ければ道の内側へ向く
    const dir: 1 | -1 = best.s > r.length / 2 ? -1 : 1;
    this.ride = new Ride(this.roads.net, { road: best.road, s: Math.min(r.length - 1, Math.max(1, best.s)), dir }, this.manual);
    return true;
  }

  teleport(x: number, z: number) {
    this.anchor = { x, z };
    this.ride = null;
    this.smoothEye = null;
  }

  private handleActions() {
    for (const a of this.input.take()) {
      const ride = this.ride;
      switch (a) {
        case "pause":
          this.paused = !this.paused;
          break;
        case "camera":
          this.camera = CAMERA_MODES[(CAMERA_MODES.indexOf(this.camera) + 1) % CAMERA_MODES.length];
          this.smoothEye = null;
          this.hud.syncSettings({ camera: this.camera });
          break;
        case "watch":
          this.watching = !this.watching;
          if (ride) ride.power = this.watching ? this.auto : this.manual;
          break;
        case "choose-left":
          ride?.chooseDirection(-1);
          break;
        case "choose-straight":
          ride?.chooseDirection(0);
          break;
        case "choose-right":
          ride?.chooseDirection(1);
          break;
        case "lane-left":
          ride?.shiftLane(-0.5);
          break;
        case "lane-right":
          ride?.shiftLane(0.5);
          break;
        case "u-turn":
          ride?.uTurn();
          break;
        case "map":
          // 世界地図は M4
          break;
      }
    }
    if (this.hud.chosen !== null) {
      this.ride?.choose(this.hud.chosen);
      this.hud.chosen = null;
    }
  }

  private tick(t: number) {
    requestAnimationFrame((tt) => this.tick(tt));
    const dtRaw = (t - this.lastT) / 1000;
    this.frameDt.push(t - this.lastT);
    if (this.frameDt.length > 20000) this.frameDt.splice(0, 10000);
    this.lastT = t;
    const dt = Math.min(0.1, Math.max(0, dtRaw));
    this.handleActions();
    if (!this.ride) this.place();
    const ride = this.ride;
    this.manual.pedal = this.input.pedal;
    this.manual.brake = this.input.brake ? 1 : 0;
    if (ride && !this.paused) {
      this.acc += dt * this.timeScale;
      let n = 0;
      const maxSteps = 24 * this.timeScale;
      while (this.acc >= DT && n < maxSteps) {
        ride.step(DT);
        this.acc -= DT;
        n++;
      }
      if (n >= maxSteps) this.acc = 0;
    }

    let eye = { x: this.anchor.x, y: this.view.heights.height(this.anchor.x, this.anchor.z) + 40, z: this.anchor.z };
    let target = { x: this.anchor.x + 10, y: eye.y - 5, z: this.anchor.z };
    let fov = 55;
    let pose: ReturnType<Ride["pose"]> | null = null;
    if (ride?.road) {
      pose = ride.pose();
      const aspect = this.view.camera.aspect;
      const c = cameraPose(this.camera, pose, aspect, (x, z) => this.view.surfaceHeight(x, z));
      if (!this.smoothEye) this.smoothEye = { ...c.eye };
      const k = this.camera === "rider" ? 1 : 1 - Math.exp(-dt * 8);
      this.smoothEye.x += (c.eye.x - this.smoothEye.x) * k;
      this.smoothEye.y += (c.eye.y - this.smoothEye.y) * k;
      this.smoothEye.z += (c.eye.z - this.smoothEye.z) * k;
      eye = { ...this.smoothEye };
      if (this.camera !== "rider") eye.y = Math.max(eye.y, this.view.surfaceHeight(eye.x, eye.z) + 1.2);
      target = c.target;
      fov = c.fov;
      this.anchor = { x: pose.x, z: pose.z };
    }
    this.view.frame(eye, target, fov, () => {
      this.player.group.visible = !!pose;
      if (pose && ride) {
        this.player.update(
          this.paused ? 0 : dt,
          pose.x - this.view.originX,
          pose.y,
          pose.z - this.view.originZ,
          pose.dx,
          pose.dz,
          pose.grade,
          ride.speed,
          ride.watts,
          ride.odometer,
          this.camera === "rider",
        );
      }
    });
    this.updateHud(t);
  }

  private updateHud(t: number) {
    // 眺める乗り方では操作がなければ 5 秒で HUD を消す（M4 で仕上げる）
    this.hud.setVisible(!this.watching || performance.now() - this.input.lastActivity < 5000 || this.hud.menuOpen);
    if (t - this.hudT < 100) return;
    this.hudT = t;
    const ride = this.ride;
    this.status.hidden = !!ride;
    if (!ride) {
      this.status.textContent = `道路を生成中（残り ${this.roads.pending} 区画）`;
      return;
    }
    const road = ride.road;
    this.hud.update({
      speed: ride.speed,
      watts: ride.watts,
      grade: ride.grade,
      odometer: ride.odometer,
      climb: ride.climb,
      time: ride.time,
      roadName: road?.name ?? "",
      elevation: road ? sampleRoad(road, ride.pos.s).y : 0,
      autoBrake: ride.autoBrake > 0,
      upcoming: ride.upcoming,
      canUTurn: ride.speed < 0.5,
      watching: this.watching,
      paused: this.paused,
    });
  }
}
