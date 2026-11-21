// 閉じている間の旅（冒険の草案 4.2）: 描画なしで走行を進め、通った町・前を通った喫茶店・見えた名所・最高地点・道筋を残す。
// 道路の読み込みは呼び出し側（ensure が false の間は待つ）。描画にも端末の機能にも依存しない。

import type { Poi, WorldNode } from "../shared/world/types.ts";
import type { AdventureLedger } from "./adventure.ts";
import { RIDDEN_BIN, type RiddenLog } from "./ridden.ts";
import type { Ride } from "./ride.ts";
import { type RoadNetwork, sampleRoad } from "./road-network.ts";
import { type WatchRoute, watchChoice } from "./watch.ts";

/** 計算の 1 歩 (s)。速い下り（20m/s）でも 1 歩が 10m の区切りより短い */
export const JOURNEY_DT = 0.1;
/** まとめて進める時間の上限 (s)【初期値】 */
export const JOURNEY_MAX_S = 12 * 3600;
/** 道筋を残す間隔 (m) と点の数の上限 */
const PATH_STEP = 100;
const PATH_MAX = 600;
/** 町・名所を「通った」「見えた」とする距離 (m)【初期値】 */
const TOWN_NEAR = 400;
const LANDMARK_NEAR = 300;
/** 喫茶店の前を通ったとする道のりの差 (m) */
const CAFE_NEAR = 20;

export interface JourneyLog {
  /** 旅を進めた時間の始まり（Unix 秒）と、進めた時間 (s) */
  from: number;
  seconds: number;
  distance: number;
  /** 新しく走った道のり（使った冒険の距離） */
  explored: number;
  cafes: { id: string; name: string; road: string; s: number; x: number; z: number; y: number }[];
  towns: string[];
  landmarks: string[];
  maxElevation: number;
  /** 道筋（世界座標。100m ごと） */
  path: [number, number][];
  /** 冒険の距離が尽きて終わった */
  exhausted: boolean;
}

export interface JourneyContext {
  net: RoadNetwork;
  ridden: RiddenLog;
  ledger: AdventureLedger;
  route: WatchRoute;
  /** 位置 (x, z) の周りの道路が読み込まれているか（false なら待つ） */
  ensure: (x: number, z: number) => boolean;
  pois: () => Iterable<Poi>;
  landmarks?: { id: string; name: string; x: number; z: number }[];
}

export type JourneyStatus = "running" | "waiting" | "done";

export class JourneySim {
  readonly log: JourneyLog;
  /** 進めた時間 (s) */
  elapsed = 0;
  private lastPathOdo = -Infinity;
  private seenCafe = new Set<string>();
  private seenTown = new Set<string>();
  private seenLandmark = new Set<string>();
  private odo0: number;
  private spent0: number;

  constructor(
    private ride: Ride,
    private ctx: JourneyContext,
    /** 進める時間 (s) */
    readonly seconds: number,
    from: number,
  ) {
    this.odo0 = ride.odometer;
    this.spent0 = ctx.ledger.spent;
    this.log = { from, seconds: 0, distance: 0, explored: 0, cafes: [], towns: [], landmarks: [], maxElevation: -Infinity, path: [], exhausted: false };
  }

  get done(): boolean {
    return this.elapsed >= this.seconds || this.ctx.ledger.balance < RIDDEN_BIN;
  }

  /** 歩数 maxSteps まで進める（または待つ・終わる） */
  run(maxSteps: number): JourneyStatus {
    const r = this.ride;
    const c = this.ctx;
    r.adventure = c.ledger;
    for (let i = 0; i < maxSteps; i++) {
      if (this.done) return this.finish();
      if (!r.road) return "waiting";
      const p = r.pose();
      if (!c.ensure(p.x, p.z)) return "waiting";
      // 分岐: 眺める乗り方の選び方（冒険の残りが少なければ走った道）
      const u = r.upcoming;
      if (u && u.selected === null && !r.plan) {
        const k = watchChoice(u, c.route, c.ridden, c.net, c.ledger.balance);
        if (k !== u.defaultIndex) r.choose(k);
      }
      if (r.blocked && r.speed < 0.5) r.uTurn();
      r.step(JOURNEY_DT);
      this.elapsed += JOURNEY_DT;
      this.observe();
    }
    this.sync();
    return this.done ? this.finish() : "running";
  }

  /** 残りの道のりの目安 (m): 残りの時間を今の速さで走った分と、冒険の残りの小さい方 */
  get remainingHint(): number {
    return Math.min(this.ctx.ledger.balance, (this.seconds - this.elapsed) * Math.max(5, this.ride.speed));
  }

  private finish(): JourneyStatus {
    this.sync();
    this.log.exhausted = this.ctx.ledger.balance < RIDDEN_BIN;
    return "done";
  }

  private sync() {
    this.log.seconds = this.elapsed;
    this.log.distance = this.ride.odometer - this.odo0;
    this.log.explored = this.ctx.ledger.spent - this.spent0;
  }

  /** 通った町・喫茶店・名所、最高地点、道筋 */
  private observe() {
    const r = this.ride;
    if (!r.road) return;
    const p = r.pose();
    const log = this.log;
    if (p.y > log.maxElevation) log.maxElevation = p.y;
    if (r.odometer - this.lastPathOdo >= PATH_STEP) {
      this.lastPathOdo = r.odometer;
      log.path.push([Math.round(p.x), Math.round(p.z)]);
      // 多くなったら 1 つおきに間引く
      if (log.path.length > PATH_MAX) log.path = log.path.filter((_, i) => i % 2 === 0);
    }
    // 町・名所・喫茶店は 1 秒に 1 回見る
    if (Math.round(this.elapsed / JOURNEY_DT) % 10 !== 0) return;
    for (const n of this.ctx.net.nodes.values()) {
      if (n.kind !== "town" && n.kind !== "village") continue;
      if (this.seenTown.has(n.id) || !n.name) continue;
      if (Math.abs(n.x - p.x) > TOWN_NEAR || Math.abs(n.z - p.z) > TOWN_NEAR) continue;
      this.seenTown.add(n.id);
      log.towns.push(townLabel(n));
    }
    for (const lm of this.ctx.landmarks ?? []) {
      if (this.seenLandmark.has(lm.id)) continue;
      if (Math.hypot(lm.x - p.x, lm.z - p.z) > LANDMARK_NEAR) continue;
      this.seenLandmark.add(lm.id);
      log.landmarks.push(lm.name);
    }
    for (const poi of this.ctx.pois()) {
      if (poi.kind !== "cafe" || this.seenCafe.has(poi.id) || poi.road !== r.pos.road) continue;
      if (Math.abs(poi.s - r.pos.s) > CAFE_NEAR) continue;
      const road = r.road;
      const at = sampleRoad(road, poi.s);
      this.seenCafe.add(poi.id);
      log.cafes.push({ id: poi.id, name: poi.name, road: poi.road, s: poi.s, x: at.x, z: at.z, y: at.y });
    }
  }
}

const townLabel = (n: WorldNode) => n.name;
