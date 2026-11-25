// 走るゲームの本体。走行（sim）を 120Hz で進め、描画・画面・入力をつなぐ。
// 描画と画面は sim の状態を読むだけ（モック仕様 3.3）。
// 保存（モック仕様 7.3）: 現在地・総距離・獲得標高・走行時間・走った区間・スタンプ・設定・装いを platform の保存に残し、起動時は続きから始める。

import { SoundSystem } from "./audio/sound.ts";
import { platform } from "./platform/index.ts";
import { DEFAULT_SETTINGS, parseSave, SAVE_VERSION, type SaveData, type SaveSettings, type Stamp, START_MONEY, type WorkSave } from "./shared/save.ts";
import { FIXED_WEATHER, type Weather, type WeatherKind, WEATHER_LABELS, weatherAt, worldDay, worldHour } from "./shared/world/weather.ts";
import { RiddenLog } from "./sim/ridden.ts";
import { watchChoice } from "./sim/watch.ts";
import { CRR, DT } from "./sim/bicycle.ts";
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
import { type BleDevice, DEFAULT_CW, type DeviceRole, TrainerLink } from "./sim/trainer/link.ts";
import { smoothedGrade, trainerGrade } from "./sim/trainer/grade.ts";
import { VirtualDevice } from "./sim/trainer/virtual.ts";
import { TrainerPanel, type TrainerSettings } from "./ui/trainer-panel.ts";
import { RideRecorder } from "./sim/trainer/recorder.ts";
import { fitFileName, recorderToFit } from "./ride-export.ts";
import { type ActivitySummary, AdventureLedger, type Sport, VERDICT_LABELS } from "./sim/adventure.ts";
import { readActivityFile } from "./shared/activity-file.ts";
import { AdventurePanel, type PreviewRow } from "./ui/adventure-panel.ts";
import { JOURNEY_MAX_S, JourneySim } from "./sim/journey.ts";
import { JourneyPanel } from "./ui/journey-panel.ts";
import { AddressBook, type AddressPoint, D0_STREET_BOX } from "./shared/world/address.ts";
import { CARRIER_COST, carryLimit, Delivery, type DeliveryOrder, type DeliveryResult, type Gear, GEAR_LABELS, gearBlocks, makeOrder, orderSeed, type Place, REGULAR_AFTER } from "./shared/delivery.ts";
import { chomeSpot, MEAL_SIGNS } from "./shared/work-places.ts";
import { Arena, type EconomyState, openCompany, ownCompany, windUp } from "./shared/economy.ts";
import { Market } from "./sim/market.ts";
import { type FreightDest, truckState } from "./shared/freight.ts";
import { RankingPanel } from "./ui/ranking-panel.ts";
import { CompanyPanel, type CompanyTab } from "./ui/company-panel.ts";
import { type StreetAsk, StreetWork } from "./sim/street-work.ts";
import { type Walker, walkersNear } from "./sim/pedestrians.ts";
import { DeliveryPanel, DeliveryStrip, OfferCard } from "./ui/delivery-panel.ts";
import { FOODS, type Pace, REST_S, Stamina } from "./shared/stamina.ts";
import { ROUTE_STYLE_LABELS, type RouteStyle } from "./sim/route-plan.ts";
import { hash } from "./shared/world/hash.ts";
import { project } from "./shared/geo/projection.ts";
import { HOKKAIDO_BASE } from "./shared/world/hokkaido.ts";

/** これより長く閉じていたら、開いた時に旅をまとめて進める (s)【初期値】 */
const JOURNEY_GAP_S = 60;
/** まとめて進める計算に 1 フレームで使う時間 (ms) */
const JOURNEY_FRAME_MS = 12;

/** 冒険の地図で、走った道と現在地の周りに未走行の道を描く距離 (m)【初期値】 */
const ADVENTURE_REVEAL = 300;
/** 冒険のワープで、走った道・立ち寄った所からこの距離 (m) までを許す【初期値】 */
const ADVENTURE_WARP = 200;
/** 眺めている間の立ち寄りを見せる時間 (ms)【初期値】 */
const WATCH_STOP_MS = 20000;

