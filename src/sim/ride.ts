// 道路網の上を走る（モック仕様 6.2・6.3）。状態は 道路・道のり・向き・左右位置・速度。
// - 左側通行。既定の左右位置は左車線の中央
// - カーブの手前で自動的に減速する（先の曲率から上限速度を求め、間に合うように制動する）
// - 接続点の 150m 手前から進路の候補を出す。選ばなければいちばん直進に近い道
// - 行き止まりでは自動で折り返す。停止中は U ターンできる
// - 別の道路へ曲がる時は、接続点の口から口まで、左側の車線から左側の車線へ曲線で走る
// 描画に依存しない。

import type { Junction, JunctionArm, Road } from "../shared/world/types.ts";
import { type BikeParams, CRR, DEFAULT_BIKE, DT, integrateSpeed } from "./bicycle.ts";
import { cornerCurve, junctionShape, type Vec3 } from "./junction-shape.ts";
import type { PowerSource } from "./power.ts";
import { RIDDEN_BIN, RiddenLog } from "./ridden.ts";
import { type RoadNetwork, type RoadPosition, roadSpacing, sampleRoad } from "./road-network.ts";
import { planRoute, type RoutePlan, type RouteStyle } from "./route-plan.ts";

/** カーブで許す横加速度 (m/s²)【初期値】 */
export const LATERAL_ACCEL = 4;
/** カーブ手前の減速に使う減速度 (m/s²) */
export const CURVE_DECEL = 2.5;
/** 冒険の距離が尽きる所の手前で止まる減速度 (m/s²) と、止まる所の余り (m)、先を見る道のり (m) */
const ADVENTURE_DECEL = 2.5;
const EDGE_MARGIN = 0.5;
const EDGE_LOOK = 120;
/** 進路の候補を出し始める距離 (m) */
export const CHOICE_DISTANCE = 150;
/** 先読みする距離 (m) */
const LOOKAHEAD = 140;

export interface Choice {
  arm: JunctionArm;
  /** 進行方向に対する角度（ラジアン、右が正） */
  angle: number;
  destination: string;
  /** その道路の先の端までの距離 (m) */
  distance: number;
  /** 同じ道路をそのまま進む */
  straightOn: boolean;
}

export interface Upcoming {
  junction: Junction;
  /** 接続点までの距離 (m) */
  distance: number;
  /** 接続点がある道路上の位置 */
  s: number;
  choices: Choice[];
  /** 選ばなかった時に進む候補 */
  defaultIndex: number;
  /** 選んだ候補（選んでいなければ null） */
  selected: number | null;
  /** 経路に沿って自動で選んだ */
  byPlan?: boolean;
}

/** 接続点を曲がる途中の線 */
interface Turn {
  junction: string;
  pts: Vec3[];
  /** 各点までの距離 */
  acc: number[];
  /** 両端の向き（入る道路・出る道路の向き） */
  d0: [number, number];
  d1: [number, number];
  length: number;
  /** 進んだ距離 */
  d: number;
  /** 曲がり終えた所（出る腕の口） */
  to: RoadPosition;
}

/** 曲がる線の計画（状態を変えない） */
interface TurnPlan {
  /** 入る道路で曲がり始める道のり */
  entryS: number;
  to: RoadPosition;
  offOut: number;
}

/** ペースの速さまで前へ押す力 (N) と、弱め始める速さの差 (m/s)【初期値】（配達の草案 26 章）。平らな道で 0→36km/h が約 10 秒 */
export const CRUISE_FORCE = 110;
const CRUISE_TAPER = 1.5;

