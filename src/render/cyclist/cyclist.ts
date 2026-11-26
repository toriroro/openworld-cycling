// 自転車とライダーをまとめた1台分。設定（Outfit）と画質（lod）を受け、走行の状態から姿勢を付ける。
// update() は M3 の PlayerModel.update と同じ引数で、走行の状態を読むだけ。

import * as THREE from "three";
import type { Outfit } from "../../shared/outfit.ts";
import { PaletteMaterial } from "./palette.ts";
import { Rider } from "./rider.ts";
import { ankling, FIT, type Lod, RoadBike } from "./road-bike.ts";
import { Cargo, type CargoLook } from "./cargo.ts";

export interface CyclistPose {
  /** クランクの角度（左が前で 0） */
  phase: number;
  speed: number;
  watts: number;
  /** 走った距離（車輪の回転に使う） */
  distance: number;
  /** ハンドルの切れ角（右が正） */
  steer: number;
  lean: number;
  firstPerson: boolean;
  /** 曲がる向きへ頭を向ける角度（左が正） */
  headYaw?: number;
  /** 後方を見る量（-1..1、左の肩越しが正） */
  look?: number;
}

/** 後方を見る動きの長さ（秒）: 振り向く・見る・戻す */
const LOOK_IN = 0.35;
const LOOK_HOLD = 0.75;
const LOOK_OUT = 0.5;

/** 進む向きを求める区間（秒）。走行の計算の刻みと描画のずれを均す */
const HEADING_WINDOW = 0.25;
/** 向きの追従の速さ（ばねの固有角振動数、1/秒） */
const HEADING_OMEGA = 5;
/**
 * 力み（0..1）: swayFrom W で始まり、その EFFORT_FULL_RATIO 倍で最大。力むほど腰・肩・車体の左右の振れが大きくなる。
 * swayFrom は設定で変えられる（既定 300W。2026-11-17 ユーザーの指定）。
 */
export const EFFORT_FULL_RATIO = 2;

const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

export class CyclistModel {
  readonly group = new THREE.Group();
  readonly material = new PaletteMaterial();
  readonly bike = new RoadBike(this.material);
  readonly rider = new Rider(this.material);
  /** 配達鞄とリアキャリア（配達の草案 29 章） */
  readonly cargo = new Cargo();
  /** 飲む動き（0〜1。右手を口へ。配達の草案 30 章） */
  drink = 0;
  private can: THREE.Mesh;
  private outfit: Outfit;
  private lod: Lod;
  private phase = 0;
  private lean = 0;
  private steer = 0;
  /** 最近の位置（進む向きを求める） */
  private trail: { t: number; x: number; z: number }[] = [];
  private clock = 0;
  /** 滑らかにした向きと、その変わる速さ（左に曲がると正） */
  private yaw = NaN;
  private yawRate = 0;
  /** FTP（W）。力みの始まりを決める。設定ができるまでの【初期値】 */
  /** 体がぶれ始める出力 (W)。設定の「体がぶれ始める出力」 */
  swayFrom = 300;
  /** トレーナーのケイデンス (rpm)。無ければ null で、出力から決める */
  cadenceOverride: number | null = null;
  private headYaw = 0;
  private lookSide = 0;
  private lookTime = Infinity;
  /** 次に自分から後方を見るまでの秒数 */
  private nextLook = 30 + Math.random() * 40;

  constructor(outfit: Outfit, lod: Lod) {
    this.group.name = "cyclist";
    this.group.add(this.bike.group, this.rider.group);
    this.rider.group.add(this.cargo.bag);
    // 飲み物の缶（飲む動きの間だけ右手に出す）
    this.can = new THREE.Mesh(new THREE.CylinderGeometry(0.033, 0.033, 0.12, 12), new THREE.MeshStandardMaterial({ color: "#2a7fd4", roughness: 0.35, metalness: 0.6 }));
    this.can.visible = false;
    this.rider.group.add(this.can);
    this.bike.group.add(this.cargo.rack);
    this.outfit = outfit;
    this.lod = lod;
    this.rider.setLod(lod);
    this.setOutfit(outfit);
  }

  setOutfit(o: Outfit) {
    this.outfit = o;
    this.material.apply(o);
    this.bike.build(o.bike, this.lod);
    this.rider.setHelmet(o.rider.helmet);
  }

