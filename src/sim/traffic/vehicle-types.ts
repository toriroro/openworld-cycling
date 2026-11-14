// 車の種類（都市と交通の草案 6.6）。寸法は日本の車の一般的な値【初期値】。形は render/traffic/vehicle-shapes.ts。
// 北海道・東北の町と農村を手本に、軽自動車と軽トラックを多めにする。

export type VehicleType = "sedan" | "kei" | "minivan" | "van" | "keiTruck" | "bus";

export interface VehicleSpec {
  /** 長さ・幅・高さ (m) */
  length: number;
  width: number;
  height: number;
  /** 規制速度に掛ける係数（遅い車ほど小さい） */
  pace: number;
}

export const VEHICLE_SPECS: Record<VehicleType, VehicleSpec> = {
  sedan: { length: 4.6, width: 1.76, height: 1.45, pace: 1.0 },
  kei: { length: 3.4, width: 1.48, height: 1.78, pace: 0.95 },
  minivan: { length: 4.7, width: 1.8, height: 1.85, pace: 1.0 },
  van: { length: 4.7, width: 1.7, height: 1.98, pace: 0.95 },
  keiTruck: { length: 3.4, width: 1.48, height: 1.8, pace: 0.85 },
  bus: { length: 10.5, width: 2.49, height: 3.05, pace: 0.85 },
};

export const VEHICLE_TYPES = Object.keys(VEHICLE_SPECS) as VehicleType[];

/** 道路の等級（幹線・一般道・山道・林道）ごとの種類の割合【初期値】。自転車道には車を出さない */
export const TYPE_MIX: Record<number, [VehicleType, number][]> = {
  0: [["sedan", 0.3], ["kei", 0.25], ["minivan", 0.17], ["van", 0.1], ["keiTruck", 0.1], ["bus", 0.08]],
  1: [["sedan", 0.26], ["kei", 0.32], ["minivan", 0.13], ["van", 0.1], ["keiTruck", 0.14], ["bus", 0.05]],
  2: [["sedan", 0.25], ["kei", 0.35], ["minivan", 0.1], ["van", 0.08], ["keiTruck", 0.22]],
  3: [["keiTruck", 1]],
};

/** 道路の等級ごとの 1km あたりの台数（両方向の合計、昼の値）【初期値】。落ち着いて走れるよう少なめ */
export const DENSITY_PER_KM = [4, 2, 0.5, 0.06, 0];

/** 等級ごとの規制速度 (m/s)【初期値】: 幹線 60km/h、一般道 50、山道 40、林道 25 */
export const SPEED_LIMIT = [16.7, 13.9, 11.1, 6.9, 0];

/** 時刻（世界の時計、時）による交通量の係数: 朝夕に多く、深夜に少ない */
export function hourFactor(hour: number): number {
  const pts: [number, number][] = [
    [0, 0.15],
    [5, 0.15],
    [7, 1.3],
    [9, 1.3],
    [10, 1],
    [16, 1],
    [17.5, 1.3],
    [19, 1.1],
    [22, 0.35],
    [24, 0.15],
  ];
  const h = ((hour % 24) + 24) % 24;
  for (let i = 1; i < pts.length; i++) {
    const [h1, v1] = pts[i];
    const [h0, v0] = pts[i - 1];
    if (h <= h1) return v0 + ((v1 - v0) * (h - h0)) / (h1 - h0);
  }
  return pts[0][1];
}

/** 色（sRGB の 16 進）。日本の車に多い白・銀・黒を多めに */
export const CAR_COLORS: [string, number][] = [
  ["#f2f2ee", 0.28],
  ["#b9bdc0", 0.18],
  ["#1d1f22", 0.14],
  ["#6c7174", 0.1],
  ["#2b3f63", 0.07],
  ["#8e1f24", 0.05],
  ["#cbbd9a", 0.06],
  ["#3e5a46", 0.04],
  ["#5a4636", 0.03],
  ["#d9d3c2", 0.05],
];
/** 軽トラックはほとんど白 */
export const KEI_TRUCK_COLORS: [string, number][] = [
  ["#f2f2ee", 0.8],
  ["#b9bdc0", 0.12],
  ["#3e5a46", 0.08],
];
/** 路線バスの帯の色 */
export const BUS_COLORS: [string, number][] = [
  ["#1f5aa6", 0.35],
  ["#2f8a4e", 0.25],
  ["#c4352b", 0.2],
  ["#e08a1e", 0.2],
];