export class Ride {
  pos: RoadPosition;
  speed = 0;
  /** 進行方向に対する左右位置 (m、右が正)。道路の中心から */
  offset = 0;
  /** 利用者が動かした左右位置の量 (m) */
  laneShift = 0;
  watts = 0;
  /** 推進に使う出力の倍率（ペースの補助。配達の草案 26 章）。watts は漕いだ出力のまま */
  assist = 1;
  /** ペースの速さ (m/s)。漕いでいて、これより遅い間は前へ押す力を足す。0 なら足さない（配達の草案 26 章） */
  cruise = 0;
  brake = 0;
  autoBrake = 0;
  grade = 0;
  odometer = 0;
  climb = 0;
  time = 0;
  upcoming: Upcoming | null = null;
  /** 行き止まりで折り返した回数（確認用） */
  uTurns = 0;
  bike: BikeParams = { ...DEFAULT_BIKE };
  /** 行き先と、そこまでの経路（モック仕様 6.3） */
  goal: { x: number; z: number } | null = null;
  plan: RoutePlan | null = null;
  /** 経路の引き方（配達の草案 14.1） */
  routeStyle: RouteStyle = "short";
  goalReached = false;
  private replanT = 0;
  private replanAfterJunction = false;
  private lastY = NaN;
  private curveT = 0;
  private curveLimit = Infinity;
  /** 接続点を曲がっている途中なら、その線（pos は曲がり終える所） */
  turn: Turn | null = null;
  /** 走った道路の区間 */
  ridden = new RiddenLog();
  /** 冒険の乗り方（冒険の草案 2.2）: 未走行の道を進む時に使う距離。null なら制限しない（自由・トレーナー） */
  adventure: { readonly balance: number; spend(d: number): void } | null = null;
  /** 冒険の距離が無く、未走行の区間の手前で止まっている */
  blocked = false;

  constructor(
    private net: RoadNetwork,
    start: RoadPosition,
    public power: PowerSource,
  ) {
    this.pos = { ...start };
    this.offset = this.defaultOffset();
  }

  get road(): Road | undefined {
    return this.net.roads.get(this.pos.road);
  }

  /** 左車線の中央（利用者のずらしを含む） */
  defaultOffset(): number {
    const r = this.road;
    if (!r) return 0;
    const hw = r.width / 2;
    return Math.max(-hw + 0.5, Math.min(hw - 0.5, -r.width / 4 + this.laneShift));
  }

  shiftLane(delta: number) {
    const r = this.road;
    const lim = r ? r.width / 2 : 3;
    this.laneShift = Math.max(-lim, Math.min(lim, this.laneShift + delta));
  }

  /** 候補を選ぶ（候補の番号） */
  choose(index: number) {
    if (this.upcoming && index >= 0 && index < this.upcoming.choices.length) {
      this.upcoming.selected = index;
      this.upcoming.byPlan = false;
    }
  }

  /** 角度の向き（−1 左、0 直進、1 右）に近い候補を選ぶ */
  chooseDirection(dir: -1 | 0 | 1) {
    const u = this.upcoming;
    if (!u) return;
    let best = -1;
    let bestScore = -Infinity;
    u.choices.forEach((c, i) => {
      const target = dir * (Math.PI / 2);
      const score = -Math.abs(c.angle - target);
      if (score > bestScore) {
        bestScore = score;
        best = i;
      }
    });
    if (best >= 0) {
      u.selected = best;
      u.byPlan = false;
    }
  }

  /** 行き先を指定する（null で解除）。分岐は経路に沿って自動で選ぶ */
  setGoal(x: number, z: number): boolean;
  setGoal(goal: null): boolean;
  setGoal(x: number | null, z?: number): boolean {
    this.goalReached = false;
    if (x === null) {
      this.goal = null;
      this.plan = null;
      return true;
    }
    this.goal = { x, z: z! };
    this.replan();
    return this.plan !== null;
  }

  private replan() {
    this.replanT = 30;
    this.plan = this.goal ? planRoute(this.net, this.pos, this.goal.x, this.goal.z, this.routeStyle) : null;
    if (this.upcoming && this.upcoming.selected !== null && this.upcoming.byPlan) this.upcoming.selected = null;
    this.applyPlan();
  }

  /** 近づいた接続点で、経路の腕を選んだ状態にする */
  private applyPlan() {
    const u = this.upcoming;
    const step = this.plan?.steps[0];
    if (!u || !step || step.junction !== u.junction.id || (u.selected !== null && !u.byPlan)) return;
    const i = u.choices.findIndex((c) => c.arm.road === step.arm.road && c.arm.dir === step.arm.dir && Math.abs(c.arm.s - step.arm.s) < 0.5);
    if (i >= 0) {
      u.selected = i;
      u.byPlan = true;
    }
  }

  /** 停止中の U ターン */
  uTurn(): boolean {
    if (this.speed > 0.5 || this.turn) return false;
    this.pos.dir = (-this.pos.dir) as 1 | -1;
    this.upcoming = null;
    this.uTurns++;
    if (this.goal) this.replan();
    return true;
  }

