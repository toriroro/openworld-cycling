// 走行の記録を FIT（Garmin の Flexible and Interoperable Data Transfer）の活動ファイルにする（トレーナー連携の草案 6.2）。
// ライブラリを使わずに書く。DOM・Node に依存しない純粋な関数。
//
// 書くメッセージ: file_id, device_info, event（タイマーの開始・停止）, record（1 秒ごと）, lap, session, activity。
// スポーツは自転車（2）、種目は仮想の走行（virtual_activity 58）。値はすべて little endian。

/** FIT の時刻の起点（1989-12-31T00:00:00Z）の Unix 秒 */
export const FIT_EPOCH = 631065600;

/** 1 秒ごとの記録。無い値は null */
export interface FitSample {
  /** Unix 秒 */
  t: number;
  /** 起点からの道のり (m) */
  distance: number;
  /** m/s */
  speed: number;
  /** W */
  power: number;
  cadence: number | null;
  heartRate: number | null;
  /** 標高 (m) */
  altitude: number;
  /** 勾配（割合。0.05 = 5%） */
  grade: number;
  /** 緯度・経度（度）。生成の世界では null */
  lat: number | null;
  lon: number | null;
}

export interface FitActivity {
  samples: FitSample[];
  /** 獲得標高 (m) */
  ascent: number;
  /** 作った時刻（Unix 秒） */
  created: number;
  /** 端末の時差（分。日本は 540）。activity の local_timestamp に使う */
  utcOffsetMin: number;
}

// 基本の型（FIT の base type）
const T = {
  enum: 0x00,
  uint8: 0x02,
  sint16: 0x83,
  uint16: 0x84,
  sint32: 0x85,
  uint32: 0x86,
  uint32z: 0x8c,
} as const;
type BaseType = (typeof T)[keyof typeof T];
const SIZE: Record<BaseType, number> = { 0x00: 1, 0x02: 1, 0x83: 2, 0x84: 2, 0x85: 4, 0x86: 4, 0x8c: 4 };
/** 無効値（値が無い時に入れる） */
const INVALID: Record<BaseType, number> = { 0x00: 0xff, 0x02: 0xff, 0x83: 0x7fff, 0x84: 0xffff, 0x85: 0x7fffffff, 0x86: 0xffffffff, 0x8c: 0 };

// 全体のメッセージ番号
export const MESG = { fileId: 0, session: 18, lap: 19, record: 20, event: 21, deviceInfo: 23, activity: 34 } as const;

/** フィールドの定義: [フィールド番号, 型] */
type FieldDef = readonly [number, BaseType];

