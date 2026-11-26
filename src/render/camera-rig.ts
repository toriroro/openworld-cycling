// 視点（モック仕様 6.5）。後方・一人称・ドローンの3つ。downhill-3D の src/render/camera.ts の考え方を移し、
// 道路網の上の位置（世界座標の姿勢）から求める。地形にめり込まないようにする。

export const CAMERA_MODES = ["chase", "rider", "drone"] as const;
export type CameraMode = (typeof CAMERA_MODES)[number];
export const CAMERA_LABELS: Record<CameraMode, string> = { chase: "後方", rider: "一人称", drone: "ドローン" };

export interface Point {
  x: number;
  y: number;
  z: number;
}

export interface RiderPose extends Point {
  /** 進行方向（水平の単位ベクトル） */
  dx: number;
  dz: number;
  grade: number;
}

export interface CameraPose {
  eye: Point;
  target: Point;
  fov: number;
  /** カメラの近い面 (m)。一人称は手元（ハンドル・腕）が近いので手前にする */
  near?: number;
}

/** 一人称の画角（縦）。手元のハンドルと腕が映る広角（2026-11-17 ユーザー。前は 64 度・縦長の画面 76 度）。縦長は腕の形の切り口が映らない 88 度 */
export const RIDER_FOV = 92;
export const RIDER_FOV_PORTRAIT = 88;

type Ground = (x: number, z: number) => number;

function clearTerrain(eye: Point, target: Point, ground: Ground, lift = 1.2) {
  eye.y = Math.max(eye.y, ground(eye.x, eye.z) + lift);
  for (const t of [0.2, 0.4, 0.6, 0.8]) {
    const x = eye.x * (1 - t) + target.x * t;
    const z = eye.z * (1 - t) + target.z * t;
    const need = (ground(x, z) + 0.5 - target.y * t) / (1 - t);
    if (need > eye.y) eye.y = need;
  }
}

/** car: 自分の車で走っている（D7a）。後ろの視点を遠く高く、一人称は右の運転席から */
export function cameraPose(mode: CameraMode, p: RiderPose, aspect: number, ground: Ground, car = false): CameraPose {
  const portrait = aspect < 0.8;
  const at = (fwd: number, right: number, up: number): Point => ({
    x: p.x + p.dx * fwd - p.dz * right,
    y: p.y + p.grade * fwd + up,
    z: p.z + p.dz * fwd + p.dx * right,
  });
  if (mode === "rider" && car) {
    const eye = at(0.45, 0.35, 1.42);
    const target = at(30, 0.35, 0.4);
    return { eye, target, fov: portrait ? RIDER_FOV_PORTRAIT : RIDER_FOV, near: 0.12 };
  }
  if (mode === "rider") {
    const eye = at(-0.15, 0, 1.45);
    const target = at(30, 0, 0.3);
    return { eye, target, fov: portrait ? RIDER_FOV_PORTRAIT : RIDER_FOV, near: 0.12 };
  }
  if (mode === "drone") {
    const eye = at(portrait ? 15 : 12, portrait ? -9 : -14, 10);
    const target = at(0, 0, 0.6);
    clearTerrain(eye, target, ground, 3);
    return { eye, target, fov: portrait ? 50 : 42 };
  }
  const k = car ? 1.75 : 1;
  const eye = at((portrait ? -5.6 : -4.8) * k, 0, (portrait ? 2.8 : 2.3) * (car ? 1.45 : 1));
  const target = at(3 * k, 0, car ? 1.2 : 0.9);
  clearTerrain(eye, target, ground);
  return { eye, target, fov: portrait ? 62 : 55 };
}