  /**
   * 推進に使う出力 (W)。漕いだ出力 × 補助の倍率。ペースの速さより遅い間は、少なくとも CRUISE_FORCE の力になるようにする
   * （速さとの差が CRUISE_TAPER より小さくなると弱める。上りでは坂の分を引くので、上りの速さは倍率だけの時と同じ）
   */
  private propulsionWatts(): number {
    const w = this.watts * this.assist;
    if (this.cruise <= 0 || this.watts <= 0 || this.speed >= this.cruise) return w;
    const k = Math.min(1, (this.cruise - this.speed) / CRUISE_TAPER);
    const climb = this.bike.mass * 9.80665 * Math.max(0, this.grade);
    const force = Math.max(0, CRUISE_FORCE - climb) * k;
    return Math.max(w, force * Math.max(0.5, this.speed));
  }

  /** 1歩進める（DT 秒）。道路が読み込まれていなければ止まって待つ */
  step(dt = DT) {
    const road = this.road;
    if (!road) {
      this.speed = 0;
      return;
    }
    const { watts, brake } = this.power.read(dt);
    const here = sampleRoad(road, this.pos.s);
    this.grade = this.turn ? this.turnGrade() : here.grade * this.pos.dir;
    this.bike.crr = CRR[road.surface];
    // カーブの上限速度は 1/20 秒ごとに求める
    this.curveT -= dt;
    if (this.curveT <= 0) {
      this.curveT = 0.05;
      this.curveLimit = this.curveSpeedLimit();
    }
    // 冒険の距離が足りない時は、未走行の区間の手前で止まれるように減速する（冒険の草案 2.1）
    const edge = this.adventureEdge();
    const limit = edge < Infinity ? Math.min(this.curveLimit, Math.sqrt(2 * ADVENTURE_DECEL * Math.max(0, edge - EDGE_MARGIN))) : this.curveLimit;
    this.autoBrake = this.speed > limit ? Math.min(1, (this.speed - limit) * 0.6 + 0.15) : 0;
    this.brake = Math.max(brake, this.autoBrake);
    this.watts = this.autoBrake > 0 ? 0 : watts;
    const r = integrateSpeed(this.speed, this.grade, this.brake, this.propulsionWatts(), dt, this.bike);
    let dist = r.distance;
    this.speed = r.speed;
    if (edge < Infinity && dist >= edge - EDGE_MARGIN) {
      dist = Math.max(0, edge - EDGE_MARGIN);
      this.speed = 0;
    }
    this.blocked = edge < Infinity && edge - EDGE_MARGIN < 0.05;
    this.advance(dist);
    this.time += dt;
    // 冒険の距離は、未走行の 10m の区切りに入った時に 1 区切り分を使う
    if (dist > 0 && this.ridden.mark(this.pos.road, this.pos.s) && this.adventure) this.adventure.spend(RIDDEN_BIN);
    // 左右位置はなめらかに目標へ
    const target = this.defaultOffset();
    this.offset += (target - this.offset) * Math.min(1, dt * 1.5);
    const y = this.turn ? this.turnPoint(this.turn.d).y : sampleRoad(this.road!, this.pos.s).y;
    if (!Number.isNaN(this.lastY) && y > this.lastY) this.climb += y - this.lastY;
    this.lastY = y;
    if (this.replanAfterJunction) {
      this.replanAfterJunction = false;
      this.replan();
    }
    if (this.goal) {
      // 読み込んだ道路が増えるので、ときどき引き直す
      this.replanT -= dt;
      if (this.replanT <= 0) this.replan();
      if (this.plan && this.pos.road === this.plan.goal.road && Math.abs(this.pos.s - this.plan.goal.s) < 15) {
        this.goal = null;
        this.plan = null;
        this.goalReached = true;
      }
    }
    this.updateUpcoming();
    this.applyPlan();
  }

