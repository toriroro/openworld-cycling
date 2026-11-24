// 交通（都市と交通の草案 6 章、T1 の一部）。端末ごとに自分の周りに車を出して動かし、同期しない（決定 2026-11-13）。
// - 量は場所（道路の等級）と世界の時刻から決める。範囲の外れで出し、範囲を出たら消す
// - 前の車・自転車への追従は Intelligent Driver Model。自転車は 1.5m 空けて、対向車線が空いている時に追い越す
// - 接触判定はしない（概要仕様 4.1）。自転車と重なった回数だけ数える
// - 従道路から出る車は口で止まり、近づく車がなければ出る。信号はまだない（街路網は U1）
// - バスはバス停で止まる
// sim は shared/world と sim の道路網だけに依存する（モック仕様 3.3）。描画は読むだけ。

import type { Junction, Road } from "../../shared/world/types.ts";
import { cornerCurve, junctionShape, type Vec3 } from "../junction-shape.ts";
import { type RoadNetwork, type RoadPosition, sampleRoad } from "../road-network.ts";
import { type BusStop, busStopsOn } from "./bus-stops.ts";
import {
  BUS_COLORS,
  CAR_COLORS,
  DENSITY_PER_KM,
  hourFactor,
  KEI_TRUCK_COLORS,
  SPEED_LIMIT,
  TYPE_MIX,
  VEHICLE_SPECS,
  type VehicleType,
} from "./vehicle-types.ts";

export type TrafficLevel = "off" | "few" | "normal";
export const TRAFFIC_LEVEL_FACTOR: Record<TrafficLevel, number> = { off: 0, few: 0.45, normal: 1 };

/** 種付きの乱数（テストで再現するため。Math.random は使わない） */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pickWeighted<T>(list: [T, number][], u: number): T {
  let sum = 0;
  for (const [, w] of list) sum += w;
  let x = u * sum;
  for (const [v, w] of list) {
    x -= w;
    if (x <= 0) return v;
  }
  return list[list.length - 1][0];
}

interface TurnState {
  pts: Vec3[];
  acc: number[];
  length: number;
  d: number;
  to: RoadPosition;
}

/** 次の接続点での動き（決めたら変えない） */
interface JunctionPlan {
  junction: string;
  /** 今の道路での接続点の道のり */
  s: number;
  /** 曲がり始める道のり（直進なら null） */
  entryS: number | null;
  to: RoadPosition | null;
  offOut: number;
  /** 従道路から出るので止まって確かめる */
  yieldFirst: boolean;
  cleared: boolean;
  /** 行き止まり・道路の続きが読み込まれていない */
  dead: boolean;
}

export interface Vehicle {
  id: number;
  type: VehicleType;
  length: number;
  width: number;
  /** 色（sRGB の 16 進） */
  color: string;
  pos: RoadPosition;
  /** 進行方向に対する左右位置 (m、右が正)。道路の中心から */
  offset: number;
  speed: number;
  /** この車の好む速さの係数 */
  pace: number;
  turn: TurnState | null;
  plan: JunctionPlan | null;
  /** 追い越し中の相手（-1 は自転車） */
  passing: { target: number; offset: number } | null;
  waitT: number;
  /** 遅い相手の後ろについている時間 (s) */
  followT: number;
  /** 交差する相手と向かい合って止まっている時間と、相手を見ないで進む期限（互いに譲り合って動けなくなるのを防ぐ） */
  blockedT: number;
  ignoreCrossUntil: number;
  /** バス: 止まっている停留所と、出る時刻 */
  busStop: { id: string; until: number } | null;
  servedStop: string;
  /** 描画用の姿勢（世界座標） */
  x: number;
  y: number;
  z: number;
  dx: number;
  dz: number;
  grade: number;
  /** 減速中（尾灯を明るく） */
  braking: boolean;
  age: number;
}

/** 自転車（プレイヤー）の状態。避ける相手として渡す */
export interface Rider {
  x: number;
  z: number;
  dx: number;
  dz: number;
  speed: number;
  /** 道路の上にいる時の位置 */
  pos: RoadPosition | null;
  offset: number;
}

const BIKE_LENGTH = 1.8;
const BIKE_WIDTH = 0.6;
/** 自転車を追い越す時の横の間隔 (m)【初期値】 */
const BIKE_CLEARANCE = 1.5;

export interface TrafficOptions {
  /** 車を出す範囲 (m) */
  radius: number;
  /** 台数の上限 */
  max: number;
}

export const TRAFFIC_STANDARD: TrafficOptions = { radius: 500, max: 150 };
export const TRAFFIC_LIGHT: TrafficOptions = { radius: 320, max: 50 };

