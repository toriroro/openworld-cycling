// 自分の自転車とライダー（downhill-3D のモデルを使う）。姿勢・傾き・ペダルの回転。sim の状態を読むだけ。

import * as THREE from "three";
import { mergeStatic } from "./merge-static.ts";
import { RoadBikeModel } from "./rider/bike.ts";
import { HumanRider } from "./rider/human-rider.ts";

export class PlayerModel {
  readonly group = new THREE.Group();
  private bike = new RoadBikeModel();
  private rider = new HumanRider();
  private phase = 0;
  private lean = 0;
  private lastYaw = NaN;

  constructor() {
    this.group.name = "player";
    this.group.add(this.bike.group, this.rider.group);
    // 自転車の動かない部品を材質ごとにまとめる（スポークなど 100 近い部品があり、描画命令が多すぎるため）
    mergeStatic(this.bike.group);
    mergeStatic(this.bike.steering);
    for (const w of this.bike.wheels) mergeStatic(w);
    this.group.traverse((o) => {
      if (o instanceof THREE.Mesh) o.castShadow = true;
    });
  }

  /**
   * 描画座標での位置 (x, y, z)、進行方向 (dx, dz)、勾配、速度、出力。
   * firstPerson なら体を隠して腕だけにする。
   */
  update(dt: number, x: number, y: number, z: number, dx: number, dz: number, grade: number, speed: number, watts: number, distance: number, firstPerson: boolean) {
    const yaw = Math.atan2(dx, dz);
    // 曲がる速さから傾き（横加速度 = 速度 × 向きの変わる速さ）
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
    const sprint = Math.max(0, Math.min(1, (watts - 300) / 300));
    this.rider.update({ phase: this.phase, sprint, tuck: speed > 13 && watts === 0, steeringAngle: -this.lean * 0.15, firstPerson });
    this.bike.update(distance, -this.lean * 0.15, speed);
  }
}