  /**
   * 冒険の距離で進める所までの道のり (m)。今の道路の先を 10m の区切りごとに見て、未走行の区切りに入るたびに 1 区切り分（10m）を残りから引く。
   * 残りが 1 区切りに足りない未走行の区切りの手前までを返す。
   * 残りが十分ある・冒険でない・接続点を曲がっている間は Infinity（曲がり終えた先の道路でまた見る）
   */
  adventureEdge(): number {
    const adv = this.adventure;
    if (!adv || this.turn || adv.balance > EDGE_LOOK) return Infinity;
    const road = this.road;
    if (!road) return Infinity;
    const dir = this.pos.dir;
    let s = this.pos.s;
    let left = adv.balance;
    let dist = 0;
    while (dist < EDGE_LOOK) {
      // この区切りの終わり（進む向き）
      let end = dir > 0 ? (Math.floor(s / RIDDEN_BIN) + 1) * RIDDEN_BIN : (Math.ceil(s / RIDDEN_BIN) - 1) * RIDDEN_BIN;
      end = Math.max(0, Math.min(road.length, end));
      const len = Math.abs(end - s);
      if (len < 1e-9) return Infinity; // 道路の端（その先は接続点を越えた道路で見る）
      const mid = (s + end) / 2;
      if (!this.ridden.has(road.id, mid)) {
        if (left < RIDDEN_BIN) return dist;
        left -= RIDDEN_BIN;
      }
      dist += len;
      s = end;
    }
    return Infinity;
  }

  /** ds だけ道路網を進む */
  private advance(ds: number) {
    let left = ds;
    for (let guard = 0; left > 1e-9 && guard < 16; guard++) {
      const t = this.turn;
      if (t) {
        const rest = t.length - t.d;
        if (rest > left) {
          t.d += left;
          this.odometer += left;
          return;
        }
        this.odometer += rest;
        left -= rest;
        this.turn = null;
        continue;
      }
      const road = this.road;
      if (!road) return;
      const next = this.nextJunction(road);
      // 別の道路へ曲がるなら、入る腕の口で曲がり始める
      const plan = next && (next.s - this.pos.s) * this.pos.dir < 40 ? this.turnPlanAt(next.junction, next.s) : null;
      const end = plan ? plan.entryS : next ? next.s : this.pos.dir > 0 ? road.length : 0;
      const remain = (end - this.pos.s) * this.pos.dir;
      if (remain > left) {
        this.pos.s += left * this.pos.dir;
        this.odometer += left;
        return;
      }
      if (remain > 0) {
        this.pos.s = end;
        this.odometer += remain;
        left -= remain;
      }
      if (!next) {
        // 接続点が読み込まれていない道路の端: 止まって待つ
        this.speed = 0;
        return;
      }
      if (plan) this.startTurn(next.junction, next.s, plan);
      else {
        this.pos.s = next.s;
        this.passJunction(next.junction, next.s);
      }
    }
  }

  /** 接続点 j で選んでいる（選んでいなければ既定の）候補 */
  private pickAt(j: Junction, s: number): Choice | undefined {
    const u = this.upcoming && this.upcoming.junction.id === j.id ? this.upcoming : null;
    if (u) return u.choices[u.selected ?? u.defaultIndex];
    const c = this.choicesAt(j, s);
    return c.choices[c.defaultIndex];
  }

  /** 接続点 j（今の道路の道のり s）で別の道路・向きへ曲がるなら、曲がり始める所と曲がり終える所 */
  private turnPlanAt(j: Junction, s: number, pick = this.pickAt(j, s)): TurnPlan | null {
    if (!pick) return null;
    const road = this.road!;
    if (pick.arm.road === road.id && pick.arm.dir === this.pos.dir) return null;
    const shape = junctionShape(this.net, j);
    const inArm = shape.arms.find((a) => a.arm.road === road.id && a.arm.dir === -this.pos.dir && Math.abs(a.arm.s - s) < 0.5);
    const outArm = shape.arms.find((a) => a.arm.road === pick.arm.road && a.arm.dir === pick.arm.dir && Math.abs(a.arm.s - pick.arm.s) < 0.5);
    if (!inArm || !outArm) return null;
    const out = this.net.roads.get(pick.arm.road)!;
    const hw = out.width / 2;
    const offOut = Math.max(-hw + 0.5, Math.min(hw - 0.5, -out.width / 4 + this.laneShift));
    return { entryS: inArm.mouthS, to: { road: out.id, s: outArm.mouthS, dir: pick.arm.dir }, offOut };
  }

