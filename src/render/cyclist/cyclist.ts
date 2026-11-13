// 自転車とライダーをまとめた1台分。設定（Outfit）と画質（lod）を受け、走行の状態から姿勢を付ける。
// update() は M3 の PlayerModel.update と同じ引数で、走行の状態を読むだけ。

import * as THREE from "three";
import type { Outfit } from "../../shared/outfit.ts";
import { PaletteMaterial } from "./palette.ts";
import { Rider } from "./rider.ts";
import { ankling, FIT, type Lod, RoadBike } from "./road-bike.ts";

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

export class CyclistModel {
  readonly group = new THREE.Group();
  readonly material = new PaletteMaterial();
  readonly bike = new RoadBike(this.material);
  readonly rider = new Rider(this.material);
  private outfit: Outfit;
  private lod: Lod;
  private phase = 0;
  private lean = 0;
  private lastYaw = NaN;
  private steer = 0;
  private lastPos: { x: number; z: number } | null = null;
  /** 道の向きに対する進む向きのずれ（車線を移る時、左が正） */
  private drift = 0;
  private headYaw = 0;
  private lookSide = 0;
  private lookTime = Infinity;
  /** 次に自分から後方を見るまでの秒数 */
  private nextLook = 30 + Math.random() * 40;

  constructor(outfit: Outfit, lod: Lod) {
    this.group.name = "cyclist";
    this.group.add(this.bike.group, this.rider.group);
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
    const effort = Math.max(0, Math.min(1, (p.watts - 300) / 300));
    this.rider.update({
      pedals: [this.bike.pedalPoint(1, p.phase), this.bike.pedalPoint(-1, p.phase)],
      hands: [this.bike.hoodPoint(1), this.bike.hoodPoint(-1)],
      saddle: FIT.saddle,
      effort,
      phase: p.phase,
      tuck: p.speed > 13 && p.watts === 0,
      firstPerson: p.firstPerson,
      ankles: [ankling(p.phase), ankling(p.phase + Math.PI)],
      headYaw: p.headYaw ?? 0,
      look: p.look ?? 0,
    });
  }

  /**
   * 描画座標での位置 (x, y, z)、進行方向 (dx, dz)、勾配、速度、出力、走った距離。M3 の PlayerModel.update と同じ形。
   * firstPerson なら体を隠して腕だけにする。
   */
  update(dt: number, x: number, y: number, z: number, dx: number, dz: number, grade: number, speed: number, watts: number, distance: number, firstPerson: boolean) {
    // 車線を移る時は、道の向きから少し斜めに進む（横の速さ / 速度）
    let lateral = 0;
    if (this.lastPos && dt > 0) {
      const mx = x - this.lastPos.x;
      const mz = z - this.lastPos.z;
      // 原点の置き直しなどの飛びは無視する
      if (Math.hypot(mx, mz) < speed * dt * 3 + 0.5) lateral = (mx * dz - mz * dx) / dt;
    }
    this.lastPos = { x, z };
    const targetDrift = speed > 1 ? Math.max(-0.4, Math.min(0.4, Math.atan2(lateral, speed))) : 0;
    this.drift += (targetDrift - this.drift) * Math.min(1, dt * 8);
    const yaw = Math.atan2(dx, dz) + this.drift;
    let yawRate = 0;
    if (!Number.isNaN(this.lastYaw) && dt > 0) {
      let d = yaw - this.lastYaw;
      while (d > Math.PI) d -= Math.PI * 2;
      while (d < -Math.PI) d += Math.PI * 2;
      // U ターンなどで向きが一度に変わった時は曲がったと見なさない
      yawRate = Math.abs(d) > 1 ? 0 : d / dt;
    }
    this.lastYaw = yaw;
    // 倒し込みは曲がる速さから（横加速度 = 速度 × 向きの変わる速さ）。左に曲がる時は左（+X）へ倒す
    const targetLean = Math.max(-0.5, Math.min(0.5, Math.atan((speed * yawRate) / 9.8)));
    this.lean += (targetLean - this.lean) * Math.min(1, dt * 4);
    // ハンドルの切れ角は曲がる速さと速度から（ホイールベース約 1m）。走行中の小さな角度も見えるよう 2.5 倍
    const targetSteer = Math.max(-0.7, Math.min(0.7, -Math.atan((1.0 * yawRate) / Math.max(2, speed)) * 2.5));
    this.steer += (targetSteer - this.steer) * Math.min(1, dt * 6);
    // 漕ぐ度の小さな釣り合いの動き（遅いほど、力むほど大きい）と、もがく時の車体の振り
    const effort = Math.max(0, Math.min(1, (watts - 300) / 300));
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
    // ケイデンスは出力から（漕いでいない時は止める）
    const cadence = watts > 0 ? 75 + Math.min(1, watts / 400) * 25 : 0;
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
  }
}
