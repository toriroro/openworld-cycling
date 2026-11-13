// 縦方向の走行物理（downhill-3D の src/physics/bicycle.ts から移した。モック仕様 6.1）。
// 重力・空気抵抗・転がり抵抗・駆動力・制動。120Hz の固定更新。勾配の符号を問わない。
// 推進力は入力元（PowerSource）の出力 W から求める。

export const G = 9.80665;
export const DT = 1 / 120;
export const DRIVETRAIN_EFFICIENCY = 0.97;
/** 駆動力の上限 (N)。止まった所から踏み出す時の力の上限（変速して踏む前提で大きめ） */
export const DRIVE_FORCE_LIMIT = 400;

export interface BikeParams {
  /** 体重＋機材重量 (kg) */
  mass: number;
  /** 空気抵抗の面積と係数の積 (m²) */
  cda: number;
  /** 空気の密度 (kg/m³) */
  rho: number;
  /** 転がり抵抗の係数 */
  crr: number;
  /** 路面の摩擦係数 */
  mu: number;
  /** ブレーキいっぱいの減速度 (m/s²) */
  brakeDecel: number;
  /** 向かい風 (m/s) */
  wind: number;
}

/** downhill-3D と同じ初期値。体重 75kg ＋ 機材 8kg */
export const DEFAULT_BIKE: BikeParams = { mass: 83, cda: 0.32, rho: 1.06, crr: 0.004, mu: 0.85, brakeDecel: 5, wind: 0 };

/** 路面ごとの転がり抵抗 */
export const CRR = { paved: 0.004, gravel: 0.011 } as const;

export interface Forces {
  gravity: number;
  drag: number;
  rolling: number;
  brake: number;
  propulsion: number;
  acceleration: number;
}

export const clamp = (x: number, a: number, b: number) => Math.max(a, Math.min(b, x));

/** 速度 speed (m/s)、勾配 grade（進む向きに上りが正）、ブレーキ 0〜1、出力 watts の時の力 */
export function forces(speed: number, grade: number, brake: number, watts: number, p: BikeParams = DEFAULT_BIKE, lateralAcceleration = 0): Forces {
  const theta = Math.atan(grade);
  const normal = p.mass * G * Math.cos(theta);
  const gravity = -p.mass * G * Math.sin(theta);
  const air = speed + p.wind;
  const drag = 0.5 * p.rho * p.cda * air * Math.abs(air);
  const available = Math.sqrt(Math.max(0, (p.mu * normal) ** 2 - (p.mass * lateralAcceleration) ** 2));
  const braking = Math.min(clamp(brake, 0, 1) * p.mass * p.brakeDecel, available);
  const rolling = p.crr * normal;
  const w = Math.max(0, watts);
  const propulsion = brake > 0 || w <= 0 ? 0 : Math.min(DRIVE_FORCE_LIMIT, (w * DRIVETRAIN_EFFICIENCY) / Math.max(0.1, speed), available);
  // 前にだけ進む: 止まっている時は抵抗やブレーキで後ろへ動かさない
  const acceleration = (gravity + propulsion - drag - rolling - braking) / p.mass;
  return { gravity, drag, rolling, brake: braking, propulsion, acceleration: speed <= 0 ? Math.max(0, acceleration) : acceleration };
}

export function integrateSpeed(speed: number, grade: number, brake: number, watts: number, dt = DT, p: BikeParams = DEFAULT_BIKE, lateral = 0) {
  const f = forces(speed, grade, brake, watts, p, lateral);
  const end = Math.max(0, speed + f.acceleration * dt);
  // 止まる途中の1歩は止まった所までの距離にする
  const movingTime = f.acceleration < 0 && end === 0 ? Math.min(dt, speed / -f.acceleration) : dt;
  return { speed: end, distance: (speed + end) * 0.5 * movingTime, forces: f };
}

/** 一定の出力・勾配での釣り合いの速度（二分法）。照合用 */
export function equilibriumSpeed(watts: number, grade: number, p: BikeParams = DEFAULT_BIKE): number {
  const theta = Math.atan(grade);
  const resist = (v: number) => p.mass * G * Math.sin(theta) + p.crr * p.mass * G * Math.cos(theta) + 0.5 * p.rho * p.cda * (v + p.wind) * Math.abs(v + p.wind);
  const f = (v: number) => watts * DRIVETRAIN_EFFICIENCY - v * resist(v);
  let lo = 0.01;
  let hi = 40;
  for (let i = 0; i < 200; i++) {
    const m = (lo + hi) / 2;
    if (f(m) > 0) lo = m;
    else hi = m;
  }
  return (lo + hi) / 2;
}
