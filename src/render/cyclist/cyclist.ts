// 自転車とライダーをまとめた1台分。設定（Outfit）と画質（lod）を受け、走行の状態から姿勢を付ける。
// update() は M3 の PlayerModel.update と同じ引数で、走行の状態を読むだけ。

import * as THREE from "three";
import type { Outfit } from "../../shared/outfit.ts";
import { PaletteMaterial } from "./palette.ts";
import { Rider } from "./rider.ts";
import { FIT, type Lod, RoadBike } from "./road-bike.ts";

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
}

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
    });
  }

  /**
   * 描画座標での位置 (x, y, z)、進行方向 (dx, dz)、勾配、速度、出力、走った距離。M3 の PlayerModel.update と同じ形。
   * firstPerson なら体を隠して腕だけにする。
   */
  update(dt: number, x: number, y: number, z: number, dx: number, dz: number, grade: number, speed: number, watts: number, distance: number, firstPerson: boolean) {
    const yaw = Math.atan2(dx, dz);
    let yawRate = 0;
    if (!Number.isNaN(this.lastYaw) && dt > 0) {
      let d = yaw - this.lastYaw;
      while (d > Math.PI) d -= Math.PI * 2;
      while (d < -Math.PI) d += Math.PI * 2;
      yawRate = d / dt;
    }
    this.lastYaw = yaw;
    const targetLean = Math.max(-0.5, Math.min(0.5, Math.atan((speed * yawRate) / 9.8)));
    this.lean += (targetLean - this.lean) * Math.min(1, dt * 4);
    this.group.position.set(x, y, z);
    this.group.rotation.set(0, 0, 0);
    this.group.rotateY(yaw);
    this.group.rotateX(-Math.atan(grade));
    this.group.rotateZ(this.lean);
    // ケイデンスは出力から（漕いでいない時は止める）
    const cadence = watts > 0 ? 75 + Math.min(1, watts / 400) * 25 : 0;
    this.phase = (this.phase + (cadence / 60) * Math.PI * 2 * dt) % (Math.PI * 2);
    this.pose(dt, { phase: this.phase, speed, watts, distance, steer: -this.lean * 0.15, lean: this.lean, firstPerson });
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
