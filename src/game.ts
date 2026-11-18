// 走るゲームの本体。走行（sim）を 120Hz で進め、描画・画面・入力をつなぐ。
// 描画と画面は sim の状態を読むだけ（モック仕様 3.3）。
// 保存（モック仕様 7.3）: 現在地・総距離・獲得標高・走行時間・走った区間・スタンプ・設定・装いを platform の保存に残し、起動時は続きから始める。

import { SoundSystem } from "./audio/sound.ts";
import { platform } from "./platform/index.ts";
import { DEFAULT_SETTINGS, parseSave, SAVE_VERSION, type SaveData, type SaveSettings, type Stamp } from "./shared/save.ts";
import { FIXED_WEATHER, type Weather, type WeatherKind, WEATHER_LABELS, weatherAt, worldHour } from "./shared/world/weather.ts";
import { RiddenLog } from "./sim/ridden.ts";
import { watchChoice } from "./sim/watch.ts";
import { DT } from "./sim/bicycle.ts";
import { AutoPower, ManualPower } from "./sim/power.ts";
import { Ride } from "./sim/ride.ts";
import { type Rider, TRAFFIC_LIGHT, TRAFFIC_STANDARD, Traffic } from "./sim/traffic/traffic.ts";
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
import { MapOverlay } from "./ui/map-overlay.ts";
import { StampBook, StopPanel } from "./ui/cafe-panel.ts";
import { creditLine } from "./ui/credit.ts";
import { ControlsHelp, TitleScreen } from "./ui/title.ts";
import type { Cafe } from "./render/town-layout.ts";
import { Minimap } from "./ui/minimap.ts";
import { compass, LandmarkBook } from "./ui/landmark-book.ts";
import { arrivedAt, isLandmarkStamp, type LandmarkData, landmarkStampId } from "./shared/world/landmarks.ts";
import { nearestOnNetwork } from "./sim/route-plan.ts";
import type { RoadClient } from "./workers/road-client.ts";

/** カメラの近い面の既定 (m)。一人称だけ手前にする（camera-rig.ts） */
const NEAR_DEFAULT = 0.8;

