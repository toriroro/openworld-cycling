// Bluetooth の機器（トレーナー連携の草案 2.3、概要仕様 9.5 の 5）。ほかの所から navigator.bluetooth を直接呼ばない。
// ウェブ（PC と Android の Chrome・Edge）は Web Bluetooth。iOS アプリではネイティブのプラグインに差し替える。

import { BLE } from "../sim/trainer/ble-codec.ts";
import type { BleDevice } from "../sim/trainer/link.ts";

export type BluetoothKind = "trainer" | "heart";

export interface BluetoothPort {
  /** 使えるか（ブラウザが対応していない・https でない時は false） */
  readonly available: boolean;
  /** 機器を選ぶ画面を出す（押す操作の中から呼ぶ）。選ばなかったら null */
  choose(kind: BluetoothKind): Promise<BleDevice | null>;
}

// Web Bluetooth の型（TypeScript の DOM の型に無いので、使う所だけ）
interface WbCharacteristic extends EventTarget {
  value?: DataView;
  readValue(): Promise<DataView>;
  startNotifications(): Promise<WbCharacteristic>;
  writeValueWithResponse?(v: BufferSource): Promise<void>;
  writeValue(v: BufferSource): Promise<void>;
}
interface WbService {
  getCharacteristic(uuid: string): Promise<WbCharacteristic>;
}
interface WbServer {
  connected: boolean;
  connect(): Promise<WbServer>;
  disconnect(): void;
  getPrimaryService(uuid: string): Promise<WbService>;
}
interface WbDevice extends EventTarget {
  name?: string;
  gatt?: WbServer;
}
interface WbBluetooth {
  requestDevice(o: { filters: { services: string[] }[]; optionalServices?: string[] }): Promise<WbDevice>;
}

const SERVICES: Record<BluetoothKind, string[]> = {
  trainer: [BLE.ftms, BLE.power],
  heart: [BLE.heartRate],
};

class WebBleDevice implements BleDevice {
  onDisconnect: (() => void) | null = null;
  private server: WbServer | null = null;
  private chars = new Map<string, WbCharacteristic>();
  private closing = false;

  constructor(
    private dev: WbDevice,
    private wanted: string[],
  ) {
    dev.addEventListener("gattserverdisconnected", () => {
      this.server = null;
      this.chars.clear();
      if (!this.closing) this.onDisconnect?.();
    });
  }

  get name() {
    return this.dev.name || "名前の無い機器";
  }

  get connected() {
    return !!this.server?.connected;
  }

  async connect(): Promise<string[]> {
    if (!this.dev.gatt) throw new Error("GATT が使えない");
    this.closing = false;
    this.chars.clear();
    this.server = await this.dev.gatt.connect();
    const found: string[] = [];
    for (const s of this.wanted) {
      try {
        await this.server.getPrimaryService(s);
        found.push(s);
      } catch {
        /* 無いサービス */
      }
    }
    return found;
  }

  disconnect() {
    this.closing = true;
    try {
      this.dev.gatt?.disconnect();
    } catch {
      /* もう切れている */
    }
    this.server = null;
    this.chars.clear();
  }

  private async char(service: string, characteristic: string): Promise<WbCharacteristic> {
    const key = `${service}/${characteristic}`;
    const c = this.chars.get(key);
    if (c) return c;
    if (!this.server) throw new Error("つながっていない");
    const ch = await (await this.server.getPrimaryService(service)).getCharacteristic(characteristic);
    this.chars.set(key, ch);
    return ch;
  }

  async read(service: string, characteristic: string): Promise<DataView> {
    return (await this.char(service, characteristic)).readValue();
  }

  async subscribe(service: string, characteristic: string, fn: (v: DataView) => void): Promise<void> {
    const c = await this.char(service, characteristic);
    c.addEventListener("characteristicvaluechanged", () => {
      if (c.value) fn(c.value);
    });
    await c.startNotifications();
  }

  async write(service: string, characteristic: string, bytes: Uint8Array): Promise<void> {
    const c = await this.char(service, characteristic);
    const data = new Uint8Array(bytes);
    if (c.writeValueWithResponse) await c.writeValueWithResponse(data);
    else await c.writeValue(data);
  }
}

export function webBluetooth(): BluetoothPort {
  const nav = globalThis.navigator as (Navigator & { bluetooth?: WbBluetooth }) | undefined;
  const bt = nav?.bluetooth;
  const available = !!bt && (globalThis as { isSecureContext?: boolean }).isSecureContext !== false;
  return {
    available,
    async choose(kind) {
      if (!bt) return null;
      const services = SERVICES[kind];
      try {
        const dev = await bt.requestDevice({ filters: services.map((s) => ({ services: [s] })), optionalServices: services });
        return new WebBleDevice(dev, services);
      } catch (e) {
        // 選ぶ画面を閉じた時（NotFoundError）は null
        if (e instanceof DOMException && e.name === "NotFoundError") return null;
        throw e;
      }
    },
  };
}