  setLod(lod: Lod) {
    if (lod === this.lod) return;
    this.lod = lod;
    this.bike.build(this.outfit.bike, lod);
    this.rider.setLod(lod);
  }

  /** 姿勢だけを付ける（位置・向きは group を呼ぶ側で置く） */
  pose(_dt: number, p: CyclistPose) {
    this.bike.update(p.distance, p.steer, p.speed, p.phase);
    const effort = this.effort(p.watts);
    // 飲む動き: 右手（hands[1]）を口の前へ。胸の付け根から立った姿勢で上へ 0.6m・前へ 0.2m を、胸の向きで回す
    const hands = [this.bike.hoodPoint(1), this.bike.hoodPoint(-1)];
    const chest = this.rider.chest;
    const q = this.rider.chestQ;
    if (this.drink > 0 && chest && q && !p.firstPerson) {
      const mouth = new THREE.Vector3(-0.06, 0.6, 0.2).applyQuaternion(q).add(chest);
      hands[1] = hands[1].clone().lerp(mouth, this.drink);
      this.can.visible = this.drink > 0.35;
      this.can.position.copy(hands[1]).add(new THREE.Vector3(0, 0.02, 0.04));
      this.can.quaternion.setFromAxisAngle(new THREE.Vector3(1, 0, 0), -1.9 * this.drink);
    } else this.can.visible = false;
    this.rider.update({
      pedals: [this.bike.pedalPoint(1, p.phase), this.bike.pedalPoint(-1, p.phase)],
      hands: hands as [THREE.Vector3, THREE.Vector3],
      drink: this.can.visible || this.drink > 0 ? this.drink : 0,
      saddle: FIT.saddle,
      effort,
      phase: p.phase,
      tuck: p.speed > 13 && p.watts === 0,
      firstPerson: p.firstPerson,
      ankles: [ankling(p.phase), ankling(p.phase + Math.PI)],
      headYaw: p.headYaw ?? 0,
      look: p.look ?? 0,
    });
    this.cargo.placeBag(this.rider.chest, this.rider.chestQ, p.firstPerson);
  }

  /** 配達鞄・リアキャリアの見た目（null で隠す） */
  setCargo(look: CargoLook | null) {
    this.cargo.set(look);
  }

