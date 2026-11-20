// トレーナー・心拍計とのやり取り（トレーナー連携の草案 2・3・4）。
// 機器は BleDevice の形で受け取る（ウェブは platform の Web Bluetooth、開発用は仮想トレーナー、iOS は後でネイティブ）。
// 描画にも Bluetooth の API にも依存しないので、仮想トレーナーで Node のテストから通せる。

import {
  BLE,
  type BikeReading,
  type CrankState,
  encodeRequestControl,
  encodeSimulation,
  encodeStart,
  FTMS_OP,
  parseControlPointResponse,
  parseCyclingPower,
  parseHeartRate,
  parseIndoorBikeData,
  supportsSimulation,
} from "./ble-codec.ts";
import { GradeSchedule } from "./grade.ts";
import { TrainerPower } from "./trainer-power.ts";

/** 機器との GATT のやり取り。サービス・特性は UUID の文字列 */
export interface BleDevice {
  readonly name: string;
  readonly connected: boolean;
  /** つなぐ。使えるサービスの UUID を返す */
  connect(): Promise<string[]>;
  disconnect(): void;
  read(service: string, characteristic: string): Promise<DataView>;
  subscribe(service: string, characteristic: string, fn: (v: DataView) => void): Promise<void>;
  write(service: string, characteristic: string, bytes: Uint8Array): Promise<void>;
  /** 切れた時に呼ばれる（こちらから disconnect した時は呼ばれなくてよい） */
  onDisconnect: (() => void) | null;
}

export type DeviceRole = "trainer" | "heart";
export type SlotState = "connecting" | "connected" | "reconnecting";

interface Slot {
  role: DeviceRole;
  device: BleDevice;
  state: SlotState;
  /** つないだ機器の種類（FTMS のトレーナー・パワーメーター・心拍計） */
  kind: "ftms" | "power" | "heart" | null;
  /** 勾配を送れる（FTMS の制御が取れた） */
  control: boolean;
  crank: CrankState | null;
  retryAt: number;
  /** 何度目の接続か（古い接続の通知を捨てるため） */
  generation: number;
  error: string;
}

/** 送る値（勾配は効きを掛けた後） */
export interface TrainerTarget {
  grade: number;
  crr: number;
  cw: number;
}

/** 空気抵抗の係数 (kg/m)【初期値】【未確認】（草案 4.1） */
export const DEFAULT_CW = 0.51;
/** 切れてからつなぎ直すまで (ms)【初期値】 */
const RETRY_FIRST_MS = 2000;
const RETRY_MS = 5000;
/** 制御の応答を待つ時間 (ms) */
const RESPONSE_TIMEOUT_MS = 3000;
/** ケイデンス・心拍が途切れたとみなす時間 (ms) */
const CADENCE_TIMEOUT_MS = 3000;
const HEART_TIMEOUT_MS = 5000;

export interface SlotInfo {
  name: string;
  state: SlotState;
  kind: Slot["kind"];
  control: boolean;
  error: string;
}

export class TrainerLink {
  readonly power: TrainerPower;
  private slots: Record<DeviceRole, Slot | null> = { trainer: null, heart: null };
  private cadence = { v: 0, at: -Infinity };
  private heart = { v: 0, at: -Infinity, fromHeart: false };
  private schedule = new GradeSchedule();
  /** 応答待ちの制御の書き込み */
  private waiter: { op: number; resolve: (ok: boolean) => void } | null = null;
  private busy = false;
  /** 最後に送れた値（確認用） */
  lastSent: TrainerTarget | null = null;
  /** 送った勾配の記録（確認用。最後の 2000 件） */
  readonly sentLog: { t: number; grade: number }[] = [];
  /** 最後に接続で失敗した理由 */
  lastError = "";
  /** 状態が変わった時（画面の更新用） */
  onChange: () => void = () => {};

  constructor(private now: () => number) {
    this.power = new TrainerPower(now);
  }

  /** 機器をつなぐ（同じ役割の前の機器は外す） */
  async attach(role: DeviceRole, device: BleDevice): Promise<boolean> {
    this.detach(role);
    const slot: Slot = { role, device, state: "connecting", kind: null, control: false, crank: null, retryAt: 0, generation: 0, error: "" };
    this.slots[role] = slot;
    device.onDisconnect = () => this.lost(slot);
    this.onChange();
    const ok = await this.setup(slot);
    if (!ok && this.slots[role] === slot) {
      // 最初の接続でつながらなければ外す（選び直してもらう）
      device.onDisconnect = null;
      device.disconnect();
      this.slots[role] = null;
      this.onChange();
    }
    return ok;
  }

  /** 機器を外す */
  detach(role: DeviceRole) {
    const s = this.slots[role];
    if (!s) return;
    this.slots[role] = null;
    s.device.onDisconnect = null;
    s.device.disconnect();
    if (role === "trainer") {
      this.power.reset();
      this.cadence.at = -Infinity;
      this.schedule.reset();
      this.lastSent = null;
      this.waiter = null;
    } else this.heart.at = -Infinity;
    this.onChange();
  }

  info(role: DeviceRole): SlotInfo | null {
    const s = this.slots[role];
    return s ? { name: s.device.name, state: s.state, kind: s.kind, control: s.control, error: s.error } : null;
  }

  /** トレーナー（出力の機器）がつながっている（つなぎ直し中を含む） */
  get hasTrainer(): boolean {
    return this.slots.trainer !== null;
  }

  /** ケイデンス (rpm)。無ければ null */
  get cadenceRpm(): number | null {
    return this.now() - this.cadence.at < CADENCE_TIMEOUT_MS ? this.cadence.v : null;
  }