export class Traffic {
  readonly vehicles: Vehicle[] = [];
  options: TrafficOptions = TRAFFIC_STANDARD;
  level: TrafficLevel = "normal";
  /** 車の色を場所で決める（配達用のバン・軽トラをその丁目の業者の色にする。配達の草案 18 章）。null なら色の表から */
  paint: ((x: number, z: number, type: VehicleType, u: number) => string | null) | null = null;
  /** 世界の時刻（時） */
  hour = 12;
  /** 確かめる用の数 */
  readonly stats = { spawned: 0, removed: 0, overlaps: 0, passes: 0, busStops: 0, yields: 0 };
  private rand: () => number;
  private nextId = 1;
  private t = 0;
  private spawnT = 0;
  private overlapping = new Set<number>();
  private stopCache = new Map<string, BusStop[]>();
  private stopVersion = -1;
  /** 範囲の中の道路の長さ（台数の目標と、出す場所を選ぶのに使う） */
  private nearby: { road: Road; s0: number; s1: number; weight: number }[] = [];
  private filled = false;
  private fillRounds = 0;

  constructor(
    private net: RoadNetwork,
    seed = 1,
    /** 地面の高さ（バス停を置ける所を決める） */
    private ground?: (x: number, z: number) => number,
  ) {
    this.rand = rng(seed);
  }

  /** 全部消して出し直す（場所を移した時） */
  reset() {
    this.vehicles.length = 0;
    this.filled = false;
    this.fillRounds = 0;
    this.overlapping.clear();
  }

  /** 道路の上のバス停（読み込んだ道路ごとに覚える） */
  stopsOn(road: Road): BusStop[] {
    if (this.stopVersion !== this.net.version) {
      // 消えた道路の分を忘れる
      for (const id of this.stopCache.keys()) if (!this.net.roads.has(id)) this.stopCache.delete(id);
      this.stopVersion = this.net.version;
    }
    let l = this.stopCache.get(road.id);
    if (!l) this.stopCache.set(road.id, (l = busStopsOn(road, this.net.nodes.values(), this.ground)));
    return l;
  }

  /** 範囲の中のバス停 */
  stopsNear(x: number, z: number, range: number): BusStop[] {
    const out: BusStop[] = [];
    for (const n of this.nearby) for (const st of this.stopsOn(n.road)) if (Math.abs(st.x - x) < range && Math.abs(st.z - z) < range) out.push(st);
    return out;
  }

  /** 毎フレーム。dt は秒（止めている時は呼ばない）。rider は自転車（道路にいなければ null） */
  update(dt: number, cx: number, cz: number, rider: Rider | null) {
    this.t += dt;
    this.spawnT -= dt;
    const R = this.options.radius;
    if (this.spawnT <= 0) {
      this.spawnT = 0.5;
      this.scanRoads(cx, cz, R * 1.1);
      this.despawn(cx, cz, R);
      this.spawn(cx, cz, rider);
    }
    for (const v of this.vehicles) this.updatePose(v);
    for (const v of this.vehicles) this.drive(v, dt, rider);
    for (const v of this.vehicles) this.updatePose(v);
    this.countOverlaps(rider);
  }

  // ---- 出す・消す ----

  private densityOf(r: Road): number {
    if (r.kind === "cycleway") return 0;
    return DENSITY_PER_KM[r.cls] ?? 0;
  }

  private scanRoads(cx: number, cz: number, R: number) {
    this.nearby = [];
    for (const r of this.net.roads.values()) {
      const d = this.densityOf(r);
      if (d <= 0) continue;
      const P = r.points;
      const n = P.length / 3;
      const ds = r.length / (n - 1);
      const step = Math.max(1, Math.floor(20 / ds));
      let s0 = -1;
      let s1 = -1;
      for (let i = 0; i < n; i += step) {
        const x = P[i * 3] + r.origin[0];
        const z = P[i * 3 + 2] + r.origin[1];
        if ((x - cx) * (x - cx) + (z - cz) * (z - cz) < R * R) {
          const s = i * ds;
          if (s0 < 0) s0 = s;
          s1 = s;
        }
      }
      if (s0 < 0) continue;
      s1 = Math.min(r.length, s1 + step * ds);
      this.nearby.push({ road: r, s0, s1, weight: ((s1 - s0) / 1000) * d });
    }
  }

  private target(): number {
    const k = hourFactor(this.hour) * TRAFFIC_LEVEL_FACTOR[this.level];
    let sum = 0;
    for (const n of this.nearby) sum += n.weight;
    return Math.min(this.options.max, Math.round(sum * k));
  }