const FILE_ID: FieldDef[] = [
  [0, T.enum], // type: 4 = activity
  [1, T.uint16], // manufacturer: 255 = development
  [2, T.uint16], // product
  [3, T.uint32z], // serial_number
  [4, T.uint32], // time_created
];
const DEVICE_INFO: FieldDef[] = [
  [253, T.uint32], // timestamp
  [0, T.uint8], // device_index: 0 = creator
  [2, T.uint16], // manufacturer
  [4, T.uint16], // product
  [5, T.uint16], // software_version（×100）
];
const EVENT: FieldDef[] = [
  [253, T.uint32],
  [0, T.enum], // event: 0 = timer
  [1, T.enum], // event_type: 0 = start, 4 = stop_all
];
const RECORD_BASE: FieldDef[] = [
  [253, T.uint32],
  [2, T.uint16], // altitude（×5、+500）
  [3, T.uint8], // heart_rate
  [4, T.uint8], // cadence
  [5, T.uint32], // distance（×100）
  [6, T.uint16], // speed（×1000）
  [7, T.uint16], // power
  [9, T.sint16], // grade（%×100）
];
const RECORD_POS: FieldDef[] = [
  ...RECORD_BASE,
  [0, T.sint32], // position_lat（semicircles）
  [1, T.sint32], // position_long
];
const LAP: FieldDef[] = [
  [253, T.uint32],
  [254, T.uint16], // message_index
  [0, T.enum], // event: 9 = lap
  [1, T.enum], // event_type: 1 = stop
  [2, T.uint32], // start_time
  [7, T.uint32], // total_elapsed_time（×1000）
  [8, T.uint32], // total_timer_time（×1000）
  [9, T.uint32], // total_distance（×100）
  [13, T.uint16], // avg_speed（×1000）
  [14, T.uint16], // max_speed
  [15, T.uint8], // avg_heart_rate
  [16, T.uint8], // max_heart_rate
  [17, T.uint8], // avg_cadence
  [19, T.uint16], // avg_power
  [20, T.uint16], // max_power
  [21, T.uint16], // total_ascent
  [24, T.enum], // lap_trigger: 7 = session_end
  [25, T.enum], // sport
  [39, T.enum], // sub_sport
];
const SESSION: FieldDef[] = [
  [253, T.uint32],
  [254, T.uint16],
  [0, T.enum], // event: 8 = session
  [1, T.enum], // event_type: 1 = stop
  [2, T.uint32], // start_time
  [5, T.enum], // sport
  [6, T.enum], // sub_sport
  [7, T.uint32], // total_elapsed_time
  [8, T.uint32], // total_timer_time
  [9, T.uint32], // total_distance
  [14, T.uint16], // avg_speed
  [15, T.uint16], // max_speed
  [16, T.uint8], // avg_heart_rate
  [17, T.uint8], // max_heart_rate
  [18, T.uint8], // avg_cadence
  [20, T.uint16], // avg_power
  [21, T.uint16], // max_power
  [22, T.uint16], // total_ascent
  [25, T.uint16], // first_lap_index
  [26, T.uint16], // num_laps
  [28, T.enum], // trigger: 0 = activity_end
];
const ACTIVITY: FieldDef[] = [
  [253, T.uint32],
  [0, T.uint32], // total_timer_time
  [1, T.uint16], // num_sessions
  [2, T.enum], // type: 0 = manual
  [3, T.enum], // event: 26 = activity
  [4, T.enum], // event_type: 1 = stop
  [5, T.uint32], // local_timestamp
];

export const SPORT_CYCLING = 2;
export const SUB_SPORT_VIRTUAL = 58;
/** 製造者: 開発用（255）。製品番号は自前の値 */
const MANUFACTURER = 255;
const PRODUCT = 1;
const SOFTWARE_VERSION = 1;

/** FIT の CRC（CRC-16/ARC と同じ。4 ビットずつの表） */
const CRC_TABLE = [0x0000, 0xcc01, 0xd801, 0x1400, 0xf001, 0x3c00, 0x2800, 0xe401, 0xa001, 0x6c00, 0x7800, 0xb401, 0x5000, 0x9c01, 0x8801, 0x4400];
export function fitCrc(bytes: Uint8Array, crc = 0): number {
  for (const b of bytes) {
    let tmp = CRC_TABLE[crc & 0xf];
    crc = (crc >> 4) & 0x0fff;
    crc = crc ^ tmp ^ CRC_TABLE[b & 0xf];
    tmp = CRC_TABLE[crc & 0xf];
    crc = (crc >> 4) & 0x0fff;
    crc = crc ^ tmp ^ CRC_TABLE[(b >> 4) & 0xf];
  }
  return crc;
}

class Writer {
  private buf = new Uint8Array(4096);
  private view = new DataView(this.buf.buffer);
  length = 0;

