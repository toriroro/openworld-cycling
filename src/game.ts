// 走るゲームの本体。走行（sim）を 120Hz で進め、描画・画面・入力をつなぐ。
// 描画と画面は sim の状態を読むだけ（モック仕様 3.3）。
// 保存（モック仕様 7.3）: 現在地・総距離・獲得標高・走行時間・走った区間・スタンプ・設定・装いを platform の保存に残し、起動時は続きから始める。

import { platform } from "./platform/index.ts";
import { DEFAULT_SETTINGS, parseSave, SAVE_KEY, SAVE_VERSION, type SaveData, type SaveSettings, type Stamp } from "./shared/save.ts";
import { GENERATOR_VERSION, ORIGIN } from "./shared/world/constants.ts";
import { RiddenLog } from "./sim/ridden.ts";
import { watchChoice } from "./sim/watch.ts";
import { DT } from "./sim/bicycle.ts";
import { AutoPower, ManualPower } from "./sim/power.ts";
import { Ride } from "./sim/ride.ts";
import { sampleRoad } from "./sim/road-network.ts";
import { CAMERA_MODES, type CameraMode, cameraPose } from "./render/camera-rig.ts";
import type { Quality } from "./render/world-view.ts";
import { PlayerModel } from "./render/player.ts";
import { showcaseView } from "./render/cyclist/showcase.ts";
import { DEFAULT_OUTFIT, type Outfit } from "./shared/outfit.ts";
import { OutfitPanel } from "./ui/outfit-panel.ts";
import { OrbitDrag, orbitView } from "./ui/orbit-drag.ts";
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
  /** 自転車と装いの設定（M4 で platform の保存に載せる） */
  outfit: Outfit = DEFAULT_OUTFIT;
  private outfitPanel: OutfitPanel;
  /** 画面のドラッグで視点を回す */
  readonly orbit: OrbitDrag;
  private pausedBeforeOutfit = false;
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
  /** 保存する設定 */
  settings: SaveSettings = { ...DEFAULT_SETTINGS };
  /** 走った道路の区間（走り直しても引き継ぐ） */
  ridden = new RiddenLog();
  stamps: Stamp[] = [];
  /** 保存データを読み終えた（読み終えるまで道路に乗せない） */
  private loaded = false;
  /** 続きから始める位置と記録 */
  private resume: { pos: SaveData["pos"]; odometer: number; climb: number; time: number; generator: number } | null = null;
  private saveT = 0;
  /** 最後に保存した時刻（確認用） */
  lastSaved = "";
  /** 眺める乗り方: 次に視点を切り替える時刻 */
  private watchCamAt = 0;
  /** 眺める乗り方で自動で切り替えた視点の記録（確認用） */
  readonly watchCameraLog: { t: number; camera: CameraMode }[] = [];
  /** 最後に描いた時刻（フレームレートの上限用） */
  private lastDraw = 0;
  private routeSel: HTMLSelectElement;
  private fpsSel: HTMLSelectElement;

  constructor(
    private view: WorldView,
    private roads: RoadClient,
    start: { x: number; z: number } = { x: ORIGIN.x, z: ORIGIN.z },
    opts: { resume?: boolean } = {},
  ) {
    this.anchor = { ...start };
    const settings: Settings = { power: this.manual.setting, quality: view.quality, hour: view.env.hour, camera: this.camera };
    this.hud = new Hud(this.input, settings);
    this.hud.onSettings = (s) => this.applySettings(s, true);
    // 眺める乗り方の設定（モック仕様 7.2）
    this.routeSel = this.hud.addSelect(
      "眺める進路",
      [
        ["unridden", "未走行の道を優先"],
        ["follow", "道なり"],
      ],
      this.settings.watchRoute,
      (v) => {
        this.settings.watchRoute = v;
        void this.save();
      },
    );
    this.fpsSel = this.hud.addSelect(
      "眺める時のフレームレート",
      [
        ["30", "30 fps"],
        ["free", "上限なし"],
      ],
      this.settings.fps30 ? "30" : "free",
      (v) => {
        this.settings.fps30 = v === "30";
        void this.save();
      },
    );
    view.scene.add(this.player.group);
    // 軽量画質では自転車とライダーも簡略版
    this.player.setLod(view.quality === "light" ? "low" : "high");
    // 自転車と装いの設定画面。開いている間は一時停止し、自転車を横から見る
    this.orbit = new OrbitDrag(view.renderer.domElement);
    this.outfitPanel = new OutfitPanel(document.body, this.outfit);
    this.outfitPanel.onChange = (o) => {
      this.outfit = o;
      void this.save();
      this.player.setOutfit(o);
    };
    this.outfitPanel.onClose = () => {
      this.paused = this.pausedBeforeOutfit;
      this.hud.root.classList.remove("hidden");
      this.smoothEye = null;
    };
    this.status = document.getElementById("status")!;
    // タブが隠れたら一時停止（モック仕様 6.4）し、保存する
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) {
        this.paused = true;
        void this.save();
      }
    });
    addEventListener("pagehide", () => void this.save());
    if (opts.resume === false) this.loaded = true;
    else
      void platform.storage.load(SAVE_KEY).then((text) => {
        const data = parseSave(text);
        if (data) this.applySave(data);
        this.loaded = true;
      });
    requestAnimationFrame((t) => this.tick(t));
  }

  /** 設定を変える（画面から、または保存データから） */
  private applySettings(s: Partial<Settings>, fromUser: boolean) {
    const view = this.view;
    if (s.power !== undefined) {
      this.manual.setting = s.power;
      this.auto.setting = s.power;
      this.settings.power = s.power;
    }
    if (s.quality) {
      view.setQuality(s.quality);
      this.player.setLod(s.quality === "light" ? "low" : "high");
      // 画質は選んだ時だけ残す（選んでいなければ端末に合わせた既定）
      if (fromUser) this.settings.quality = s.quality;
    }
    if (s.hour !== undefined) {
      view.env.setHour(s.hour);
      this.settings.hour = s.hour;
    }
    if (s.camera) {
      this.camera = s.camera;
      this.settings.camera = s.camera;
    }
    if (!fromUser) this.hud.syncSettings(s);
  }

  private applySave(d: SaveData) {
    this.settings = { ...d.settings };
    const cam = (CAMERA_MODES as readonly string[]).includes(d.settings.camera) ? (d.settings.camera as CameraMode) : undefined;
    this.applySettings({ power: d.settings.power, hour: d.settings.hour, camera: cam, quality: (d.settings.quality ?? undefined) as Quality | undefined }, false);
    this.settings.quality = d.settings.quality;
    this.outfit = d.outfit;
    this.player.setOutfit(d.outfit);
    this.ridden = RiddenLog.fromJSON(d.ridden);
    this.stamps = d.stamps;
    this.setWatching(d.watching);
    this.routeSel.value = d.settings.watchRoute;
    this.fpsSel.value = d.settings.fps30 ? "30" : "free";
    if (d.pos) this.anchor = { x: d.pos.x, z: d.pos.z };
    this.resume = { pos: d.pos, odometer: d.odometer, climb: d.climb, time: d.time, generator: d.generator };
    this.ride = null;
  }

  /** 今の状態を保存データにする */
  snapshot(): SaveData {
    const r = this.ride;
    const p = r?.road ? r.pose() : null;
    return {
      version: SAVE_VERSION,
      generator: GENERATOR_VERSION,
      savedAt: new Date().toISOString(),
      pos: r && p ? { road: r.pos.road, s: r.pos.s, dir: r.pos.dir, x: p.x, z: p.z } : this.resume?.pos ?? null,
      odometer: r?.odometer ?? this.resume?.odometer ?? 0,
      climb: r?.climb ?? this.resume?.climb ?? 0,
      time: r?.time ?? this.resume?.time ?? 0,
      ridden: this.ridden.toJSON(),
      stamps: this.stamps,
      settings: this.settings,
      outfit: this.outfit,
      watching: this.watching,
    };
  }

  async save() {
    if (!this.loaded) return;
    const d = this.snapshot();
    await platform.storage.save(SAVE_KEY, JSON.stringify(d));
    this.lastSaved = d.savedAt;
  }

  /** 起点の近くの道路に乗せる（起点の町から出る道を選ぶ） */
  private place(): boolean {
    if (!this.loaded) return false;
    const a = this.anchor;
    if (!this.roads.ready({ x0: a.x - 600, z0: a.z - 600, x1: a.x + 600, z1: a.z + 600 })) return false;
    // 続きから: 保存した道路がそのままあれば、その位置と向きに乗せる
    const res = this.resume;
    if (res?.pos && res.generator === GENERATOR_VERSION) {
      const road = this.roads.net.roads.get(res.pos.road);
      if (road && res.pos.s >= 0 && res.pos.s <= road.length) {
        this.startRide({ road: road.id, s: res.pos.s, dir: res.pos.dir });
        return true;
      }
    }
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
    this.startRide({ road: best.road, s: Math.min(r.length - 1, Math.max(1, best.s)), dir });
    return true;
  }

  private startRide(pos: { road: string; s: number; dir: 1 | -1 }) {
    const ride = new Ride(this.roads.net, pos, this.watching ? this.auto : this.manual);
    ride.ridden = this.ridden;
    const res = this.resume;
    if (res) {
      ride.odometer = res.odometer;
      ride.climb = res.climb;
      ride.time = res.time;
      this.resume = null;
    }
    this.ride = ride;
  }

  /** 眺める乗り方の開始・終了: 自動の入力元、視点の自動切替、画面の常時点灯 */
  setWatching(on: boolean) {
    this.watching = on;
    if (this.ride) this.ride.power = on ? this.auto : this.manual;
    platform.keepAwake(on);
    this.watchCamAt = performance.now() + this.watchInterval();
    // 終わったら、選んでいた視点に戻す
    if (!on && (CAMERA_MODES as readonly string[]).includes(this.settings.camera)) {
      this.camera = this.settings.camera as CameraMode;
      this.smoothEye = null;
    }
  }

  /** 視点を切り替える間隔 20〜40 秒 */
  private watchInterval() {
    return 20000 + Math.random() * 20000;
  }

  /** 眺める乗り方の毎フレームの処理: 進路を選び、時々視点を変える */
  private updateWatching(t: number) {
    const ride = this.ride;
    if (!this.watching || !ride) return;
    const u = ride.upcoming;
    if (u && u.selected === null && !ride.plan) {
      const i = watchChoice(u, this.settings.watchRoute, this.ridden, this.roads.net);
      if (i !== u.defaultIndex) ride.choose(i);
    }
    if (t >= this.watchCamAt && !this.orbit.active) {
      const others = CAMERA_MODES.filter((m) => m !== this.camera);
      this.camera = others[Math.floor(Math.random() * others.length)];
      this.smoothEye = null;
      this.watchCameraLog.push({ t, camera: this.camera });
      if (this.watchCameraLog.length > 200) this.watchCameraLog.shift();
      this.watchCamAt = t + this.watchInterval();
    }
  }

  teleport(x: number, z: number) {
    // 記録は引き継ぐ
    const r = this.ride;
    if (r) this.resume = { pos: null, odometer: r.odometer, climb: r.climb, time: r.time, generator: GENERATOR_VERSION };
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
          this.setWatching(!this.watching);
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
        case "look-left":
          this.player.lookBack(1);
          break;
        case "look-right":
          this.player.lookBack(-1);
          break;
        case "u-turn":
          this.player.lookBack(-1); // 対向車線の側を見てから回る
          ride?.uTurn();
          break;
        case "outfit":
          if (this.outfitPanel.isOpen) this.outfitPanel.close();
          else {
            this.pausedBeforeOutfit = this.paused;
            this.paused = true;
            this.hud.toggleMenu(false);
            this.hud.root.classList.add("hidden");
            this.outfitPanel.open(this.outfit);
          }
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
    // 眺める乗り方ではフレームレートを 30 に抑えられる（モック仕様 7.2）。走行は経った時間だけ進めるので速さは変わらない
    if (this.watching && this.settings.fps30 && t - this.lastDraw < 1000 / 30 - 2) return;
    this.lastDraw = t;
    const dtRaw = (t - this.lastT) / 1000;
    this.frameDt.push(t - this.lastT);
    if (this.frameDt.length > 20000) this.frameDt.splice(0, 10000);
    this.lastT = t;
    const dt = Math.min(0.1, Math.max(0, dtRaw));
    this.handleActions();
    if (!this.ride) this.place();
    this.updateWatching(t);
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
      this.orbit.update(dt);
      if (this.orbit.active && !this.outfitPanel.isOpen) {
        const o = orbitView(c.eye, c.target, { x: pose.x, y: pose.y + 1.0, z: pose.z }, this.orbit.yaw, this.orbit.pitch, this.camera === "rider");
        c.eye = o.eye;
        c.target = o.target;
      }
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
      if (this.outfitPanel.isOpen) {
        const r = this.outfitPanel.root.getBoundingClientRect();
        const portrait = innerWidth / innerHeight < 0.8;
        const share = portrait ? (innerHeight - r.top) / innerHeight : (innerWidth - r.left) / innerWidth;
        const s = showcaseView(this.player.group, aspect, share, 0.35 + this.orbit.yaw);
        eye = { x: s.eye.x + this.view.originX, y: s.eye.y, z: s.eye.z + this.view.originZ };
        target = { x: s.target.x + this.view.originX, y: s.target.y, z: s.target.z + this.view.originZ };
        fov = s.fov;
      }
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
          this.camera === "rider" && !this.outfitPanel.isOpen,
        );
      }
    });
    this.updateHud(t);
  }

  private updateHud(t: number) {
    // 10 秒ごとに保存する
    if (this.ride && t - this.saveT > 10000) {
      this.saveT = t;
      void this.save();
    }
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