  private despawn(cx: number, cz: number, R: number) {
    const lim = R * 1.15;
    for (let i = this.vehicles.length - 1; i >= 0; i--) {
      const v = this.vehicles[i];
      const gone = !this.net.roads.has(v.pos.road) || (v.turn && !this.net.roads.has(v.turn.to.road));
      const far = Math.hypot(v.x - cx, v.z - cz) > lim;
      // 行き止まり・続きの無い道で止まった車は、離れていれば消す
      const stuck = v.plan?.dead && v.speed < 0.2 && Math.hypot(v.x - cx, v.z - cz) > 150;
      if (gone || far || stuck) {
        this.vehicles.splice(i, 1);
        this.overlapping.delete(v.id);
        this.stats.removed++;
      }
    }
    const want = this.target();
    // 交通量を減らした時は遠い車から消す
    if (this.vehicles.length > want + 2) {
      const sorted = [...this.vehicles].sort((a, b) => Math.hypot(b.x - cx, b.z - cz) - Math.hypot(a.x - cx, a.z - cz));
      for (const v of sorted.slice(0, this.vehicles.length - want)) {
        if (Math.hypot(v.x - cx, v.z - cz) < 200 && this.level !== "off") break;
        this.vehicles.splice(this.vehicles.indexOf(v), 1);
        this.stats.removed++;
      }
    }
  }

  private spawn(cx: number, cz: number, rider: Rider | null) {
    const want = this.target();
    const R = this.options.radius;
    let tries = 0;
    // 最初は範囲の中を一度に埋める。以降は 1 回に 4 台まで、範囲の外れか後ろに出す
    let budget = this.filled ? 4 : want;
    while (this.vehicles.length < want && budget > 0 && tries < 160) {
      tries++;
      // 道路の端に当たった時は選び直す（短い道路の多い町中で、ここで打ち切ると車が増えない）
      const site = this.pickSite();
      if (!site) {
        if (!this.nearby.length) break;
        continue;
      }
      const { road, s, dir } = site;
      const p = sampleRoad(road, s);
      const d = Math.hypot(p.x - cx, p.z - cz);
      if (d > R) continue;
      if (this.filled) {
        const behind = rider ? (p.x - cx) * rider.dx + (p.z - cz) * rider.dz < -0.3 * d : false;
        if (!(d > R * 0.72 || (behind && d > 160))) continue;
      } else if (d < 40) continue;
      // 接続点の近く（曲がる線の上）と、ほかの車の近くには出さない
      if (this.net.junctionsOn(road.id).some((j) => Math.abs(j.s - s) < 35)) continue;
      if (this.vehicles.some((o) => Math.hypot(o.x - p.x, o.z - p.z) < 25)) continue;
      this.vehicles.push(this.makeVehicle(road, s, dir));
      this.stats.spawned++;
      budget--;
    }
    if (this.nearby.length && (this.vehicles.length >= want * 0.8 || ++this.fillRounds >= 4)) this.filled = true;
  }

  private pickSite(): { road: Road; s: number; dir: 1 | -1 } | null {
    let sum = 0;
    for (const n of this.nearby) sum += n.weight;
    if (sum <= 0) return null;
    let x = this.rand() * sum;
    for (const n of this.nearby) {
      x -= n.weight;
      if (x <= 0) {
        const s = n.s0 + (n.s1 - n.s0) * this.rand();
        if (s < 20 || s > n.road.length - 20) return null;
        return { road: n.road, s, dir: this.rand() < 0.5 ? 1 : -1 };
      }
    }
    return null;
  }

  private paintAt(road: Road, s: number, type: VehicleType, fallback: string): string {
    if (!this.paint) return fallback;
    const p = sampleRoad(road, s);
    return this.paint(p.x, p.z, type, this.rand()) ?? fallback;
  }

  private makeVehicle(road: Road, s: number, dir: 1 | -1): Vehicle {
    const type = pickWeighted(TYPE_MIX[road.cls] ?? TYPE_MIX[1], this.rand());
    const spec = VEHICLE_SPECS[type];
    const palette = type === "bus" ? BUS_COLORS : type === "keiTruck" ? KEI_TRUCK_COLORS : CAR_COLORS;
    const v: Vehicle = {
      id: this.nextId++,
      type,
      length: spec.length,
      width: spec.width,
      color: this.paintAt(road, s, type, pickWeighted(palette, this.rand())),
      pos: { road: road.id, s, dir },
      offset: this.laneOffset(road, spec.width),
      speed: 0,
      pace: spec.pace * (0.88 + 0.22 * this.rand()),
      turn: null,
      plan: null,
      passing: null,
      waitT: 0,
      followT: 0,
      blockedT: 0,
      ignoreCrossUntil: 0,
      busStop: null,
      servedStop: "",
      x: 0,
      y: 0,
      z: 0,
      dx: 1,
      dz: 0,
      grade: 0,
      braking: false,
      age: 0,
    };
    v.speed = this.speedLimit(v, road) * 0.9;
    this.updatePose(v);
    return v;
  }

