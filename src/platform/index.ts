// 端末の機能の窓口（モック仕様 3.3、概要仕様 9.5 の 5）。保存・画面の常時点灯・振動・外部リンク・Bluetooth の機器。
// ほかの所から localStorage・navigator.wakeLock・navigator.vibrate・navigator.bluetooth を直接呼ばない。モックではウェブ用の実装だけを持つ。
// iOS アプリではこのファイルの中身をネイティブの実装に差し替える。

import { type BluetoothPort, webBluetooth } from "./bluetooth.ts";

export interface KeyValueStore {
  load(key: string): Promise<string | null>;
  save(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
}

export interface Platform {
  storage: KeyValueStore;
  /** 画面を消灯させない（on）／戻す（off）。使えない環境では何もしない */
  keepAwake(on: boolean): void;
  /** いま常時点灯が効いているか（確認用） */
  readonly awake: boolean;
  vibrate(ms: number): void;
  openExternal(url: string): void;
  /** トレーナー・心拍計（トレーナー連携の草案 2.3） */
  bluetooth: BluetoothPort;
  /** ファイルを端末に保存する（ウェブはダウンロード。iOS は共有の画面を後で。トレーナー連携の草案 6.2） */
  saveFile(name: string, bytes: Uint8Array, type: string): Promise<void>;
  /** API（/api/*）の接続先。ウェブ版は同じオリジン（""）。iOS アプリでは公開サイトを指す（概要仕様 9.5 の 6） */
  apiBase: string;
}

const PREFIX = "owc:";

/** ブラウザの保存領域。使えない（プライベートブラウズ・容量超過など）時は記憶だけに残す */
function webStorage(): KeyValueStore {
  const memory = new Map<string, string>();
  const ls = (): Storage | null => {
    try {
      return globalThis.localStorage ?? null;
    } catch {
      return null;
    }
  };
  return {
    async load(key) {
      try {
        const v = ls()?.getItem(PREFIX + key);
        if (v !== null && v !== undefined) return v;
      } catch {
        /* 読めなければ記憶から */
      }
      return memory.get(key) ?? null;
    },
    async save(key, value) {
      memory.set(key, value);
      try {
        ls()?.setItem(PREFIX + key, value);
      } catch {
        /* 書けなければ記憶だけ */
      }
    },
    async remove(key) {
      memory.delete(key);
      try {
        ls()?.removeItem(PREFIX + key);
      } catch {
        /* なし */
      }
    },
  };
}

interface WakeLockSentinelLike {
  release(): Promise<void>;
  addEventListener(type: "release", fn: () => void): void;
}

function webPlatform(): Platform {
  let want = false;
  let sentinel: WakeLockSentinelLike | null = null;
  const nav = globalThis.navigator as (Navigator & { wakeLock?: { request(type: "screen"): Promise<WakeLockSentinelLike> } }) | undefined;
  const acquire = async () => {
    if (!want || sentinel || !nav?.wakeLock || document.visibilityState !== "visible") return;
    try {
      const s = await nav.wakeLock.request("screen");
      sentinel = s;
      s.addEventListener("release", () => {
        if (sentinel === s) sentinel = null;
      });
    } catch {
      /* 使えない・許されない時は何もしない */
    }
  };
  // タブが隠れると常時点灯は外れるので、戻った時に取り直す
  if (typeof document !== "undefined") document.addEventListener("visibilitychange", () => void acquire());
  return {
    storage: webStorage(),
    keepAwake(on) {
      want = on;
      if (on) void acquire();
      else if (sentinel) {
        const s = sentinel;
        sentinel = null;
        void s.release().catch(() => undefined);
      }
    },
    get awake() {
      return sentinel !== null;
    },
    vibrate(ms) {
      try {
        nav?.vibrate?.(ms);
      } catch {
        /* 振動なし */
      }
    },
    openExternal(url) {
      globalThis.open?.(url, "_blank", "noopener");
    },
    bluetooth: webBluetooth(),
    apiBase: "",
    async saveFile(name, bytes, type) {
      const url = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type }));
      const a = document.createElement("a");
      a.href = url;
      a.download = name;
      a.style.display = "none";
      document.body.appendChild(a);
      a.click();
      a.remove();
      // ダウンロードが始まるまで待ってから消す
      setTimeout(() => URL.revokeObjectURL(url), 10000);
    },
  };
}

export const platform: Platform = webPlatform();
