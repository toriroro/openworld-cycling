// 開発用の仮想トレーナー・心拍計（トレーナー連携の草案 2.3）。BleDevice の形で、実機と同じバイト列を出し入れする。
// 実機が無くても、接続 → 走行 → 切断 → つなぎ直しを通せる。一般の画面には出さない。

import {
  BLE,
  decodeSimulation,
  encodeControlPointResponse,
  encodeFtmsFeature,
  encodeIndoorBikeData,
  FTMS_OP,
  type SimulationParams,
} from "./ble-codec.ts";
import type { BleDevice } from "./link.ts";

type Listener = (v: DataView) => void;

export class VirtualDevice implements BleDevice {
  connected = false;
  onDisconnect: (() => void) | null = null;
  /** 漕ぐ出力 (W) */
  watts = 200;
  /** ケイデンス (rpm)。出力が 0 なら 0 */
  cadence = 85;
  /** 次の n 回の接続を失敗させる（つなぎ直しの確認用） */
  failConnects = 0;
  /** 受け取ったシミュレーションの値 */
  readonly received: SimulationParams[] = [];
  /** 制御を許さない（勾配を受け付けない機器の確認用） */
  refuseControl = false;
  private listeners = new Map<string, Listener>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private controlled = false;

  constructor(
    readonly kind: "trainer" | "heart",
    readonly name = kind === "trainer" ? "仮想トレーナー" : "仮想心拍計",
    /** 通知の間隔 (ms)。0 なら自分では送らない（テストが emit() を呼ぶ） */
    private interval = 250,
  ) {}

  async connect(): Promise<string[]> {
    if (this.failConnects > 0) {
      this.failConnects--;
      throw new Error("接続できない（仮想）");
    }
    this.connected = true;
    this.controlled = false;
    if (this.interval > 0 && !this.timer) this.timer = setInterval(() => this.emit(), this.interval);
    return this.kind === "trainer" ? [BLE.ftms] : [BLE.heartRate];
  }

  disconnect() {
    this.connected = false;
    this.listeners.clear();
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** 機器の側から切れたことにする（電源を切った・離れた） */
  drop() {
    if (!this.connected) return;
    this.disconnect();
    this.onDisconnect?.();
  }

  async read(service: string, characteristic: string): Promise<DataView> {
    if (!this.connected) throw new Error("つながっていない");
    if (service === BLE.ftms && characteristic === BLE.ftmsFeature) return view(encodeFtmsFeature(true));
    throw new Error("読めない特性");
  }

  async subscribe(service: string, characteristic: string, fn: Listener): Promise<void> {
    if (!this.connected) throw new Error("つながっていない");
    this.listeners.set(`${service}/${characteristic}`, fn);
  }

  async write(service: string, characteristic: string, bytes: Uint8Array): Promise<void> {
    if (!this.connected) throw new Error("つながっていない");
    if (service !== BLE.ftms || characteristic !== BLE.ftmsControlPoint) throw new Error("書けない特性");
    const op = bytes[0];
    let result = 1;
    if (op === FTMS_OP.requestControl) {
      if (this.refuseControl) result = 5;
      else this.controlled = true;
    } else if (!this.controlled) result = 5;
    else if (op === FTMS_OP.simulation) {
      const p = decodeSimulation(view(bytes));
      if (p) this.received.push(p);
    }
    // 応答は書き込みの後に通知で返る
    const fn = this.listeners.get(`${BLE.ftms}/${BLE.ftmsControlPoint}`);
    queueMicrotask(() => fn?.(view(encodeControlPointResponse(op, result))));
  }

  /** 最後に受け取った勾配（割合） */
  get grade(): number | null {
    return this.received.length ? this.received[this.received.length - 1].grade : null;
  }

  /** 通知を 1 回送る */
  emit() {
    if (!this.connected) return;
    if (this.kind === "trainer") {
      const fn = this.listeners.get(`${BLE.ftms}/${BLE.indoorBikeData}`);
      fn?.(view(encodeIndoorBikeData({ speedKmh: 0, cadence: this.watts > 0 ? this.cadence : 0, watts: this.watts })));
    } else {
      const fn = this.listeners.get(`${BLE.heartRate}/${BLE.heartRateMeasurement}`);
      fn?.(view(new Uint8Array([0, Math.round(110 + this.watts / 5)])));
    }
  }
}

const view = (b: Uint8Array) => new DataView(b.buffer, b.byteOffset, b.byteLength);