  /** 左側の車線の中央（左側通行）。狭い道では左へ寄せる */
  laneOffset(road: Road, width: number): number {
    const hw = road.width / 2;
    return Math.max(-hw + width / 2 + 0.1, Math.min(0, -road.width / 4));
  }

  private speedLimit(v: Vehicle, road: Road): number {
    return (SPEED_LIMIT[road.cls] ?? 8) * v.pace;
  }

  // ---- 姿勢 ----

  private updatePose(v: Vehicle) {
    if (v.turn) {
      const t = v.turn;
      const a = this.turnPoint(t, t.d);
      const b = this.turnPoint(t, Math.min(t.length, t.d + 1));
      const c = this.turnPoint(t, Math.max(0, t.d - 1));
      let dx = b.x - c.x;
      let dz = b.z - c.z;
      const l = Math.hypot(dx, dz) || 1;
      dx /= l;
      dz /= l;
      v.x = a.x;
      v.y = a.y;
      v.z = a.z;
      v.dx = dx;
      v.dz = dz;
      v.grade = (b.y - c.y) / (l || 1);
      return;
    }
    const road = this.net.roads.get(v.pos.road);
    if (!road) return;
    const p = sampleRoad(road, v.pos.s);
    const dx = p.dx * v.pos.dir;
    const dz = p.dz * v.pos.dir;
    v.x = p.x - dz * v.offset;
    v.y = p.y;
    v.z = p.z + dx * v.offset;
    v.dx = dx;
    v.dz = dz;
    v.grade = p.grade * v.pos.dir;
  }

  private turnPoint(t: TurnState, d: number): Vec3 {
    let i = 1;
    while (i < t.pts.length - 1 && t.acc[i] < d) i++;
    const a = t.pts[i - 1];
    const b = t.pts[i];
    const seg = t.acc[i] - t.acc[i - 1] || 1;
    const k = Math.max(0, Math.min(1, (d - t.acc[i - 1]) / seg));
    return { x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k, z: a.z + (b.z - a.z) * k };
  }

  // ---- 運転 ----

  private drive(v: Vehicle, dt: number, rider: Rider | null) {
    v.age += dt;
    const road = this.net.roads.get(v.turn ? v.turn.to.road : v.pos.road);
    if (!road) return;
    const limit = this.speedLimit(v, road);
    let vmax = limit;
    // 曲がっている途中・曲がる前は遅く
    if (v.turn) vmax = Math.min(vmax, 6.5);
    else {
      vmax = Math.min(vmax, this.curveLimit(v, road));
      this.planJunction(v, road);
    }
    // 止まる所（接続点の口・行き止まり・バス停）までの距離
    let stopAt = Infinity;
    const plan = v.plan;
    if (!v.turn && plan) {
      const dist = (plan.entryS ?? plan.s) * v.pos.dir - v.pos.s * v.pos.dir;
      if (plan.dead) stopAt = Math.min(stopAt, Math.abs(plan.s - v.pos.s) - 4);
      if (plan.entryS !== null && dist > 0) vmax = Math.min(vmax, Math.sqrt(6.5 * 6.5 + 2 * 2 * dist));
      if (plan.yieldFirst && !plan.cleared) {
        if (dist < 4 && v.speed < 0.6) {
          v.waitT += dt;
          if (v.waitT > 1.2 && this.junctionClear(v, plan, rider)) {
            plan.cleared = true;
            this.stats.yields++;
          }
        }
        if (!plan.cleared) stopAt = Math.min(stopAt, Math.max(0, dist - 1));
      }
    }
    if (!v.turn && v.type === "bus") stopAt = Math.min(stopAt, this.busStopDistance(v, road));

    // 前の相手（車・自転車）
    const lead = this.leader(v, rider);
    if (lead.cross && !lead.bike && v.speed < 0.3 && lead.gap < 12) {
      v.blockedT += dt;
      if (v.blockedT > 3) {
        v.ignoreCrossUntil = this.t + 3;
        v.blockedT = 0;
      }
    } else v.blockedT = 0;
    if (lead.bike && lead.gap < 40 && lead.speed < this.speedLimit(v, road) - 2.5) v.followT += dt;
    else if (lead.gap > 60) v.followT = 0;
    let accel = this.idm(v, vmax, lead.gap, lead.speed, lead.bike);
    if (stopAt < Infinity) accel = Math.min(accel, this.idm(v, vmax, stopAt, 0, false, true));
    // 追い越し
    this.considerPassing(v, road, lead, rider);
    accel = Math.max(-6, Math.min(1.5, accel));
    v.braking = accel < -0.8 || v.speed < 0.3;
    v.speed = Math.max(0, v.speed + accel * dt);

    // 左右位置
    const base = this.laneOffset(road, v.width);
    let want = v.passing ? v.passing.offset : base;
    if (v.busStop) want = -road.width / 2 + v.width / 2 + 0.1;
    // 狭い道で対向車が近い時は左へ寄せる
    if (!v.passing && road.width < 5.2 && this.oncomingNear(v, 70)) want = -road.width / 2 + v.width / 2 + 0.1;
    const dOff = want - v.offset;
    const rate = (v.passing ? 1.2 : 0.8) * dt;
    if (!v.turn) v.offset += Math.max(-rate, Math.min(rate, dOff));

    this.advance(v, v.speed * dt);
  }

