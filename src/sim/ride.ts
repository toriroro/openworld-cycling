// 道路網の上を走る（モック仕様 6.2・6.3）。状態は 道路・道のり・向き・左右位置・速度。
// - 左側通行。既定の左右位置は左車線の中央
// - カーブの手前で自動的に減速する（先の曲率から上限速度を求め、間に合うように制動する）
// - 接続点の 150m 手前から進路の候補を出す。選ばなければいちばん直進に近い道
// - 行き止まりでは自動で折り返す。停止中は U ターンできる
// 描画に依存しない。

import type { Junction, JunctionArm, Road } from "../shared/world/types.ts";
import { type BikeParams, CRR, DEFAULT_BIKE, DT, integrateSpeed } from "./bicycle.ts";
import type { PowerSource } from "./power.ts";
import { type RoadNetwork, type RoadPosition, roadSpacing, sampleRoad } from "./road-network.ts";
import { planRoute, type RoutePlan } from "./route-plan.ts";

/** カーブで許す横加速度 (m/s²)【初期値】 */
export const LATERAL_ACCEL = 4;
/** カーブ手前の減速に使う減速度 (m/s²) */
export const CURVE_DECEL = 2.5;
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

export class Ride {
  pos: RoadPosition;
  speed = 0;
  /** 進行方向に対する左右位置 (m、右が正)。道路の中心から */
  offset = 0;
  /** 利用者が動かした左右位置の量 (m) */
  laneShift = 0;
  watts = 0;
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
  goalReached = false;
  private replanT = 0;
  private replanAfterJunction = false;
  private lastY = NaN;
  private curveT = 0;
  private curveLimit = Infinity;

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
    this.plan = this.goal ? planRoute(this.net, this.pos, this.goal.x, this.goal.z) : null;
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
    if (this.speed > 0.5) return false;
    this.pos.dir = (-this.pos.dir) as 1 | -1;
    this.upcoming = null;
    this.uTurns++;
    if (this.goal) this.replan();
    return true;
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
    this.grade = here.grade * this.pos.dir;
    this.bike.crr = CRR[road.surface];
    // カーブの上限速度は 1/20 秒ごとに求める
    this.curveT -= dt;
    if (this.curveT <= 0) {
      this.curveT = 0.05;
      this.curveLimit = this.curveSpeedLimit();
    }
    this.autoBrake = this.speed > this.curveLimit ? Math.min(1, (this.speed - this.curveLimit) * 0.6 + 0.15) : 0;
    this.brake = Math.max(brake, this.autoBrake);
    this.watts = this.autoBrake > 0 ? 0 : watts;
    const r = integrateSpeed(this.speed, this.grade, this.brake, this.watts, dt, this.bike);
    this.speed = r.speed;
    this.advance(r.distance);
    this.time += dt;
    // 左右位置はなめらかに目標へ
    const target = this.defaultOffset();
    this.offset += (target - this.offset) * Math.min(1, dt * 1.5);
    const y = sampleRoad(this.road!, this.pos.s).y;
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

  /** ds だけ道路網を進む */
  private advance(ds: number) {
    let left = ds;
    for (let guard = 0; left > 1e-9 && guard < 16; guard++) {
      const road = this.road;
      if (!road) return;
      const next = this.nextJunction(road);
      const end = next ? next.s : this.pos.dir > 0 ? road.length : 0;
      const remain = (end - this.pos.s) * this.pos.dir;
      if (remain > left) {
        this.pos.s += left * this.pos.dir;
        this.odometer += left;
        return;
      }
      this.pos.s = end;
      this.odometer += Math.max(0, remain);
      left -= Math.max(0, remain);
      if (!next) {
        // 接続点が読み込まれていない道路の端: 止まって待つ
        this.speed = 0;
        return;
      }
      this.passJunction(next.junction, next.s);
    }
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

  private passJunction(j: Junction, s: number) {
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
    if (pick.arm.road !== this.pos.road || pick.arm.dir !== this.pos.dir) {
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

  /** 進む向きの先の点の列（接続点では選んだ／既定の進路へ） */
  pathAhead(dist: number, step: number): { x: number; z: number; d: number }[] {
    const out: { x: number; z: number; d: number }[] = [];
    let road = this.road;
    if (!road) return out;
    let s = this.pos.s;
    let dir = this.pos.dir;
    let d = 0;
    let usedChoice = false;
    for (let guard = 0; d <= dist && guard < 200; guard++) {
      const p = sampleRoad(road, s);
      out.push({ x: p.x, z: p.z, d });
      let ns = s + dir * step;
      // 接続点を越える時は進路の先へ
      const u = this.upcoming;
      if (!usedChoice && u && road.id === this.pos.road && (u.s - s) * dir >= 0 && (u.s - ns) * dir < 0) {
        const pick = u.choices[u.selected ?? u.defaultIndex];
        usedChoice = true;
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
    const p = sampleRoad(road, this.pos.s);
    const dx = p.dx * this.pos.dir;
    const dz = p.dz * this.pos.dir;
    // 右向き = (−dz, dx)
    return { x: p.x - dz * this.offset, y: p.y, z: p.z + dx * this.offset, dx, dz, grade: p.grade * this.pos.dir, spacing: roadSpacing(road) };
  }
}