  /** 曲がる線: 入る道路の fromS（左右位置 offIn）から、出る腕の口の車線へ */
  private turnLine(plan: TurnPlan, fromS: number, offIn: number): { pts: Vec3[]; acc: number[]; d0: [number, number]; d1: [number, number] } {
    const road = this.road!;
    const a = sampleRoad(road, fromS);
    const dx = a.dx * this.pos.dir;
    const dz = a.dz * this.pos.dir;
    const p0 = { x: a.x - dz * offIn, y: a.y, z: a.z + dx * offIn };
    const out = this.net.roads.get(plan.to.road)!;
    const b = sampleRoad(out, plan.to.s);
    const ex = b.dx * plan.to.dir;
    const ez = b.dz * plan.to.dir;
    const p1 = { x: b.x - ez * plan.offOut, y: b.y, z: b.z + ex * plan.offOut };
    const chord = Math.sqrt((p1.x - p0.x) ** 2 + (p1.z - p0.z) ** 2);
    const pts = cornerCurve(p0, dx, dz, p1, ex, ez, Math.max(4, Math.ceil(chord / 1.5)));
    const acc = [0];
    for (let i = 1; i < pts.length; i++) acc.push(acc[i - 1] + Math.sqrt((pts[i].x - pts[i - 1].x) ** 2 + (pts[i].z - pts[i - 1].z) ** 2));
    return { pts, acc, d0: [dx, dz], d1: [ex, ez] };
  }

  private startTurn(j: Junction, s: number, plan: TurnPlan) {
    const line = this.turnLine(plan, this.pos.s, this.offset);
    // 接続点を通った扱い（経路の段を進める、候補を消す）は曲がり始めた時にする
    this.passJunction(j, s, true);
    this.pos = { ...plan.to };
    this.offset = plan.offOut;
    const length = line.acc[line.acc.length - 1];
    this.turn = length > 0.05 ? { junction: j.id, pts: line.pts, acc: line.acc, d0: line.d0, d1: line.d1, length, d: 0, to: plan.to } : null;
  }

  /** 曲がる線の上で距離 d の点と向き */
  private turnPoint(d: number): Vec3 & { dx: number; dz: number } {
    const t = this.turn!;
    let i = 1;
    while (i < t.pts.length - 1 && t.acc[i] < d) i++;
    const a = t.pts[i - 1];
    const b = t.pts[i];
    const seg = t.acc[i] - t.acc[i - 1] || 1;
    const f = Math.max(0, Math.min(1, (d - t.acc[i - 1]) / seg));
    // 向きは点ごとの向き（前後の点の差）の間を補間する
    const dirAt = (k: number) => {
      if (k <= 0) return t.d0;
      if (k >= t.pts.length - 1) return t.d1;
      const p = t.pts[Math.max(0, k - 1)];
      const q = t.pts[Math.min(t.pts.length - 1, k + 1)];
      const x = q.x - p.x;
      const z = q.z - p.z;
      const l = Math.sqrt(x * x + z * z) || 1;
      return [x / l, z / l];
    };
    const da = dirAt(i - 1);
    const db = dirAt(i);
    let dx = da[0] + (db[0] - da[0]) * f;
    let dz = da[1] + (db[1] - da[1]) * f;
    const l = Math.sqrt(dx * dx + dz * dz) || 1;
    dx /= l;
    dz /= l;
    return { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f, z: a.z + (b.z - a.z) * f, dx, dz };
  }

  private turnGrade(): number {
    const t = this.turn!;
    const a = this.turnPoint(Math.max(0, t.d - 1));
    const b = this.turnPoint(Math.min(t.length, t.d + 1));
    const h = Math.sqrt((b.x - a.x) ** 2 + (b.z - a.z) ** 2);
    return h > 0.01 ? (b.y - a.y) / h : 0;
  }

  /** 進む向きで次にある接続点（今いる位置ちょうどのものは除く） */
  private nextJunction(road: Road): { junction: Junction; s: number } | null {
    const list = this.net.junctionsOn(road.id);
    if (this.pos.dir > 0) {
      for (const j of list) if (j.s > this.pos.s + 1e-6) return j;
    } else {
      for (let i = list.length - 1; i >= 0; i--) if (list[i].s < this.pos.s - 1e-6) return list[i];
    }
    return null;
  }