  /** Intelligent Driver Model の加速度。gap は前の相手までの隙間 (m)、lv は相手の速さ */
  private idm(v: Vehicle, vmax: number, gap: number, lv: number, bike: boolean, line = false): number {
    const a = 1.2;
    const b = 2.0;
    // 止まる線（接続点の口・バス停）にはほぼ線まで寄せる
    const s0 = line ? 0.4 : bike ? 6 : 3;
    const T = line ? 0.4 : bike ? 2.5 : 1.5;
    const vel = v.speed;
    const free = 1 - (vel / Math.max(0.5, vmax)) ** 4;
    if (gap === Infinity) return a * free;
    const ss = s0 + Math.max(0, vel * T + (vel * (vel - lv)) / (2 * Math.sqrt(a * b)));
    return a * (free - (ss / Math.max(0.1, gap)) ** 2);
  }

  /** 先のカーブで落とす速さ（横の加速度 2.5m/s²） */
  private curveLimit(v: Vehicle, road: Road): number {
    let lim = Infinity;
    for (const d of [12, 30, 55]) {
      const s1 = v.pos.s + v.pos.dir * (d - 8);
      const s2 = v.pos.s + v.pos.dir * (d + 8);
      if (s1 < 0 || s2 < 0 || s1 > road.length || s2 > road.length) continue;
      const a = sampleRoad(road, s1);
      const b = sampleRoad(road, s2);
      const cross = Math.abs(a.dx * b.dz - a.dz * b.dx);
      const k = Math.asin(Math.min(1, cross)) / 16;
      if (k < 1e-4) continue;
      const vc = Math.sqrt(2.5 / k);
      lim = Math.min(lim, Math.sqrt(vc * vc + 2 * 2 * Math.max(0, d - 12)));
    }
    return Math.max(5, lim);
  }

  /** 進む向きで前にいる相手と隙間。世界座標で見るので、道路をまたいでも働く */
  private leader(v: Vehicle, rider: Rider | null): { gap: number; speed: number; bike: boolean; id: number; lat: number; width: number; length: number; cross: boolean } {
    let best = { gap: Infinity, speed: 0, bike: false, id: 0, lat: 0, width: 0, length: 0, cross: false };
    const ignoreCross = this.t < v.ignoreCrossUntil;
    const look = 90;
    const consider = (id: number, x: number, z: number, hx: number, hz: number, speed: number, len: number, wid: number, bike: boolean) => {
      const rx = x - v.x;
      const rz = z - v.z;
      const lon = rx * v.dx + rz * v.dz;
      if (lon <= 0 || lon > look) return;
      const lat = -rx * v.dz + rz * v.dx;
      const same = hx * v.dx + hz * v.dz;
      if (same <= 0.3 && ignoreCross && !bike) return;
      const margin = same > 0.3 ? 0.3 : 0.12;
      if (Math.abs(lat) > (v.width + wid) / 2 + margin) return;
      // 追い越し中の相手は、横に十分離れたら前の相手として見ない
      const gap = lon - (v.length + len) / 2;
      const sp = same > 0.3 ? speed * same : 0;
      if (gap < best.gap) best = { gap, speed: sp, bike, id, lat, width: wid, length: len, cross: same <= 0.3 };
    };
    for (const o of this.vehicles) if (o !== v) consider(o.id, o.x, o.z, o.dx, o.dz, o.speed, o.length, o.width, false);
    if (rider) consider(-1, rider.x, rider.z, rider.dx, rider.dz, rider.speed, BIKE_LENGTH, BIKE_WIDTH, true);
    return best;
  }

