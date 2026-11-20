// トレーナー・パワーメーター・心拍計の Bluetooth のバイト列の解析と組み立て（トレーナー連携の草案 2.1・2.2）。
// DOM にも Bluetooth の API にも依存しない。値はすべて little endian。

/** サービスと特性の UUID（16 ビットの短い形を 128 ビットにしたもの。Web Bluetooth はこの形も数値も受け付ける） */
const uuid16 = (n: number) => `0000${n.toString(16).padStart(4, "0")}-0000-1000-8000-00805f9b34fb`;

export const BLE = {
  ftms: uuid16(0x1826),
  ftmsFeature: uuid16(0x2acc),
  indoorBikeData: uuid16(0x2ad2),
  ftmsControlPoint: uuid16(0x2ad9),
  ftmsStatus: uuid16(0x2ada),
  power: uuid16(0x1818),
  powerMeasurement: uuid16(0x2a63),
  heartRate: uuid16(0x180d),
  heartRateMeasurement: uuid16(0x2a37),
} as const;

/** 1 回の通知から読めた値（無い項目は undefined） */
export interface BikeReading {
  /** 瞬間の出力 (W) */
  watts?: number;
  /** ケイデンス (rpm) */
  cadence?: number;
  /** 心拍 (bpm) */
  heartRate?: number;
  /** 機器の計った速度 (km/h)。表示にも物理にも使わない（確認用） */
  speedKmh?: number;
}

class Reader {
  o = 0;
  constructor(private v: DataView) {}
  get left() {
    return this.v.byteLength - this.o;
  }
  u8() {
    const x = this.v.getUint8(this.o);
    this.o += 1;
    return x;
  }
  u16() {
    const x = this.v.getUint16(this.o, true);
    this.o += 2;
    return x;
  }
  s16() {
    const x = this.v.getInt16(this.o, true);
    this.o += 2;
    return x;
  }
  u24() {
    const x = this.v.getUint16(this.o, true) | (this.v.getUint8(this.o + 2) << 16);
    this.o += 3;
    return x;
  }
  u32() {
    const x = this.v.getUint32(this.o, true);
    this.o += 4;
    return x;
  }
  skip(n: number) {
    this.o += n;
  }
}

/**
 * FTMS の Indoor Bike Data（0x2AD2）。フラグの順に項目が並ぶ。
 * ビット 0（More Data）が 0 の時だけ瞬間の速度がある（ほかのビットと意味が逆）。
 * 1 つの通知に入りきらない機器は、項目を何回かに分けて送る（読めた項目だけ返す）。
 */
export function parseIndoorBikeData(v: DataView): BikeReading {
  const out: BikeReading = {};
  if (v.byteLength < 2) return out;
  const r = new Reader(v);
  const f = r.u16();
  const has = (bit: number) => (f & (1 << bit)) !== 0;
  try {
    if (!has(0)) out.speedKmh = r.u16() / 100;
    if (has(1)) r.skip(2); // 平均の速度
    if (has(2)) out.cadence = r.u16() / 2;
    if (has(3)) r.skip(2); // 平均のケイデンス
    if (has(4)) r.skip(3); // 総距離
    if (has(5)) r.skip(2); // 負荷の段
    if (has(6)) out.watts = r.s16();
    if (has(7)) r.skip(2); // 平均の出力
    if (has(8)) r.skip(5); // 消費エネルギー（合計・毎時・毎分）
    if (has(9)) out.heartRate = r.u8();
  } catch {
    /* 短すぎる通知は読めた所まで */
  }
  return out;
}

/** パワーメーターのクランクの前回の値（ケイデンスを差から求める） */
export interface CrankState {
  revs: number;
  /** 最後にクランクが回った時刻（1/1024 秒、16 ビットで一周する） */
  time: number;
  /** 前回のケイデンス (rpm) */
  cadence: number;
  /** 同じ値が続いた回数（止まったのを知るため） */
  stale: number;
}

/**
 * Cycling Power Measurement（0x2A63）。出力は必ずある。
 * クランクの回転の累計と時刻があれば、前回との差からケイデンスを求める（state を書き換える）。
 */
export function parseCyclingPower(v: DataView, state: CrankState | null): { reading: BikeReading; crank: CrankState | null } {
  const out: BikeReading = {};
  if (v.byteLength < 4) return { reading: out, crank: state };
  const r = new Reader(v);
  const f = r.u16();
  const has = (bit: number) => (f & (1 << bit)) !== 0;
  out.watts = r.s16();
  let crank = state;
  try {
    if (has(0)) r.skip(1); // 左右のバランス
    if (has(2)) r.skip(2); // トルクの累計
    if (has(4)) r.skip(6); // 車輪の回転の累計（32 ビット）と時刻
    if (has(5) && r.left >= 4) {
      const revs = r.u16();
      const time = r.u16();
      if (!state) crank = { revs, time, cadence: 0, stale: 0 };
      else {
        const dr = (revs - state.revs + 0x10000) & 0xffff;
        const dt = ((time - state.time + 0x10000) & 0xffff) / 1024;
        if (dr > 0 && dt > 0) crank = { revs, time, cadence: Math.min(250, (dr / dt) * 60), stale: 0 };
        // 通知は 1 秒に 1〜4 回。3 回続けて回っていなければ止まったとみなす
        else crank = { ...state, stale: state.stale + 1, cadence: state.stale + 1 >= 3 ? 0 : state.cadence };
      }
      out.cadence = crank.cadence;
    }
  } catch {
    /* 短すぎる通知は読めた所まで */
  }
  return { reading: out, crank };
}