  private grow(n: number) {
    if (this.length + n <= this.buf.length) return;
    let cap = this.buf.length * 2;
    while (cap < this.length + n) cap *= 2;
    const b = new Uint8Array(cap);
    b.set(this.buf.subarray(0, this.length));
    this.buf = b;
    this.view = new DataView(b.buffer);
  }
  u8(v: number) {
    this.grow(1);
    this.view.setUint8(this.length, v);
    this.length += 1;
  }
  value(type: BaseType, v: number) {
    this.grow(4);
    const o = this.length;
    switch (type) {
      case T.enum:
      case T.uint8:
        this.view.setUint8(o, v);
        break;
      case T.sint16:
        this.view.setInt16(o, v, true);
        break;
      case T.uint16:
        this.view.setUint16(o, v, true);
        break;
      case T.sint32:
        this.view.setInt32(o, v, true);
        break;
      case T.uint32:
      case T.uint32z:
        this.view.setUint32(o, v, true);
        break;
    }
    this.length += SIZE[type];
  }
  bytes(): Uint8Array {
    return this.buf.slice(0, this.length);
  }
}

/** 値を型の範囲に収める（範囲の外・NaN・null は無効値） */
function fit(type: BaseType, v: number | null | undefined): number {
  if (v === null || v === undefined || !Number.isFinite(v)) return INVALID[type];
  const r = Math.round(v);
  const range: Record<BaseType, [number, number]> = {
    0x00: [0, 254],
    0x02: [0, 254],
    0x83: [-32767, 32766],
    0x84: [0, 65534],
    0x85: [-2147483647, 2147483646],
    0x86: [0, 4294967294],
    0x8c: [1, 4294967295],
  };
  const [lo, hi] = range[type];
  return r < lo || r > hi ? INVALID[type] : r;
}

const semicircles = (deg: number | null) => (deg === null ? null : (deg * 2 ** 31) / 180);
const fitTime = (unix: number) => Math.round(unix) - FIT_EPOCH;

/** 定義メッセージとデータメッセージを書く道具（局所のメッセージ番号を割り当てる） */
class Messages {
  readonly w = new Writer();
  private locals = new Map<string, { local: number; fields: FieldDef[] }>();

  write(global: number, fields: FieldDef[], values: (number | null)[], key = String(global)) {
    let d = this.locals.get(key);
    if (!d) {
      d = { local: this.locals.size, fields };
      if (d.local > 15) throw new Error("局所のメッセージ番号が足りない");
      this.locals.set(key, d);
      // 定義メッセージ: ヘッダ（定義の印 0x40）、予約、エンディアン（0 = little）、全体の番号、フィールドの数、各フィールド
      this.w.u8(0x40 | d.local);
      this.w.u8(0);
      this.w.u8(0);
      this.w.value(T.uint16, global);
      this.w.u8(fields.length);
      for (const [num, type] of fields) {
        this.w.u8(num);
        this.w.u8(SIZE[type]);
        this.w.u8(type);
      }
    }
    this.w.u8(d.local);
    d.fields.forEach(([, type], i) => this.w.value(type, fit(type, values[i])));
  }
}

interface Totals {
  start: number;
  end: number;
  elapsed: number;
  timer: number;
  distance: number;
  avgSpeed: number;
  maxSpeed: number;
  avgHr: number | null;
  maxHr: number | null;
  avgCad: number | null;
  avgPower: number;
  maxPower: number;
}

/** 区切り（タイマーの停止）とみなす記録の間隔 (s) */
const GAP = 1.5;

export function fitTotals(samples: FitSample[]): Totals {
  const start = samples[0].t;
  const end = samples[samples.length - 1].t;
  let timer = 0;
  for (let i = 1; i < samples.length; i++) {
    const dt = samples[i].t - samples[i - 1].t;
    if (dt <= GAP) timer += dt;
  }
  const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
  const hr = samples.map((s) => s.heartRate).filter((v): v is number => v !== null && v > 0);
  const cad = samples.map((s) => s.cadence).filter((v): v is number => v !== null && v > 0);
  const distance = samples[samples.length - 1].distance - samples[0].distance;
  return {
    start,
    end,
    elapsed: end - start,
    timer,
    distance,
    avgSpeed: timer > 0 ? distance / timer : 0,
    maxSpeed: Math.max(...samples.map((s) => s.speed)),
    avgHr: avg(hr),
    maxHr: hr.length ? Math.max(...hr) : null,
    // ケイデンスの平均は漕いでいる間だけ（0 を除く。一般の機器と同じ）
    avgCad: avg(cad),
    avgPower: avg(samples.map((s) => s.power)) ?? 0,
    maxPower: Math.max(...samples.map((s) => s.power)),
  };
}

