// 走行の記録（トレーナー連携の草案 6.1）。トレーナーで走っている間、1 秒に 1 回、道のり・速度・出力・ケイデンス・心拍・標高・勾配・位置を残す。
// 描画にも端末の機能にも依存しない。保存は toJSON / fromJSON で呼び出し側が platform の保存へ置く。
// 位置は世界座標のまま残し、緯度・経度にするのは書き出す時（北海道の世界だけ）。

/** 1 回の記録の長さの上限 (s)。超えたら残さない【初期値】 */
export const MAX_SAMPLES = 12 * 3600;

export interface RecordInput {
  /** Unix 時刻 (ms) */
  now: number;
  /** 走行の総距離・獲得標高（Ride.odometer・climb。差を数える） */
  odometer: number;
  climb: number;
  speed: number;
  power: number;
  cadence: number | null;
  heartRate: number | null;
  altitude: number;
  grade: number;
  x: number;
  z: number;
}

export interface RecordedSample {
  /** Unix 秒 */
  t: number;
  distance: number;
  speed: number;
  power: number;
  cadence: number | null;
  heartRate: number | null;
  altitude: number;
  grade: number;
  x: number;
  z: number;
}

const COLS = ["t", "d", "v", "p", "c", "h", "y", "g", "x", "z"] as const;
type Col = (typeof COLS)[number];
/** 保存する時の丸め（小数の桁）。t は記録の始まりからの秒 */
const ROUND: Record<Col, number> = { t: 1, d: 10, v: 100, p: 1, c: 1, h: 1, y: 10, g: 10000, x: 10, z: 10 };

export class RideRecorder {
  /** どの世界の記録か（位置を緯度・経度にできるかを決める） */
  world: string;
  /** 記録の始まり（Unix 秒）。まだなら null */
  startedAt: number | null = null;
  /** 獲得標高 (m) */
  ascent = 0;
  private distance = 0;
  private cols: Record<Col, number[]> = { t: [], d: [], v: [], p: [], c: [], h: [], y: [], g: [], x: [], z: [] };
  private lastSec = -1;
  private lastOdo = NaN;
  private lastClimb = NaN;
  /** 変わったら true（保存する側が見て false に戻す） */
  dirty = false;

  constructor(world: string) {
    this.world = world;
  }

  get length() {
    return this.cols.t.length;
  }

  get full() {
    return this.length >= MAX_SAMPLES;
  }

  /** 記録した道のり (m) */
  get totalDistance() {
    return this.distance;
  }

  /** 記録した時間 (s)。間の空いた所（1.5 秒より長い）は数えない */
  get timerSeconds() {
    const t = this.cols.t;
    let s = 0;
    for (let i = 1; i < t.length; i++) if (t[i] - t[i - 1] <= 1.5) s += t[i] - t[i - 1];
    return s;
  }

  /**
   * 記録する。同じ秒の 2 回目からは道のりの差だけ数えて残さない。
   * 記録しない間（一時停止・立ち寄り・トレーナーが外れている）は gap() を呼ぶ
   */
  record(i: RecordInput): boolean {
    // 道のり・獲得標高は前回からの差（「はじめから」で総距離が 0 に戻った時は数えない）
    if (Number.isFinite(this.lastOdo) && i.odometer >= this.lastOdo) this.distance += i.odometer - this.lastOdo;
    if (Number.isFinite(this.lastClimb) && i.climb >= this.lastClimb) this.ascent += i.climb - this.lastClimb;
    this.lastOdo = i.odometer;
    this.lastClimb = i.climb;
    const sec = Math.floor(i.now / 1000);
    if (sec <= this.lastSec || this.full) return false;
    this.lastSec = sec;
    if (this.startedAt === null) this.startedAt = sec;
    const c = this.cols;
    c.t.push(sec - this.startedAt);
    c.d.push(this.distance);
    c.v.push(i.speed);
    c.p.push(i.power);
    c.c.push(i.cadence ?? -1);
    c.h.push(i.heartRate ?? -1);
    c.y.push(i.altitude);
    c.g.push(i.grade);
    c.x.push(i.x);
    c.z.push(i.z);
    this.dirty = true;
    return true;
  }

  /** 記録しない間: 次に記録する時は、それまでに進んだ道のりを数えない */
  gap() {
    this.lastOdo = NaN;
    this.lastClimb = NaN;
  }

  samples(): RecordedSample[] {
    const c = this.cols;
    const t0 = this.startedAt ?? 0;
    return c.t.map((t, i) => ({
      t: t0 + t,
      distance: c.d[i],
      speed: c.v[i],
      power: c.p[i],
      cadence: c.c[i] < 0 ? null : c.c[i],
      heartRate: c.h[i] < 0 ? null : c.h[i],
      altitude: c.y[i],
      grade: c.g[i],
      x: c.x[i],
      z: c.z[i],
    }));
  }

  /** 記録を消す（同じ世界のまま） */
  clear() {
    this.startedAt = null;
    this.ascent = 0;
    this.distance = 0;
    for (const k of COLS) this.cols[k] = [];
    this.lastSec = -1;
    this.gap();
    this.dirty = true;
  }

  toJSON() {
    const cols = {} as Record<Col, number[]>;
    for (const k of COLS) cols[k] = this.cols[k].map((v) => Math.round(v * ROUND[k]) / ROUND[k]);
    return { v: 1, world: this.world, startedAt: this.startedAt, ascent: Math.round(this.ascent * 10) / 10, distance: Math.round(this.distance * 10) / 10, cols };
  }

  /** 保存から戻す。壊れていれば null */
  static fromJSON(value: unknown): RideRecorder | null {
    if (typeof value !== "object" || value === null) return null;
    const o = value as Record<string, unknown>;
    if (o.v !== 1 || typeof o.world !== "string") return null;
    const r = new RideRecorder(o.world);
    const cols = o.cols as Record<string, unknown> | undefined;
    if (!cols) return null;
    const n = Array.isArray(cols.t) ? cols.t.length : 0;
    for (const k of COLS) {
      const a = cols[k];
      if (!Array.isArray(a) || a.length !== n || !a.every((x) => typeof x === "number" && Number.isFinite(x))) return null;
      r.cols[k] = (a as number[]).slice(0, MAX_SAMPLES);
    }
    r.startedAt = n && typeof o.startedAt === "number" ? o.startedAt : null;
    r.ascent = typeof o.ascent === "number" && o.ascent >= 0 ? o.ascent : 0;
    r.distance = typeof o.distance === "number" && o.distance >= 0 ? o.distance : n ? r.cols.d[n - 1] : 0;
    r.lastSec = n && r.startedAt !== null ? r.startedAt + r.cols.t[n - 1] : -1;
    return r;
  }
}