  /** 心拍 (bpm)。無ければ null */
  get heartRate(): number | null {
    return this.now() - this.heart.at < HEART_TIMEOUT_MS ? this.heart.v : null;
  }

  /** 毎フレーム: つなぎ直しと、勾配の送信。target が null なら送らない */
  update(target: TrainerTarget | null) {
    const now = this.now();
    for (const role of ["trainer", "heart"] as const) {
      const s = this.slots[role];
      if (s && s.state === "reconnecting" && now >= s.retryAt) {
        s.retryAt = now + RETRY_MS;
        s.state = "connecting";
        this.onChange();
        void this.setup(s).then((ok) => {
          if (!ok && this.slots[role] === s) {
            s.state = "reconnecting";
            this.onChange();
          }
        });
      }
    }
    const t = this.slots.trainer;
    if (!target || !t || t.state !== "connected" || !t.control || this.busy) return;
    if (!this.schedule.shouldSend(now, target.grade) && this.lastSent && this.lastSent.crr === target.crr && this.lastSent.cw === target.cw) return;
    const gen = t.generation;
    this.busy = true;
    void this.writeControl(t, encodeSimulation({ grade: target.grade, crr: target.crr, cw: target.cw, wind: 0 }), FTMS_OP.simulation)
      .then((ok) => {
        if (!ok || t.generation !== gen || this.slots.trainer !== t) return;
        this.schedule.markSent(now, target.grade);
        this.lastSent = { ...target };
        this.sentLog.push({ t: now, grade: target.grade });
        if (this.sentLog.length > 2000) this.sentLog.splice(0, 1000);
      })
      .finally(() => {
        this.busy = false;
      });
  }

  private lost(slot: Slot) {
    if (this.slots[slot.role] !== slot) return;
    slot.state = "reconnecting";
    slot.retryAt = this.now() + RETRY_FIRST_MS;
    slot.generation++;
    if (slot.role === "trainer") this.schedule.reset();
    if (this.waiter) {
      this.waiter.resolve(false);
      this.waiter = null;
    }
    this.onChange();
  }

  /** つないで通知を受け始める。FTMS なら制御を取る */
  private async setup(slot: Slot): Promise<boolean> {
    const gen = ++slot.generation;
    const live = () => this.slots[slot.role] === slot && slot.generation === gen;
    try {
      const services = await slot.device.connect();
      if (!live()) return false;
      if (slot.role === "heart") {
        if (!services.includes(BLE.heartRate)) throw new Error("心拍のサービスが無い");
        await slot.device.subscribe(BLE.heartRate, BLE.heartRateMeasurement, (v) => live() && this.onReading(slot, parseHeartRate(v)));
        slot.kind = "heart";
      } else if (services.includes(BLE.ftms)) {
        slot.kind = "ftms";
        let sim = true;
        try {
          sim = supportsSimulation(await slot.device.read(BLE.ftms, BLE.ftmsFeature));
        } catch {
          /* 読めなければ対応しているとみなして試す */
        }
        await slot.device.subscribe(BLE.ftms, BLE.indoorBikeData, (v) => live() && this.onReading(slot, parseIndoorBikeData(v)));
        slot.control = false;
        if (sim) {
          await slot.device.subscribe(BLE.ftms, BLE.ftmsControlPoint, (v) => live() && this.onResponse(v));
          slot.control = (await this.writeControl(slot, encodeRequestControl(), FTMS_OP.requestControl)) && (await this.writeControl(slot, encodeStart(), FTMS_OP.start));
          this.schedule.reset();
        }
      } else if (services.includes(BLE.power)) {
        slot.kind = "power";
        slot.crank = null;
        await slot.device.subscribe(BLE.power, BLE.powerMeasurement, (v) => {
          if (!live()) return;
          const r = parseCyclingPower(v, slot.crank);
          slot.crank = r.crank;
          this.onReading(slot, r.reading);
        });
      } else throw new Error("トレーナー・パワーメーターのサービスが無い");
      if (!live()) return false;
      slot.state = "connected";
      slot.error = "";
      this.onChange();
      return true;
    } catch (e) {
      slot.error = e instanceof Error ? e.message : String(e);
      this.lastError = slot.error;
      this.onChange();
      return false;
    }
  }

  private onReading(slot: Slot, r: BikeReading) {
    const t = this.now();
    if (slot.role === "trainer") {
      if (r.watts !== undefined) this.power.feed(r.watts, t);
      if (r.cadence !== undefined) this.cadence = { v: r.cadence, at: t };
      // トレーナーが心拍を出していれば、心拍計がつながっていない時だけ使う
      if (r.heartRate !== undefined && r.heartRate > 0 && !this.slots.heart) this.heart = { v: r.heartRate, at: t, fromHeart: false };
    } else if (r.heartRate !== undefined) this.heart = { v: r.heartRate, at: t, fromHeart: true };
  }

  private onResponse(v: DataView) {
    const r = parseControlPointResponse(v);
    const w = this.waiter;
    if (!r || !w || r.op !== w.op) return;
    this.waiter = null;
    w.resolve(r.ok);
  }

  /** 制御の書き込みと応答待ち。1 つずつ送る */
  private writeControl(slot: Slot, bytes: Uint8Array, op: number): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      let done = false;
      const finish = (ok: boolean) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        if (this.waiter?.resolve === finish) this.waiter = null;
        resolve(ok);
      };
      const timer = setTimeout(() => finish(false), RESPONSE_TIMEOUT_MS);
      this.waiter = { op, resolve: finish };
      slot.device.write(BLE.ftms, BLE.ftmsControlPoint, bytes).catch(() => finish(false));
    });
  }
}