  /** 対向車が前 dist m 以内にいるか（道路の幅の中） */
  private oncomingNear(v: Vehicle, dist: number): boolean {
    for (const o of this.vehicles) {
      if (o === v) continue;
      if (o.dx * v.dx + o.dz * v.dz > -0.3) continue;
      const rx = o.x - v.x;
      const rz = o.z - v.z;
      const lon = rx * v.dx + rz * v.dz;
      const lat = -rx * v.dz + rz * v.dx;
      if (lon > -5 && lon < dist && Math.abs(lat) < 8) return true;
    }
    return false;
  }

  private considerPassing(v: Vehicle, road: Road, lead: ReturnType<Traffic["leader"]>, rider: Rider | null) {
    if (v.turn || v.busStop) {
      v.passing = null;
      return;
    }
    if (v.passing) {
      // 相手を抜いたら戻る。相手を見失った・対向車が来た時も戻る
      const t = v.passing.target === -1 ? rider : this.vehicles.find((o) => o.id === v.passing!.target);
      if (!t) {
        v.passing = null;
        return;
      }
      const rel = (t.x - v.x) * v.dx + (t.z - v.z) * v.dz;
      const tl = v.passing.target === -1 ? BIKE_LENGTH : (t as Vehicle).length;
      if (rel < -(v.length + tl) / 2 - 7) v.passing = null;
      // 対向車が来たらやめる。ただし相手の横に並びかけていたら抜き切る（並んだまま車線へ戻ると相手に重なる）
      else if (rel > (v.length + tl) / 2 + 3 && this.oncomingNear(v, 60 + v.speed * 3)) v.passing = null;
      return;
    }
    if (lead.gap === Infinity || lead.gap > 45) return;
    const vmax = this.speedLimit(v, road);
    if (lead.speed > vmax - 2.5) return;
    if (v.plan && !v.plan.dead && v.plan.entryS !== null && Math.abs(v.plan.entryS - v.pos.s) < 120) return;
    if (v.plan && Math.abs(v.plan.s - v.pos.s) < 60) return;
    // 横の位置: 相手の右端から間隔を空ける
    const hw = road.width / 2;
    const clearance = lead.bike ? BIKE_CLEARANCE : 1.0;
    const want = v.offset + lead.lat + lead.width / 2 + clearance + v.width / 2;
    const maxOff = hw - v.width / 2 - 0.15;
    // 狭い道で長く待たされた時だけ、間隔を 1.1m まで詰める
    const got = Math.min(want, maxOff) - (v.offset + lead.lat + lead.width / 2 + v.width / 2);
    const minClear = lead.bike && v.followT > 20 ? 1.1 : clearance;
    if (got < minClear - 1e-3) return;
    // 追い越しにかかる時間だけ、対向車線と先の道が空いているか
    const vPass = Math.min(vmax + 2, lead.speed + 7);
    const dist = lead.gap + v.length + lead.length + 12;
    const time = dist / Math.max(2, vPass - lead.speed);
    const need = vPass * time + 20;
    if (this.oncomingNear(v, need + vmax * time)) return;
    if (!this.straightAhead(v, road, need)) return;
    v.passing = { target: lead.id, offset: Math.min(want, maxOff) };
    this.stats.passes++;
  }

  /** 先の need m が見通しのよい直線に近いか（向きの変化 0.3 rad 未満、道路の端まで続く） */
  private straightAhead(v: Vehicle, road: Road, need: number): boolean {
    const end = v.pos.s + v.pos.dir * need;
    if (end < 0 || end > road.length) return false;
    const a = sampleRoad(road, v.pos.s);
    for (const f of [0.5, 1]) {
      const b = sampleRoad(road, v.pos.s + v.pos.dir * need * f);
      if (a.dx * b.dx + a.dz * b.dz < 0.955) return false;
    }
    return true;
  }

  // ---- 接続点 ----

  private nextJunction(v: Vehicle): { junction: Junction; s: number } | null {
    const list = this.net.junctionsOn(v.pos.road);
    if (v.pos.dir > 0) {
      for (const j of list) if (j.s > v.pos.s + 1e-6) return j;
    } else {
      for (let i = list.length - 1; i >= 0; i--) if (list[i].s < v.pos.s - 1e-6) return list[i];
    }
    return null;
  }