  /**
   * 描画座標での位置 (x, y, z)、進行方向 (dx, dz)、勾配、速度、出力、走った距離。M3 の PlayerModel.update と同じ形。
   * firstPerson なら体を隠して腕だけにする。
   */
  update(dt: number, x: number, y: number, z: number, dx: number, dz: number, grade: number, speed: number, watts: number, distance: number, firstPerson: boolean) {
    // 進む向き: 道の向き、または最近 0.25 秒の移動の向き（車線を移る時の斜めの動きも入る）
    this.clock += dt;
    const last = this.trail[this.trail.length - 1];
    // 原点の置き直しなどの飛びがあれば履歴を捨てる
    if (last && Math.hypot(x - last.x, z - last.z) > Math.max(1, speed * (this.clock - last.t) * 3 + 0.5)) this.trail = [];
    this.trail.push({ t: this.clock, x, z });
    while (this.trail.length > 2 && this.trail[1].t < this.clock - HEADING_WINDOW) this.trail.shift();
    let target = Math.atan2(dx, dz);
    const first = this.trail[0];
    const mx = x - first.x;
    const mz = z - first.z;
    if (speed > 1.5 && Math.hypot(mx, mz) > speed * HEADING_WINDOW * 0.5) {
      const travel = Math.atan2(mx, mz);
      // 道の向きから大きく外れる時（U ターン直後など）は道の向き。左右へ寄る時の向きの変わりは半分だけ効かせる
      // （全部効かせると、寄り終わった後に車体の向きが遅れて大きく振れた。2026-11-26）
      const dev = wrap(travel - target);
      if (Math.abs(dev) < 0.5) target += dev * 0.5;
    }
    // ばねで滑らかに追う（行き過ぎない減衰）。変わる速さはばねの速度をそのまま使う
    if (Number.isNaN(this.yaw)) this.yaw = target;
    if (dt > 0) {
      const h = Math.min(dt, 0.05);
      const err = wrap(target - this.yaw);
      this.yawRate += (HEADING_OMEGA * HEADING_OMEGA * err - 2 * HEADING_OMEGA * this.yawRate) * h;
      this.yaw = wrap(this.yaw + this.yawRate * h);
    }
    const yaw = this.yaw;
    const yawRate = this.yawRate;
    // 倒し込みは曲がる速さから（横加速度 = 速度 × 向きの変わる速さ）。左に曲がる時は左（+X）へ倒す
    const targetLean = Math.max(-0.5, Math.min(0.5, Math.atan((speed * yawRate) / 9.8)));
    this.lean += (targetLean - this.lean) * Math.min(1, dt * 3);
    // ハンドルの切れ角は曲がる速さと速度から（ホイールベース約 1m）。走行中の小さな角度も見えるよう 2.5 倍
    const targetSteer = Math.max(-0.7, Math.min(0.7, -Math.atan((1.0 * yawRate) / Math.max(2, speed)) * 2.5));
    this.steer += (targetSteer - this.steer) * Math.min(1, dt * 4);
    // 漕ぐ度の小さな釣り合いの動き（遅いほど、力むほど大きい）と、もがく時の車体の振り
    const effort = this.effort(watts);
    const wobble = Math.sin(this.phase) * (watts > 0 ? 0.008 + effort * 0.04 + 0.04 / Math.max(1, speed) : 0);
    const rock = Math.sin(this.phase) * effort * 0.12;
    // 曲がる向きへ頭を向ける
    const targetHead = Math.max(-0.45, Math.min(0.45, yawRate * 0.8));
    this.headYaw += (targetHead - this.headYaw) * Math.min(1, dt * 3);
    this.group.position.set(x, y, z);
    this.group.rotation.set(0, 0, 0);
    this.group.rotateY(yaw);
    this.group.rotateX(-Math.atan(grade));
    this.group.rotateZ(-(this.lean + rock));
    // ケイデンスは出力から（漕いでいない時は止める）。トレーナーのケイデンスがあればそれを使う（トレーナー連携の草案 3.4）
    const cadence = this.cadenceOverride ?? (watts > 0 ? 75 + Math.min(1, watts / 400) * 25 : 0);
    this.phase = (this.phase + (cadence / 60) * Math.PI * 2 * dt) % (Math.PI * 2);
    // ときどき自分から後方を確認する（日本は左側通行なので右の肩越しが多い）
    if (speed > 4 && dt > 0) {
      this.nextLook -= dt;
      if (this.nextLook <= 0) {
        this.lookBack(Math.random() < 0.7 ? -1 : 1);
        this.nextLook = 40 + Math.random() * 60;
      }
    }
    this.lookTime += dt;
    this.pose(dt, { phase: this.phase, speed, watts, distance, steer: this.steer + wobble, lean: this.lean, firstPerson, headYaw: this.headYaw, look: this.lookAmount() });
  }

  /** 力み（0..1）。swayFrom から swayFrom × EFFORT_FULL_RATIO まで */
  private effort(watts: number) {
    const a = Math.max(1, this.swayFrom);
    return Math.max(0, Math.min(1, (watts - a) / (a * (EFFORT_FULL_RATIO - 1))));
  }

  /** 後方を見る（side: 1 で左の肩越し、-1 で右の肩越し）。見ている途中なら向きだけ変える */
  lookBack(side: 1 | -1) {
    if (this.lookTime < LOOK_IN + LOOK_HOLD) {
      this.lookSide = side;
      return;
    }
    this.lookSide = side;
    this.lookTime = 0;
    this.nextLook = Math.max(this.nextLook, 20);
  }

  private lookAmount() {
    const t = this.lookTime;
    const ease = (k: number) => k * k * (3 - 2 * k);
    let a = 0;
    if (t < LOOK_IN) a = ease(t / LOOK_IN);
    else if (t < LOOK_IN + LOOK_HOLD) a = 1;
    else if (t < LOOK_IN + LOOK_HOLD + LOOK_OUT) a = 1 - ease((t - LOOK_IN - LOOK_HOLD) / LOOK_OUT);
    return a * this.lookSide;
  }

  stats() {
    const bike = this.bike.stats();
    const rider = this.rider.stats();
    return { lod: this.lod, bike, rider, draws: bike.draws + rider.draws, triangles: bike.triangles + rider.triangles };
  }

  dispose() {
    this.bike.dispose();
    this.material.dispose();
    this.cargo.dispose();
  }
}
