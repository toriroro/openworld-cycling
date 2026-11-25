// 脚と体力（配達の草案 14.2）。DOM・端末の機能に依存しない（後でサーバーでも使えるように）。
// 脚 = 無酸素の余力（W′）。臨界出力（CP）を超えた分で減り、下回った分で戻る。
// 体力 = 1 日の余力。漕いだ仕事 (J) で減り、食べる・休むと戻る。尽きると大きく遅くなる（ハンガーノック）。強制では止めない（草案 11 章の 17）。

export interface StaminaParams {
  /** 臨界出力 (W) */
  cp: number;
  /** 脚の量 (J) */
  wPrime: number;
  /** 体力の量 (J、漕ぐ仕事に換算) */
  energy: number;
}

/** 既定【初期値】: CP 200W、脚 15kJ（「全力」で 2 分ほど）、体力 1,200kJ（「ふつう」で 2 時間ほど） */
export const DEFAULT_STAMINA: StaminaParams = { cp: 200, wPrime: 15000, energy: 1_200_000 };

/** CP を下回った分のうち脚に戻る割合【初期値】（止まっていると 15kJ が 2.5 分で戻る） */
const RECOVER = 0.5;
/** CP を超えた分の仕事は体力を余計に使う倍率【初期値】 */
const HARD_COST = 1.5;
/** 脚が尽きた時の出力の上限（CP の割合）と、体力が尽きた時の上限【初期値】 */
const LEGS_OUT_CAP = 0.95;
const BONK_CAP = 0.55;

/** ペース（0 = 漕がない）と、その出力の CP に対する割合【初期値】 */
export const PACE_LABELS = ["止まる", "ゆっくり", "ふつう", "急ぐ", "全力"] as const;
export const PACE_SHARE = [0, 0.6, 0.85, 1.15, 1.6] as const;
export type Pace = 0 | 1 | 2 | 3 | 4;

export function paceWatts(pace: Pace, cp: number): number {
  return PACE_SHARE[pace] * cp;
}

/**
 * ペースごとの走りの補助（配達の草案 26 章）: 推進に使う出力を、漕いだ出力のこの倍にする。脚と体力は漕いだ出力で減る。
 * 平らな道で ゆっくり 30・ふつう 40・急ぐ 50・全力 約 56 km/h になる値（DEFAULT_BIKE で求めた）【初期値】
 */
export const PACE_ASSIST = [1, 1.08, 1.63, 2.24, 2.24] as const;
/** ペースごとの平らな道の速さ (km/h)。この速さより遅い間は、早く届くように前へ押す力を足す（src/sim/ride.ts の cruise）【初期値】 */
export const PACE_SPEED = [0, 30, 40, 50, 56] as const;

/** 車に当たった時に減る体力（体力の量に対する割合）【初期値】 */
export const CAR_HIT = 0.05;

/** 食べ物（喫茶店）: 値段 (円) と戻る体力 (J)【初期値】 */
export const FOODS = [
  { id: "coffee", name: "コーヒーとパン", price: 500, energy: 250_000 },
  { id: "meal", name: "食事", price: 900, energy: 550_000 },
] as const;
/** 休む: かかる時間 (s)、戻る体力 (J)。脚は全部戻る【初期値】 */
export const REST_S = 300;
const REST_ENERGY = 40_000;

export class Stamina {
  legs: number;
  energy: number;

  constructor(readonly p: StaminaParams = DEFAULT_STAMINA) {
    this.legs = p.wPrime;
    this.energy = p.energy;
  }

  /** 漕いだ出力 (W) で dt 秒進める */
  update(watts: number, dt: number) {
    const { cp, wPrime } = this.p;
    if (watts > cp) this.legs = Math.max(0, this.legs - (watts - cp) * dt);
    else this.legs = Math.min(wPrime, this.legs + (cp - watts) * RECOVER * dt);
    const hard = Math.max(0, watts - cp);
    this.energy = Math.max(0, this.energy - (watts - hard + hard * HARD_COST) * dt);
  }

  /** いま出せる出力の上限 (W) */
  cap(): number {
    if (this.energy <= 0) return this.p.cp * BONK_CAP;
    if (this.legs <= 0) return this.p.cp * LEGS_OUT_CAP;
    return Infinity;
  }

  /** 0〜1 */
  get legsShare(): number {
    return this.legs / this.p.wPrime;
  }
  get energyShare(): number {
    return this.energy / this.p.energy;
  }
  get bonk(): boolean {
    return this.energy <= 0;
  }

  /** 体力を量の share だけ減らす（車に当たった時） */
  hit(share: number) {
    this.energy = Math.max(0, this.energy - this.p.energy * share);
  }

  eat(energy: number) {
    this.energy = Math.min(this.p.energy, this.energy + energy);
  }

  rest() {
    this.legs = this.p.wPrime;
    this.eat(REST_ENERGY);
  }

  toJSON() {
    return { legs: Math.round(this.legs), energy: Math.round(this.energy) };
  }

  static fromJSON(v: unknown, p: StaminaParams = DEFAULT_STAMINA): Stamina {
    const s = new Stamina(p);
    const r = typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {};
    const num = (x: unknown, d: number, hi: number) => (typeof x === "number" && Number.isFinite(x) ? Math.min(hi, Math.max(0, x)) : d);
    s.legs = num(r.legs, p.wPrime, p.wPrime);
    s.energy = num(r.energy, p.energy, p.energy);
    return s;
  }
}
