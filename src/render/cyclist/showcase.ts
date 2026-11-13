// 設定画面を開いている間の視点。自転車を右（駆動系の側）の斜め前から見て、画面の空いている側に収める。
// 横画面は設定画面が右にあるので左に、縦画面は下にあるので上に寄せる。

import * as THREE from "three";

export interface ShowcaseView {
  eye: THREE.Vector3;
  target: THREE.Vector3;
  fov: number;
}

/**
 * group: 自転車とライダーの group（世界に置かれた状態）。aspect: 画面の縦横比。
 * panelShare: 設定画面が覆う割合（横画面なら幅、縦画面なら高さ）。yaw: 横から回り込む角度（0 で真横）。
 * 返す座標は group の親の座標（描画の座標）。
 */
export function showcaseView(group: THREE.Object3D, aspect: number, panelShare: number, yaw = 0.35): ShowcaseView {
  const portrait = aspect < 0.8;
  const fov = portrait ? 42 : 30;
  const vfov = (fov * Math.PI) / 180;
  const hfov = 2 * Math.atan(Math.tan(vfov / 2) * aspect);
  // 収めたい大きさ（自転車の長さ 1.9m、ライダーの頭まで 1.75m）
  const freeW = portrait ? 1 : 1 - panelShare;
  const freeH = portrait ? 1 - panelShare : 1;
  const needW = 2.1;
  const needH = 1.95;
  const distW = needW / 2 / (Math.tan(hfov / 2) * freeW);
  const distH = needH / 2 / (Math.tan(vfov / 2) * freeH);
  const dist = Math.max(distW, distH);
  const center = new THREE.Vector3(0, 0.88, 0.05);
  // 右（-X）の斜め前から
  const dir = new THREE.Vector3(-Math.cos(yaw), 0.12, Math.sin(yaw)).normalize();
  const eyeLocal = center.clone().addScaledVector(dir, dist);
  // 空いている側の中心に自転車が来るよう、見る点をずらす
  const right = new THREE.Vector3().crossVectors(dir.clone().negate(), new THREE.Vector3(0, 1, 0)).normalize();
  const up = new THREE.Vector3().crossVectors(right, dir.clone().negate()).normalize();
  const target = center.clone();
  if (portrait) target.addScaledVector(up, -Math.tan(vfov / 2) * dist * panelShare);
  else target.addScaledVector(right, Math.tan(hfov / 2) * dist * panelShare);
  group.updateMatrix();
  return { eye: eyeLocal.applyMatrix4(group.matrix), target: target.applyMatrix4(group.matrix), fov };
}