  /** 次の接続点での動きを決める（見えてから 1 回だけ） */
  private planJunction(v: Vehicle, road: Road) {
    if (v.plan && this.net.junctions.has(v.plan.junction)) return;
    const next = this.nextJunction(v);
    if (!next) {
      const endS = v.pos.dir > 0 ? road.length : 0;
      v.plan = { junction: "", s: endS, entryS: null, to: null, offOut: 0, yieldFirst: false, cleared: true, dead: true };
      return;
    }
    if (Math.abs(next.s - v.pos.s) > 220) {
      v.plan = null;
      return;
    }
    const j = next.junction;
    const arms = j.arms.filter((a) => {
      const r = this.net.roads.get(a.road);
      if (!r || this.densityOf(r) <= 0) return false;
      // 来た道へ戻る腕は除く
      if (a.road === road.id && a.dir === -v.pos.dir && Math.abs(a.s - next.s) < 0.5) return false;
      return true;
    });
    if (!arms.length) {
      v.plan = { junction: j.id, s: next.s, entryS: null, to: null, offOut: 0, yieldFirst: false, cleared: true, dead: true };
      return;
    }
    // 出る腕を選ぶ: 等級の高い道へ行きやすく、同じ道路をそのまま進みやすい
    const here = sampleRoad(road, next.s);
    const hx = here.dx * v.pos.dir;
    const hz = here.dz * v.pos.dir;
    const weighted: [(typeof arms)[number], number][] = arms.map((a) => {
      const r = this.net.roads.get(a.road)!;
      const p = sampleRoad(r, Math.max(0, Math.min(r.length, a.s + a.dir * 15)));
      const q = sampleRoad(r, a.s);
      const l = Math.hypot(p.x - q.x, p.z - q.z) || 1;
      const dot = ((p.x - q.x) * hx + (p.z - q.z) * hz) / l;
      const cls = [1, 0.6, 0.25, 0.04][r.cls] ?? 0.01;
      const same = a.road === road.id ? 2.5 : 1;
      return [a, cls * same * (0.4 + 0.6 * Math.max(0, dot))];
    });
    const arm = pickWeighted(weighted, this.rand());
    // 従道路: 今の道より等級の高い道路が接続点にある
    const others = j.arms.filter((a) => a.road !== road.id).map((a) => this.net.roads.get(a.road)?.cls ?? 9);
    const yieldFirst = arm.road !== road.id && others.length > 0 && Math.min(...others) < road.cls;
    if (arm.road === road.id && arm.dir === v.pos.dir) {
      v.plan = { junction: j.id, s: next.s, entryS: null, to: null, offOut: v.offset, yieldFirst: false, cleared: true, dead: false };
      return;
    }
    const shape = junctionShape(this.net, j);
    const inArm = shape.arms.find((a) => a.arm.road === road.id && a.arm.dir === -v.pos.dir && Math.abs(a.arm.s - next.s) < 0.5);
    const outArm = shape.arms.find((a) => a.arm.road === arm.road && a.arm.dir === arm.dir && Math.abs(a.arm.s - arm.s) < 0.5);
    const out = this.net.roads.get(arm.road)!;
    if (!inArm || !outArm) {
      v.plan = { junction: j.id, s: next.s, entryS: null, to: { road: arm.road, s: arm.s, dir: arm.dir }, offOut: this.laneOffset(out, v.width), yieldFirst, cleared: !yieldFirst, dead: false };
      return;
    }
    // もう口を過ぎていたら（出したばかりの車など）、そのまま進む
    const entryS = inArm.mouthS;
    if ((entryS - v.pos.s) * v.pos.dir < 0) {
      v.plan = { junction: j.id, s: next.s, entryS: null, to: { road: arm.road, s: arm.s, dir: arm.dir }, offOut: this.laneOffset(out, v.width), yieldFirst: false, cleared: true, dead: false };
      return;
    }
    v.plan = {
      junction: j.id,
      s: next.s,
      entryS,
      to: { road: out.id, s: outArm.mouthS, dir: arm.dir },
      offOut: this.laneOffset(out, v.width),
      yieldFirst,
      cleared: !yieldFirst,
      dead: false,
    };
  }

  /** 接続点に近づく相手がいないか（止まって待っている車は数えない） */
  private junctionClear(v: Vehicle, plan: JunctionPlan, rider: Rider | null): boolean {
    const j = this.net.junctions.get(plan.junction);
    if (!j) return true;
    for (const o of this.vehicles) {
      if (o === v || o.speed < 0.8) continue;
      const rx = j.x - o.x;
      const rz = j.z - o.z;
      const d = Math.hypot(rx, rz);
      if (d < 55 && (rx * o.dx + rz * o.dz) / (d || 1) > -0.2) return false;
    }
    if (rider) {
      const d = Math.hypot(j.x - rider.x, j.z - rider.z);
      if (d < 35 && rider.speed > 0.5) return false;
    }
    return true;
  }

