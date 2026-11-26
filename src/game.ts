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
import { type Rider, TRAFFIC_LIGHT, TRAFFIC_STANDARD, Traffic, type Vehicle } from "./sim/traffic/traffic.ts";
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
import { AddressBook, type AddressPoint, D0_STREET_BOX, shortAddress } from "./shared/world/address.ts";
import type { Junction } from "./shared/world/types.ts";
import { CARRIER_COST, carryLimit, Delivery, type DeliveryOrder, type DeliveryResult, type Gear, GEAR_LABELS, gearBlocks, type HandoffZone, handoffZone, inZone, makeOrder, orderSeed, type Place, REGULAR_AFTER } from "./shared/delivery.ts";
import { chomeSpot, chomeSpots, MEAL_SIGNS, type RoadSpot, roadSpot } from "./shared/work-places.ts";
import { Arena, type EconomyState, openCompany, ownCompany, windUp } from "./shared/economy.ts";
import { Market } from "./sim/market.ts";
import { type FreightDest, truckState } from "./shared/freight.ts";
import { RankingPanel } from "./ui/ranking-panel.ts";
import { CompanyPanel, type CompanyTab } from "./ui/company-panel.ts";
import { type StreetAsk, StreetWork } from "./sim/street-work.ts";
import { type Walker, walkersNear } from "./sim/pedestrians.ts";
import { DeliveryPanel, DeliveryStrip, OfferCard } from "./ui/delivery-panel.ts";
import { OrderPhone } from "./ui/order-phone.ts";
import { OrderFeed } from "./sim/order-feed.ts";
import { CAR_HIT, effectivePace, FOODS, LEGS_BACK, type Pace, PACE_ASSIST, PACE_SPEED, paceWatts, REST_S, Stamina } from "./shared/stamina.ts";
import { planPath, ROUTE_STYLE_LABELS, type RouteStyle } from "./sim/route-plan.ts";
import type { HandoffKind, HandoffMark } from "./render/handoff-marks.ts";
import type { AddressSign } from "./render/address-signs.ts";
import { junctionCorners, junctionShape } from "./sim/junction-shape.ts";
import { hash } from "./shared/world/hash.ts";
import { project } from "./shared/geo/projection.ts";
import { HOKKAIDO_BASE } from "./shared/world/hokkaido.ts";
import type { PlayMode } from "./world-choice.ts";
import { autoItem, type FoodKind, isFood, type RestItem, restBlock, REST_MENU, type RestStop, restStopAt, restStopsNear, REST_STOP_RANGE } from "./shared/rest-stops.ts";
import { type CardEntry, fmtSeconds, RestCard } from "./ui/rest-card.ts";
import { MyPage, type MyPageInfo } from "./ui/my-page.ts";
import type { PhoneInfo } from "./ui/order-phone.ts";
import { KIND_LABELS, kindOf, OPEN_DELIVERED, OPEN_MONEY, DRIVE_CARRY, type DriveKind, driveCheck, setDrive, VEHICLES } from "./shared/economy.ts";
import { PlayerCar } from "./render/player-car.ts";
import { applyMod, type CarMods, type ModId, modBlock, modCost, NO_MODS, PAINT, PAINT_CHOICES, SHELF, WINTER } from "./shared/car-care.ts";
import { CAR_PART_LABELS, CAR_PARTS, type CarCare, carEffects, type CarService, carServiceBlock, carServicePrice, CAR_SERVICES, driveWear, freshCar, RESCUE, rescueCar, serviceCar, TANK, worstCarPart } from "./shared/car-care.ts";
import { PACE_LABELS } from "./shared/stamina.ts";

/** 自分の車（D7a。配達の草案 33 章）: ペースの段ごとの速さ (km/h)、加速・ブレーキ (m/s²)、大きさ (m)、受け渡しで歩く時間 (s)【初期値】 */
const CAR_PACE_KMH = [0, 30, 40, 50, 60] as const;
const CAR_PACE_LABELS = ["止まる", "30km/h", "40km/h", "50km/h", "60km/h"] as const;
const CAR_SPEC: Record<DriveKind, { accel: number; brake: number; length: number; width: number }> = {
  kei: { accel: 2.2, brake: 6, length: 3.4, width: 1.48 },
  van: { accel: 1.9, brake: 6, length: 3.4, width: 1.48 },
};
export const CAR_WALK_S = 30;
import { type BikeCare, CARE_LABELS, CARE_PARTS, CARE_SERVICES, careBlock, careEffects, careFromJSON, type CareService, FRESH_CARE, serviceCare, wear, worstPart } from "./shared/bike-care.ts";