/** 名所の立ち寄りの視点: 回る半径・目の高さ・見る高さ (m) */
const LANDMARK_VIEW: Record<string, { r: number; eye: number; look: number }> = {
  tvtower: { r: 150, eye: 30, look: 70 },
  odori: { r: 120, eye: 40, look: 0 },
  clocktower: { r: 45, eye: 14, look: 9 },
  akarenga: { r: 95, eye: 28, look: 12 },
  hokudai: { r: 70, eye: 20, look: 6 },
  nakajima: { r: 60, eye: 18, look: 6 },
  jingu: { r: 70, eye: 24, look: 6 },
  asahiyama: { r: 60, eye: 20, look: 2 },
  moiwa: { r: 70, eye: 25, look: 6 },
  moere: { r: 90, eye: 30, look: 12 },
  okurayama: { r: 220, eye: 60, look: 40 },
  hitsujigaoka: { r: 18, eye: 5, look: 4 },
};

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
  /** 眺める乗り方で自動で切り替えた視点の記録（確認用） */
  readonly watchCameraLog: { t: number; camera: CameraMode }[] = [];
  /** 最後に描いた時刻（フレームレートの上限用） */
  private lastDraw = 0;
  private routeSel: HTMLSelectElement;
  readonly minimap: Minimap;
  readonly mapOverlay: MapOverlay;
  /** 立ち寄った店の識別子 */
  stampSet = new Set<string>();
  private minimapT = 0;
  /** 喫茶店に立ち寄っている間の店（モック仕様 7.1） */
  /** 立ち寄り中（喫茶店か名所のどちらか） */
  stop: { cafe: Cafe | null; landmark: LandmarkData | null; t0: number } | null = null;
  /** 名所帳から選んだ行き先の名所（地図を押して行き先を変えたら null） */
  goalLandmark: LandmarkData | null = null;
  /** 直前に立ち寄った名所。150m 離れるまで同じ名所に立ち寄りにしない（"*" は走り始めた所） */
  private lastLandmark: { id: string; x: number; z: number } | null = null;
  /** 名所の行き先から一番近い走る道までの距離（山の上の名所で着いたとみなす範囲を広げる） */
  private landmarkGap = new Map<string, number>();
  private landmarkBook = new LandmarkBook();
  /** 出発した店（60m 離れるまで、また止まっても立ち寄りにしない） */
  private lastCafe: { id: string; x: number; z: number } | null = null;
  private stopPanel = new StopPanel();
  /** 交通（都市と交通の草案 6 章）。端末ごとに出し、同期しない */
  readonly traffic: Traffic;
  private trafficSel: HTMLSelectElement;
  /** 音（モック仕様 7.5） */
  readonly sound = new SoundSystem();
  private volumeSel: HTMLSelectElement;
  /** いまの場所の天候（画面に出す名前と、描く雲・霧の量） */
  weatherNow: Weather = FIXED_WEATHER.clear;
  /** 次の空の計算で、雲と霧をすぐに切り替える */
  private skySnap = true;
  private skyT = 0;
  /** 世界の時計のずれ (ms、検証用) */
  clockOffset = 0;
  /** 検証用: 保存しない形で時刻・天候を決める（URL の ?time= ?weather= と window.__dev） */
  forceSky: { hour?: number; weather?: WeatherKind } | null = null;
  /** 保存データを読み終えた時（保存がなければ null） */
  readonly ready: Promise<SaveData | null>;
  readonly title: TitleScreen;
  readonly help = new ControlsHelp();
  private muteSel: HTMLSelectElement;
  private stampBook = new StampBook();
  private fpsSel: HTMLSelectElement;

  constructor(
    private view: WorldView,
    private roads: RoadClient,
    start: { x: number; z: number } = view.world.origin,
    opts: { resume?: boolean; title?: boolean } = {},
  ) {
    this.anchor = { ...start };
    this.title = new TitleScreen(view.world);
    // 出典（北海道の世界は走っている間も見える所に出す。北海道の草案 3.1・3.2）
    if (view.world.attribution.length) document.body.appendChild(creditLine(view.world, "ride-credit"));
    this.traffic = new Traffic(roads.net, (Date.now() & 0x7fffffff) | 1, (x, z) => view.heights.height(x, z));
    this.traffic.options = view.quality === "light" ? TRAFFIC_LIGHT : TRAFFIC_STANDARD;
    const st = this.settings;
    const settings: Settings = { power: this.manual.setting, sway: st.sway, quality: view.quality, clock: st.clock, hour: st.hour, weather: st.weather, camera: this.camera };
    this.hud = new Hud(this.input, settings);
    this.hud.onSettings = (s) => this.applySettings(s, true);
    // 小地図と世界地図（モック仕様 7.4）
    this.minimap = new Minimap(this.hud.root, () => this.toggleMap());
    this.mapOverlay = new MapOverlay(roads.seed, view.world);
    this.mapOverlay.onClearGoal = () => {
      this.goalLandmark = null;
      this.ride?.setGoal(null);
    };
    // 音量と消音
    this.volumeSel = this.hud.addSelect(
      "音量",
      [
        ["1", "100%"],
        ["0.6", "60%"],
        ["0.3", "30%"],
        ["0.15", "15%"],
        ["0.05", "5%"],
      ],
      String(this.settings.volume),
      (v) => {
        this.settings.volume = Number(v);
        this.sound.setVolume(this.settings.volume, this.settings.muted);
        void this.save();
      },
    );
    this.muteSel = this.hud.addSelect(
      "消音",
      [
        ["off", "切"],
        ["on", "入"],
      ],
      this.settings.muted ? "on" : "off",
      (v) => {
        this.settings.muted = v === "on";
        this.sound.setVolume(this.settings.volume, this.settings.muted);
        void this.save();
      },
    );
    this.sound.setVolume(this.settings.volume, this.settings.muted);
    this.trafficSel = this.hud.addSelect(
      "交通量",
      [
        ["normal", "標準"],
        ["few", "少ない"],
        ["off", "なし"],
      ],
      this.settings.traffic,
      (v) => {
        this.settings.traffic = v;
        this.traffic.level = v;
        void this.save();
      },
    );
    this.traffic.level = this.settings.traffic;
    this.stopPanel.onDepart = () => this.depart();
    this.stampBook.onPick = (st) => this.startFrom(st);
    this.hud.addButton("スタンプ帳", () => {
      this.hud.toggleMenu(false);
      this.stampBook.open(this.stamps);
    });
    this.hud.addButton("地図", () => {
      this.hud.toggleMenu(false);
      this.toggleMap();
    });
    // 名所帳（北海道の世界。名所の草案）
    if (view.world.local) {
      this.landmarkBook.onGoal = (lm) => this.goToLandmark(lm);
      this.landmarkBook.onStart = (st) => this.startFrom(st);
      this.hud.addButton("名所帳", () => {
        this.hud.toggleMenu(false);
        this.openLandmarkBook();
      });
    }
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
      "眺める時の fps",
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
    this.ready =
      opts.resume === false
        ? Promise.resolve(null)
        : platform.storage.load(this.view.world.saveKey).then((text) => {
            const data = parseSave(text);
            if (data) this.applySave(data);
            return data;
          });
    void this.ready.then(() => {
      this.loaded = true;
    });
    // 起動画面（止めた状態で後ろに世界を出しておく）
    this.title.onChoose = (c) => this.leaveTitle(c);
    this.title.onHelp = () => this.help.open();
    this.hud.addButton("操作", () => {
      this.hud.toggleMenu(false);
      this.help.open();
    });
    this.hud.addButton("タイトルへ", () => this.showTitle());
    if (opts.title) {
      this.paused = true;
      this.hud.root.classList.add("hidden");
      void this.ready.then((d) => this.title.show(d));
    }
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
    if (s.sway !== undefined) {
      this.settings.sway = s.sway;
      this.player.swayFrom = s.sway;
      if (fromUser) void this.save();
    }
    if (s.quality) {
      view.setQuality(s.quality);
      this.traffic.options = s.quality === "light" ? TRAFFIC_LIGHT : TRAFFIC_STANDARD;
      this.player.setLod(s.quality === "light" ? "low" : "high");
      // 画質は選んだ時だけ残す（選んでいなければ端末に合わせた既定）
      if (fromUser) this.settings.quality = s.quality;
    }
    if (s.clock) this.settings.clock = s.clock;
    if (fromUser && s.clock === "fixed" && s.hour === undefined) {
      // 固定にした時は、いま見ている時刻のまま止める
      const hour = Math.round(view.env.hour * 4) / 4;
      this.settings.hour = hour % 24;
      this.hud.syncSettings({ hour: this.settings.hour });
    }
    if (s.hour !== undefined) this.settings.hour = s.hour;
    if (s.weather) this.settings.weather = s.weather;
    if (s.clock || s.weather) this.skySnap = true;
    if (fromUser && (s.clock || s.hour !== undefined || s.weather)) void this.save();
    if (s.camera) {
      // 視点を選び直したら、ドラッグで回した向きを元に戻す
      if (s.camera !== this.camera) this.orbit.reset();
      this.camera = s.camera;
      this.settings.camera = s.camera;
    }
    if (!fromUser) this.hud.syncSettings(s);
  }

  private applySave(d: SaveData) {
    this.settings = { ...d.settings };
    const cam = (CAMERA_MODES as readonly string[]).includes(d.settings.camera) ? (d.settings.camera as CameraMode) : undefined;
    this.applySettings(
      { power: d.settings.power, sway: d.settings.sway, clock: d.settings.clock, hour: d.settings.hour, weather: d.settings.weather, camera: cam, quality: (d.settings.quality ?? undefined) as Quality | undefined },
      false,
    );
    this.settings.quality = d.settings.quality;
    this.outfit = d.outfit;
    this.player.setOutfit(d.outfit);
    this.ridden = RiddenLog.fromJSON(d.ridden);
    this.stamps = d.stamps;
    this.stampSet = new Set(d.stamps.map((st) => st.poi));
    this.setWatching(d.watching);
    this.routeSel.value = d.settings.watchRoute;
    this.volumeSel.value = String(d.settings.volume);
    // 選べる段階にない値（前の既定 0.7 など）は 30% にそろえる
    if (!this.volumeSel.value) {
      this.volumeSel.value = "0.3";
      this.settings.volume = 0.3;
    }
    this.sound.setVolume(this.settings.volume, d.settings.muted);
    this.muteSel.value = d.settings.muted ? "on" : "off";
    this.fpsSel.value = d.settings.fps30 ? "30" : "free";
    this.trafficSel.value = d.settings.traffic;
    this.traffic.level = d.settings.traffic;
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
      generator: this.view.world.generator,
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
    await platform.storage.save(this.view.world.saveKey, JSON.stringify(d));
    this.lastSaved = d.savedAt;
  }

  /** 起点の近くの道路に乗せる（起点の町から出る道を選ぶ） */
  private place(): boolean {
    if (!this.loaded) return false;
    const a = this.anchor;
    if (!this.roads.ready({ x0: a.x - 600, z0: a.z - 600, x1: a.x + 600, z1: a.z + 600 })) return false;
    // 続きから: 保存した道路がそのままあれば、その位置と向きに乗せる
    const res = this.resume;
    if (res?.pos && res.generator === this.view.world.generator) {
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
      // 続きから始めた所では、60m 動くまで立ち寄りにしない（店の前で終えた時にもう一度数えないため）
      const p0 = ride.road ? ride.pose() : null;
      if (p0) this.lastCafe = { id: "*", x: p0.x, z: p0.z };
      // 名所も同じ（走り始めた所が名所のそばでも、150m 動くまで立ち寄りにしない）
      if (p0) this.lastLandmark = { id: "*", x: p0.x, z: p0.z };
      ride.odometer = res.odometer;
      ride.climb = res.climb;
      ride.time = res.time;
      this.resume = null;
    }
    this.ride = ride;
    this.skySnap = true;
  }

  /**
   * 空: 世界の時計と、いる場所の天候（概要仕様 3.7）。設定で自分の画面だけ固定できる。
   * 天候は 1 秒ごとに求め、描く雲・霧はゆっくり近づける。
   */
  private updateSky(dt: number) {
    const env = this.view.env;
    const ms = Date.now() + this.clockOffset;
    const f = this.forceSky;
    const st = this.settings;
    env.setClock(ms);
    env.setHour(f?.hour ?? (st.clock === "fixed" ? st.hour : worldHour(ms)));
    const now = performance.now();
    if (this.skySnap || now - this.skyT > 1000) {
      this.skyT = now;
      const fixed = f?.weather ?? (st.weather === "world" ? null : st.weather);
      const w = fixed ? FIXED_WEATHER[fixed] : weatherAt(this.anchor.x, this.anchor.z, ms);
      this.weatherNow = w;
      env.setWeather(w.cloud, w.fog, this.skySnap);
      this.skySnap = false;
    }
    env.step(dt);
  }

  /** 近くの車の音の大きさ（近く・速いほど大きい。0〜1） */
  private trafficLoudness(): number {
    let sum = 0;
    for (const v of this.traffic.vehicles) {
      const d = Math.hypot(v.x - this.anchor.x, v.z - this.anchor.z);
      if (d > 150) continue;
      sum += (Math.min(1, 0.25 + v.speed / 14) * (v.type === "bus" ? 1.6 : 1)) / (1 + (d / 14) ** 2);
    }
    return Math.min(1, sum);
  }

  /** 交通を進める（一時停止中は止める）。自転車を避ける相手として渡す */
  private updateTraffic(dt: number, pose: ReturnType<Ride["pose"]> | null) {
    const ride = this.ride;
    if (this.paused || !ride) return;
    const rider: Rider | null = pose ? { x: pose.x, z: pose.z, dx: pose.dx, dz: pose.dz, speed: ride.speed, pos: { ...ride.pos }, offset: ride.offset } : null;
    this.traffic.hour = this.view.env.hour;
    let left = dt * this.timeScale;
    while (left > 1e-6) {
      const h = Math.min(0.1, left);
      this.traffic.update(h, this.anchor.x, this.anchor.z, rider);
      left -= h;
    }
  }

  /** 検証用: 時刻・天候を決める（null で世界のものに戻す） */
  setForcedSky(f: { hour?: number; weather?: WeatherKind } | null) {
    this.forceSky = f;
    this.skySnap = true;
  }

  /** 眺める乗り方の開始・終了: 自動の入力元、画面の常時点灯（視点は選んだままにする。2026-11-17 ユーザー） */
  setWatching(on: boolean) {
    this.watching = on;
    if (this.ride) this.ride.power = on ? this.auto : this.manual;
    platform.keepAwake(on);
    // 終わったら、選んでいた視点に戻す
    if (!on && (CAMERA_MODES as readonly string[]).includes(this.settings.camera)) {
      this.camera = this.settings.camera as CameraMode;
      this.smoothEye = null;
    }
  }

  /** 眺める乗り方の毎フレームの処理: 進路を選ぶ */
  private updateWatching(t: number) {
    const ride = this.ride;
    if (!this.watching || !ride) return;
    const u = ride.upcoming;
    if (u && u.selected === null && !ride.plan) {
      const i = watchChoice(u, this.settings.watchRoute, this.ridden, this.roads.net);
      if (i !== u.defaultIndex) ride.choose(i);
    }
  }

  /** 世界地図を開く・閉じる。地図を押すと行き先になる */
  toggleMap() {
    if (this.mapOverlay.isOpen) {
      this.mapOverlay.close();
      return;
    }
    const p = this.ride?.road ? this.ride.pose() : null;
    this.mapOverlay.open(p?.x ?? this.anchor.x, p?.z ?? this.anchor.z, {
      ridden: this.ridden,
      player: () => (this.ride?.road ? this.ride.pose() : null),
      goal: () => this.ride?.goal ?? null,
      stamped: () => this.stampSet,
      onTap: (x, z) => {
        this.goalLandmark = null;
        this.ride?.setGoal(x, z);
      },
      landmarks: () => this.landmarkMarks(),
    });
  }

  /** 起動画面を出す（止めて保存する） */
  showTitle() {
    this.hud.toggleMenu(false);
    this.depart();
    this.paused = true;
    if (this.mapOverlay.isOpen) this.mapOverlay.close();
    this.hud.root.classList.add("hidden");
    void this.save().then(() => this.title.show(this.snapshot()));
  }

  private leaveTitle(c: "continue" | "new" | "watch") {
    if (c === "new") this.startNew();
    if (c === "watch") this.setWatching(true);
    else this.setWatching(false);
    this.hud.root.classList.remove("hidden");
    this.paused = false;
    this.smoothEye = null;
  }

  /** はじめから: 記録（位置・総距離・走った区間・スタンプ）を消して起点から。設定と装いは残す */
  startNew() {
    this.ridden = new RiddenLog();
    this.stamps = [];
    this.stampSet = new Set();
    this.lastCafe = null;
    this.lastLandmark = null;
    this.goalLandmark = null;
    this.resume = { pos: null, odometer: 0, climb: 0, time: 0, generator: this.view.world.generator };
    this.anchor = { ...this.view.world.origin };
    this.ride = null;
    this.smoothEye = null;
    void this.save();
  }

  /** 止まった所の 30m 以内に喫茶店の前があれば、立ち寄りにする */
  private checkCafe(t: number) {
    const ride = this.ride;
    if (!ride?.road || this.stop) return;
    const p = ride.pose();
    const lc = this.lastCafe;
    if (lc && Math.hypot(lc.x - p.x, lc.z - p.z) > 60) this.lastCafe = null;
    if (ride.speed > 0.3) return;
    for (const c of this.view.towns.cafesNear(p.x, p.z, 80)) {
      if (this.lastCafe && (this.lastCafe.id === "*" || this.lastCafe.id === c.poi.id)) continue;
      if (Math.hypot(c.roadX - p.x, c.roadZ - p.z) > 30) continue;
      this.arrive(c, t);
      return;
    }
  }

  private arrive(c: Cafe, t: number) {
    let st = this.stamps.find((x) => x.poi === c.poi.id);
    if (st) st.visits++;
    else {
      st = {
        poi: c.poi.id,
        name: c.poi.name,
        date: new Date().toLocaleDateString("sv-SE"),
        visits: 1,
        x: c.roadX,
        z: c.roadZ,
        elevation: c.roadY,
        road: c.poi.road,
        s: c.poi.s,
      };
      this.stamps.push(st);
      this.stampSet.add(c.poi.id);
    }
    this.stop = { cafe: c, landmark: null, t0: t };
    this.lastCafe = { id: c.poi.id, x: c.roadX, z: c.roadZ };
    this.hud.toggleMenu(false);
    this.hud.root.classList.add("hidden");
    this.stopPanel.show(st, this.stamps.length);
    void this.save();
  }

  /** 名所帳を開く: 今いる所からの距離と方角、行ったかどうか */
  openLandmarkBook() {
    const list = this.view.landmarks?.list ?? [];
    const p = this.ride?.road ? this.ride.pose() : this.anchor;
    const goal = this.ride?.goal;
    this.landmarkBook.open(
      list.map((lm) => ({
        lm,
        distance: Math.hypot(lm.x - p.x, lm.z - p.z),
        dir: compass(lm.x - p.x, lm.z - p.z),
        stamp: this.stamps.find((st) => st.poi === landmarkStampId(lm.id)) ?? null,
        goal: !!goal && this.goalLandmark === lm && goal.x === lm.x && goal.z === lm.z,
      })),
    );
  }

  /** 名所を行き先にする（経路は地図で選んだ行き先と同じに探す） */
  goToLandmark(lm: LandmarkData): boolean {
    this.goalLandmark = lm;
    return this.ride?.setGoal(lm.x, lm.z) ?? false;
  }

  /** 地図・小地図に出す名所の印 */
  private landmarkMarks() {
    const list = this.view.landmarks?.list ?? [];
    const goal = this.ride?.goal;
    return list.map((lm) => ({ x: lm.x, z: lm.z, name: lm.name, visited: this.stampSet.has(landmarkStampId(lm.id)), goal: !!goal && goal.x === lm.x && goal.z === lm.z }));
  }

  /** 止まった所が名所の区域のそば（名所の草案）なら、名所の立ち寄りにする */
  private checkLandmark(t: number) {
    const ride = this.ride;
    const list = this.view.landmarks?.list;
    if (!ride?.road || this.stop || !list) return;
    const p = ride.pose();
    const ll = this.lastLandmark;
    if (ll && Math.hypot(ll.x - p.x, ll.z - p.z) > 150) this.lastLandmark = null;
    if (ride.speed > 0.3 || this.lastLandmark?.id === "*") return;
    // 着いた名所が 2 つ以上なら、行き先の名所、無ければ行き先の点が近い方
    let best: LandmarkData | null = null;
    let bestD = Infinity;
    for (const lm of list) {
      if (this.lastLandmark?.id === landmarkStampId(lm.id)) continue;
      if (Math.abs(lm.x - p.x) > 3000 || Math.abs(lm.z - p.z) > 3000) continue;
      let gap = this.landmarkGap.get(lm.id);
      if (gap === undefined) {
        gap = nearestOnNetwork(this.roads.net, lm.x, lm.z)?.d ?? 0;
        this.landmarkGap.set(lm.id, gap);
      }
      if (!arrivedAt(lm, p.x, p.z, gap)) continue;
      const d = lm === this.goalLandmark ? -1 : Math.hypot(lm.x - p.x, lm.z - p.z);
      if (d < bestD) {
        best = lm;
        bestD = d;
      }
    }
    if (best) this.arriveLandmark(best, t);
  }

  private arriveLandmark(lm: LandmarkData, t: number) {
    const ride = this.ride!;
    const p = ride.pose();
    const id = landmarkStampId(lm.id);
    let st = this.stamps.find((x) => x.poi === id);
    if (st) st.visits++;
    else {
      st = {
        poi: id,
        name: lm.name,
        date: new Date().toLocaleDateString("sv-SE"),
        visits: 1,
        x: p.x,
        z: p.z,
        elevation: p.y,
        road: ride.pos.road,
        s: ride.pos.s,
      };
      this.stamps.push(st);
      this.stampSet.add(id);
    }
    if (this.goalLandmark === lm) {
      this.goalLandmark = null;
      ride.setGoal(null);
    }
    this.stop = { cafe: null, landmark: lm, t0: t };
    this.lastLandmark = { id, x: p.x, z: p.z };
    this.hud.toggleMenu(false);
    this.hud.root.classList.add("hidden");
    const all = this.view.landmarks?.list.length ?? 0;
    const done = this.stamps.filter((x) => isLandmarkStamp(x.poi)).length;
    this.stopPanel.show(st, this.stamps.length, { done, all });
    void this.save();
  }

  /** 「出発」: 走行に戻る */
  depart() {
    if (!this.stop) return;
    // 名所を出たら、150m 走るまでほかの名所にも立ち寄りにしない（隣り合う名所: テレビ塔と大通公園など）
    const lm = this.stop.landmark;
    const ride = this.ride;
    if (lm && ride?.road) {
      const p = ride.pose();
      this.lastLandmark = { id: "*", x: p.x, z: p.z };
    }
    this.stop = null;
    this.stopPanel.hide();
    this.hud.root.classList.remove("hidden");
    this.smoothEye = null;
  }

  /** スタンプ帳の店から走る（記録は引き継ぐ） */
  startFrom(st: Stamp) {
    this.depart();
    const r = this.ride;
    this.resume = {
      pos: { road: st.road, s: st.s, dir: 1, x: st.x, z: st.z },
      odometer: r?.odometer ?? 0,
      climb: r?.climb ?? 0,
      time: r?.time ?? 0,
      generator: this.view.world.generator,
    };
    this.lastCafe = { id: st.poi, x: st.x, z: st.z };
    this.lastLandmark = isLandmarkStamp(st.poi) ? { id: st.poi, x: st.x, z: st.z } : null;
    this.anchor = { x: st.x, z: st.z };
    this.ride = null;
    this.smoothEye = null;
    this.traffic.reset();
  }

  teleport(x: number, z: number) {
    // 記録は引き継ぐ
    const r = this.ride;
    if (r) this.resume = { pos: null, odometer: r.odometer, climb: r.climb, time: r.time, generator: this.view.world.generator };
    this.anchor = { x, z };
    this.ride = null;
    this.smoothEye = null;
    this.skySnap = true;
    this.traffic.reset();
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
          this.orbit.reset();
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
          this.toggleMap();
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
    this.checkCafe(t);
    this.checkLandmark(t);
    this.sound.update({
      speed: this.ride?.speed ?? 0,
      surface: this.ride?.road?.surface ?? "paved",
      riding: !!this.ride && !this.paused && !this.stop && !document.hidden,
      traffic: this.paused || document.hidden ? 0 : this.trafficLoudness(),
    });
    const ride = this.ride;
    this.manual.pedal = this.input.pedal;
    this.manual.brake = this.input.brake ? 1 : 0;
    if (ride && !this.paused && !this.stop) {
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
    this.view.nearPlane = NEAR_DEFAULT;
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
      this.view.nearPlane = c.near ?? NEAR_DEFAULT;
      this.anchor = { x: pose.x, z: pose.z };
      if (this.outfitPanel.isOpen) {
        const r = this.outfitPanel.root.getBoundingClientRect();
        const portrait = innerWidth / innerHeight < 0.8;
        const share = portrait ? (innerHeight - r.top) / innerHeight : (innerWidth - r.left) / innerWidth;
        const s = showcaseView(this.player.group, aspect, share, 0.35 + this.orbit.yaw);
        eye = { x: s.eye.x + this.view.originX, y: s.eye.y, z: s.eye.z + this.view.originZ };
        target = { x: s.target.x + this.view.originX, y: s.target.y, z: s.target.z + this.view.originZ };
        fov = s.fov;
        this.view.nearPlane = NEAR_DEFAULT;
      }
    }
    // 立ち寄り中は店の外観を回る視点
    const st = this.stop;
    const sl = st?.landmark;
    if (st && sl) {
      // 名所の立ち寄り: 名所の周りをゆっくり回って見上げる
      const v = LANDMARK_VIEW[sl.kind] ?? { r: 70, eye: 25, look: 8 };
      const g = this.view.heights.height(sl.x, sl.z);
      const a = (t - st.t0) / 14000 + 0.6;
      const ex = sl.x + Math.cos(a) * v.r;
      const ez = sl.z + Math.sin(a) * v.r;
      eye = { x: ex, y: Math.max(g + v.eye, this.view.surfaceHeight(ex, ez) + 4), z: ez };
      target = { x: sl.x, y: g + v.look, z: sl.z };
      fov = 55;
      this.view.nearPlane = NEAR_DEFAULT;
      this.smoothEye = null;
    }
    if (st?.cafe) {
      const c = st.cafe;
      // 店の正面（道路側）を中心に左右へゆっくり回る
      const a = Math.atan2(c.fz, c.fx) + Math.sin((t - st.t0) / 9000) * 1.1;
      const R = 22;
      const ex = c.x + Math.cos(a) * R;
      const ez = c.z + Math.sin(a) * R;
      eye = { x: ex, y: Math.max(c.top + 6, this.view.surfaceHeight(ex, ez) + 3), z: ez };
      target = { x: c.x, y: c.top + 2.2, z: c.z };
      fov = 50;
      this.view.nearPlane = NEAR_DEFAULT;
      this.smoothEye = null;
    }
    this.updateSky(dt);
    this.updateTraffic(dt, pose);
    this.view.frame(eye, target, fov, () => {
      const env = this.view.env;
      this.view.trafficView.update(this.traffic, this.view.originX, this.view.originZ, 2.2 * Math.max(1 - env.daylight, env.mist * 0.7), eye.x, eye.z);
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
    const pose = road ? ride.pose() : null;
    const goal = ride.goal;
    const goalDistance = goal && pose ? Math.hypot(goal.x - pose.x, goal.z - pose.z) : null;
    const gl = this.goalLandmark;
    const goalName = gl && goal && goal.x === gl.x && goal.z === gl.z ? gl.name : null;
    // 小地図（10 回／秒）と世界地図の表示
    if (pose && t - this.minimapT > 100) {
      this.minimapT = t;
      this.minimap.draw({ roads: this.roads.roadEntries(), pois: this.roads.pois.values(), ridden: this.ridden, stamped: this.stampSet, x: pose.x, z: pose.z, dx: pose.dx, dz: pose.dz, goal, landmarks: this.landmarkMarks() });
    }
    if (this.mapOverlay.isOpen)
      this.mapOverlay.setInfo(
        goalDistance !== null ? `${goalName ?? "行き先"}まで 直線 ${(goalDistance / 1000).toFixed(1)} km${ride.plan ? "" : "（経路を探索中）"}` : ride.goalReached ? "行き先に着いた" : "地図を押すと行き先を指定",
        !!goal,
      );
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
      goalDistance,
      goalName,
      hour: this.view.env.hour,
      weather: WEATHER_LABELS[this.weatherNow.kind],
    });
  }
}