/** 活動ファイルのバイト列。記録が 1 つも無ければ例外 */
export function encodeActivityFit(a: FitActivity): Uint8Array {
  const s = a.samples;
  if (!s.length) throw new Error("記録が無い");
  const m = new Messages();
  const tot = fitTotals(s);
  const hasPos = s.some((x) => x.lat !== null && x.lon !== null);
  m.write(MESG.fileId, FILE_ID, [4, MANUFACTURER, PRODUCT, 1, fitTime(a.created)]);
  m.write(MESG.deviceInfo, DEVICE_INFO, [fitTime(tot.start), 0, MANUFACTURER, PRODUCT, SOFTWARE_VERSION * 100]);
  m.write(MESG.event, EVENT, [fitTime(tot.start), 0, 0]);
  const recFields = hasPos ? RECORD_POS : RECORD_BASE;
  for (let i = 0; i < s.length; i++) {
    const r = s[i];
    // 間が空いた所（一時停止・立ち寄り・切断）はタイマーを止めて、また始める
    if (i > 0 && r.t - s[i - 1].t > GAP) {
      m.write(MESG.event, EVENT, [fitTime(s[i - 1].t), 0, 4]);
      m.write(MESG.event, EVENT, [fitTime(r.t), 0, 0]);
    }
    const vals: (number | null)[] = [
      fitTime(r.t),
      (r.altitude + 500) * 5,
      r.heartRate,
      r.cadence,
      r.distance * 100,
      r.speed * 1000,
      r.power,
      r.grade * 10000,
    ];
    if (hasPos) vals.push(semicircles(r.lat), semicircles(r.lon));
    m.write(MESG.record, recFields, vals);
  }
  m.write(MESG.event, EVENT, [fitTime(tot.end), 0, 4]);
  const summary = [tot.elapsed * 1000, tot.timer * 1000, tot.distance * 100, tot.avgSpeed * 1000, tot.maxSpeed * 1000];
  m.write(MESG.lap, LAP, [
    fitTime(tot.end),
    0,
    9,
    1,
    fitTime(tot.start),
    ...summary,
    tot.avgHr,
    tot.maxHr,
    tot.avgCad,
    tot.avgPower,
    tot.maxPower,
    a.ascent,
    7,
    SPORT_CYCLING,
    SUB_SPORT_VIRTUAL,
  ]);
  m.write(MESG.session, SESSION, [
    fitTime(tot.end),
    0,
    8,
    1,
    fitTime(tot.start),
    SPORT_CYCLING,
    SUB_SPORT_VIRTUAL,
    ...summary.slice(0, 3),
    ...summary.slice(3),
    tot.avgHr,
    tot.maxHr,
    tot.avgCad,
    tot.avgPower,
    tot.maxPower,
    a.ascent,
    0,
    1,
    0,
  ]);
  m.write(MESG.activity, ACTIVITY, [fitTime(tot.end), tot.timer * 1000, 1, 0, 26, 1, fitTime(tot.end) + a.utcOffsetMin * 60]);
  const data = m.w.bytes();
  // ファイルのヘッダ（14 バイト）: 大きさ、プロトコル 2.0、プロファイル 21.32、データの長さ、".FIT"、ヘッダの CRC
  const out = new Uint8Array(14 + data.length + 2);
  const v = new DataView(out.buffer);
  v.setUint8(0, 14);
  v.setUint8(1, 0x20);
  v.setUint16(2, 2132, true);
  v.setUint32(4, data.length, true);
  out.set([0x2e, 0x46, 0x49, 0x54], 8);
  v.setUint16(12, fitCrc(out.subarray(0, 12)), true);
  out.set(data, 14);
  v.setUint16(14 + data.length, fitCrc(out.subarray(0, 14 + data.length)), true);
  return out;
}