  /** 道のりを進める。曲がる線・接続点・道路の端の処理 */
  private advance(v: Vehicle, ds: number) {
    let left = ds;
    for (let guard = 0; guard < 6 && left > 1e-6; guard++) {
      if (v.turn) {
        const t = v.turn;
        const r = t.length - t.d;
        if (left < r) {
          t.d += left;
          return;
        }
        left -= r;
        v.pos = { ...t.to };
        v.offset = v.plan?.offOut ?? v.offset;
        v.turn = null;
        v.plan = null;
        v.waitT = 0;
        continue;
      }
      const road = this.net.roads.get(v.pos.road);
      if (!road) return;
      const plan = v.plan;
      let end = v.pos.dir > 0 ? road.length : 0;
      if (plan && !plan.dead) end = plan.entryS ?? plan.s;
      if (plan?.dead) end = plan.s;
      const remain = (end - v.pos.s) * v.pos.dir;
      if (left < remain || !plan) {
        v.pos.s += Math.min(left, Math.max(0, remain)) * v.pos.dir;
        if (!plan) v.pos.s = Math.max(0, Math.min(road.length, v.pos.s));
        return;
      }
      v.pos.s = end;
      left -= Math.max(0, remain);
      if (plan.dead) {
        v.speed = 0;
        return;
      }
      if (plan.yieldFirst && !plan.cleared) {
        v.speed = 0;
        return;
      }
      if (plan.entryS === null) {
        if (plan.to) {
          // 曲がる形が作れなかった: そのまま次の道路へ
          v.pos = { ...plan.to };
          v.offset = plan.offOut;
        } else {
          // 直進: 接続点を過ぎる
          v.pos.s = plan.s + v.pos.dir * 0.01;
        }
        v.plan = null;
        continue;
      }
      // 曲がり始める
      const out = this.net.roads.get(plan.to!.road);
      if (!out) return;
      const a = sampleRoad(road, v.pos.s);
      const dx = a.dx * v.pos.dir;
      const dz = a.dz * v.pos.dir;
      const p0 = { x: a.x - dz * v.offset, y: a.y, z: a.z + dx * v.offset };
      const b = sampleRoad(out, plan.to!.s);
      const ex = b.dx * plan.to!.dir;
      const ez = b.dz * plan.to!.dir;
      const p1 = { x: b.x - ez * plan.offOut, y: b.y, z: b.z + ex * plan.offOut };
      const chord = Math.hypot(p1.x - p0.x, p1.z - p0.z);
      const pts = cornerCurve(p0, dx, dz, p1, ex, ez, Math.max(4, Math.ceil(chord / 1.5)));
      const acc = [0];
      for (let i = 1; i < pts.length; i++) acc.push(acc[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z));
      v.turn = { pts, acc, length: acc[acc.length - 1], d: 0, to: { ...plan.to! } };
      v.passing = null;
    }
  }

  // ---- バス ----

  /** バス停で止まる: 止まる所までの距離。止まっている間は 0 */
  private busStopDistance(v: Vehicle, road: Road): number {
    if (v.busStop) {
      if (this.t > v.busStop.until) {
        v.servedStop = v.busStop.id;
        v.busStop = null;
        return Infinity;
      }
      return 0;
    }
    for (const st of this.stopsOn(road)) {
      if (st.side !== -v.pos.dir || st.id === v.servedStop) continue;
      const d = (st.s - v.pos.s) * v.pos.dir;
      if (d < -2 || d > 90) continue;
      // 半分ほどは客がいなくて止まらない
      const h = Math.floor(st.s * 7 + v.id * 977) % 100;
      if (h < 45) continue;
      if (d < 1.5 && v.speed < 0.4) {
        // 乗り降りの時間【初期値】
        v.busStop = { id: st.id, until: this.t + 8 + (h % 10) };
        this.stats.busStops++;
        return 0;
      }
      return Math.max(0, d);
    }
    return Infinity;
  }

  // ---- 確かめる ----

  private countOverlaps(rider: Rider | null) {
    if (!rider) return;
    for (const v of this.vehicles) {
      const rx = rider.x - v.x;
      const rz = rider.z - v.z;
      const lon = rx * v.dx + rz * v.dz;
      const lat = -rx * v.dz + rz * v.dx;
      const hit = Math.abs(lon) < (v.length + BIKE_LENGTH) / 2 && Math.abs(lat) < (v.width + BIKE_WIDTH) / 2;
      if (hit && !this.overlapping.has(v.id)) {
        this.overlapping.add(v.id);
        this.stats.overlaps++;
      } else if (!hit) this.overlapping.delete(v.id);
    }
  }
}