  private choicesAt(j: Junction, s: number): { choices: Choice[]; defaultIndex: number } {
    const road = this.road!;
    const here = sampleRoad(road, s);
    const hx = here.dx * this.pos.dir;
    const hz = here.dz * this.pos.dir;
    const choices: Choice[] = [];
    for (const a of j.arms) {
      const r = this.net.roads.get(a.road);
      if (!r) continue;
      // 来た道へ戻る腕は除く
      if (a.road === road.id && Math.abs(a.s - s) < 0.5 && a.dir === -this.pos.dir) continue;
      const p0 = sampleRoad(r, a.s);
      const p1 = sampleRoad(r, Math.max(0, Math.min(r.length, a.s + a.dir * 20)));
      let ax = p1.x - p0.x;
      let az = p1.z - p0.z;
      const l = Math.hypot(ax, az) || 1;
      ax /= l;
      az /= l;
      const angle = Math.atan2(hx * az - hz * ax, hx * ax + hz * az);
      const dest = this.net.destinationOf(a);
      choices.push({ arm: a, angle, destination: dest.name, distance: dest.distance, straightOn: a.road === road.id && a.dir === this.pos.dir });
    }
    choices.sort((p, q) => p.angle - q.angle);
    let def = -1;
    let best = Infinity;
    choices.forEach((c, i) => {
      // 同じ道路をそのまま進むなら少し優先する
      const score = Math.abs(c.angle) - (c.straightOn ? 0.2 : 0);
      if (score < best) {
        best = score;
        def = i;
      }
    });
    return { choices, defaultIndex: def };
  }

  private passJunction(j: Junction, s: number, turning = false) {
    let u = this.upcoming;
    if (!u || u.junction.id !== j.id) {
      const c = this.choicesAt(j, s);
      u = { junction: j, distance: 0, s, choices: c.choices, defaultIndex: c.defaultIndex, selected: null };
    }
    const pick = u.choices[u.selected ?? u.defaultIndex];
    this.upcoming = null;
    // 経路: 予定どおりなら次の段へ、外れたら引き直す
    if (this.plan) {
      const st = this.plan.steps[0];
      const onPlan = st && st.junction === j.id && pick && st.arm.road === pick.arm.road && st.arm.dir === pick.arm.dir;
      if (onPlan) this.plan.steps.shift();
      else this.replanAfterJunction = true;
    }
    if (!pick) {
      // 行き止まり: 折り返す
      this.pos.dir = (-this.pos.dir) as 1 | -1;
      this.speed = Math.min(this.speed, 2);
      this.uTurns++;
      return;
    }
    if (!turning && (pick.arm.road !== this.pos.road || pick.arm.dir !== this.pos.dir)) {
      this.pos = { road: pick.arm.road, s: pick.arm.s, dir: pick.arm.dir };
    }
  }

  private updateUpcoming() {
    const road = this.road;
    if (!road) return;
    const next = this.nextJunction(road);
    if (!next) {
      this.upcoming = null;
      return;
    }
    const d = (next.s - this.pos.s) * this.pos.dir;
    if (d > CHOICE_DISTANCE) {
      if (this.upcoming && this.upcoming.junction.id !== next.junction.id) this.upcoming = null;
      return;
    }
    if (!this.upcoming || this.upcoming.junction.id !== next.junction.id) {
      const c = this.choicesAt(next.junction, next.s);
      this.upcoming = { junction: next.junction, distance: d, s: next.s, choices: c.choices, defaultIndex: c.defaultIndex, selected: null };
    }
    this.upcoming.distance = d;
  }

  /** 先 140m の道（選んだ進路に沿う）の曲率から、今出してよい速度の上限 */
  private curveSpeedLimit(): number {
    const pts = this.pathAhead(LOOKAHEAD, 4);
    let limit = Infinity;
    for (let i = 1; i < pts.length - 1; i++) {
      const a = pts[i - 1], b = pts[i], c = pts[i + 1];
      const abx = b.x - a.x, abz = b.z - a.z, bcx = c.x - b.x, bcz = c.z - b.z;
      const cross = abx * bcz - abz * bcx;
      const la = Math.hypot(abx, abz), lb = Math.hypot(bcx, bcz), lc = Math.hypot(c.x - a.x, c.z - a.z);
      if (cross === 0 || la < 0.5 || lb < 0.5) continue;
      const R = (la * lb * lc) / (2 * Math.abs(cross));
      const vmax = Math.sqrt(LATERAL_ACCEL * R);
      // その地点までに CURVE_DECEL で落とせる速度
      const allowed = Math.sqrt(vmax * vmax + 2 * CURVE_DECEL * Math.max(0, b.d - 4));
      if (allowed < limit) limit = allowed;
    }
    return limit;
  }

