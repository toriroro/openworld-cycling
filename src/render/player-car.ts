// 自分の車（D7a。配達の草案 33 章）: 経営者が自分で乗る軽自動車・軽バン。形は交通の車と同じ（vehicle-shapes.ts）で、業者の色に塗る。
// 走行の状態（位置・向き・勾配）を読むだけ。

import * as THREE from "three";
import type { DriveKind } from "../shared/economy.ts";
import { vehicleGeometry } from "./traffic/vehicle-shapes.ts";

/** 経済の乗り物の名前と、交通の車の形の対応 */
const SHAPE: Record<DriveKind, "kei" | "van"> = { kei: "kei", van: "van" };

export class PlayerCar {
  readonly group = new THREE.Group();
  private paint = new THREE.MeshStandardMaterial({ color: "#ffffff", metalness: 0.35, roughness: 0.38 });
  private fixed = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.55, metalness: 0.1 });
  private kind: DriveKind | null = null;
  private e = new THREE.Euler(0, 0, 0, "YXZ");

  constructor() {
    this.group.name = "player-car";
    this.group.visible = false;
  }

  /** 乗る車を変える（null で隠す） */
  set(kind: DriveKind | null, color: string) {
    this.paint.color.set(color);
    if (kind === this.kind) {
      this.group.visible = !!kind;
      return;
    }
    this.kind = kind;
    this.group.clear();
    if (kind) {
      const g = vehicleGeometry(SHAPE[kind]);
      for (const [geo, mat] of [
        [g.paint, this.paint],
        [g.fixed, this.fixed],
      ] as const) {
        const m = new THREE.Mesh(geo, mat);
        m.castShadow = true;
        m.receiveShadow = true;
        this.group.add(m);
      }
    }
    this.group.visible = !!kind;
  }

  /** 描画座標での位置・進む向き・勾配 */
  update(x: number, y: number, z: number, dx: number, dz: number, grade: number) {
    if (!this.kind) return;
    this.group.position.set(x, y + 0.02, z);
    this.e.set(-Math.atan(grade), Math.atan2(dx, dz), 0);
    this.group.quaternion.setFromEuler(this.e);
  }
}