/** Heart Rate Measurement（0x2A37）。フラグのビット 0 が 1 なら 16 ビット */
export function parseHeartRate(v: DataView): BikeReading {
  if (v.byteLength < 2) return {};
  const f = v.getUint8(0);
  if (f & 1) return v.byteLength >= 3 ? { heartRate: v.getUint16(1, true) } : {};
  return { heartRate: v.getUint8(1) };
}

/** Fitness Machine Feature（0x2ACC）: 目標の設定のビット 13 が「シミュレーションの値」に対応 */
export function supportsSimulation(v: DataView): boolean {
  if (v.byteLength < 8) return false;
  const target = v.getUint32(4, true);
  return (target & (1 << 13)) !== 0;
}

export const FTMS_OP = {
  requestControl: 0x00,
  reset: 0x01,
  start: 0x07,
  stop: 0x08,
  simulation: 0x11,
  response: 0x80,
} as const;

export const encodeRequestControl = () => new Uint8Array([FTMS_OP.requestControl]);
export const encodeStart = () => new Uint8Array([FTMS_OP.start]);

export interface SimulationParams {
  /** 勾配（割合。0.05 = 5%） */
  grade: number;
  /** 転がり抵抗の係数 */
  crr: number;
  /** 空気抵抗の係数 (kg/m) */
  cw: number;
  /** 風速 (m/s、向かい風が正) */
  wind: number;
}

const clampInt = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, Math.round(x)));

/** 「シミュレーションの値」（0x11）: 風速 0.001m/s・勾配 0.01%（符号つき 16 ビット）、転がり抵抗 0.0001・空気抵抗 0.01kg/m（8 ビット） */
export function encodeSimulation(p: SimulationParams): Uint8Array {
  const b = new Uint8Array(7);
  const v = new DataView(b.buffer);
  b[0] = FTMS_OP.simulation;
  v.setInt16(1, clampInt(p.wind * 1000, -32768, 32767), true);
  v.setInt16(3, clampInt(p.grade * 10000, -32768, 32767), true);
  b[5] = clampInt(p.crr * 10000, 0, 255);
  b[6] = clampInt(p.cw * 100, 0, 255);
  return b;
}

/** 制御の応答（0x80, 要求した命令, 結果）。結果 1 が成功 */
export function parseControlPointResponse(v: DataView): { op: number; ok: boolean; result: number } | null {
  if (v.byteLength < 3 || v.getUint8(0) !== FTMS_OP.response) return null;
  const result = v.getUint8(2);
  return { op: v.getUint8(1), ok: result === 1, result };
}

/** 確認用: シミュレーションの値の書き込みを読み戻す */
export function decodeSimulation(v: DataView): SimulationParams | null {
  if (v.byteLength < 7 || v.getUint8(0) !== FTMS_OP.simulation) return null;
  return { wind: v.getInt16(1, true) / 1000, grade: v.getInt16(3, true) / 10000, crr: v.getUint8(5) / 10000, cw: v.getUint8(6) / 100 };
}

// 以下は仮想トレーナー（開発用）とテストが通知のバイト列を作るのに使う

/** Indoor Bike Data を作る（速度・ケイデンス・出力、あれば心拍） */
export function encodeIndoorBikeData(r: { speedKmh: number; cadence: number; watts: number; heartRate?: number }): Uint8Array {
  let flags = (1 << 2) | (1 << 6);
  if (r.heartRate !== undefined) flags |= 1 << 9;
  const b = new Uint8Array(2 + 2 + 2 + 2 + (r.heartRate !== undefined ? 1 : 0));
  const v = new DataView(b.buffer);
  v.setUint16(0, flags, true);
  v.setUint16(2, clampInt(r.speedKmh * 100, 0, 65535), true);
  v.setUint16(4, clampInt(r.cadence * 2, 0, 65535), true);
  v.setInt16(6, clampInt(r.watts, -32768, 32767), true);
  if (r.heartRate !== undefined) b[8] = clampInt(r.heartRate, 0, 255);
  return b;
}

/** Fitness Machine Feature を作る（ケイデンス・出力の計測、シミュレーションの値に対応） */
export function encodeFtmsFeature(simulation = true): Uint8Array {
  const b = new Uint8Array(8);
  const v = new DataView(b.buffer);
  v.setUint32(0, (1 << 1) | (1 << 14), true);
  v.setUint32(4, simulation ? 1 << 13 : 0, true);
  return b;
}

export const encodeControlPointResponse = (op: number, result = 1) => new Uint8Array([FTMS_OP.response, op, result]);