/** 配達の注文を出す丁目を、住宅街の道を走れる範囲の縁からこれだけ内側に限る (m)（配達の草案 13 章） */
const DELIVERY_MARGIN = 150;
/** 配達アプリの知らせ: 受けるか決める時間 (s)、次の知らせまでの間（走行の時間 s、最短と幅）【初期値】 */
const OFFER_WINDOW = 25;
const OFFER_GAP = [20, 40] as const;

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
  /** ワープで引き継ぐ行き先（次に走り始めた時に探し直す） */
  private carryGoal: { x: number; z: number } | null = null;
  private resume: { pos: SaveData["pos"]; odometer: number; climb: number; time: number; generator: number } | null = null;
  private saveT = 0;
  /** 最後に保存した時刻（確認用） */
  lastSaved = "";
  /** 保存した後（アカウントの同期。main.ts） */
  onSaved: () => Promise<void> | void = () => {};
  /** 保存を止める（サーバーの保存を手元に入れて読み込み直す間。配達の草案 23.3） */
  blockSave = false;
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
  /**
   * 名所の行き先から一番近い走る道の点の距離と高さ（山の上の名所で着いたとみなす範囲を広げ、麓では着かないようにする）。
   * 行き先の経路と同じく、道路網のつながりの外の切れ端（Road.island）は除く
   */
  private landmarkNear = new Map<string, { d: number; y: number } | null>();
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
  /** トレーナー・心拍計（トレーナー連携の草案）。時刻は実時間（機器の通知と同じ） */
  readonly trainer = new TrainerLink(() => performance.now());
  private trainerPanel: TrainerPanel;
  /** 機器を選ぶ画面・最初の接続の途中の役割 */
  private trainerBusy: DeviceRole | null = null;
  private trainerError = "";
  /** 最後に送ろうとした勾配（効きを掛けた後。接続点を曲がっている間はこれを保つ） */
  private trainerGradeNow = 0;
  private trainerPanelT = 0;
  /** 開発用の仮想の機器（window.__dev から出力を変えたり切ったりする） */
  readonly virtualDevices: Partial<Record<DeviceRole, VirtualDevice>> = {};
  /** トレーナーで走った記録（トレーナー連携の草案 6章）。世界ごとに 1 つ */
  recorder: RideRecorder;
  private recordLoaded = false;
  private recordSaveT = 0;
  /** 記録を消す確認（1 回目に押した時刻） */
  private clearArmedAt = -Infinity;
  /** 最後に書き出したファイルの名前（確認用） */
  lastExport = "";
  /** 冒険の乗り方の帳簿（冒険の草案）。自由で始めた世界は null */
  adventure: AdventureLedger | null = null;
  private adventurePanel = new AdventurePanel();
  /** 取り込む前の記録（ファイルから読んだ物） */
  pendingImports: ActivitySummary[] = [];
  private journeyPanel = new JourneyPanel();
  /** 閉じていた間の旅をまとめて進めている計算 */
  catchup: JourneySim | null = null;
  /** 世界地図に出す短い知らせ（冒険のワープを断った時など） */
  private mapNote: { text: string; until: number } | null = null;
  /** 住所（北海道の世界。配達の草案 13 章） */
  addresses: AddressBook | null = null;
  /** 配達の注文を出す丁目と、配達を受けられる範囲（世界座標） */
  private deliveryArea: { x0: number; z0: number; x1: number; z1: number; points: AddressPoint[] } | null = null;
  /** 出している注文（受ける前）と、受けている配達 */
  private offer: DeliveryOrder | null = null;
  /** 受けている注文（先頭が向かっている注文。リアキャリアで 2 件まで。配達の草案 22.6 の 49） */
  deliveries: Delivery[] = [];
  get delivery(): Delivery | null {
    return this.deliveries[0] ?? null;
  }
  /** 自転車の装備（保存する） */
  gear: Gear = "bag";
  /** もう注文を受けられない */
  private get full(): boolean {
    return this.deliveries.length >= carryLimit(this.gear);
  }
  /** 買い物を頼んで待っている人の注文の番号 */
  private waitingNo = -1;
  private orderNo = 0;
  /** 所持金（経営していない時）・届けた数・期限に間に合った数（配達の草案 14 章。保存する） */
  private wallet = START_MONEY;
  /** 所持金。経営している間は業者の資金（配達の草案 21.1 の 32） */
  get money(): number {
    const c = this.market ? ownCompany(this.market.state) : null;
    return c ? c.cash : this.wallet;
  }
  set money(v: number) {
    const c = this.market ? ownCompany(this.market.state) : null;
    if (c) c.cash = Math.round(v);
    else this.wallet = v;
  }
  delivered = 0;
  onTime = 0;
  /** 配達の案内（草案 3.3・14.1）: none = 住所と地図だけ、map = 地図に行き先の印、route = 経路を自動で引く */
  deliveryGuide: WorkSave["guide"] = "none";
  /** 経路の引き方（草案 14.1） */
  routeStyle: RouteStyle = "short";
  /** 脚と体力（草案 14.2）。眺める乗り方では使わない */
  stamina = new Stamina();
  /** 配達アプリ（草案 14.3）: 知らせを受けるか、出している知らせ、次の知らせの時刻（走行の時間 s） */
  appOn = true;
  /**
   * 出している注文の知らせ。配達アプリ・常連の店は until（走行の時間 s）で消える。
   * 道端の頼み事・家からの発送は ask を持ち、その場から離れると消える（配達の草案 16 章）
   */
  private cardOffer: { order: DeliveryOrder; until: number | null; ask: StreetAsk | null } | null = null;
  /** 町で見つかる仕事（頼み事の人・旗の家・店）。北海道の世界で住所を読めた時だけ */
  streetWork: StreetWork | null = null;
  /** 店ごとの届けた件数（常連の判定） */
  regulars: Record<string, number> = {};
  /** 買い物を頼んだ人（届けるまで待っている。描く時だけ使う） */
  private waitingPerson: Walker | null = null;
  /** 地図で頼み事・旗の家の前を行き先にした（着いたら止まる） */
  private stopAtGoal = false;
  /** 検証用: 世界の時刻（UNIX 秒）に足す秒 */
  workClockOffset = 0;
  private nextOfferAt = 15;
  private offerCard: OfferCard;
  /** 配達中に経路の終わりに着いたので、止まるまでブレーキをかけている */
  private arriving = false;
  private goalWasReached = false;
  private workSelects: { guide?: HTMLSelectElement; route?: HTMLSelectElement; app?: HTMLSelectElement } = {};
  private deliveryPanel = new DeliveryPanel();
  /** 経済の場（業者・縄張り・順位。配達の草案 18 章）。住所を読めた北海道の世界だけ */
  market: Market | null = null;
  private economySaved: EconomyState | null = null;
  private rankingPanel = new RankingPanel();
  private companyPanel = new CompanyPanel();
  private marketT = 0;
  private freightT = 0;
  /** 縄張りを塗った画像（地図に重ねる） */
  private territoryImg: { canvas: HTMLCanvasElement; version: number } | null = null;
  private deliveryStrip: DeliveryStrip;
  /** 受け取った・届けた直後の短い知らせ */
  private deliveryNote: { text: string; until: number } | null = null;

  constructor(
    private view: WorldView,
    private roads: RoadClient,
    start: { x: number; z: number } = view.world.origin,
    opts: { resume?: boolean; title?: boolean; dev?: boolean } = {},
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
    // 配達（北海道の世界。配達の草案 13 章、D0）
    this.deliveryStrip = new DeliveryStrip(this.hud.root);
    this.offerCard = new OfferCard(this.hud.root);
    this.offerCard.onAccept = () => this.acceptCardOffer();
    this.offerCard.onSkip = () => this.skipCardOffer();
    if (view.world.id === "hokkaido") this.setupDelivery();
    // トレーナー（トレーナー連携の草案 5章）
    this.trainerPanel = new TrainerPanel(this.trainerSettings(), !!opts.dev);
    this.trainerPanel.onConnect = (role) => void this.connectDevice(role);
    this.trainerPanel.onDisconnect = (role) => {
      this.trainer.detach(role);
      this.trainerError = "";
      this.refreshTrainer();
    };
    if (opts.dev) this.trainerPanel.onVirtual = (role) => void this.attachVirtual(role);
    this.trainerPanel.onExport = () => void this.exportRecord();
    this.trainerPanel.onClearRecord = () => this.clearRecord();
    this.recorder = new RideRecorder(view.world.id);
    void platform.storage.load(this.recordKey).then((text) => {
      try {
        const r = text ? RideRecorder.fromJSON(JSON.parse(text)) : null;
        if (r && r.world === view.world.id) this.recorder = r;
      } catch {
        /* 壊れた記録は使わない */
      }
      this.recordLoaded = true;
      this.refreshTrainer();
    });
    this.trainerPanel.onSettings = (t) => {
      if (t.effect !== undefined) this.settings.trainerEffect = t.effect;
      if (t.bodyMass !== undefined) this.settings.bodyMass = t.bodyMass;
      if (t.bikeMass !== undefined) this.settings.bikeMass = t.bikeMass;
      if (t.route !== undefined) this.settings.trainerRoute = t.route;
      this.applyMass();
      void this.save();
    };
    this.trainer.onChange = () => this.refreshTrainer();
    // 冒険（冒険の草案 5 章）
    this.adventurePanel.onFiles = (files) => void this.readImportFiles(files);
    this.adventurePanel.onSport = (i, sport) => this.setPendingSport(i, sport);
    this.adventurePanel.onConfirm = () => this.confirmImports();
    this.adventurePanel.onCancelPreview = () => {
      this.pendingImports = [];
      this.adventurePanel.showPreview([]);
    };
    this.adventurePanel.onJourney = () => {
      this.adventurePanel.close();
      this.settings.watchRoute = "unridden";
      this.routeSel.value = "unridden";
      this.paused = false;
      this.depart();
      this.setWatching(true);
      // 旅に出る: 閉じている間も進む（冒険の草案 4.2）
      const now = Date.now() / 1000;
      if (this.adventure) this.adventure.journey = { startedAt: now, lastSimulated: now };
      void this.save();
    };
    this.adventurePanel.onLastJourney = () => {
      const l = this.adventure?.lastJourney;
      if (!l) return;
      this.adventurePanel.close();
      this.journeyPanel.open(l, this.adventure!.balance);
    };
    this.adventurePanel.onFree = () => {
      if (this.adventure) this.adventure.mode = "free";
      void this.save();
      this.adventurePanel.update(this.adventureView());
    };
    this.hud.addButton("冒険", () => {
      this.hud.toggleMenu(false);
      this.adventurePanel.open(this.adventureView());
      this.adventurePanel.showPreview(this.previewRows());
    });
    this.hud.addButton("トレーナー", () => {
      this.hud.toggleMenu(false);
      this.refreshTrainer();
      this.trainerPanel.open();
    });
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
        void this.saveRecord();
      }
    });
    addEventListener("pagehide", () => {
      void this.save();
      void this.saveRecord();
    });
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
    this.trainerPanel.sync(this.trainerSettings());
    this.adventure = d.adventure ? AdventureLedger.fromJSON(d.adventure) : null;
    this.applyWork(d.work);
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
      adventure: this.adventure?.toJSON() ?? null,
      work: { money: this.wallet, delivered: this.delivered, onTime: this.onTime, stamina: this.stamina.toJSON(), guide: this.deliveryGuide, routeStyle: this.routeStyle, app: this.appOn, regulars: this.regulars, economy: this.market?.state ?? this.economySaved, gear: this.gear },
    };
  }

  async save() {
    if (!this.loaded || this.blockSave) return;
    const d = this.snapshot();
    await platform.storage.save(this.view.world.saveKey, JSON.stringify(d));
    this.lastSaved = d.savedAt;
    await this.onSaved();
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
    const ride = new Ride(this.roads.net, pos, this.powerSource());
    ride.ridden = this.ridden;
    ride.routeStyle = this.routeStyle;
    ride.bike.mass = this.settings.bodyMass + this.settings.bikeMass;
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
    // ワープの前の行き先を、移った所から探し直す
    const g = this.carryGoal;
    this.carryGoal = null;
    if (g) ride.setGoal(g.x, g.z);
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
    // 眺めるのをやめたら旅も終わる（冒険の草案 4）
    if (!on && this.adventure) this.adventure.journey = null;
    if (this.ride) this.ride.power = this.powerSource();
    platform.keepAwake(on || this.trainer.hasTrainer);
    // 終わったら、選んでいた視点に戻す
    if (!on && (CAMERA_MODES as readonly string[]).includes(this.settings.camera)) {
      this.camera = this.settings.camera as CameraMode;
      this.smoothEye = null;
    }
  }

  /** 眺める乗り方の毎フレームの処理: 進路を選ぶ */
  private updateWatching(t: number) {
    const ride = this.ride;
    if (!ride) return;
    // トレーナーで走る時も、選んであれば眺める乗り方の進路の選び方を使う（トレーナー連携の草案 11 章の 4）
    const route = this.watching ? this.settings.watchRoute : ride.power === this.trainer.power && this.settings.trainerRoute !== "manual" ? this.settings.trainerRoute : null;
    if (!route) return;
    // 冒険: 冒険の距離がほとんど無ければ走った道を選ぶ。尽きて止まったら折り返す（冒険の草案 2.1）
    const budget = ride.adventure ? ride.adventure.balance : null;
    if (this.watching && ride.blocked && ride.speed < 0.5 && !this.paused && !this.stop) ride.uTurn();
    const u = ride.upcoming;
    if (u && u.selected === null && !ride.plan) {
      const i = watchChoice(u, route, this.ridden, this.roads.net, budget);
      if (i !== u.defaultIndex) ride.choose(i);
    }
  }

  /** 世界地図を開く・閉じる。地図を押すと行き先になる（「ワープ」の間は、押した所へワープして地図を閉じる） */
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
        if (this.mapOverlay.warping) {
          // 冒険では、走った道か立ち寄った所の近くへだけ（冒険の草案 2.1）
          if (this.adventure?.active && !this.canWarpTo(x, z)) {
            this.mapNote = { text: "冒険では、走った道か立ち寄った所の近くへだけワープできる", until: performance.now() + 4000 };
            return;
          }
          this.mapOverlay.close();
          this.teleport(x, z);
          return;
        }
        this.goalLandmark = null;
        // 頼み事の人・旗の家の近くを押したら、その前を行き先にして着いたら止まる（配達の草案 16 章）
        const snap = this.full ? null : this.streetWork?.snap(x, z);
        this.stopAtGoal = !!snap;
        this.ride?.setGoal(snap?.x ?? x, snap?.z ?? z);
        // 半オート: 止まっていれば「ふつう」で漕ぎ出す（配達の草案 14.1）
        if (this.manual.pace === 0) this.setPace(2);
      },
      landmarks: () => this.landmarkMarks(),
      addresses: this.addresses ?? undefined,
      marks: () => [...this.deliveryMarks(), ...this.workMarks(true)],
      territory: () => this.territoryLayer(),
      depots: () => this.market?.depots() ?? [],
      freight: () => this.freightLayer(),
      // 経営している業者は先頭に（凡例は 8 行まで）
      legend: () => {
        const mine = this.market?.own()?.id;
        return [...(this.market?.now.entities ?? [])]
          .filter((e) => e.area > 0 || e.id === mine)
          .sort((p, q) => Number(q.id === mine) - Number(p.id === mine) || q.area - p.area)
          .map((e) => ({ name: e.id === mine ? `${e.name}（経営）` : e.name, color: e.color }));
      },
      reveal: () => (this.adventure?.active ? ADVENTURE_REVEAL : null),
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

  private leaveTitle(c: "continue" | "new" | "new-adventure" | "watch") {
    if (c === "new") this.startNew("free");
    if (c === "new-adventure") this.startNew("adventure");
    // 続きから: 旅の途中なら眺めたまま（閉じていた間の旅をまとめて進める）
    if (c === "watch" || (c === "continue" && this.adventure?.journey)) this.setWatching(true);
    else this.setWatching(false);
    this.hud.root.classList.remove("hidden");
    this.paused = false;
    this.smoothEye = null;
  }

  private adventureView() {
    const a = this.adventure;
    return { mode: a ? a.mode : null, balance: a?.balance ?? 0, spent: a?.spent ?? 0, imports: a?.imports ?? [], hasLastJourney: !!a?.lastJourney };
  }

  /** 選んだファイルを読んで、取り込む前の一覧に足す（位置は読んだ所で距離にして捨てる。冒険の草案 3.1） */
  async readImportFiles(files: { name: string; arrayBuffer(): Promise<ArrayBuffer> }[]) {
    const errors: string[] = [];
    for (const f of files) {
      try {
        const acts = await readActivityFile(f.name, new Uint8Array(await f.arrayBuffer()));
        if (!acts.length) errors.push(`${f.name}: 記録が無い`);
        this.pendingImports.push(...acts.map((a) => ({ ...a, file: f.name })));
      } catch (e) {
        errors.push(`${f.name}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    this.pendingImports.sort((a, b) => a.start - b.start);
    this.adventurePanel.showPreview(this.previewRows(), errors.join(" / "));
  }

  private previewRows(): PreviewRow[] {
    const a = this.adventure;
    if (!a) return [];
    const now = Date.now() / 1000;
    return this.pendingImports.map((p) => {
      const v = a.evaluate(p, now, this.pendingImports);
      return { file: p.file ?? "", sport: p.sport, start: p.start, distance: p.distance, seconds: p.seconds, credit: v.ok ? v.credit : null, reason: v.ok ? "" : VERDICT_LABELS[v.reason] };
    });
  }

  private setPendingSport(i: number, sport: Sport) {
    const p = this.pendingImports[i];
    if (p) p.sport = sport;
    this.adventurePanel.showPreview(this.previewRows());
  }

  /** 一覧の取り込める記録を取り込む */
  confirmImports(): number {
    const a = this.adventure;
    if (!a) return 0;
    const now = Date.now() / 1000;
    let total = 0;
    for (const p of this.pendingImports) total += a.add(p, now);
    this.pendingImports = [];
    void this.save();
    this.adventurePanel.showPreview([]);
    this.adventurePanel.update(this.adventureView());
    return total;
  }

  /** 冒険のワープ: 走った道か、立ち寄った店・名所の近くか */
  private canWarpTo(x: number, z: number): boolean {
    const r2 = ADVENTURE_WARP * ADVENTURE_WARP;
    if (this.stamps.some((s) => (s.x - x) ** 2 + (s.z - z) ** 2 <= r2)) return true;
    return this.mapOverlay.map?.nearRidden(this.ridden, x, z, ADVENTURE_WARP) ?? false;
  }

  /**
   * 旅（冒険の草案 4.2）: 眺めて走っている間は進めた時刻を今にする。閉じていた・タブを隠していた間が 60 秒を超えたら、
   * その時間（12 時間まで）を描かずにまとめて進め、終わったら旅の記録を出す。まとめて進めている間は true
   */
  private updateJourney(): boolean {
    const adv = this.adventure;
    const j = adv?.journey;
    const ride = this.ride;
    const now = Date.now() / 1000;
    if (!adv?.active || !j || !ride?.road || !this.watching) {
      if (this.catchup) this.endCatchup();
      return false;
    }
    if (this.catchup) {
      const sim = this.catchup;
      const t0 = performance.now();
      let st = sim.run(200);
      while (st === "running" && performance.now() - t0 < JOURNEY_FRAME_MS) st = sim.run(200);
      const p = ride.pose();
      this.anchor = { x: p.x, z: p.z };
      this.journeyPanel.setProgress(`閉じていた間の旅を計算している（${(sim.log.distance / 1000).toFixed(1)} km・${Math.round((sim.elapsed / sim.seconds) * 100)}%）${st === "waiting" ? " 道路を読み込み中" : ""}`);
      if (st === "done") this.finishCatchup(sim, now);
      return true;
    }
    if (this.paused || this.stop) return false;
    const gap = now - j.lastSimulated;
    if (gap <= JOURNEY_GAP_S) {
      j.lastSimulated = now;
      return false;
    }
    // まとめて進め始める
    const roads = this.roads;
    const landmarks = (this.view.landmarks?.list ?? []).map((l) => ({ id: l.id, name: l.name, x: l.x, z: l.z }));
    this.catchup = new JourneySim(
      ride,
      {
        net: roads.net,
        ridden: this.ridden,
        ledger: adv,
        route: "unridden",
        ensure: (x, z) => {
          roads.update(x, z);
          return roads.ready({ x0: x - 1500, z0: z - 1500, x1: x + 1500, z1: z + 1500 });
        },
        pois: () => roads.pois.values(),
        landmarks,
      },
      Math.min(gap, JOURNEY_MAX_S),
      j.lastSimulated,
    );
    this.catchupStarted = performance.now();
    return true;
  }

  /** 最後にまとめて進めた計算にかかった時間 (ms、確認用) */
  lastCatchupMs = 0;
  private catchupStarted = 0;

  private finishCatchup(sim: JourneySim, now: number) {
    const adv = this.adventure!;
    const log = sim.log;
    this.lastCatchupMs = performance.now() - this.catchupStarted;
    // 前を通った喫茶店にスタンプを付ける
    const date = new Date().toLocaleDateString("sv-SE");
    for (const c of log.cafes) {
      const st = this.stamps.find((x) => x.poi === c.id);
      if (st) st.visits++;
      else {
        this.stamps.push({ poi: c.id, name: c.name, date, visits: 1, x: c.x, z: c.z, elevation: c.y, road: c.road, s: c.s });
        this.stampSet.add(c.id);
      }
    }
    adv.lastJourney = log;
    if (adv.journey) adv.journey.lastSimulated = now;
    this.endCatchup();
    this.traffic.reset();
    this.skySnap = true;
    void this.save();
    this.journeyPanel.open(log, adv.balance);
  }

  private endCatchup() {
    this.catchup = null;
    this.smoothEye = null;
    this.journeyPanel.setProgress(null);
  }

  /** 推進力の入力元: 眺める乗り方は自動、トレーナーがつながっていればトレーナー、それ以外は手動 */
  private powerSource() {
    return this.watching ? this.auto : this.trainer.hasTrainer ? this.trainer.power : this.manual;
  }

  /** 体重と機材の重さ（トレーナー連携の草案 3.2） */
  private applyMass() {
    if (this.ride) this.ride.bike.mass = this.settings.bodyMass + this.settings.bikeMass;
  }

  private trainerSettings(): TrainerSettings {
    const st = this.settings;
    return { effect: st.trainerEffect, bodyMass: st.bodyMass, bikeMass: st.bikeMass, route: st.trainerRoute };
  }

  /** 機器を選んでつなぐ（押す操作の中から呼ぶ。選ぶ画面を出すまでに await を挟まない） */
  private async connectDevice(role: DeviceRole) {
    if (this.trainerBusy) return;
    this.trainerBusy = role;
    this.trainerError = "";
    let chosen: Promise<BleDevice | null>;
    try {
      chosen = platform.bluetooth.choose(role);
    } catch (e) {
      chosen = Promise.reject(e);
    }
    this.refreshTrainer();
    try {
      const dev = await chosen;
      if (dev && !(await this.trainer.attach(role, dev))) this.trainerError = this.trainer.lastError || "機器が応えない";
    } catch (e) {
      this.trainerError = e instanceof Error ? e.message : String(e);
    } finally {
      this.trainerBusy = null;
      this.refreshTrainer();
    }
  }

  /** 開発用: 仮想の機器をつなぐ */
  async attachVirtual(role: DeviceRole): Promise<VirtualDevice> {
    const dev = new VirtualDevice(role);
    this.virtualDevices[role] = dev;
    this.trainerBusy = role;
    this.refreshTrainer();
    try {
      await this.trainer.attach(role, dev);
    } finally {
      this.trainerBusy = null;
      this.refreshTrainer();
    }
    return dev;
  }

  /** 機器の状態が変わった: 入力元・常時点灯・画面 */
  private refreshTrainer() {
    if (this.ride) this.ride.power = this.powerSource();
    platform.keepAwake(this.watching || this.trainer.hasTrainer);
    this.trainerPanel.update({
      available: platform.bluetooth.available,
      trainer: this.trainer.info("trainer"),
      heart: this.trainer.info("heart"),
      signal: this.trainer.power.signal,
      busy: this.trainerBusy,
      error: this.trainerError,
      record: {
        seconds: this.recorder.timerSeconds,
        distance: this.recorder.totalDistance,
        samples: this.recorder.length,
        full: this.recorder.full,
        clearArmed: performance.now() - this.clearArmedAt <= 3000,
      },
    });
  }

  private get recordKey() {
    return `ride-log-${this.view.world.id}`;
  }

  /**
   * 記録（トレーナー連携の草案 6.1）: トレーナーで走っている間、1 秒に 1 回。最初に出力が 0 より大きくなった時に始める。
   * 一時停止・立ち寄り・タブが隠れている・トレーナーが外れている間は残さず、その間に進んだ道のりも数えない。30 秒ごとに保存する
   */
  private updateRecord() {
    const rec = this.recorder;
    const ride = this.ride;
    const ok = this.recordLoaded && !!ride?.road && ride.power === this.trainer.power && !this.paused && !this.stop && !document.hidden;
    if (ride && ok && (rec.length > 0 || this.trainer.power.watts > 0)) {
      const p = ride.pose();
      rec.record({
        now: Date.now(),
        odometer: ride.odometer,
        climb: ride.climb,
        speed: ride.speed,
        power: this.trainer.power.watts,
        cadence: this.trainer.cadenceRpm,
        heartRate: this.trainer.heartRate,
        altitude: p.y,
        grade: ride.grade,
        x: p.x,
        z: p.z,
      });
    } else rec.gap();
    const now = performance.now();
    if (rec.dirty && now - this.recordSaveT > 30000) {
      this.recordSaveT = now;
      void this.saveRecord();
    }
  }

  async saveRecord() {
    if (!this.recordLoaded || !this.recorder.dirty) return;
    this.recorder.dirty = false;
    if (this.recorder.length) await platform.storage.save(this.recordKey, JSON.stringify(this.recorder.toJSON()));
    else await platform.storage.remove(this.recordKey);
  }

  /** FIT で書き出して、記録を区切る（草案 6.1） */
  async exportRecord(): Promise<string | null> {
    const rec = this.recorder;
    if (!rec.length) return null;
    const name = fitFileName(rec);
    await platform.saveFile(name, recorderToFit(rec), "application/vnd.ant.fit");
    this.lastExport = name;
    rec.clear();
    await this.saveRecord();
    this.refreshTrainer();
    return name;
  }

  /** 記録を消す（3 秒以内にもう一度押した時だけ） */
  clearRecord() {
    const now = performance.now();
    if (now - this.clearArmedAt > 3000) {
      this.clearArmedAt = now;
      this.refreshTrainer();
      return;
    }
    this.clearArmedAt = -Infinity;
    this.recorder.clear();
    void this.saveRecord();
    this.refreshTrainer();
  }

  /** 走行中の表示に出すトレーナーの状態（問題がある時だけ） */
  private trainerNote(): string | null {
    const i = this.trainer.info("trainer");
    if (!i) return null;
    if (i.state !== "connected") return "トレーナー 再接続を待っている";
    if (!this.trainer.power.signal) return "トレーナー 出力の信号なし";
    return null;
  }

  /**
   * トレーナーへ勾配を送る（トレーナー連携の草案 4章）。前後 15m の平均に効きを掛ける。
   * 一時停止中・立ち寄り中・眺めている間は 0。接続点を曲がっている間は曲がる前の値を保つ
   */
  private updateTrainer() {
    const link = this.trainer;
    if (!link.hasTrainer) return;
    const ride = this.ride;
    const road = ride?.road;
    let grade = 0;
    if (ride && road && !this.paused && !this.stop && !this.watching) {
      grade = ride.turn ? this.trainerGradeNow : trainerGrade(smoothedGrade(road, ride.pos.s, ride.pos.dir), this.settings.trainerEffect);
    }
    this.trainerGradeNow = grade;
    link.update({ grade, crr: CRR[road?.surface ?? "paved"], cw: DEFAULT_CW });
  }

  /** はじめから: 記録（位置・総距離・走った区間・スタンプ）を消して起点から。設定と装いは残す */
  startNew(mode: "free" | "adventure" = "free") {
    // 冒険は最初に 20km を持って始める（冒険の草案 2 章）
    this.adventure = mode === "adventure" ? new AdventureLedger(Math.floor(Date.now() / 1000)) : null;
    this.pendingImports = [];
    this.ridden = new RiddenLog();
    this.stamps = [];
    this.stampSet = new Set();
    this.lastCafe = null;
    this.lastLandmark = null;
    this.goalLandmark = null;
    this.carryGoal = null;
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
    this.showCafeExtras("");
    void this.save();
  }

  // ---- 配達（配達の草案 13 章、D0） ----

  private setupDelivery() {
    const a = project(D0_STREET_BOX.north, D0_STREET_BOX.west);
    const b = project(D0_STREET_BOX.south, D0_STREET_BOX.east);
    void fetch(`${HOKKAIDO_BASE}addresses.json`)
      .then((r) => (r.ok ? (r.json() as Promise<AddressPoint[]>) : null))
      .then((list) => {
        if (!list) return;
        this.addresses = new AddressBook(list);
        const m = DELIVERY_MARGIN;
        this.deliveryArea = {
          x0: a.x,
          z0: a.z,
          x1: b.x,
          z1: b.z,
          points: list.filter((p) => p.jo !== undefined && p.x > a.x + m && p.x < b.x - m && p.z > a.z + m && p.z < b.z - m),
        };
        const area = this.deliveryArea;
        this.buildMarket(list, a, b);
        this.streetWork = new StreetWork(this.roads.net, this.view.world.local?.buildings ?? null, this.addresses, (x, z) => x > area.x0 + m && x < area.x1 - m && z > area.z0 + m && z < area.z1 - m);
      })
      .catch(() => {
        /* 住所が無ければ配達は出さない */
      });
    this.deliveryPanel.onClose = () => this.deliveryPanel.hide();
    this.deliveryPanel.onOther = () => this.newOrder();
    this.deliveryPanel.onAccept = () => this.acceptOrder();
    this.deliveryPanel.onCancel = (i) => {
      const d = this.deliveries[i];
      if (!d) return;
      this.deliveries = this.deliveries.filter((x) => x !== d);
      if (d.order.no === this.waitingNo) this.waitingPerson = null;
      this.deliveryPanel.hide();
      if (i === 0 && this.delivery) this.guideTo(this.delivery.target);
    };
    this.deliveryPanel.onFocus = (i) => {
      const d = this.deliveries[i];
      if (!d) return;
      this.deliveries = [d, ...this.deliveries.filter((x) => x !== d)];
      this.deliveryPanel.hide();
      this.guideTo(d.target);
    };
    this.deliveryPanel.onBuyGear = () => {
      if (this.gear === "carrier" || this.money < CARRIER_COST) return;
      this.money -= CARRIER_COST;
      this.gear = "carrier";
      void this.save();
      this.openGear();
    };
    this.hud.addButton("装備", () => {
      this.hud.toggleMenu(false);
      this.openGear();
    });
    this.deliveryPanel.onMove = () => {
      this.deliveryPanel.hide();
      const p = this.addresses?.byName.get("大通西4丁目");
      if (p) this.teleport(p.x, p.z);
    };
    this.hud.addButton("配達", () => {
      this.hud.toggleMenu(false);
      this.openDelivery();
    });
    this.hud.addButton("順位", () => {
      this.hud.toggleMenu(false);
      this.openRanking();
    });
    this.hud.addButton("経営", () => {
      this.hud.toggleMenu(false);
      this.openCompany();
    });
    this.companyPanel.onChange = () => {
      this.market?.touch(this.worldToday());
      void this.save();
    };
    this.companyPanel.onOpen = (name, chome) => {
      const m = this.market;
      if (!m) return;
      if (!openCompany(m.arena, m.state, this.worldToday(), chome, name, this.wallet)) return;
      this.wallet = 0;
      this.companyPanel.closedNote = "";
      m.touch(this.worldToday());
      void this.save();
      this.openCompany();
    };
    this.companyPanel.onWindUp = () => {
      const m = this.market;
      const c = m?.own();
      if (!m || !c) return;
      this.wallet = windUp(m.state, c, this.worldToday());
      this.companyPanel.closedNote = `${c.name}を畳んだ。所持金 ${this.wallet.toLocaleString("ja-JP")} 円`;
      m.touch(this.worldToday());
      void this.save();
      this.openCompany();
    };
    this.rankingPanel.onJoin = (id) => {
      if (!this.market) return;
      this.market.state.player.company = id;
      this.market.update(this.worldToday(), this.nowMs());
      this.market.version++;
      this.openRanking();
      void this.save();
    };
    this.workSelects.guide = this.hud.addSelect(
      "配達の案内",
      [
        ["none", "住所と地図だけ"],
        ["map", "地図に行き先の印"],
        ["route", "経路を自動で引く"],
      ],
      this.deliveryGuide,
      (v) => {
        this.deliveryGuide = v;
        void this.save();
      },
    );
    this.workSelects.route = this.hud.addSelect(
      "経路の引き方",
      (Object.keys(ROUTE_STYLE_LABELS) as RouteStyle[]).map((k) => [k, ROUTE_STYLE_LABELS[k]] as [RouteStyle, string]),
      this.routeStyle,
      (v) => {
        this.routeStyle = v;
        const r = this.ride;
        if (r) {
          r.routeStyle = v;
          if (r.goal) r.setGoal(r.goal.x, r.goal.z);
        }
        void this.save();
      },
    );
    this.workSelects.app = this.hud.addSelect(
      "配達アプリ",
      [
        ["on", "知らせを受ける"],
        ["off", "受けない"],
      ],
      this.appOn ? "on" : "off",
      (v) => {
        this.appOn = v === "on";
        if (!this.appOn && this.cardOffer && !this.cardOffer.ask) this.closeCardOffer();
        void this.save();
      },
    );
  }

  /** 保存データの仕事の記録を戻す（無ければ始めの状態） */
  private applyWork(w: WorkSave | null) {
    this.wallet = w?.money ?? START_MONEY;
    this.delivered = w?.delivered ?? 0;
    this.onTime = w?.onTime ?? 0;
    this.stamina = Stamina.fromJSON(w?.stamina ?? null);
    this.deliveryGuide = w?.guide ?? "none";
    this.routeStyle = w?.routeStyle ?? "short";
    this.appOn = w?.app ?? true;
    this.regulars = { ...(w?.regulars ?? {}) };
    this.gear = w?.gear ?? "bag";
    this.economySaved = w?.economy ?? null;
    if (this.market) {
      this.market = new Market(this.market.arena, this.roads.seed, this.worldToday(), this.economySaved, this.nowMs());
      this.checkClosed();
      this.checkAway();
    }
    if (this.ride) this.ride.routeStyle = this.routeStyle;
    const sel = this.workSelects;
    if (sel.guide) sel.guide.value = this.deliveryGuide;
    if (sel.route) sel.route.value = this.routeStyle;
    if (sel.app) sel.app.value = this.appOn ? "on" : "off";
  }

  /** ペースを選ぶ（配達の草案 14.1） */
  setPace(p: Pace) {
    this.manual.pace = p;
  }

  /** 喫茶店でできること: 食べる・休む（配達の草案 14.2） */
  private showCafeExtras(note: string) {
    const buttons = FOODS.map((f) => ({
      label: `${f.name} ${f.price} 円`,
      disabled: this.money < f.price || this.stamina.energyShare >= 0.999,
      onClick: () => {
        this.money -= f.price;
        this.stamina.eat(f.energy);
        this.showCafeExtras(`体力 ${Math.round(this.stamina.energyShare * 100)}%  所持金 ${this.money} 円`);
        void this.save();
      },
    }));
    buttons.push({
      label: `休む ${REST_S / 60} 分`,
      disabled: false,
      onClick: () => {
        this.stamina.rest();
        for (const d of this.deliveries) d.addTime(REST_S);
        this.showCafeExtras(`${REST_S / 60} 分休んだ  脚 100%  体力 ${Math.round(this.stamina.energyShare * 100)}%`);
        void this.save();
      },
    });
    this.stopPanel.setExtras(buttons, note || `所持金 ${this.money} 円  体力 ${Math.round(this.stamina.energyShare * 100)}%`);
  }

  /** 配達中に経路の終わりに着いたら止まり、止まったら受け取り・受け渡しを試す（配達の草案 14.1） */
  private updateArrival(ride: Ride) {
    const reached = ride.goalReached;
    if ((this.delivery || this.stopAtGoal) && reached && !this.goalWasReached && !this.watching) this.arriving = true;
    this.goalWasReached = reached;
    if (!this.arriving || ride.speed > 0.3) return;
    this.arriving = false;
    this.stopAtGoal = false;
    this.checkDelivery();
    // 次の行き先が無ければ止まったままにする
    if (!ride.goal) this.setPace(0);
  }

  /** 世界の時刻（UNIX 秒）。注文・頼み事・旗はこの時刻から決まる */
  private worldUnix(): number {
    return Date.now() / 1000 + this.workClockOffset;
  }

  /**
   * 配達アプリ・常連の店の知らせ（配達の草案 14.3・16 章）。受けている配達・開いている画面があれば出さない。
   * 常連の店があれば、知らせの 3 回に 1 回はその店から（アプリを切っていても来る）
   */
  private updateApp(time: number) {
    const ride = this.ride;
    const area = this.deliveryArea;
    const c = this.cardOffer;
    if (c?.ask) return;
    const busy = this.full || this.deliveryPanel.isOpen || !!this.stop || this.watching || this.paused;
    const hasRegular = Object.values(this.regulars).some((n) => n >= REGULAR_AFTER);
    if ((!this.appOn && !hasRegular) || !ride?.road || !area || busy) {
      if (c && !this.paused) this.closeCardOffer();
      return;
    }
    if (c) {
      if (c.until !== null && time >= c.until) this.closeCardOffer();
      else if (c.until !== null) this.offerCard.setTimer(c.until - time);
      return;
    }
    if (time < this.nextOfferAt) return;
    const p = ride.pose();
    const no = ++this.orderNo;
    const seed = orderSeed(this.worldUnix());
    let order: DeliveryOrder | null = null;
    if (this.inDeliveryArea(p.x, p.z)) {
      const regular = hasRegular && this.streetWork && (!this.appOn || hash(seed, no, 0x7e9) % 3 === 0) ? this.streetWork.regularPlaces(p.x, p.z, 800, this.regulars) : [];
      if (regular.length) order = makeOrder(area.points, p.x, p.z, no, seed, { pickups: regular, source: "regular" });
      else if (this.appOn) order = this.appOrder(p.x, p.z, no, seed);
    }
    if (!order) {
      this.scheduleOffer(time);
      return;
    }
    this.cardOffer = { order, until: time + OFFER_WINDOW, ask: null };
    this.offerCard.show(order, order.approach);
    this.offerCard.setTimer(OFFER_WINDOW);
  }

  /** 配達アプリの出前の注文: 受け取りは近くの食べ物の店（店のデータが無ければ丁目） */
  private appOrder(x: number, z: number, no: number, seed: number): DeliveryOrder | null {
    const area = this.deliveryArea;
    if (!area) return null;
    const shops = this.streetWork?.shopPlaces(x, z, 800, MEAL_SIGNS) ?? [];
    return makeOrder(area.points, x, z, no, seed, shops.length ? { pickups: shops } : {});
  }

  /** 止まった所の近くに頼み事の人・旗の家があれば、知らせを出す。離れたら消す（配達の草案 16 章） */
  private updateStreetWork(ride: Ride) {
    const sw = this.streetWork;
    if (!sw || !ride.road || this.watching) return;
    const p = ride.pose();
    if (!this.inDeliveryArea(p.x, p.z)) {
      sw.errands = [];
      sw.flags = [];
      return;
    }
    sw.refresh(p.x, p.z, ride.time, this.worldUnix());
    const c = this.cardOffer;
    if (c?.ask) {
      const at = c.ask.kind === "errand" ? { x: c.ask.errand.roadX, z: c.ask.errand.roadZ } : c.ask.flag.spot;
      if (Math.hypot(at.x - p.x, at.z - p.z) > 30 || this.full) this.closeCardOffer();
      return;
    }
    if (this.full || this.stop || this.deliveryPanel.isOpen || this.paused || ride.speed > 0.5 || !this.deliveryArea) return;
    const ask = sw.askAt(p.x, p.z);
    if (!ask) return;
    const order = sw.orderFor(ask, this.deliveryArea.points, ++this.orderNo, orderSeed(this.worldUnix()));
    if (!order) {
      // 届け先が作れない所（範囲の端など）。同じ人・家にはもう頼まれない
      sw.used.add(ask.kind === "errand" ? ask.errand.id : ask.flag.id);
      return;
    }
    if (c) this.closeCardOffer();
    this.cardOffer = { order, until: null, ask };
    this.offerCard.show(order, order.approach, gearBlocks(order, this.gear));
  }

  private scheduleOffer(time: number) {
    this.nextOfferAt = time + OFFER_GAP[0] + (hash(0x0ffe, this.orderNo) % (OFFER_GAP[1] * 10)) / 10;
  }

  private closeCardOffer() {
    const c = this.cardOffer;
    this.cardOffer = null;
    this.offerCard.hide();
    if (!c?.ask) this.scheduleOffer(this.ride?.time ?? 0);
  }

  private skipCardOffer() {
    const c = this.cardOffer;
    // 断った頼み事・旗の家は、同じ窓の間はもう出さない
    if (c?.ask && this.streetWork) this.streetWork.used.add(c.ask.kind === "errand" ? c.ask.errand.id : c.ask.flag.id);
    this.closeCardOffer();
  }

  private acceptCardOffer() {
    const c = this.cardOffer;
    if (!c || gearBlocks(c.order, this.gear) || this.full) return;
    const ask = c.ask;
    if (ask && this.streetWork) this.streetWork.used.add(ask.kind === "errand" ? ask.errand.id : ask.flag.id);
    // 買い物を頼んだ人は、届けるまでその場で待つ（待つ人は 1 人まで）
    if (ask?.kind === "errand" && c.order.kind === "shopping" && !this.deliveries.some((d) => d.order.no === this.waitingNo)) {
      this.waitingPerson = { x: ask.errand.x, y: ask.errand.y, z: ask.errand.z, dx: -ask.errand.dz, dz: ask.errand.dx, gait: 0, still: true, seed: hash(0x9e9, c.order.no) };
      this.waitingNo = c.order.no;
    }
    this.offer = c.order;
    this.closeCardOffer();
    this.acceptOrder();
  }

  /** 仕事の印（頼み事の人・旗の家）。labels なら世界地図の印の名前を付ける */
  private workMarks(labels = false): { x: number; z: number; name: string }[] {
    const sw = this.streetWork;
    if (!sw || this.full) return [];
    return [...sw.errands.map((e) => ({ x: e.roadX, z: e.roadZ, name: labels ? "頼み事" : "" })), ...sw.flags.map((f) => ({ x: f.spot.x, z: f.spot.z, name: labels ? "家からの発送" : "" }))];
  }

  /** 歩く人・頼み事の人・旗を描く（配達の範囲の中だけ） */
  private drawPeople(pose: { x: number; z: number } | null) {
    const pv = this.view.pedestrians;
    const sw = this.streetWork;
    if (!pose || !sw || !this.inDeliveryArea(pose.x, pose.z)) {
      pv.update([], [], [], this.view.originX, this.view.originZ, 0);
      return;
    }
    const t = this.worldUnix();
    const hour = this.view.env.hour;
    const density = hour >= 7 && hour < 20 ? 0.65 : hour >= 5 && hour < 23 ? 0.35 : 0.1;
    const light = this.view.quality === "light";
    // 頼み事の人・待っている人を先に入れる（描く数の上限で落とさない）
    const people: Walker[] = [];
    const marks: { x: number; y: number; z: number }[] = [];
    for (const e of sw.errands) {
      people.push({ x: e.x, y: e.y, z: e.z, dx: -e.dz, dz: e.dx, gait: 0, still: true, seed: hash(0x9e8, e.s, e.road.length) });
      marks.push(e);
    }
    const wp = this.deliveries.some((d) => d.order.no === this.waitingNo) ? this.waitingPerson : null;
    if (wp) {
      people.push(wp);
      marks.push(wp);
    }
    for (const w of walkersNear(this.roads.net.roads.values(), pose.x, pose.z, light ? 120 : 180, t, density, light ? 60 : 200, (x, z) => this.inDeliveryArea(x, z))) people.push(w);
    const flags = sw.flags.map((f) => ({ x: f.x, y: f.y, z: f.z, yaw: Math.atan2(f.house.x - f.spot.x, f.house.z - f.spot.z) + Math.PI / 2 }));
    pv.update(people, marks, flags, this.view.originX, this.view.originZ, performance.now() / 1000);
  }

  /** 世界の日の通し番号（配達の草案 17 章） */
  private worldToday(): number {
    return worldDay(Date.now() + this.clockOffset).day;
  }

  /** 今の時刻（Unix ミリ秒。確認用に clockOffset でずらせる） */
  private nowMs(): number {
    return Date.now() + this.clockOffset;
  }

  /** 長距離の便の行き先（本店の丁目ごと）と道筋（本店|市町ごと。累積の道のり付き）。配達の草案 22 章 */
  private freightDests = new Map<string, FreightDest[] | "pending">();
  private freightPaths = new Map<string, { path: number[]; cum: number[] }>();

  /** 本店から行き先の市町までの道（Worker の道路網で探す。調べている間は null） */
  private destsFor(from: string): FreightDest[] | null {
    const got = this.freightDests.get(from);
    if (got === "pending") return null;
    if (got) return got;
    const m = this.market;
    const i = m?.arena.index.get(from);
    const nodes = this.roads.world?.local?.meta.nodes;
    if (!m || i === undefined || !nodes) return null;
    const p = m.arena.chomes[i];
    // 配達の範囲の外の市町（札幌市と区を除く）
    const towns = nodes.filter((n) => n.kind === "town" && n.name !== "札幌市" && !n.name.endsWith("区"));
    this.freightDests.set(from, "pending");
    void Promise.all(towns.map((t) => this.roads.truckRoute(p.x, p.z, t.x, t.z))).then((routes) => {
      const out: FreightDest[] = [];
      routes.forEach((r, j) => {
        if (!r) return;
        const t = towns[j];
        out.push({ town: t.name, x: t.x, z: t.z, km: Math.round(r.m / 100) / 10, min: Math.round(r.s / 60) });
        const cum = [0];
        for (let q = 2; q < r.path.length; q += 2) cum.push(cum[cum.length - 1] + Math.hypot(r.path[q] - r.path[q - 2], r.path[q + 1] - r.path[q - 1]));
        this.freightPaths.set(`${from}|${t.name}`, { path: r.path, cum });
      });
      this.freightDests.set(from, out);
      this.companyPanel.refresh();
    });
    return null;
  }

  /** 世界地図の便: 経路の線とトラックの位置（配達の草案 22.1 の 47） */
  private freightLayer() {
    const c = this.market?.own();
    if (!c?.contracts?.length) return [];
    const now = this.nowMs();
    const out: { path: number[]; color: string; town: string; trucks: { x: number; z: number; back: boolean }[] }[] = [];
    for (const k of c.contracts) {
      this.destsFor(k.from);
      const p = this.freightPaths.get(`${k.from}|${k.town}`);
      if (!p) continue;
      const total = p.cum[p.cum.length - 1];
      const at = (f: number) => {
        const d = Math.min(1, Math.max(0, f)) * total;
        let i = 1;
        while (i < p.cum.length - 1 && p.cum[i] < d) i++;
        const t = (d - p.cum[i - 1]) / Math.max(1e-6, p.cum[i] - p.cum[i - 1]);
        return { x: p.path[i * 2 - 2] + (p.path[i * 2] - p.path[i * 2 - 2]) * t, z: p.path[i * 2 - 1] + (p.path[i * 2 + 1] - p.path[i * 2 - 1]) * t };
      };
      const trucks = k.runs.map((r) => {
        const st = truckState(r, now);
        return { ...at(st.f), back: st.leg === "back" };
      });
      out.push({ path: p.path, color: c.color, town: k.town, trucks });
    }
    return out;
  }

  /** 留守の間の便があれば、経営の画面の便を開いて見せる（配達の草案 22.1 の 46） */
  private checkAway() {
    const m = this.market;
    if (!m?.away) return;
    this.companyPanel.away = m.away;
    m.away = null;
    this.openCompany("freight");
  }

  /** 経済の場を作る: 配達の範囲の丁目（D0 の範囲。配達の草案 18 章） */
  private buildMarket(list: AddressPoint[], a: { x: number; z: number }, b: { x: number; z: number }) {
    const book = this.addresses;
    if (!book) return;
    const center = book.byName.get("大通西4丁目") ?? { x: (a.x + b.x) / 2, z: (a.z + b.z) / 2 };
    const arena = new Arena(list, { x0: a.x, z0: a.z, x1: b.x, z1: b.z }, center, (x, z) => book.at(x, z), this.roads.seed);
    this.market = new Market(arena, this.roads.seed, this.worldToday(), this.economySaved, this.nowMs());
    this.checkClosed();
    this.checkAway();
    // 配達用のバン・軽トラの半分ほどを、その丁目の持ち主の業者の色にする
    this.traffic.paint = (x, z, type, u) => {
      if ((type !== "van" && type !== "keiTruck") || u > 0.6) return null;
      const at = book.at(x, z);
      const o = at ? this.market?.ownerOf(at.name) : null;
      return o && o.kind !== "player" ? o.color : null;
    };
  }

  /** いる所の住所と、その丁目の持ち主 */
  private addressWithOwner(x: number, z: number): string | null {
    const at = this.addresses?.at(x, z);
    if (!at) return null;
    const o = this.market?.ownerOf(at.name);
    return o ? `${at.name}（${o.name}）` : at.name;
  }

  /** 縄張りの画像（持ち主が変わった時だけ塗り直す） */
  private territoryLayer() {
    const m = this.market;
    if (!m) return null;
    const r = m.arena.raster;
    let img = this.territoryImg;
    if (!img || img.version !== m.version) {
      const canvas = img?.canvas ?? document.createElement("canvas");
      canvas.width = r.nx;
      canvas.height = r.nz;
      const ctx = canvas.getContext("2d")!;
      const data = ctx.createImageData(r.nx, r.nz);
      const rgb = m.now.entities.map((e) => [parseInt(e.color.slice(1, 3), 16), parseInt(e.color.slice(3, 5), 16), parseInt(e.color.slice(5, 7), 16)]);
      for (let i = 0; i < r.idx.length; i++) {
        const c = r.idx[i];
        const o = c >= 0 ? m.now.owner[c] : -1;
        if (o < 0) continue;
        const [cr, cg, cb] = rgb[o];
        data.data.set([cr, cg, cb, 255], i * 4);
      }
      ctx.putImageData(data, 0, 0);
      img = this.territoryImg = { canvas, version: m.version };
    }
    return { image: img.canvas, x0: r.x0, z0: r.z0, x1: r.x0 + r.nx * r.cell, z1: r.z0 + r.nz * r.cell };
  }

  /** 経営していた業者が廃業していたら、個人に戻して知らせる（配達の草案 21.1 の 37） */
  private checkClosed() {
    const m = this.market;
    const c = m?.closed;
    if (!m || !c) return;
    m.closed = null;
    this.wallet = windUp(m.state, c, c.closed ?? m.state.day, c.reason);
    this.companyPanel.closedNote = `${c.name}は廃業した（${c.reason ?? "—"}）。所持金 ${this.wallet.toLocaleString("ja-JP")} 円`;
    m.touch(this.worldToday());
    void this.save();
    this.openCompany();
  }

  /** 経営の画面を開く（配達の草案 21 章） */
  openCompany(tab?: CompanyTab) {
    const m = this.market;
    if (!m) {
      this.deliveryPanel.showOutside("大通の周り 約 4km 四方（北14条〜南16条、西20丁目〜東13丁目あたり）");
      return;
    }
    m.update(this.worldToday(), this.nowMs());
    this.companyPanel.open(() => {
      const mk = this.market;
      if (!mk) return null;
      const p = this.ride?.road ? this.ride.pose() : this.anchor;
      const at = this.inDeliveryArea(p.x, p.z) ? this.addresses?.at(p.x, p.z) : null;
      const own = mk.own();
      return {
        market: mk,
        today: this.worldToday(),
        money: this.wallet,
        delivered: this.delivered,
        here: at && mk.arena.index.has(at.name) ? at.name : null,
        now: this.nowMs(),
        dests: own?.depots[0] ? this.destsFor(own.depots[0]) : null,
      };
    }, tab);
  }

  /** 順位の画面を開く */
  openRanking() {
    const m = this.market;
    if (!m) {
      this.deliveryPanel.showOutside("大通の周り 約 4km 四方（北14条〜南16条、西20丁目〜東13丁目あたり）");
      return;
    }
    m.update(this.worldToday());
    const info = new Map(m.state.companies.filter((c) => c.closed === null).map((c) => [c.id, { policy: c.policy, depots: c.depots.length }]));
    this.rankingPanel.open({
      entities: m.now.entities,
      yesterday: m.yesterday.entities,
      info,
      company: m.state.player.company,
      owns: !!m.own(),
      weekday: `${worldDay(Date.now() + this.clockOffset).weekday}曜`,
      changed: m.changedSinceYesterday(),
    });
  }

  /** 配達の画面を開く: 受けている配達があればその様子、無ければ新しい注文 */
  openDelivery() {
    const ride = this.ride;
    if (this.deliveries.length && ride) {
      this.deliveryPanel.showActive(
        this.deliveries.map((d) => ({ o: d.order, picked: d.phase === "dropoff", remaining: d.remaining(ride.time) })),
        !this.full,
      );
      return;
    }
    this.newOrder();
  }

  /** 装備の画面（配達の草案 22.6 の 49） */
  openGear() {
    this.deliveryPanel.showGear(GEAR_LABELS[this.gear], carryLimit(this.gear), Math.round(this.money), CARRIER_COST, this.gear === "carrier");
  }

  private inDeliveryArea(x: number, z: number): boolean {
    const a = this.deliveryArea;
    return !!a && x >= a.x0 && x <= a.x1 && z >= a.z0 && z <= a.z1;
  }

  private newOrder() {
    const area = this.deliveryArea;
    const p = this.ride?.road ? this.ride.pose() : this.anchor;
    if (!area || !this.inDeliveryArea(p.x, p.z)) {
      this.deliveryPanel.showOutside("大通の周り 約 4km 四方（北14条〜南16条、西20丁目〜東13丁目あたり）");
      return;
    }
    this.offer = this.appOrder(p.x, p.z, ++this.orderNo, orderSeed(this.worldUnix()));
    if (this.offer) this.deliveryPanel.showOrder(this.offer, this.money);
    else this.deliveryPanel.showOutside("大通の周り 約 4km 四方（北14条〜南16条、西20丁目〜東13丁目あたり）");
  }

  private acceptOrder() {
    const ride = this.ride;
    if (!this.offer || !ride || this.full) return;
    const d = new Delivery(this.offer, ride.time, ride.odometer);
    this.deliveries.push(d);
    this.offer = null;
    this.deliveryPanel.hide();
    // 2 件目は、今の行き先のまま（配達の画面で行き先を切り替えられる）
    if (this.deliveries.length > 1) {
      this.deliveryNote = { text: `${this.deliveries.length} 件目を受けた`, until: performance.now() + 4000 };
      return;
    }
    // 地図で選んだ行き先・名所の行き先は消す（自分で道を選ぶ。案内は草案 3.3）。「経路を自動で引く」なら受け取りへの経路を引いて漕ぎ出す
    this.goalLandmark = null;
    this.guideTo(d.target);
  }

  /** 案内が「経路を自動で引く」なら、その丁目へ経路を引く。そうでなければ行き先を消す */
  private guideTo(p: Place) {
    const ride = this.ride;
    if (!ride) return;
    if (this.deliveryGuide !== "route") {
      ride.setGoal(null);
      return;
    }
    // 丁目は、道の脇がその丁目になる所へ引く（店・家・人は止まる所そのもの）
    const book = this.addresses;
    const spot = (!p.kind || p.kind === "chome") && book ? chomeSpot(this.roads.net.roads.values(), (x, z) => book.at(x, z), p) : null;
    ride.setGoal(spot?.x ?? p.x, spot?.z ?? p.z);
    if (this.manual.pace === 0) this.setPace(2);
  }

  /** 止まった所で受け取り・受け渡しをする */
  private checkDelivery() {
    const ride = this.ride;
    if (!ride?.road || !this.deliveries.length || !this.addresses || this.paused) return;
    const pose = ride.pose();
    // 持っている注文のどれでも、止まった所がその行き先なら受け取り・受け渡しをする
    for (const d of [...this.deliveries]) {
      const r = d.update(this.addresses, pose, ride.speed, ride.time, ride.odometer);
      if (!r) continue;
      if (r === "picked") {
        this.deliveryNote = { text: "受け取った", until: performance.now() + 4000 };
        if (d === this.delivery) this.guideTo(d.target);
        continue;
      }
      this.finishDelivery(d, r);
    }
  }

  private finishDelivery(d: Delivery, r: DeliveryResult) {
    const ride = this.ride;
    if (!ride || !this.addresses) return;
    this.money += r.reward;
    this.delivered++;
    if (!r.late) this.onTime++;
    // 店から受け取った配達は、店ごとに数える（常連。配達の草案 16 章）
    const extra: [string, string][] = [];
    const shop = r.order.pickup;
    if (shop.kind === "shop" && shop.id) {
      const n = (this.regulars[shop.id] ?? 0) + 1;
      this.regulars[shop.id] = n;
      extra.push(["受け取った店", `${shop.name} ${n} 件目${n >= REGULAR_AFTER ? "（常連）" : `（${REGULAR_AFTER} 件で常連）`}`]);
    }
    // 届け先の丁目の件数に入れる（所属の業者、無ければ個人。縄張り）
    const dropAt = this.addresses.at(r.order.dropoff.x, r.order.dropoff.z);
    if (dropAt && this.market) this.market.record(this.worldToday(), dropAt.name, r.reward, r.late);
    this.deliveries = this.deliveries.filter((x) => x !== d);
    if (d.order.no === this.waitingNo) this.waitingPerson = null;
    this.deliveryNote = null;
    const next = this.delivery;
    if (next) {
      // 残りの注文へ向かう
      this.guideTo(next.target);
      extra.push(["残りの注文", `${next.phase === "pickup" ? "受け取り" : "届け先"} ${next.target.name}`]);
    } else {
      ride.setGoal(null);
      this.setPace(0);
    }
    this.deliveryPanel.showResult(r, this.money, this.delivered, this.onTime, extra);
    void this.save();
  }

  private updateDeliveryStrip(time: number) {
    const d = this.delivery;
    const note = this.deliveryNote && performance.now() < this.deliveryNote.until ? this.deliveryNote.text : "";
    this.deliveryStrip.update(d ? { phase: d.phase, name: d.target.name, remaining: d.remaining(time), note, more: this.deliveries.length - 1 } : null);
  }

  /** 地図の印（案内が「地図に行き先の印」の時だけ、いまの行き先の丁目） */
  private deliveryMarks(): { x: number; z: number; name: string }[] {
    if (this.deliveryGuide === "none") return [];
    return this.deliveries.map((d) => ({ x: d.target.x, z: d.target.z, name: d.target.name }));
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
      let near = this.landmarkNear.get(lm.id);
      if (near === undefined) {
        const q = nearestOnNetwork(this.roads.net, lm.x, lm.z, true);
        const road = q && this.roads.net.roads.get(q.road);
        near = q && road ? { d: q.d, y: sampleRoad(road, q.s).y } : null;
        this.landmarkNear.set(lm.id, near);
      }
      if (!arrivedAt(lm, p.x, p.y, p.z, near)) continue;
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
    this.stopPanel.setExtras([]);
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

  /** 指定した所の近くの走る道から走り始める（世界地図の「ワープ」と開発用）。記録と行き先は引き継ぐ */
  teleport(x: number, z: number) {
    this.depart();
    const r = this.ride;
    if (r) this.resume = { pos: null, odometer: r.odometer, climb: r.climb, time: r.time, generator: this.view.world.generator };
    // まだ走り始めていない（ワープを続けた）時は、前に引き継いだ行き先のまま
    if (r) this.carryGoal = r.goal ? { ...r.goal } : null;
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
        case "pace-0":
        case "pace-1":
        case "pace-2":
        case "pace-3":
        case "pace-4":
          this.setPace(Number(a.slice(5)) as Pace);
          break;
        case "pace-up":
          this.setPace(Math.min(4, this.manual.pace + 1) as Pace);
          break;
        case "pace-down":
          this.setPace(Math.max(0, this.manual.pace - 1) as Pace);
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
    // 閉じていた間の旅をまとめて進めている間は、描かずに計算だけする（冒険の草案 4.2）
    if (this.updateJourney()) return;
    this.updateWatching(t);
    // 配達中は、止まった所を喫茶店・名所の立ち寄りにしない（受け取り・受け渡しで止まるため）
    if (this.ride) this.updateStreetWork(this.ride);
    if (this.delivery) this.checkDelivery();
    else if (!this.cardOffer?.ask) {
      this.checkCafe(t);
      this.checkLandmark(t);
    }
    // 眺めている間の立ち寄り（冒険の距離が尽きて止まった所など）は、20 秒見せてから出発する（冒険の草案 4.1）
    if (this.watching && this.stop && !this.paused && t - this.stop.t0 > WATCH_STOP_MS) this.depart();
    this.sound.update({
      speed: this.ride?.speed ?? 0,
      surface: this.ride?.road?.surface ?? "paved",
      riding: !!this.ride && !this.paused && !this.stop && !document.hidden,
      traffic: this.paused || document.hidden ? 0 : this.trafficLoudness(),
    });
    const ride = this.ride;
    this.manual.pedal = this.input.pedal;
    this.manual.brake = this.input.brake || this.arriving ? 1 : 0;
    this.trainer.power.brake = this.manual.brake;
    this.updateTrainer();
    // 冒険の距離はトレーナー以外で走る時だけ使う（冒険の草案 0 章の 7）
    if (ride) ride.adventure = this.adventure?.active && ride.power !== this.trainer.power ? this.adventure : null;
    if (ride && !this.paused && !this.stop) {
      this.acc += dt * this.timeScale;
      let n = 0;
      const maxSteps = 24 * this.timeScale;
      while (this.acc >= DT && n < maxSteps) {
        // 脚と体力（配達の草案 14.2）: 手動では出せる出力を抑え、トレーナーでは減るだけ。眺める乗り方では使わない
        this.manual.cap = this.watching ? Infinity : this.stamina.cap();
        ride.step(DT);
        if (!this.watching) this.stamina.update(ride.watts, DT);
        this.acc -= DT;
        n++;
      }
      if (n >= maxSteps) this.acc = 0;
    }
    this.updateRecord();
    if (ride) this.updateArrival(ride);

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
      const lights = 2.2 * Math.max(1 - env.daylight, env.mist * 0.7);
      this.view.trafficView.update(this.traffic, this.view.originX, this.view.originZ, lights, eye.x, eye.z);
      this.drawPeople(pose);
      this.view.realPoles?.setLights(lights);
      this.player.group.visible = !!pose;
      if (pose && ride) {
        this.player.cadenceOverride = ride.power === this.trainer.power ? this.trainer.cadenceRpm : null;
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
      this.minimap.draw({ roads: this.roads.roadEntries(), pois: this.roads.pois.values(), ridden: this.ridden, stamped: this.stampSet, x: pose.x, z: pose.z, dx: pose.dx, dz: pose.dz, goal, landmarks: this.landmarkMarks(), work: this.workMarks() });
    }
    if (this.mapOverlay.isOpen)
      this.mapOverlay.setInfo(
        goalDistance !== null ? `${goalName ?? "行き先"}まで 直線 ${(goalDistance / 1000).toFixed(1)} km${ride.plan ? "" : "（経路を探索中）"}` : ride.goalReached ? "行き先に着いた" : "地図を押すと行き先を指定",
        !!goal,
        this.mapNote && performance.now() < this.mapNote.until ? this.mapNote.text : "",
      );
    if (this.adventurePanel.isOpen && t - this.trainerPanelT > 500) this.adventurePanel.updateSummary(this.adventureView());
    const onTrainer = ride.power === this.trainer.power;
    if (this.trainerPanel.isOpen && t - this.trainerPanelT > 500) {
      this.trainerPanelT = t;
      this.refreshTrainer();
    }
    this.updateDeliveryStrip(ride.time);
    if (this.market && t - this.marketT > 1000) {
      this.marketT = t;
      if (this.market.update(this.worldToday(), this.nowMs()) > 0) this.companyPanel.refresh();
      this.checkClosed();
      this.checkAway();
      // 便の画面のトラックの様子（5 秒ごと）
      if (t - this.freightT > 5000) {
        this.freightT = t;
        this.companyPanel.refreshFreight();
      }
    }
    this.updateApp(ride.time);
    this.hud.update({
      speed: ride.speed,
      // トレーナーでは機器から受けた出力の 3 秒の平均（カーブの手前の自動減速で物理に渡す出力が 0 の間も）
      watts: onTrainer ? this.trainer.power.average : ride.watts,
      cadence: this.trainer.hasTrainer ? this.trainer.cadenceRpm : null,
      heartRate: this.trainer.heartRate,
      trainerNote: this.trainerNote(),
      onTrainer,
      adventure: this.adventure?.active ? this.adventure.balance : null,
      adventureNote: ride.blocked ? "冒険の距離が無い（運動の記録を取り込むと増える）" : null,
      grade: ride.grade,
      odometer: ride.odometer,
      climb: ride.climb,
      time: ride.time,
      roadName: [road?.name ?? "", pose && this.addressWithOwner(pose.x, pose.z)].filter(Boolean).join("  "),
      elevation: road ? sampleRoad(road, ride.pos.s).y : 0,
      autoBrake: ride.autoBrake > 0,
      upcoming: ride.upcoming,
      canUTurn: ride.speed < 0.5,
      watching: this.watching,
      paused: this.paused,
      goalDistance,
      goalName,
      pace: !this.watching && ride.power === this.manual ? this.manual.pace : null,
      legs: this.watching ? null : this.stamina.legsShare,
      energy: this.watching ? null : this.stamina.energyShare,
      hour: this.view.env.hour,
      weekday: this.forceSky?.hour !== undefined || this.settings.clock === "fixed" ? null : worldDay(Date.now() + this.clockOffset).weekday,
      weather: WEATHER_LABELS[this.weatherNow.kind],
    });
  }
}