/** 左右位置: 1 回押した時に動く量 (m)、押し続けた時の速さ (m/s) と、動き続けるまでの時間 (ms)【初期値】（配達の草案 26 章） */
const LANE_TAP = 0.8;
/** 住所の看板を立てる交差点の範囲 (m)【初期値】（配達の草案 27 章） */
const SIGN_RANGE = 130;
const LANE_SPEED = 3.5;
const LANE_HOLD_MS = 180;
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
  readonly help: ControlsHelp;
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
  /** 遊び方（配達の草案 28 章） */
  readonly mode: PlayMode;
  /** 冒険の乗り方の帳簿（冒険の草案）。自由で始めた世界は null。配達では使わない（保存には残す） */
  adventure: AdventureLedger | null = null;
  private keptAdventure: SaveData["adventure"] = null;
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
  /** 配達の範囲の丁目ごとの止まる所（道路の全部から。面した走れる道の無い丁目は無い。配達の草案 24.4） */
  private spots: Map<string, RoadSpot> | null = null;
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
    return this.deliveries.length >= this.carry();
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
  deliveryGuide: WorkSave["guide"] = "route";
  /** 経路の引き方（草案 14.1） */
  routeStyle: RouteStyle = "short";
  /** 脚と体力（草案 14.2）。眺める乗り方では使わない */
  stamina = new Stamina();
  /** 配達アプリ（草案 14.3）を入れているか */
  appOn = true;
  /**
   * 出している注文の知らせ（道端の頼み事・家からの発送。その場から離れると消える。配達の草案 16 章）。
   * 配達アプリ・常連の店の注文は右上の一覧（feed）に出す（27 章）
   */
  private cardOffer: { order: DeliveryOrder; until: number | null; ask: StreetAsk | null } | null = null;
  /** 配達アプリの注文の一覧と、それを出す右上の画面（配達の草案 27 章） */
  readonly feed = new OrderFeed();
  private phone!: OrderPhone;
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
  /** 受け渡しの所（行き先ごとの円と光の柱。配達の草案 26 章）。道路が読み込まれていない間は作らない */
  private zones = new WeakMap<Place, { zone: HandoffZone; y: number; road: string; px: number; pz: number; py: number }>();
  /** 経路の案内で円へ寄せるために動かした左右位置（受け渡しの後に戻す） */
  private steeredToZone = false;
  /** 車に当たった時刻（同じ車で続けて減らさない） */
  private carHits = new Map<number, number>();
  /** 体力を戻す所（配達の草案 28 章）: 近くの物（描く・止まって買う）と、建物ごとに決めた所の覚え */
  restStops: RestStop[] = [];
  private restCache = new Map<number, RestStop | null>();
  private restT = 0;
  private restMap: { t: number; list: RestStop[] } | null = null;
  private restCard!: RestCard;
  /** 札を閉じた所（離れるまで出さない） */
  private restDismissed: string | null = null;
  /** 体力が少ない知らせを出した段（0.3・0.15） */
  private lowWarned = 1;
  private wasExhausted = false;
  /** 円を押して向かっている所（着いたら自動で頼む。配達の草案 30 章） */
  private restGoal: RestStop | null = null;
  /** 自動で頼んだ時の演出（自販機は飲む 3 秒、店は入店して出てくる 5 秒）。終わった時に払って体力を戻す */
  restAction: { stop: RestStop; item: RestItem; t0: number; ms: number; bike: { x: number; y: number; z: number } } | null = null;
  /** 自転車の傷み（配達の草案 29 章）と、傷みの知らせを出した段（0.5・0.25）、傷めた所までの走った距離 */
  care: BikeCare = { ...FRESH_CARE };
  private careWarned = 1;
  private careOdo = NaN;
  /** 自分の車の燃料と傷み（車の種類ごと。D7b）と、燃料を使った所までの走った距離、燃料の知らせの段 */
  carCare: Partial<Record<DriveKind, CarCare>> = {};
  /** 自分の車の付け替え（車の種類ごと。D7c） */
  carMods: Partial<Record<DriveKind, CarMods>> = {};
  private carOdo = NaN;
  private fuelWarned = 1;
  private cargoKey = "";
  /** 自分で乗っている車（D7a。null なら自転車） */
  driving: DriveKind | null = null;
  private playerCar = new PlayerCar();
  /** 世界の今日の数（マイページ・配達アプリの記録。配達の草案 32 章） */
  dayStats = { day: -1, delivered: 0, earned: 0, onTime: 0 };
  private myPage = new MyPage();
  private lastCarHit = -Infinity;

  constructor(
    private view: WorldView,
    private roads: RoadClient,
    start: { x: number; z: number } = view.world.origin,
    opts: { resume?: boolean; title?: boolean; dev?: boolean; mode?: PlayMode } = {},
  ) {
    this.anchor = { ...start };
    // 配達は北海道の世界だけ（配達の草案 28 章）
    this.mode = opts.mode === "delivery" && view.world.id === "hokkaido" ? "delivery" : "cycling";
    this.title = new TitleScreen(view.world, this.mode);
    this.help = new ControlsHelp(this.mode);
    // 出典（北海道の世界は走っている間も見える所に出す。北海道の草案 3.1・3.2）
    this.traffic = new Traffic(roads.net, (Date.now() & 0x7fffffff) | 1, (x, z) => view.heights.height(x, z));
    this.traffic.options = view.quality === "light" ? TRAFFIC_LIGHT : TRAFFIC_STANDARD;
    const st = this.settings;
    const settings: Settings = { power: this.manual.setting, sway: st.sway, quality: view.quality, clock: st.clock, hour: st.hour, weather: st.weather, camera: this.camera };
    this.hud = new Hud(this.input, settings, this.mode);
    // データの出典は、走っている画面には出さず、起動画面・世界地図・メニューに出す（北海道の草案 3.1 で起動画面・メニューのどれでもよい。配達の草案 27.6）
    if (view.world.attribution.length) this.hud.addMenuFooter(creditLine(view.world, "menu-credit"));
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
    this.hud.addButton(
      "地図",
      () => {
        this.hud.toggleMenu(false);
        this.toggleMap();
      },
      "main",
    );
    if (this.mode === "cycling")
      this.hud.addButton("スタンプ帳", () => {
        this.hud.toggleMenu(false);
        this.stampBook.open(this.stamps);
      });
    // 名所帳（北海道の世界。名所の草案）
    if (view.world.local && this.mode === "cycling") {
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
    this.phone = new OrderPhone(this.hud.root);
    this.phone.onAccept = (no) => this.acceptFromPhone(no);
    this.restCard = new RestCard(this.hud.root);
    // 円を押す・クリックする（ドラッグで視点を回した時は除く）
    {
      const el = view.renderer.domElement;
      let down: { x: number; y: number; t: number } | null = null;
      el.addEventListener("pointerdown", (e) => (down = { x: e.clientX, y: e.clientY, t: performance.now() }));
      el.addEventListener("pointerup", (e) => {
        const d = down;
        down = null;
        if (!d || Math.hypot(e.clientX - d.x, e.clientY - d.y) > 10 || performance.now() - d.t > 450) return;
        const r = el.getBoundingClientRect();
        this.tapAt(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
      });
    }
    this.restCard.onClose = () => {
      this.restDismissed = this.restCard.stop?.id ?? null;
      this.restCard.hide();
    };
    this.offerCard.onAccept = () => this.acceptCardOffer();
    this.offerCard.onSkip = () => this.skipCardOffer();
    if (this.mode === "delivery") this.setupDelivery();
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
    if (this.mode === "cycling") {
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
      "mode",
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
      "mode",
    );
    // 眺める乗り方はサイクリングだけ（配達の草案 28 章）
    if (this.mode === "delivery") for (const sel of [this.routeSel, this.fpsSel]) sel.closest(".menu-row")?.remove();
    view.scene.add(this.player.group);
    view.scene.add(this.playerCar.group);
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
    this.hud.addButton(
      "操作",
      () => {
        this.hud.toggleMenu(false);
        this.help.open();
      },
      "other",
    );
    this.hud.addButton("タイトルへ", () => this.showTitle(), "other");
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
    this.setWatching(this.mode === "cycling" && d.watching);
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
    this.keptAdventure = this.mode === "delivery" ? d.adventure : null;
    this.adventure = d.adventure && this.mode === "cycling" ? AdventureLedger.fromJSON(d.adventure) : null;
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
      adventure: this.adventure?.toJSON() ?? this.keptAdventure ?? null,
      work: { money: this.wallet, delivered: this.delivered, onTime: this.onTime, stamina: this.stamina.toJSON(), guide: this.deliveryGuide, routeStyle: this.routeStyle, app: this.appOn, regulars: this.regulars, economy: this.market?.state ?? this.economySaved, gear: this.gear, bike: { ...this.care }, day: { ...this.dayStats }, car: { ...this.carCare }, carMods: { ...this.carMods } },
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
      if (d > 150 || v.type === "courier") continue;
      sum += (Math.min(1, 0.25 + v.speed / 14) * (v.type === "bus" ? 1.6 : 1)) / (1 + (d / 14) ** 2);
    }
    return Math.min(1, sum);
  }

  /** 交通を進める（一時停止中は止める）。自転車を避ける相手として渡す */
  private updateTraffic(dt: number, pose: ReturnType<Ride["pose"]> | null) {
    const ride = this.ride;
    if (this.paused || !ride) return;
    const car = this.driving ? CAR_SPEC[this.driving] : null;
    const rider: Rider | null = pose ? { x: pose.x, z: pose.z, dx: pose.dx, dz: pose.dz, speed: ride.speed, pos: { ...ride.pos }, offset: ride.offset, car: car ? { length: car.length, width: car.width } : undefined } : null;
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
        // 体力を戻す所の近くを押したら、その前を行き先にして止まる（配達の草案 28 章）
        const rest = this.restsForMap().find((r) => Math.hypot(r.x - x, r.z - z) < 30) ?? null;
        // 食べ物・飲み物の所は、着いたら自動で頼む（30 章）
        if (rest && isFood(rest.kind)) {
          this.goToRest(rest);
          this.mapNote = { text: `${rest.name}へ経路を引いた`, until: performance.now() + 4000 };
          return;
        }
        const snap = rest ? { x: rest.roadX, z: rest.roadZ } : this.full ? null : (this.streetWork?.snap(x, z) ?? null);
        this.stopAtGoal = !!snap;
        this.ride?.setGoal(snap?.x ?? x, snap?.z ?? z);
        if (rest) this.mapNote = { text: `${rest.name}へ経路を引いた`, until: performance.now() + 4000 };
        // 半オート: 止まっていれば「ふつう」で漕ぎ出す（配達の草案 14.1）
        if (this.manual.pace === 0) this.setPace(2);
      },
      landmarks: () => this.landmarkMarks(),
      addresses: this.addresses ?? undefined,
      marks: () => [...this.deliveryMarks(), ...this.workMarks(true)],
      rests: () => this.restsForMap(),
      route: () => this.routeLine(),
      onMark: (no) => this.goToMark(no),
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

  private leaveTitle(c: "continue" | "new" | "new-adventure" | "new-delivery" | "watch") {
    if (c === "new") this.startNew("free");
    if (c === "new-adventure") this.startNew("adventure");
    if (c === "new-delivery") this.startNewWork();
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

  /** 配達をはじめから: 仕事の記録（所持金・届けた件数・業者・持っている注文）を消し、起点から始める。走った記録・スタンプは残す */
  startNewWork() {
    this.deliveries = [];
    this.offer = null;
    this.feed.clear(this.ride?.time ?? 0);
    this.applyWork(null);
    this.goalLandmark = null;
    this.carryGoal = null;
    const r = this.ride;
    this.resume = { pos: null, odometer: r?.odometer ?? this.resume?.odometer ?? 0, climb: r?.climb ?? this.resume?.climb ?? 0, time: r?.time ?? this.resume?.time ?? 0, generator: this.view.world.generator };
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
        let points = list.filter((p) => p.jo !== undefined && p.x > a.x + m && p.x < b.x - m && p.z > a.z + m && p.z < b.z - m);
        // 面した走れる道の無い丁目（北大の構内など）は、注文の届け先にしない。道路は全部を持っている北海道の世界から引く
        const local = this.view.world.local;
        const book = this.addresses;
        if (local) {
          const pad = 400;
          const spots = chomeSpots(local.roadsInRect({ x0: Math.min(a.x, b.x) - pad, z0: Math.min(a.z, b.z) - pad, x1: Math.max(a.x, b.x) + pad, z1: Math.max(a.z, b.z) + pad }), (x, z) => book.at(x, z), points);
          this.spots = spots;
          points = points.filter((p) => spots.has(p.name));
        }
        this.deliveryArea = { x0: a.x, z0: a.z, x1: b.x, z1: b.z, points };
        const area = this.deliveryArea;
        this.buildMarket(list, a, b);
        this.streetWork = new StreetWork(this.roads.net, this.view.world.local?.buildings ?? null, this.addresses, (x, z) => x > area.x0 + m && x < area.x1 - m && z > area.z0 + m && z < area.z1 - m);
      })
      .catch(() => {
        /* 住所が無ければ配達は出さない */
      });
    this.deliveryPanel.onClose = () => this.deliveryPanel.hide();
    // 注文はいつも配達アプリで受ける（30 章）。配達の画面の「配達アプリを開く」はアプリを開くだけ
    this.deliveryPanel.onOther = () => {
      this.deliveryPanel.hide();
      this.phone.setOpen(true, false);
    };
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
    this.hud.addButton(
      "マイページ",
      () => {
        this.hud.toggleMenu(false);
        this.myPage.open(() => this.myPageInfo());
      },
      "main",
    );
    this.phone.onFocus = (no) => {
      const d = this.deliveries.find((x) => x.order.no === no);
      if (!d) return;
      this.deliveries = [d, ...this.deliveries.filter((x) => x !== d)];
      this.guideTo(d.target);
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
    this.companyPanel.onDrive = (k) => this.chooseDrive(k);
    this.companyPanel.carryNow = () => (this.driving ? this.carry() : 0);
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
      "mode",
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
        if (!this.appOn) this.feed.clear(this.ride?.time ?? 0);
        void this.save();
      },      "mode",
    );
  }

  /** 保存データの仕事の記録を戻す（無ければ始めの状態） */
  private applyWork(w: WorkSave | null) {
    this.wallet = w?.money ?? START_MONEY;
    this.delivered = w?.delivered ?? 0;
    this.onTime = w?.onTime ?? 0;
    this.stamina = Stamina.fromJSON(w?.stamina ?? null);
    // 行き先の印はいつも出すので、前の「住所と地図だけ」は「経路は自分で選ぶ」として読む（配達の草案 27 章）
    // 案内はいつも「経路を自動で引く」（30 章）。保存の値は残すが使わない
    this.deliveryGuide = "route";
    this.routeStyle = w?.routeStyle ?? "short";
    this.appOn = w?.app ?? true;
    this.regulars = { ...(w?.regulars ?? {}) };
    this.gear = w?.gear ?? "bag";
    this.care = careFromJSON(w?.bike ?? null);
    this.carCare = { ...(w?.car ?? {}) };
    this.carMods = { ...(w?.carMods ?? {}) };
    this.fuelWarned = 1;
    this.dayStats = w?.day ? { ...w.day } : { day: -1, delivered: 0, earned: 0, onTime: 0 };
    this.careWarned = 1;
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
    // 配達は受け渡しの円に入れば済むので止めない（配達の草案 26 章）。地図で押した頼み事の人・旗の家だけ止まる
    if (this.stopAtGoal && reached && !this.goalWasReached && !this.watching) this.arriving = true;
    this.goalWasReached = reached;
    if (!this.arriving || ride.speed > 0.3) return;
    this.arriving = false;
    this.stopAtGoal = false;
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
  /**
   * 配達アプリ（配達の草案 27 章）: 配達の範囲の中で、アプリを入れている（または常連の店がある）間、注文が一覧に届き、期限が来ると消える。
   * 一覧は右上の画面に出す。持っている注文があっても届き続ける（持てる数がいっぱいなら受けられない）。常連の店の注文は 3 回に 1 回
   */
  private updateApp(time: number) {
    const ride = this.ride;
    const area = this.deliveryArea;
    const hasRegular = Object.values(this.regulars).some((n) => n >= REGULAR_AFTER);
    // 頼み事・旗の家の知らせを出している間は、重ならないよう画面を隠す
    this.phone.show(!!area && !this.watching && !this.restCard.isOpen);
    if (area && ride) this.phone.setInfo(this.phoneInfo(time));
    {
      const m = Math.floor((((this.view.env.hour % 24) + 24) % 24) * 60);
      this.phone.setClock(`${Math.floor(m / 60)}:${String(m % 60).padStart(2, "0")}`);
    }
    if (!area || !ride?.road || this.watching) return;
    const p = ride.pose();
    let note = "";
    if (!this.appOn && !hasRegular) note = "アプリを切っている（メニューの「配達アプリ」）";
    else if (!this.inDeliveryArea(p.x, p.z)) note = "配達の範囲の外";
    if (note) {
      if (this.feed.items.length) this.feed.clear(time);
      this.phone.update([], note);
      return;
    }
    if (!this.paused)
      this.feed.tick(
        time,
        () => ++this.orderNo,
        (no) => {
          const seed = orderSeed(this.worldUnix());
          const regular = hasRegular && this.streetWork && (!this.appOn || hash(seed, no, 0x7e9) % 3 === 0) ? this.streetWork.regularPlaces(p.x, p.z, 800, this.regulars) : [];
          if (regular.length) return makeOrder(area.points, p.x, p.z, no, seed, { pickups: regular, source: "regular" });
          return this.appOn ? this.appOrder(p.x, p.z, no, seed) : null;
        },
      );
    const limit = this.carry();
    const items = this.feed.items.map((it) => ({
      order: it.order,
      remain: it.until - time,
      life: it.until - it.at,
      fromHere: Math.hypot(it.order.pickup.x - p.x, it.order.pickup.z - p.z),
      block: this.full ? `持てるのは ${limit} 件まで` : gearBlocks(it.order, this.loadGear()),
      here: false,
    }));
    // 目の前の頼み事・家からの発送も配達アプリの一覧の先頭に出す（受ける所をアプリにそろえる。30 章）
    const c = this.cardOffer;
    if (c) items.unshift({ order: c.order, remain: 1, life: 1, fromHere: Math.hypot(c.order.pickup.x - p.x, c.order.pickup.z - p.z), block: this.full ? `持てるのは ${limit} 件まで` : gearBlocks(c.order, this.loadGear()), here: true });
    this.phone.update(items, "");
  }

  /** 配達アプリの一覧から受ける */
  private acceptFromPhone(no: number) {
    if (this.cardOffer?.order.no === no) {
      this.acceptCardOffer();
      return;
    }
    const it = this.feed.items.find((x) => x.order.no === no);
    if (!it || this.full || gearBlocks(it.order, this.loadGear())) return;
    this.feed.take(no);
    this.offer = it.order;
    this.acceptOrder();
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
    // 別の札は出さず、配達アプリの一覧の先頭に出して、畳んでいれば開く（30 章）
    this.phone.setOpen(true, false);
    this.hud.flash(`${ask.kind === "errand" ? "頼み事" : "家からの発送"}　配達アプリに出た`, "ok");
  }

  private closeCardOffer() {
    this.cardOffer = null;
    this.offerCard.hide();
  }

  private skipCardOffer() {
    const c = this.cardOffer;
    // 断った頼み事・旗の家は、同じ窓の間はもう出さない
    if (c?.ask && this.streetWork) this.streetWork.used.add(c.ask.kind === "errand" ? c.ask.errand.id : c.ask.flag.id);
    this.closeCardOffer();
  }

  private acceptCardOffer() {
    const c = this.cardOffer;
    if (!c || gearBlocks(c.order, this.loadGear()) || this.full) return;
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
    const me = this.restWalker();
    if (me) people.push(me);
    for (const w of this.parcelDrivers(pose)) people.push(w);
    for (const w of walkersNear(this.roads.net.roads.values(), pose.x, pose.z, light ? 120 : 180, t, density, light ? 60 : 200, (x, z) => this.inDeliveryArea(x, z))) people.push(w);
    const flags = sw.flags.map((f) => ({ x: f.x, y: f.y, z: f.z, yaw: Math.atan2(f.house.x - f.spot.x, f.house.z - f.spot.z) + Math.PI / 2 }));
    pv.update(people, marks, flags, this.view.originX, this.view.originZ, performance.now() / 1000);
  }

  /**
   * 荷を届けに止まっている業者の車の運転手（配達の草案 28 章）: 業者の色の上着で、車の左（歩道の側）から箱を持って建物の前まで歩き、
   * 渡して手ぶらで戻る。止まっている時間の割合で位置が決まる
   */
  private parcelDrivers(pose: { x: number; z: number }): Walker[] {
    const out: Walker[] = [];
    for (const { v, phase } of this.traffic.parcelStops()) {
      if (Math.hypot(v.x - pose.x, v.z - pose.z) > 160) continue;
      // 車の左（-右）。右は (-dz, dx)
      const lx = v.dz;
      const lz = -v.dx;
      const near = v.width / 2 + 0.4;
      const far = near + 3.6;
      // 0〜0.12 降りて荷を出す、〜0.42 建物へ歩く、〜0.6 渡す、〜0.9 戻る、〜1 乗る
      let k: number;
      let walking = false;
      let out1 = true;
      if (phase < 0.12) k = 0;
      else if (phase < 0.42) {
        k = (phase - 0.12) / 0.3;
        walking = true;
      } else if (phase < 0.6) k = 1;
      else if (phase < 0.9) {
        k = 1 - (phase - 0.6) / 0.3;
        walking = true;
        out1 = false;
      } else {
        k = 0;
        out1 = false;
      }
      const d = near + (far - near) * k;
      const bx = v.x + lx * d - v.dx * 0.6;
      const bz = v.z + lz * d - v.dz * 0.6;
      // 歩く向き: 行きは建物（左）へ、戻りは車へ。止まっている時は建物を向く
      const fx = walking && !out1 ? -lx : lx;
      const fz = walking && !out1 ? -lz : lz;
      const gait = walking ? (phase * 60) % 1 : 0;
      out.push({ x: bx, y: v.y, z: bz, dx: fx, dz: fz, gait, still: !walking, seed: v.id * 7919, coat: v.color, carry: phase < 0.55 });
    }
    return out;
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
    // 配達用のバン・軽トラの半分ほどを、その丁目の持ち主の業者の色にする（その車はときどき止まって荷を届ける）。
    // 自転車の配達員は、持ち主の業者（自分の業者も）の色の上着で走る（配達の草案 28 章）
    this.traffic.paint = (x, z, type, u) => {
      const at = book.at(x, z);
      const o = at ? this.market?.ownerOf(at.name) : null;
      if (type === "courier") return o?.color ?? null;
      if ((type !== "van" && type !== "keiTruck") || u > 0.6) return null;
      return o && o.kind !== "player" ? o.color : null;
    };
    // 配達員の数（1km あたり）: 業者の持つ丁目は多め、持ち主の無い丁目は少し【初期値】
    this.traffic.couriers = (x, z) => {
      if (!this.inDeliveryArea(x, z)) return 0;
      const at = book.at(x, z);
      return at && this.market?.ownerOf(at.name) ? 1.6 : 0.6;
    };
  }

  /** いる所の住所と、その丁目の持ち主 */
  /** 今いる丁目・持ち主の業者・進む向き（北から時計回りの度。x が東、z が南）（配達の草案 27 章） */
  private whereNow(pose: { x: number; z: number; dx: number; dz: number } | null): { address: string | null; owner: string | null; heading: number } {
    if (!pose) return { address: null, owner: null, heading: 0 };
    const at = this.addresses?.at(pose.x, pose.z);
    const heading = ((Math.atan2(pose.dx, -pose.dz) * 180) / Math.PI + 360) % 360;
    return { address: at?.name ?? null, owner: (at && this.market?.ownerOf(at.name)?.name) ?? null, heading };
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
    // 持っている注文が無ければ、配達アプリを開く（範囲の外ならそう出す）
    const p = this.ride?.road ? this.ride.pose() : this.anchor;
    if (!this.inDeliveryArea(p.x, p.z)) this.deliveryPanel.showOutside("大通の周り 約 4km 四方（北14条〜南16条、西20丁目〜東13丁目あたり）");
    else this.phone.setOpen(true, false);
  }

  /** 装備の画面（配達の草案 22.6 の 49） */
  openGear() {
    const care: [string, string][] = CARE_PARTS.map((p) => [CARE_LABELS[p], `${Math.round(this.care[p] * 100)}%（自転車店で直す）`]);
    this.deliveryPanel.showGear(GEAR_LABELS[this.gear], carryLimit(this.gear), Math.round(this.money), CARRIER_COST, this.gear === "carrier", care);
  }

  private inDeliveryArea(x: number, z: number): boolean {
    const a = this.deliveryArea;
    return !!a && x >= a.x0 && x <= a.x1 && z >= a.z0 && z <= a.z1;
  }

  private acceptOrder() {
    const ride = this.ride;
    if (!this.offer || !ride || this.full) return;
    const d = new Delivery(this.offer, ride.time, ride.odometer);
    this.deliveries.push(d);
    // 受注のカットイン（配達の草案 28 章）
    const o = this.offer;
    this.hud.cutIn("受注！", `${o.pickedAtStart ? "その場で受け取り" : o.pickup.name} → ${o.dropoff.name}　${o.reward.toLocaleString("ja-JP")} 円`);
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
    // 注文を受けたら、いつも行き先へ経路を引いて漕ぎ出す（ユーザーの指定 2026-11-26。配達の草案 30 章）
    // 丁目は、道の脇がその丁目になる所へ引く（店・家・人は止まる所そのもの）
    const spot = this.spotOf(p);
    ride.setGoal(spot?.x ?? p.x, spot?.z ?? p.z);
    if (this.manual.pace === 0) this.setPace(2);
  }

  /** 行き先の止まる所（道の上の点）。丁目は道の脇がその丁目になる所、店・家・人は止まる所そのもの */
  private spotOf(p: Place): RoadSpot | null {
    const book = this.addresses;
    if (!p.kind || p.kind === "chome") return book ? (this.spots?.get(p.name) ?? chomeSpot(this.roads.net.roads.values(), (x, z) => book.at(x, z), p)) : null;
    return roadSpot(this.roads.net.roads.values(), p.x, p.z, 12);
  }

  /**
   * 行き先の受け渡しの円と光の柱（配達の草案 26 章）。円は止まる所の、建物の側の道の端。柱は建物（丁目なら道の脇の丁目の側）。
   * 止まる所の道路が読み込まれていなければ null（次に呼ばれた時に作り直す）
   */
  private zoneOf(p: Place) {
    const got = this.zones.get(p);
    if (got) return got;
    const spot = this.spotOf(p);
    const road = spot && this.roads.net.roads.get(spot.road);
    if (!spot || !road) return null;
    const sm = sampleRoad(road, spot.s);
    const hw = road.width / 2;
    const nx = -sm.dz;
    const nz = sm.dx;
    let bx = p.bx;
    let bz = p.bz;
    if (bx === undefined || bz === undefined) {
      // 丁目: 道の左右のうち、その丁目になる側へ
      const book = this.addresses;
      let side = (p.x - sm.x) * nx + (p.z - sm.z) * nz >= 0 ? 1 : -1;
      for (const k of [1, -1]) if (book?.at(sm.x + nx * k * (hw + 8), sm.z + nz * k * (hw + 8))?.name === p.name) side = k;
      bx = sm.x + nx * side * (hw + 12);
      bz = sm.z + nz * side * (hw + 12);
    }
    const zone = handoffZone({ x: sm.x, z: sm.z, dx: sm.dx, dz: sm.dz, width: road.width }, { x: bx, z: bz });
    const z = { zone, y: sm.y, road: road.id, px: bx, pz: bz, py: this.view.heights.height(bx, bz) };
    this.zones.set(p, z);
    return z;
  }

  /** 受け渡しの円に入ったら受け取り・受け渡しをする（配達の草案 26 章）。円が作れない行き先は、今までどおり止まった所で */
  private checkDelivery() {
    const ride = this.ride;
    if (!ride?.road || !this.deliveries.length || !this.addresses || this.paused) return;
    const pose = ride.pose();
    // 持っている注文のどれでも、その行き先の円の中なら受け取り・受け渡しをする
    for (const d of [...this.deliveries]) {
      const z = this.zoneOf(d.target);
      // 自分の車は円の中で止まってから、降りて歩いて渡す（配達の草案 33 章）
      const stopped = !this.driving || ride.speed < 0.5;
      const r = z ? (inZone(z.zone, pose) && stopped ? d.handoff(ride.time, ride.odometer, this.driving ? CAR_WALK_S : undefined) : null) : d.update(this.addresses, pose, ride.speed, ride.time, ride.odometer);
      if (!r) continue;
      if (z)
        this.view.handoff.play(r === "picked" ? "pickup" : "dropoff", { x: z.px, y: z.py, z: z.pz }, { x: z.zone.x, y: z.y, z: z.zone.z }, () => this.ride?.pose() ?? pose);
      if (this.steeredToZone) {
        ride.laneShift = 0;
        this.steeredToZone = false;
      }
      if (r === "picked") {
        this.deliveryNote = { text: "受け取った", until: performance.now() + 4000 };
        this.hud.flash("受け取った", "ok");
        if (d === this.delivery) this.guideTo(d.target);
        continue;
      }
      this.hud.flash("渡した", "ok");
      this.finishDelivery(d, r);
    }
  }

  /**
   * 自分の車の前の車・配達員との間（配達の草案 33 章）: 同じ車線の前 40m の相手との隙間が、
   * 2.5m ＋ 今の速さで 1 秒走る距離 ＋ 相手より速い分を 2.5m/s² で落とすのに要る距離 より短ければ掛ける
   */
  private carAheadBrake(): boolean {
    const ride = this.ride;
    if (!this.driving || !ride?.road || ride.speed < 0.5) return false;
    const p = ride.pose();
    const me = CAR_SPEC[this.driving];
    for (const v of this.traffic.vehicles) {
      const rx = v.x - p.x;
      const rz = v.z - p.z;
      const lon = rx * p.dx + rz * p.dz;
      if (lon <= 0 || lon > 40 || Math.abs(v.y - p.y) > 3) continue;
      const lat = -rx * p.dz + rz * p.dx;
      if (Math.abs(lat) > (v.width + me.width) / 2 + 0.3) continue;
      const along = Math.max(0, v.speed * (v.dx * p.dx + v.dz * p.dz));
      const gap = lon - (v.length + me.length) / 2;
      const closing = Math.max(0, ride.speed - along);
      if (gap < 2.5 + ride.speed * 1.0 + (closing * closing) / 5) return true;
    }
    return false;
  }

  /** 自分の車で、向かっている受け渡しの円の中で止まるためのブレーキ（円の中心まで 2.5m/s² で止まれる速さを超えたら・円の中では止まるまで） */
  private zoneBrake(): boolean {
    const ride = this.ride;
    const d = this.delivery;
    if (!this.driving || !ride?.road || !d || ride.turn) return false;
    const z = this.zoneOf(d.target);
    if (!z || ride.pos.road !== z.road) return false;
    const p = ride.pose();
    const ahead = (z.zone.x - p.x) * p.dx + (z.zone.z - p.z) * p.dz;
    if (inZone(z.zone, p)) return ride.speed > 0.3;
    if (ahead < 0 || ahead > 80) return false;
    // 円の中心まで 2.5m/s² で止まれる速さより速い時だけ掛ける（手前で止まってまた走り出さないように）
    return ride.speed > Math.sqrt(2 * 2.5 * ahead) + 0.3;
  }

  /** 経路を自動で引く案内の時は、受け渡しの円の手前 40m から、円のある側へ左右位置を寄せる */
  private steerToZone() {
    const ride = this.ride;
    const d = this.delivery;
    const road = ride?.road;
    if (!ride || !road || !d || this.watching) return;
    const z = this.zoneOf(d.target);
    if (!z || ride.pos.road !== z.road || ride.turn) return;
    const pose = ride.pose();
    const fx = pose.dx;
    const fz = pose.dz;
    const ahead = (z.zone.x - pose.x) * fx + (z.zone.z - pose.z) * fz;
    if (ahead < -z.zone.r || ahead > 40) return;
    // 道の中心から見た円の左右位置（右が正）を、左右位置の目標にする
    const c = sampleRoad(road, ride.pos.s);
    const lat = (z.zone.x - c.x) * -fz + (z.zone.z - c.z) * fx;
    ride.laneShift = lat + road.width / 4;
    this.steeredToZone = true;
  }

  /**
   * 車に当たった時（配達の草案 26・28 章）: すり抜けずに、自転車は 1 回跳ねて車から離れる向きへずれ、車はその逆へ寄りながら減速して止まる。
   * 体力を減らす（配達だけ）。同じ車は 4 秒、続けては 1 秒あける
   */
  private checkCarHits(ride: Ride) {
    if (this.watching || this.paused || !ride.road) return;
    const p = ride.pose();
    const now = performance.now();
    const car = this.driving ? CAR_SPEC[this.driving] : null;
    for (const v of this.traffic.contacts(p, car ? { length: car.length, width: car.width } : undefined)) {
      // どちらも止まりかけなら当たったことにしない
      if (ride.speed < 1 && v.speed < 1) continue;
      if (now - (this.carHits.get(v.id) ?? -Infinity) < 4000 || now - this.lastCarHit < 1000) continue;
      this.carHits.set(v.id, now);
      this.lastCarHit = now;
      // 自分の車: 跳ねずに大きく速さを落とし、相手は寄って止まる。体力は減らない（車同士の形は D7d で整える。配達の草案 33 章）
      if (car) {
        ride.speed *= 0.3;
        const rx = p.x - v.x;
        const rz = p.z - v.z;
        this.traffic.collide(v, -rx * v.dz + rz * v.dx > 0 ? -1 : 1);
        this.hud.flash(v.type === "courier" ? "配達員に当たった" : "車に当たった", "hit");
        continue;
      }
      // 車の中心から自転車への向きを、自転車の右（-dz, dx）に映して、ずれる向きを決める
      const rx = p.x - v.x;
      const rz = p.z - v.z;
      const side: 1 | -1 = rx * -p.dz + rz * p.dx < 0 ? -1 : 1;
      // 車の箱から出るだけずらす（0.8〜2.2m）
      const lat = Math.abs(-rx * v.dz + rz * v.dx);
      const shift = Math.max(0.8, Math.min(2.2, v.width / 2 + 0.3 - lat + 0.5));
      ride.bump(side, shift);
      // 車は、自転車がずれた向き（世界の向き）と逆へ寄る。車の右（-dz, dx）に映す
      const sx = -p.dz * side;
      const sz = p.dx * side;
      this.traffic.collide(v, sx * -v.dz + sz * v.dx > 0 ? -1 : 1);
      const who = v.type === "courier" ? "配達員" : "車";
      if (this.mode === "delivery") {
        this.stamina.hit(CAR_HIT);
        this.hud.flash(`${who}に当たった　体力 −${Math.round(CAR_HIT * 100)}%`, "hit");
      } else this.hud.flash(`${who}に当たった`, "hit");
    }
    if (this.carHits.size > 32) for (const [id, at] of this.carHits) if (now - at > 4000) this.carHits.delete(id);
  }

  /**
   * 交差点の住所の看板（配達の草案 27 章）: 今いる所から 130m 以内の、腕が 3 本以上の交差点の角に、その角の街区の住所（短い形）。
   * 住所の分かる所（北海道の世界の配達の範囲）だけ。0.4 秒ごとに選び直す
   */
  /** 近くの体力を戻す所を選び直して描く（0.4 秒ごと。配達の範囲の中だけ） */
  private updateRestStops(pose: { x: number; z: number } | null, t: number) {
    if (t - this.restT < 400) return;
    this.restT = t;
    const b = this.view.world.local?.buildings;
    if (this.mode !== "delivery" || !b || !pose || !this.inDeliveryArea(pose.x, pose.z)) this.restStops = [];
    else this.restStops = restStopsNear(b, this.roads.net.roads, pose.x, pose.z, 450, (x, z) => this.inDeliveryArea(x, z), this.restCache);
    const near = pose ? this.restStops.filter((s) => Math.hypot(s.x - pose.x, s.z - pose.z) < 260) : [];
    this.view.restStops.update(near, this.view.originX, this.view.originZ);
  }

  /** 世界地図に出す体力を戻す所（今いる所から 1km。2 秒ごとに選び直す） */
  private restsForMap(): RestStop[] {
    const b = this.view.world.local?.buildings;
    const p = this.ride?.road ? this.ride.pose() : this.anchor;
    if (this.mode !== "delivery" || !b) return [];
    const now = performance.now();
    if (!this.restMap || now - this.restMap.t > 2000) this.restMap = { t: now, list: restStopsNear(b, this.roads.net.roads, p.x, p.z, 1000, (x, z) => this.inDeliveryArea(x, z), this.restCache) };
    return this.restMap.list;
  }

  /** 同時に持てる注文の数（自分の車なら車の数。配達の草案 33 章） */
  carry(): number {
    return this.driving ? DRIVE_CARRY[this.driving] + (this.modsNow(this.driving).shelf ? SHELF.carry : 0) : carryLimit(this.gear);
  }

  /** 乗っている車の付け替え（D7c） */
  modsNow(k: DriveKind): CarMods {
    return (this.carMods[k] ??= { ...NO_MODS });
  }

  /** 車の色（塗装していなければ業者の色） */
  private carColor(k: DriveKind): string {
    return this.modsNow(k).paint ?? this.market?.own()?.color ?? "#d8642a";
  }

  /** 燃料店で付け替える（D7c。配達の草案 35 章） */
  buyMod(id: ModId) {
    const k = this.driving;
    const st = this.restCard.stop;
    if (!k || !st || modBlock(id, this.modsNow(k), this.money)) return;
    const cost = modCost(id);
    this.money -= cost.price;
    this.carMods[k] = applyMod(id, this.modsNow(k));
    for (const d of this.deliveries) d.addTime(cost.seconds);
    this.playerCar.set(k, this.carColor(k));
    const name = id === "shelf" ? "荷室の棚" : id === "winter" ? "冬タイヤ" : `塗装（${PAINT_CHOICES.find((p) => (p.color ?? "") === id.slice(6))?.name ?? ""}）`;
    this.hud.flash(`${name}　−${cost.price.toLocaleString("ja-JP")} 円`, "ok");
    this.showRest(st, `${name}　${fmtSeconds(cost.seconds)}経った`, "mods");
    void this.save();
  }

  /** 荷の大きさの判定に使う装備（車なら大きめの小包も運べる） */
  private loadGear(): Gear {
    return this.driving ? "carrier" : this.gear;
  }

  /** 自分で乗る車を決める（null で自転車に戻る）。止まっている時だけ。理由があれば返す */
  chooseDrive(k: DriveKind | null): string | null {
    const c = this.market?.own();
    if (!c) return "経営していない";
    if ((this.ride?.speed ?? 0) > 0.5) return "止まってから";
    if (k && driveCheck(c, k)) return driveCheck(c, k);
    if (!k && this.deliveries.length > carryLimit(this.gear)) return `自転車では ${carryLimit(this.gear)} 件まで（今 ${this.deliveries.length} 件）`;
    setDrive(c, k);
    this.market!.touch(this.worldToday());
    void this.save();
    this.syncDrive();
    return null;
  }

  /** 業者の「自分で乗る車」と、走り・見た目・画面を合わせる（毎フレーム。変わった時だけ切り替える） */
  private syncDrive() {
    const k = this.mode === "delivery" ? (this.market?.own()?.drive ?? null) : null;
    const ride = this.ride;
    if (ride) {
      const spec = k ? CAR_SPEC[k] : null;
      // 傷みは加速とブレーキに効く（D7b。配達の草案 34 章）
      const e = k ? carEffects(this.carNow(k)) : null;
      ride.car = spec && e ? { accel: spec.accel * e.accel, brake: spec.brake * e.brake } : null;
    }
    if (k === this.driving) return;
    this.driving = k;
    this.hud.setPaceLabels(k ? CAR_PACE_LABELS : PACE_LABELS);
    this.hud.setGaugeLabels(k ? "燃料" : "脚", k ? "車" : "体力");
    this.carOdo = ride?.odometer ?? NaN;
    this.playerCar.set(k, k ? this.carColor(k) : "#d8642a");
    this.player.group.visible = !k;
    this.hud.flash(k ? `${VEHICLES[k].label}に乗った　同時に ${this.carry()} 件まで` : "自転車に乗った", "ok");
    // 自転車道を通る経路を引き直す
    if (ride?.goal) ride.setGoal(ride.goal.x, ride.goal.z);
  }

  /** 世界の今日の数（日が変わっていれば 0 から） */
  private todayStats() {
    const today = this.worldToday();
    if (this.dayStats.day !== today) this.dayStats = { day: today, delivered: 0, earned: 0, onTime: 0 };
    return this.dayStats;
  }

  /** 経営している・入っている業者 */
  private companyNow(): { name: string; color: string; own: boolean; staff: number; cash: number } | null {
    const m = this.market;
    if (!m) return null;
    const own = m.own();
    if (own) return { name: own.name, color: own.color, own: true, staff: own.staff, cash: own.cash };
    const id = m.state.player.company;
    const c = id ? m.state.companies.find((x) => x.id === id) : null;
    return c ? { name: c.name, color: c.color, own: false, staff: c.staff, cash: 0 } : null;
  }

  /** マイページの中身（配達の草案 32 章） */
  myPageInfo(): MyPageInfo {
    const ride = this.ride;
    const ds = this.todayStats();
    const co = this.companyNow();
    const kind = co?.own ? kindOf(co.staff) : null;
    const stage = co?.own ? `経営 ${co.name}（${KIND_LABELS[kind!]}・配達員 ${co.staff} 人）` : co ? `アルバイト（所属 ${co.name}）` : "個人で配達";
    let goal: MyPageInfo["goal"] = null;
    if (!co?.own)
      goal = {
        title: "開業の条件",
        rows: [
          { label: "所持金", now: this.wallet, goal: OPEN_MONEY, unit: "yen" },
          { label: "届けた件数", now: this.delivered, goal: OPEN_DELIVERED, unit: "count" },
        ],
      };
    else if (kind === "solo") goal = { title: "中堅（配達員 7 人）まで", rows: [{ label: "配達員", now: co.staff, goal: 7, unit: "person" }] };
    else if (kind === "mid") goal = { title: "大手（配達員 25 人）まで", rows: [{ label: "配達員", now: co.staff, goal: 25, unit: "person" }] };
    return {
      stage,
      stageColor: co?.color ?? null,
      money: this.wallet,
      companyCash: co?.own ? co.cash : null,
      today: { weekday: worldDay(Date.now() + this.clockOffset).weekday, delivered: ds.delivered, earned: ds.earned },
      delivered: this.delivered,
      onTime: this.onTime,
      regulars: Object.values(this.regulars).filter((n) => n >= REGULAR_AFTER).length,
      energy: this.stamina.energyShare,
      legs: this.stamina.legsShare,
      exhausted: this.stamina.exhausted,
      care: this.driving
        ? [{ label: "燃料", share: this.carNow(this.driving).fuel / TANK[this.driving] }, ...CAR_PARTS.map((p) => ({ label: CAR_PART_LABELS[p], share: this.carNow(this.driving!)[p] }))]
        : CARE_PARTS.map((p) => ({ label: CARE_LABELS[p], share: this.care[p] })),
      vehicleTitle: this.driving ? "車" : "自転車",
      vehicleNote: this.driving ? "給油・整備は燃料店" : "直すのは自転車店",
      gear: this.driving ? `${VEHICLES[this.driving].label}（業者の車）` : GEAR_LABELS[this.gear],
      carry: this.carry(),
      deliveries: this.deliveries.map((d) => ({ phase: d.phase, target: d.target.name, reward: d.order.reward, remaining: ride ? d.remaining(ride.time) : 0 })),
      goal,
    };
  }

  /** 配達アプリの配達中・記録のタブの中身（配達の草案 32 章） */
  private phoneInfo(time: number): PhoneInfo {
    const ds = this.todayStats();
    const co = this.companyNow();
    return {
      active: this.deliveries.map((d, i) => ({ no: d.order.no, phase: d.phase, target: d.target.name, reward: d.order.reward, remaining: d.remaining(time), limit: d.order.limit, heading: i === 0 })),
      carry: this.carry(),
      today: { weekday: worldDay(Date.now() + this.clockOffset).weekday, delivered: ds.delivered, earned: ds.earned, onTime: ds.onTime },
      total: { delivered: this.delivered, onTime: this.onTime, regulars: Object.values(this.regulars).filter((n) => n >= REGULAR_AFTER).length },
      money: this.wallet,
      company: co ? (co.own ? `経営 ${co.name}` : `所属 ${co.name}`) : null,
    };
  }

  /**
   * 「横」（幅寄せ。配達の草案 30 章）: 左右の操作をした向きの真横（前後 1.8m・横 0.4〜2m）に配達員がいれば、
   * 自分は一瞬その方へ寄って戻り、相手は押されて寄り、少し遅くなって体力が 3 減る。落車はしない。同じ相手は 2 秒あける。
   * 当たったことにはしない（自分の体力は減らない）。配達員がいなければ false（ふつうに左右へ寄る）
   */
  tryYose(dir: -1 | 1): boolean {
    const ride = this.ride;
    if (this.mode !== "delivery" || this.watching || this.driving || !ride?.road || ride.speed < 1.5) return false;
    const p = ride.pose();
    const now = performance.now();
    let best: Vehicle | null = null;
    let bd = Infinity;
    for (const v of this.traffic.vehicles) {
      if (v.type !== "courier" || v.dx * p.dx + v.dz * p.dz < 0.7 || Math.abs(v.y - p.y) > 2) continue;
      const rx = v.x - p.x;
      const rz = v.z - p.z;
      const lon = rx * p.dx + rz * p.dz;
      // 自分の右（-dz, dx）を正にした横の位置
      const lat = rx * -p.dz + rz * p.dx;
      if (Math.abs(lon) > 1.8 || lat * dir < 0.4 || lat * dir > 2) continue;
      if (now - (this.carHits.get(v.id) ?? -Infinity) < 2000) continue;
      const d = Math.abs(lat) + Math.abs(lon);
      if (d < bd) {
        bd = d;
        best = v;
      }
    }
    if (!best) return false;
    ride.yose(dir);
    // 相手は自分から離れる向き（世界の向きで自分の右 × dir）へ。相手の右（-dz, dx）に映す
    const sx = -p.dz * dir;
    const sz = p.dx * dir;
    const left = this.traffic.shove(best, sx * -best.dz + sz * best.dx >= 0 ? 1 : -1);
    // 寄った時に重なっても、当たったことにしない
    this.carHits.set(best.id, now);
    this.hud.flash(`横　配達員の体力 ${left}`, "ok");
    return true;
  }

  /** 画面を押した所に体力を戻す所の円があれば、そこへ向かう（配達の草案 30 章） */
  tapAt(ndcX: number, ndcY: number): boolean {
    if (this.mode !== "delivery" || this.watching || this.paused || this.restAction) return false;
    const id = this.view.restStops.pick(ndcX, ndcY, this.view.camera);
    const st = id ? this.restStops.find((s) => s.id === id) : null;
    if (!st || !this.ride) return false;
    this.goToRest(st);
    return true;
  }

  /** 体力を戻す所へ向かい、着いたら自動で頼む。もう前にいればすぐ頼む */
  goToRest(st: RestStop) {
    const ride = this.ride;
    if (!ride?.road) return;
    this.restCard.hide();
    this.restDismissed = null;
    this.restGoal = st;
    const p = ride.pose();
    if (Math.hypot(st.roadX - p.x, st.roadZ - p.z) <= REST_STOP_RANGE[st.kind] && ride.speed < 0.5) {
      this.startRestAction(st);
      return;
    }
    this.goalLandmark = null;
    // 経路の行き先は 15m 手前で外れ、「着いたら止まる」だとそこで止まってしまうので使わない。
    // 漕ぎ続けて、店の前で restBrake が止める
    this.stopAtGoal = false;
    ride.setGoal(st.roadX, st.roadZ);
    if (this.manual.pace === 0) this.setPace(2);
    this.hud.flash(`${st.name}へ向かう`, "ok");
  }

  /**
   * 円を押して向かう所の前で止まるためのブレーキ（経路の行き先は 15m 手前で外れるので、自分で止める）。
   * 止まる所まで、今の速さで止まれる距離（2m/s² で減速）＋ 3m を切ったら掛け、止まる所の範囲に入ったら止まるまで掛ける
   */
  private restBrake(): boolean {
    const st = this.restGoal;
    const r = this.ride;
    if (!st || !r?.road || this.restAction) return false;
    const p = r.pose();
    const d = Math.hypot(st.roadX - p.x, st.roadZ - p.z);
    // 止まる所の範囲に入ったら止まるまで掛ける
    if (d <= REST_STOP_RANGE[st.kind]) return true;
    // 通り過ぎた（後ろにある）時は掛けない
    if ((st.roadX - p.x) * p.dx + (st.roadZ - p.z) * p.dz < -2) return false;
    return d < (r.speed * r.speed) / 4 + 3 && r.speed > 0.3;
  }

  /** 自動で頼む: 品を決めて演出を始める。買える物が無ければ札を出す */
  private startRestAction(st: RestStop) {
    this.restGoal = null;
    const ride = this.ride;
    if (!ride?.road || !isFood(st.kind)) return;
    const it = autoItem(st.kind as FoodKind, this.money, this.stamina.energyShare, this.stamina.legsShare);
    if (!it) {
      this.setPace(0);
      this.showRest(st, "");
      return;
    }
    const p = ride.pose();
    this.setPace(0);
    this.restAction = { stop: st, item: it, t0: performance.now(), ms: st.kind === "vending" ? 3000 : 5000, bike: { x: p.x, y: p.y, z: p.z } };
  }

  /** 演出を進める。終わったら払って体力を戻す */
  private updateRestAction() {
    const a = this.restAction;
    const rider = this.player.rider.group;
    if (!a) {
      this.player.drink = 0;
      rider.visible = true;
      return;
    }
    if (this.ride) this.ride.speed = 0;
    this.manual.pace = 0;
    const k = Math.min(1, (performance.now() - a.t0) / a.ms);
    if (a.stop.kind === "vending") {
      // 手を上げる 0.5 秒・飲む・下ろす 0.5 秒
      const up = Math.min(1, k / 0.17, (1 - k) / 0.17);
      this.player.drink = up * up * (3 - 2 * up);
    } else rider.visible = false; // 自転車を降りて店に出入りする（歩く人の形で描く。0.16〜0.84 は店の中）
    if (k < 1) return;
    this.restAction = null;
    this.player.drink = 0;
    rider.visible = true;
    this.restCard.stop = a.stop;
    this.buyRest(a.item);
    this.restCard.hide();
    this.restDismissed = a.stop.id;
  }

  /** 店に出入りする自分（歩く人の形。業者の色の上着） */
  private restWalker(): Walker | null {
    const a = this.restAction;
    if (!a || a.stop.kind === "vending") return null;
    const k = Math.min(1, (performance.now() - a.t0) / a.ms);
    // 0〜0.16 自転車から店の入口へ、0.84〜1 戻る。その間は店の中
    const door = { x: a.stop.x + a.stop.fx * 1.2, z: a.stop.z + a.stop.fz * 1.2 };
    let f: number;
    let back = false;
    if (k < 0.16) f = k / 0.16;
    else if (k > 0.84) {
      f = (1 - k) / 0.16;
      back = true;
    } else return null;
    const x = a.bike.x + (door.x - a.bike.x) * f;
    const z = a.bike.z + (door.z - a.bike.z) * f;
    let dx = door.x - a.bike.x;
    let dz = door.z - a.bike.z;
    const l = Math.hypot(dx, dz) || 1;
    dx /= l;
    dz /= l;
    if (back) {
      dx = -dx;
      dz = -dz;
    }
    return { x, y: a.bike.y, z, dx, dz, gait: (k * 18) % 1, still: false, seed: 77, coat: this.outfit.rider.jerseyColor };
  }

  /** 体力を戻す所の前で止まったら札を出す。動き出す・離れると閉じる（配達の草案 28 章） */
  private checkRest(ride: Ride) {
    const card = this.restCard;
    const p = ride.road ? ride.pose() : null;
    const open = card.stop;
    if (open && (!p || ride.speed > 1.5 || Math.hypot(open.roadX - p.x, open.roadZ - p.z) > REST_STOP_RANGE[open.kind] + 4)) card.hide();
    const d = this.restDismissed ? this.restStops.find((s) => s.id === this.restDismissed) : null;
    if (this.restDismissed && (!d || !p || Math.hypot(d.roadX - p.x, d.roadZ - p.z) > REST_STOP_RANGE[d.kind] + 4)) this.restDismissed = null;
    if (this.restAction) return;
    // 円を押して向かった所に着いたら、自動で頼む（すぐ横に別の所があっても、向かった所で）
    const rg = this.restGoal;
    if (p && rg && ride.speed < 1 && Math.hypot(rg.roadX - p.x, rg.roadZ - p.z) <= REST_STOP_RANGE[rg.kind]) {
      this.startRestAction(rg);
      return;
    }
    if (!p || card.isOpen || ride.speed > 0.5 || this.watching || this.stop) return;
    const at = restStopAt(this.restStops, p.x, p.z);
    if (!at || at.id === this.restDismissed) return;
    this.showRest(at, "");
  }

  /** 札を出す・出し直す: 食べ物の所は品書き、自転車店は傷みと整備とリアキャリア、車の整備は空気入れ（配達の草案 28・29 章） */
  private showRest(st: RestStop, note: string, page: "service" | "mods" = "service") {
    const money = `所持金 ${Math.round(this.money).toLocaleString("ja-JP")} 円`;
    if (isFood(st.kind)) {
      const entries: CardEntry[] = REST_MENU[st.kind].map((it) => ({
        name: it.name,
        price: `${it.price} 円`,
        gain: `体力 +${Math.round(it.energy * 100)}%${it.legs ? "・脚" : ""}  ${fmtSeconds(it.seconds)}`,
        why: restBlock(it, this.money, this.stamina.energyShare, this.stamina.legsShare),
        onClick: () => this.buyRest(it),
      }));
      this.restCard.show(st, `体力 ${Math.round(this.stamina.energyShare * 100)}%  ${money}`, [], entries, note);
      return;
    }
    // 自分の車で燃料店に来た: 給油・空気・オイル・ブレーキ・まとめて点検（D7b。配達の草案 34 章）
    const k = this.driving;
    if (st.kind === "car" && k && page === "mods") {
      // 付け替えの頁（D7c。配達の草案 35 章）
      const m = this.modsNow(k);
      const cur = PAINT_CHOICES.find((p) => p.color === m.paint)?.name ?? "業者の色";
      const rows: [string, string][] = [
        ["荷室の棚", m.shelf ? "付いている" : "無し"],
        ["冬タイヤ", m.winter ? "付いている" : "無し"],
        ["色", cur],
      ];
      const entries: CardEntry[] = [
        { name: "荷室の棚", price: `${SHELF.price.toLocaleString("ja-JP")} 円`, gain: `同時に持てる注文 +${SHELF.carry} 件  ${fmtSeconds(SHELF.seconds)}`, why: modBlock("shelf", m, this.money), onClick: () => this.buyMod("shelf") },
        { name: "冬タイヤ", price: `${WINTER.price.toLocaleString("ja-JP")} 円`, gain: `雪の日に遅くならない  ${fmtSeconds(WINTER.seconds)}`, why: modBlock("winter", m, this.money), onClick: () => this.buyMod("winter") },
        ...PAINT_CHOICES.map((p) => {
          const id = `paint:${p.color ?? ""}` as ModId;
          return { name: `塗装（${p.name}）`, price: `${PAINT.price.toLocaleString("ja-JP")} 円`, gain: fmtSeconds(PAINT.seconds), why: modBlock(id, m, this.money), onClick: () => this.buyMod(id) };
        }),
        { name: "給油・整備に戻る", price: "", gain: "", why: null, onClick: () => this.showRest(st, "", "service") },
      ];
      this.restCard.show(st, `資金 ${Math.round(this.money).toLocaleString("ja-JP")} 円`, rows, entries, note);
      return;
    }
    if (st.kind === "car" && k) {
      const c = this.carNow(k);
      const rows: [string, string][] = [["燃料", `${c.fuel.toFixed(1)} / ${TANK[k]} L`], ...CAR_PARTS.map((p) => [CAR_PART_LABELS[p], `${Math.round(c[p] * 100)}%`] as [string, string])];
      const entries: CardEntry[] = CAR_SERVICES.map((s) => {
        const price = carServicePrice(s, c, k);
        return {
          name: s.name,
          price: price ? `${price.toLocaleString("ja-JP")} 円` : "無料",
          gain: `${s.id === "fuel" ? `燃料 ${TANK[k]} L まで` : s.parts.map((p) => CAR_PART_LABELS[p]).join("・") + "を 100%"}  ${fmtSeconds(s.seconds)}`,
          why: carServiceBlock(s, c, k, this.money),
          onClick: () => this.buyCarService(s),
        };
      });
      entries.push({ name: "付け替え（荷室の棚・冬タイヤ・塗装）", price: "", gain: "", why: null, onClick: () => this.showRest(st, "", "mods") });
      this.restCard.show(st, `資金 ${Math.round(this.money).toLocaleString("ja-JP")} 円`, rows, entries, note);
      return;
    }
    const rows: [string, string][] = CARE_PARTS.map((p) => [CARE_LABELS[p], `${Math.round(this.care[p] * 100)}%`]);
    // 自転車で燃料店に来た時は空気入れだけ
    const services = st.kind === "bike" ? CARE_SERVICES : CARE_SERVICES.filter((s) => s.id === "air");
    const entries: CardEntry[] = services.map((s) => ({
      name: s.name,
      price: s.price ? `${s.price.toLocaleString("ja-JP")} 円` : "無料",
      gain: `${s.parts.map((p) => CARE_LABELS[p]).join("・")}を 100%  ${fmtSeconds(s.seconds)}`,
      why: careBlock(s, this.care, this.money),
      onClick: () => this.buyCare(s),
    }));
    if (st.kind === "bike")
      entries.push({
        name: "リアキャリア",
        price: `${CARRIER_COST.toLocaleString("ja-JP")} 円`,
        gain: `同時に持てる注文 ${carryLimit("carrier")} 件・大きめの小包`,
        why: this.gear === "carrier" ? "付いている" : this.money < CARRIER_COST ? "所持金が足りない" : null,
        onClick: () => {
          if (this.gear === "carrier" || this.money < CARRIER_COST) return;
          this.money -= CARRIER_COST;
          this.gear = "carrier";
          this.hud.flash("リアキャリアを付けた", "ok");
          this.showRest(st, "リアキャリアを付けた");
          void this.save();
        },
      });
    else rows.push(["車", this.market?.own() ? "乗っていない（経営の乗り物のタブで乗る）" : "持っていない"]);
    this.restCard.show(st, money, rows, entries, note);
  }

  /** 自転車店で整備を頼む: 払って直し、かかった時間を持っている注文の経った時間に足す */
  buyCare(s: CareService) {
    const st = this.restCard.stop;
    if (!st || careBlock(s, this.care, this.money)) return;
    this.money -= s.price;
    this.care = serviceCare(s, this.care);
    for (const d of this.deliveries) d.addTime(s.seconds);
    this.careWarned = 1;
    this.hud.flash(`${s.name}　${fmtSeconds(s.seconds)}`, "ok");
    this.showRest(st, `${s.name}　${fmtSeconds(s.seconds)}経った`);
    void this.save();
  }

  /** 乗っている車の燃料と傷み（無ければ満タン・整備したて。D7b） */
  carNow(k: DriveKind): CarCare {
    return (this.carCare[k] ??= freshCar(k));
  }

  /**
   * 自分の車で走った分だけ燃料を使い傷める（D7b。配達の草案 34 章）。燃料が尽きたら止め、呼んで届けてもらう札を出す。
   * 燃料が 25%・10% を切った時に近くの燃料店を知らせる
   */
  private updateCar(ride: Ride, pose: { x: number; z: number } | null) {
    const k = this.driving;
    if (!k || this.watching) {
      this.carOdo = ride.odometer;
      return;
    }
    const d = ride.odometer - this.carOdo;
    if (d > 0 && d < 500) this.carCare[k] = driveWear(this.carNow(k), k, d);
    this.carOdo = ride.odometer;
    const c = this.carNow(k);
    const share = c.fuel / TANK[k];
    if (share > this.fuelWarned + 0.05) this.fuelWarned = 1;
    for (const th of [0.25, 0.1]) {
      if (share >= th || this.fuelWarned <= th || !pose) continue;
      this.fuelWarned = th;
      let best: RestStop | null = null;
      for (const s of this.restStops) if (s.kind === "car" && (!best || Math.hypot(s.roadX - pose.x, s.roadZ - pose.z) < Math.hypot(best.roadX - pose.x, best.roadZ - pose.z))) best = s;
      this.hud.flash(`燃料 ${Math.round(th * 100)}%${best ? `　近くの燃料店 ${Math.round(Math.hypot(best.roadX - pose.x, best.roadZ - pose.z) / 10) * 10}m` : ""}`, "hit");
      break;
    }
    // 燃料が尽きた: 止まって、呼んで届けてもらう札
    if (c.fuel <= 0 && ride.speed < 0.3 && !this.restCard.isOpen) this.showRescue();
  }

  /** 燃料切れの札（呼んで届けてもらう。D7b） */
  private showRescue() {
    const k = this.driving;
    const ride = this.ride;
    if (!k || !ride?.road) return;
    const p = ride.pose();
    const st = { id: "rescue", kind: "car", name: "燃料が無い", x: p.x, y: p.y, z: p.z, fx: 0, fz: 1, road: ride.pos.road, s: ride.pos.s, roadX: p.x, roadZ: p.z, bx: p.x, bz: p.z } as RestStop;
    this.restCard.show(st, `資金 ${Math.round(this.money).toLocaleString("ja-JP")} 円`, [["燃料", "0 L"]], [
      {
        name: "呼んで届けてもらう",
        price: `${RESCUE.price.toLocaleString("ja-JP")} 円`,
        gain: `燃料 ${RESCUE.liters} L  ${fmtSeconds(RESCUE.seconds)}`,
        why: this.money < RESCUE.price ? "資金が足りない" : null,
        onClick: () => {
          if (this.money < RESCUE.price) return;
          this.money -= RESCUE.price;
          this.carCare[k] = rescueCar(this.carNow(k), k);
          for (const d of this.deliveries) d.addTime(RESCUE.seconds);
          this.fuelWarned = 1;
          this.restCard.hide();
          this.hud.flash(`燃料を ${RESCUE.liters} L 届けてもらった　−${RESCUE.price.toLocaleString("ja-JP")} 円`, "ok");
          void this.save();
        },
      },
    ]);
  }

  /** 燃料店で車の給油・整備を頼む（D7b） */
  buyCarService(s: CarService) {
    const k = this.driving;
    const st = this.restCard.stop;
    if (!k || !st || carServiceBlock(s, this.carNow(k), k, this.money)) return;
    const price = carServicePrice(s, this.carNow(k), k);
    this.money -= price;
    this.carCare[k] = serviceCar(s, this.carNow(k), k);
    for (const d of this.deliveries) d.addTime(s.seconds);
    this.fuelWarned = 1;
    this.hud.flash(`${s.name}　−${price.toLocaleString("ja-JP")} 円`, "ok");
    this.showRest(st, `${s.name}　${fmtSeconds(s.seconds)}経った`);
    void this.save();
  }

  /** 走った分だけ自転車を傷め、傷みを走りに効かせる（配達だけ。サイクリングと眺める時は傷めない） */
  private updateCare(ride: Ride) {
    const on = this.mode === "delivery" && !this.watching && ride.power === this.manual && !this.driving;
    const d = ride.odometer - this.careOdo;
    if (on && d > 0 && d < 500) this.care = wear(this.care, d);
    this.careOdo = ride.odometer;
    const e = on ? careEffects(this.care) : { crr: 1, drive: 1, brake: 1 };
    ride.careCrr = e.crr;
    ride.careDrive = e.drive;
    ride.careBrake = e.brake;
  }

  /**
   * 配達鞄とリアキャリアの見た目（配達の草案 29 章）。配達だけ。鞄と箱の色は、経営している業者、入っている業者、
   * どちらも無ければ橙
   */
  private updateCargo() {
    let look: { bag: string; rack: boolean } | null = null;
    if (this.mode === "delivery") {
      const m = this.market;
      const id = m?.own()?.id ?? m?.state.player.company ?? null;
      const color = (id && m?.now.entities.find((e) => e.id === id)?.color) || "#d8642a";
      look = { bag: color, rack: this.gear === "carrier" };
    }
    const key = look ? `${look.bag}|${look.rack}` : "";
    if (key === this.cargoKey) return;
    this.cargoKey = key;
    this.player.setCargo(look);
  }

  /** いちばん傷んだ所が 50%・25% を切った時に、近くの自転車店を知らせる */
  private warnCare(pose: { x: number; z: number } | null) {
    if (this.mode !== "delivery" || this.watching || !pose) return;
    const w = worstPart(this.care);
    if (w.share > this.careWarned + 0.05) this.careWarned = 1;
    for (const th of [0.5, 0.25]) {
      if (w.share >= th || this.careWarned <= th) continue;
      this.careWarned = th;
      // 空気だけなら燃料店でも入れられる
      const shops = this.restStops.filter((s) => s.kind === "bike" || (w.part === "tire" && s.kind === "car"));
      let best: RestStop | null = null;
      for (const s of shops) if (!best || Math.hypot(s.roadX - pose.x, s.roadZ - pose.z) < Math.hypot(best.roadX - pose.x, best.roadZ - pose.z)) best = s;
      const where = best ? `　近くの${best.name} ${Math.round(Math.hypot(best.roadX - pose.x, best.roadZ - pose.z) / 10) * 10}m` : "";
      this.hud.flash(`${CARE_LABELS[w.part]} ${Math.round(th * 100)}%${where}`, "hit");
      break;
    }
  }

  /** 買う・食べる: 所持金を払い、体力（店なら脚も）を戻し、かかった時間を持っている注文の経った時間に足す */
  buyRest(it: RestItem) {
    const st = this.restCard.stop;
    if (!st || restBlock(it, this.money, this.stamina.energyShare, this.stamina.legsShare)) return;
    this.money -= it.price;
    this.stamina.refill(it.energy, it.legs);
    for (const d of this.deliveries) d.addTime(it.seconds);
    const pct = Math.round(this.stamina.energyShare * 100);
    this.hud.flash(`${it.name}　−${it.price} 円　体力 ${pct}%`, "ok");
    this.showRest(st, `${it.name}　${fmtSeconds(it.seconds)}経った`);
    this.lowWarned = 1;
    void this.save();
  }

  /** 脚・体力が尽きて、選んだペースより遅いペースで走っている時、そのペース。そうでなければ null */
  private cappedPace(): number | null {
    const sel = this.manual.pace;
    if (sel === 0) return null;
    const eff = effectivePace(sel, this.manual.cp, this.stamina.cap());
    return eff < sel ? eff : null;
  }

  /** 体力が 30%・15% を切った時に、近くの店を知らせる（地図で押すとそこまでの経路） */
  private warnLowEnergy(pose: { x: number; z: number } | null) {
    if (this.mode !== "delivery" || this.watching || !pose) return;
    // 脚が尽きた時: 戻るまで抑えることを知らせる
    const ex = this.stamina.exhausted;
    if (ex && !this.wasExhausted) this.hud.flash(`脚が尽きた　脚 ${Math.round(LEGS_BACK * 100)}% まで出力を抑える`, "hit");
    this.wasExhausted = ex;
    const e = this.stamina.energyShare;
    if (e > this.lowWarned + 0.05) this.lowWarned = 1;
    for (const th of [0.3, 0.15]) {
      if (e >= th || this.lowWarned <= th) continue;
      this.lowWarned = th;
      let best: RestStop | null = null;
      let bd = Infinity;
      for (const st of this.restStops) {
        if (!isFood(st.kind)) continue;
        // 店を先に（自販機は少ししか戻らない）
        const d = Math.hypot(st.roadX - pose.x, st.roadZ - pose.z) * (st.kind === "vending" ? 2.5 : 1);
        if (d < bd) {
          bd = d;
          best = st;
        }
      }
      const where = best ? `　近くの${best.name} ${Math.round(Math.hypot(best.roadX - pose.x, best.roadZ - pose.z) / 10) * 10}m` : "";
      this.hud.flash(`体力 ${Math.round(th * 100)}%${where}`, "hit");
      break;
    }
  }

  private updateAddressSigns(pose: { x: number; z: number } | null, t: number) {
    const book = this.addresses;
    if (!pose || !book) {
      if (this.signList.length) this.view.addressSigns.update((this.signList = []), this.view.originX, this.view.originZ);
      return;
    }
    if (t - this.signT > 400) {
      this.signT = t;
      const near: { j: Junction; d: number }[] = [];
      for (const j of this.roads.net.junctions.values()) {
        if (j.arms.length < 3) continue;
        const d = (j.x - pose.x) ** 2 + (j.z - pose.z) ** 2;
        if (d < SIGN_RANGE * SIGN_RANGE) near.push({ j, d });
      }
      near.sort((a, b) => a.d - b.d);
      const list: AddressSign[] = [];
      for (const { j } of near) {
        for (const c of junctionCorners(junctionShape(this.roads.net, j))) {
          const at = book.at(c.x + c.bx * 25, c.z + c.bz * 25, 120);
          if (!at) continue;
          list.push({ x: c.x, y: c.y, z: c.z, nx: -c.bx, nz: -c.bz, label: shortAddress(at) });
        }
        if (list.length >= 48) break;
      }
      this.signList = list;
    }
    this.view.addressSigns.update(this.signList, this.view.originX, this.view.originZ);
  }
  private signList: AddressSign[] = [];
  private signT = -Infinity;

  /** 受け渡しの所の印（持っている注文の行き先。案内が「住所と地図だけ」なら 150m 以内だけ） */
  private handoffMarks(pose: { x: number; z: number } | null): HandoffMark[] {
    if (!pose) return [];
    const out: HandoffMark[] = [];
    const cur = this.delivery;
    for (const d of [cur, ...this.deliveries.filter((x) => x !== cur)]) {
      if (!d) continue;
      const z = this.zoneOf(d.target);
      if (!z) continue;
      const kind: HandoffKind = d.phase === "pickup" ? "pickup" : "dropoff";
      out.push({ kind, active: d === cur, px: z.px, py: z.py, pz: z.pz, zx: z.zone.x, zy: z.y, zz: z.zone.z, r: z.zone.r });
    }
    return out;
  }

  private finishDelivery(d: Delivery, r: DeliveryResult) {
    const ride = this.ride;
    if (!ride || !this.addresses) return;
    this.money += r.reward;
    this.delivered++;
    if (!r.late) this.onTime++;
    const ds = this.todayStats();
    ds.delivered++;
    ds.earned += r.reward;
    if (!r.late) ds.onTime++;
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

  /** 地図の印（持っている注文の行き先。案内によらず出す。配達の草案 27 章）。受け取りか届け先か、いま向かっている方か。id は注文の番号 */
  private deliveryMarks(): { x: number; z: number; name: string; kind: "pickup" | "dropoff"; active: boolean; id: number }[] {
    const cur = this.delivery;
    return this.deliveries.map((d) => {
      const z = this.zones.get(d.target);
      return { x: z?.zone.x ?? d.target.x, z: z?.zone.z ?? d.target.z, name: d.target.name, kind: d.phase === "pickup" ? "pickup" : "dropoff", active: d === cur, id: d.order.no };
    });
  }

  /** 地図で受け取り・届け先の印を押した: その注文を向かう方にして、行き先まで経路を引いて漕ぎ出す（配達の草案 27 章） */
  private goToMark(no: number) {
    const d = this.deliveries.find((x) => x.order.no === no);
    if (!d) return;
    this.deliveries = [d, ...this.deliveries.filter((x) => x !== d)];
    this.routedByTap.add(no);
    this.goalLandmark = null;
    this.stopAtGoal = false;
    this.guideTo(d.target);
    this.mapNote = { text: `${d.phase === "pickup" ? "受け取り" : "届け先"}の${d.target.name}へ経路を引いた`, until: performance.now() + 4000 };
  }
  /** 地図の印を押して経路を引いた注文（案内が「経路を自動で引く」でなくても、受け取った後も届け先へ引く） */
  private routedByTap = new Set<number>();

  /** 行き先までの経路の線（地図・小地図。配達の草案 26 章）。1/4 秒ごとに引き直す */
  private routeLine(): number[] | null {
    const ride = this.ride;
    if (!ride?.plan || !ride.road) return null;
    const now = performance.now();
    if (this.routeCache && now - this.routeCache.t < 250 && this.routeCache.plan === ride.plan) return this.routeCache.path;
    const path = planPath(this.roads.net, ride.pos, ride.plan);
    // 今いる所から線を始める
    const p = ride.pose();
    path.unshift(p.x, p.z);
    this.routeCache = { t: now, plan: ride.plan, path };
    return path;
  }
  private routeCache: { t: number; plan: object; path: number[] } | null = null;

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
          if (this.mode === "cycling") this.setWatching(!this.watching);
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
          if (!this.tryYose(-1)) ride?.shiftLane(-LANE_TAP);
          break;
        case "lane-right":
          if (!this.tryYose(1)) ride?.shiftLane(LANE_TAP);
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
      // 名所の立ち寄り（回って眺める視点）はサイクリングだけ（配達の草案 28 章）
      if (this.mode === "cycling") this.checkLandmark(t);
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
    // 左右のボタン・キーを押し続けている間は、左右位置を動かし続ける（配達の草案 26 章）
    const lane = this.input.lane;
    if (lane && ride && !this.paused && performance.now() - this.input.laneSince > LANE_HOLD_MS) ride.shiftLane(lane * LANE_SPEED * dt);
    this.manual.brake = this.input.brake || this.arriving || this.restBrake() || this.zoneBrake() || this.carAheadBrake() ? 1 : 0;
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
        // 体力とペースの補助は配達の自転車だけ。サイクリングは補助なしの出力で走る（配達の草案 28 章）。車は体力を使わない（33 章）
        const work = this.mode === "delivery" && !this.driving;
        // 燃料が尽きたら走れない（D7b）
        if (this.driving) ride.carTarget = this.carNow(this.driving).fuel > 0 ? CAR_PACE_KMH[this.manual.pedal ? 2 : this.manual.pace] / 3.6 : 0;
        this.manual.cap = this.watching || !work ? Infinity : this.stamina.cap();
        // ペースの補助（配達の草案 26 章）: 手動で漕ぐ時だけ。漕ぐボタンは「ふつう」と同じ
        const assisted = ride.power === this.manual && !this.watching && work;
        // 脚・体力が尽きて出力が抑えられている間は、抑えた出力で走れるペースの補助と速さにする（30 章）
        const pace = effectivePace(this.manual.pedal ? 2 : this.manual.pace, this.manual.cp, this.manual.cap);
        ride.assist = assisted ? PACE_ASSIST[pace] : 1;
        const nominal = this.manual.pedal ? this.manual.setting : paceWatts(pace, this.manual.cp);
        ride.cruise = assisted && nominal > 0 ? (PACE_SPEED[pace] / 3.6) * Math.min(1, this.manual.cap / nominal) : 0;
        ride.step(DT);
        if (!this.watching && work) this.stamina.update(ride.watts, DT);
        this.acc -= DT;
        n++;
      }
      if (n >= maxSteps) this.acc = 0;
    }
    this.updateRecord();
    if (ride) {
      this.updateArrival(ride);
      this.checkCarHits(ride);
      this.steerToZone();
      this.checkRest(ride);
      this.updateCare(ride);
      this.updateRestAction();
      this.syncDrive();
      this.updateCar(ride, ride.road ? ride.pose() : null);
    }

    let eye = { x: this.anchor.x, y: this.view.heights.height(this.anchor.x, this.anchor.z) + 40, z: this.anchor.z };
    let target = { x: this.anchor.x + 10, y: eye.y - 5, z: this.anchor.z };
    let fov = 55;
    this.view.nearPlane = NEAR_DEFAULT;
    let pose: ReturnType<Ride["pose"]> | null = null;
    if (ride?.road) {
      pose = ride.pose();
      const aspect = this.view.camera.aspect;
      const c = cameraPose(this.camera, pose, aspect, (x, z) => this.view.surfaceHeight(x, z), !!this.driving);
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
      // 向きは遅らせない: 注視点を、遅れて追う目の位置から同じ向き・同じ距離に置く。
      // 注視点だけ先に動くと、左右へ寄った時に画面が一瞬回って見えた（ユーザーの指摘 2026-11-26）
      target = { x: this.smoothEye.x + (c.target.x - c.eye.x), y: this.smoothEye.y + (c.target.y - c.eye.y), z: this.smoothEye.z + (c.target.z - c.eye.z) };
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
      // 近くの配達員は人の形で描き、その分の箱の形を隠す（配達の草案 30 章）
      this.view.npcRiders.update(this.traffic, this.view.originX, this.view.originZ, this.anchor.x, this.anchor.z, this.paused ? 0 : dt, this.mode === "delivery" && !!pose);
      this.view.trafficView.update(this.traffic, this.view.originX, this.view.originZ, lights, eye.x, eye.z, this.view.npcRiders.drawn);
      this.drawPeople(pose);
      this.view.handoff.update(this.handoffMarks(pose), this.view.originX, this.view.originZ, this.paused ? 0 : dt);
      this.updateAddressSigns(pose, t);
      this.updateRestStops(pose, t);
      // 掘割の擁壁とアンダーパスの天井（北海道の世界。道が読み込まれた・遠くへ動いた時だけ作り直す）
      if (this.view.world.local && pose) this.view.cutWalls.update(this.roads.net.roads.values(), this.view.heights, this.view.originX, this.view.originZ, pose.x, pose.z, this.roads.net.version);
      this.view.restStops.pulse(t / 1000);
      this.view.realPoles?.setLights(lights);
      this.player.group.visible = !!pose && !this.driving;
      if (pose && this.driving) this.playerCar.update(pose.x - this.view.originX, pose.y, pose.z - this.view.originZ, pose.dx, pose.dz, pose.grade);
      if (pose && ride && !this.driving) {
        this.player.cadenceOverride = ride.power === this.trainer.power ? this.trainer.cadenceRpm : null;
        this.player.update(
          this.paused ? 0 : dt,
          pose.x - this.view.originX,
          pose.y + ride.hopHeight,
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
      this.minimap.draw({ roads: this.roads.roadEntries(), pois: this.roads.pois.values(), ridden: this.ridden, stamped: this.stampSet, x: pose.x, z: pose.z, dx: pose.dx, dz: pose.dz, goal, landmarks: this.landmarkMarks(), work: this.workMarks(), targets: this.deliveryMarks(), route: this.routeLine(), rests: this.restStops });
      this.warnLowEnergy(pose);
      this.warnCare(pose);
      this.updateCargo();
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
      roadName: road?.name ?? "",
      ...this.whereNow(pose),
      elevation: road ? sampleRoad(road, ride.pos.s).y : 0,
      autoBrake: ride.autoBrake > 0,
      upcoming: ride.upcoming,
      // 走っていても U ターンできる（減速してから回る。配達の草案 27 章）
      canUTurn: !this.watching && !!ride.road && !ride.uTurnPending,
      watching: this.watching,
      paused: this.paused,
      goalDistance,
      goalName,
      pace: !this.watching && ride.power === this.manual ? this.manual.pace : null,
      // 脚が尽きて抑えている間に実際に走れるペース（選んだペースより遅い時だけ）
      paceCapped: !this.watching && ride.power === this.manual && this.mode === "delivery" ? this.cappedPace() : null,
      // 自分の車では、2 本の棒を燃料と車のいちばん傷んだ所にする（D7b）
      legs: this.watching || this.mode === "cycling" ? null : this.driving ? this.carNow(this.driving).fuel / TANK[this.driving] : this.stamina.legsShare,
      energy: this.watching || this.mode === "cycling" ? null : this.driving ? worstCarPart(this.carNow(this.driving)).share : this.stamina.energyShare,
      care: this.mode === "delivery" ? worstPart(this.care).share : null,
      hour: this.view.env.hour,
      weekday: this.forceSky?.hour !== undefined || this.settings.clock === "fixed" ? null : worldDay(Date.now() + this.clockOffset).weekday,
      weather: WEATHER_LABELS[this.weatherNow.kind],
    });
  }
}