  /** 進む向きの先の点の列（接続点では選んだ／既定の進路へ、曲がる線に沿って） */
  pathAhead(dist: number, step: number): { x: number; z: number; d: number }[] {
    const out: { x: number; z: number; d: number }[] = [];
    let road = this.road;
    if (!road) return out;
    let s = this.pos.s;
    let dir = this.pos.dir;
    let d = 0;
    // 道路の上の点も、曲がる線と同じく今の車線の位置で取る（中心線で取ると、曲がる線とのつなぎ目で横に跳び、
    // 急なカーブに見えて直進の交差点でも減速していた。北海道の世界は交差点ごとに道路が分かれるので、ほぼ全部の交差点で起きた）
    let off = this.offset;
    if (this.turn) {
      const t = this.turn;
      const p = this.turnPoint(t.d);
      out.push({ x: p.x, z: p.z, d: 0 });
      for (let q = 0; q < t.pts.length; q++) {
        if (t.acc[q] <= t.d) continue;
        d = t.acc[q] - t.d;
        out.push({ x: t.pts[q].x, z: t.pts[q].z, d });
      }
      if (d > dist) return out;
      d += step;
      s += dir * step;
    }
    let usedChoice = false;
    for (let guard = 0; d <= dist && guard < 200; guard++) {
      if (s < 0 || s > road.length) break;
      const p = sampleRoad(road, s);
      out.push({ x: p.x - p.dz * dir * off, z: p.z + p.dx * dir * off, d });
      let ns = s + dir * step;
      // 接続点を越える時は進路の先へ
      const u = this.upcoming;
      if (!usedChoice && u && road.id === this.pos.road && (u.s - s) * dir >= 0 && (u.s - ns) * dir < 0) {
        const pick = u.choices[u.selected ?? u.defaultIndex];
        usedChoice = true;
        const plan = pick ? this.turnPlanAt(u.junction, u.s, pick) : null;
        if (plan) {
          // 入る口から出る口までは曲がる線をたどる（口が後ろにあれば今の位置から）
          const from = (plan.entryS - this.pos.s) * dir > 0 ? plan.entryS : this.pos.s;
          const line = this.turnLine(plan, from, this.defaultOffset());
          const base = d - (s - from) * dir;
          // 入る口より先に置いた点は捨てる
          while (out.length > 1 && out[out.length - 1].d > base) out.pop();
          for (let q = 0; q < line.pts.length; q++) out.push({ x: line.pts[q].x, z: line.pts[q].z, d: base + line.acc[q] });
          road = this.net.roads.get(plan.to.road)!;
          dir = plan.to.dir;
          off = plan.offOut;
          d = base + line.acc[line.acc.length - 1] + step;
          s = plan.to.s + dir * step;
          continue;
        }
        if (pick && (pick.arm.road !== road.id || pick.arm.dir !== dir)) {
          const r2 = this.net.roads.get(pick.arm.road);
          if (r2) {
            const over = step - Math.abs(u.s - s);
            road = r2;
            dir = pick.arm.dir;
            ns = pick.arm.s + dir * over;
          }
        }
      }
      if (ns < 0 || ns > road.length) break;
      s = ns;
      d += step;
    }
    return out;
  }

  /** 今の位置（世界座標、左右位置を含む）と進行方向 */
  pose() {
    const road = this.road!;
    if (this.turn) {
      const p = this.turnPoint(this.turn.d);
      return { x: p.x, y: p.y, z: p.z, dx: p.dx, dz: p.dz, grade: this.turnGrade(), spacing: roadSpacing(road) };
    }
    const p = sampleRoad(road, this.pos.s);
    const dx = p.dx * this.pos.dir;
    const dz = p.dz * this.pos.dir;
    // 右向き = (−dz, dx)
    return { x: p.x - dz * this.offset, y: p.y, z: p.z + dx * this.offset, dx, dz, grade: p.grade * this.pos.dir, spacing: roadSpacing(road) };
  }
}
