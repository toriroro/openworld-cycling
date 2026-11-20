// トレーナーの画面（トレーナー連携の草案 5章）: 機器の接続と状態、効き、体重・機材、分岐の選び方。
// 文言は操作・状態・事実情報だけ。機器の状態は Game から受けて表示するだけ。

import { BIKE_MASS, BODY_MASS } from "../shared/save.ts";
import type { DeviceRole, SlotInfo } from "../sim/trainer/link.ts";

const h = <K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text = "", parent?: HTMLElement) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  parent?.appendChild(e);
  return e;
};

export interface TrainerSettings {
  effect: number;
  bodyMass: number;
  bikeMass: number;
  route: "manual" | "follow" | "unridden";
}

export interface TrainerView {
  available: boolean;
  trainer: SlotInfo | null;
  heart: SlotInfo | null;
  /** 出力の通知が来ているか */
  signal: boolean;
  /** 選ぶ画面を出している・最初の接続の途中の役割 */
  busy: DeviceRole | null;
  /** 最後の失敗（無ければ空） */
  error: string;
}

const ROLE_LABEL: Record<DeviceRole, string> = { trainer: "トレーナー", heart: "心拍計" };

function stateText(role: DeviceRole, s: SlotInfo, signal: boolean): string {
  if (s.state === "connecting") return "接続している";
  if (s.state === "reconnecting") return "切れた。再接続を待っている";
  if (role === "heart") return "接続中";
  if (s.kind === "power") return signal ? "接続中（パワーメーター。勾配は送らない）" : "接続中・出力の信号なし";
  if (!s.control) return signal ? "接続中（勾配を受け付けない）" : "接続中・出力の信号なし";
  return signal ? "接続中" : "接続中・出力の信号なし";
}

export class TrainerPanel {
  readonly root: HTMLElement;
  private rows = {} as Record<DeviceRole, { name: HTMLElement; state: HTMLElement; connect: HTMLButtonElement; drop: HTMLButtonElement; virtual: HTMLButtonElement | null }>;
  private note: HTMLElement;
  private els: { effect: HTMLInputElement; effectOut: HTMLElement; body: HTMLInputElement; bodyOut: HTMLElement; bike: HTMLInputElement; bikeOut: HTMLElement; route: HTMLSelectElement };
  onConnect: (role: DeviceRole) => void = () => {};
  onDisconnect: (role: DeviceRole) => void = () => {};
  /** 開発用: 仮想の機器をつなぐ */
  onVirtual: ((role: DeviceRole) => void) | null = null;
  onSettings: (s: Partial<TrainerSettings>) => void = () => {};

  constructor(settings: TrainerSettings, dev: boolean) {
    this.root = h("div", "stamp-book trainer-panel hidden");
    document.body.appendChild(this.root);
    const head = h("div", "stamp-head", "", this.root);
    h("div", "stamp-title", "トレーナー", head);
    const close = h("button", "btn", "閉じる", head);
    close.type = "button";
    close.addEventListener("click", () => this.close());
    const body = h("div", "stamp-list", "", this.root);
    this.note = h("div", "trainer-note hidden", "", body);
    for (const role of ["trainer", "heart"] as const) {
      const item = h("div", "stamp-item", "", body);
      const text = h("div", "stamp-text", "", item);
      h("div", "stamp-name", ROLE_LABEL[role], text);
      const name = h("div", "stamp-meta", "", text);
      const state = h("div", "stamp-meta", "未接続", text);
      const btns = h("div", "landmark-btns", "", item);
      const connect = h("button", "btn", "つなぐ", btns);
      connect.type = "button";
      connect.addEventListener("click", () => this.onConnect(role));
      const drop = h("button", "btn", "外す", btns);
      drop.type = "button";
      drop.addEventListener("click", () => this.onDisconnect(role));
      let virtual: HTMLButtonElement | null = null;
      if (dev) {
        virtual = h("button", "btn", "仮想（開発用）", btns);
        virtual.type = "button";
        virtual.addEventListener("click", () => this.onVirtual?.(role));
      }
      this.rows[role] = { name, state, connect, drop, virtual };
    }
    const settingsBox = h("div", "trainer-settings", "", body);
    const row = (label: string) => {
      const r = h("label", "menu-row", "", settingsBox);
      h("span", "", label, r);
      return r;
    };
    const range = (r: HTMLElement, min: number, max: number, step: number, value: number, fmt: (v: number) => string, on: (v: number) => void) => {
      const e = h("input", "", "", r);
      e.type = "range";
      e.min = String(min);
      e.max = String(max);
      e.step = String(step);
      e.value = String(value);
      const out = h("span", "menu-value", fmt(value), r);
      e.addEventListener("input", () => {
        out.textContent = fmt(Number(e.value));
        on(Number(e.value));
      });
      return { e, out };
    };
    const pct = (v: number) => `${v}%`;
    const kg = (v: number) => `${v} kg`;
    const ef = range(row("勾配の効き"), 0, 100, 10, Math.round(settings.effect * 100), pct, (v) => this.onSettings({ effect: v / 100 }));
    const bm = range(row("体重"), BODY_MASS.min, BODY_MASS.max, 1, settings.bodyMass, kg, (v) => this.onSettings({ bodyMass: v }));
    const bk = range(row("機材の重さ"), BIKE_MASS.min, BIKE_MASS.max, 0.5, settings.bikeMass, kg, (v) => this.onSettings({ bikeMass: v }));
    const rr = row("分岐");
    const route = h("select", "", "", rr);
    for (const [v, l] of [
      ["manual", "自分で選ぶ"],
      ["follow", "道なり"],
      ["unridden", "未走行の道を優先"],
    ] as const) {
      const o = h("option", "", l, route);
      o.value = v;
    }
    route.value = settings.route;
    route.addEventListener("change", () => this.onSettings({ route: route.value as TrainerSettings["route"] }));
    h("div", "stamp-meta trainer-foot", "勾配の効きはトレーナーの重さだけを変える。速度は実際の勾配で計算する。体重と機材の重さは手動・眺めるにも効く。", body);
    this.els = { effect: ef.e, effectOut: ef.out, body: bm.e, bodyOut: bm.out, bike: bk.e, bikeOut: bk.out, route };
  }

  get isOpen() {
    return !this.root.classList.contains("hidden");
  }

  open() {
    this.root.classList.remove("hidden");
  }

  close() {
    this.root.classList.add("hidden");
  }

  sync(s: TrainerSettings) {
    this.els.effect.value = String(Math.round(s.effect * 100));
    this.els.effectOut.textContent = `${Math.round(s.effect * 100)}%`;
    this.els.body.value = String(s.bodyMass);
    this.els.bodyOut.textContent = `${s.bodyMass} kg`;
    this.els.bike.value = String(s.bikeMass);
    this.els.bikeOut.textContent = `${s.bikeMass} kg`;
    this.els.route.value = s.route;
  }

  update(v: TrainerView) {
    this.note.classList.toggle("hidden", v.available && !v.error);
    this.note.textContent = !v.available ? "このブラウザは Bluetooth に対応していない（PC・Android の Chrome か Edge で使える）" : v.error ? `接続できなかった: ${v.error}` : "";
    for (const role of ["trainer", "heart"] as const) {
      const r = this.rows[role];
      const s = v[role];
      r.name.textContent = s ? s.name : "";
      r.state.textContent = v.busy === role ? "接続している" : s ? stateText(role, s, v.signal) : "未接続";
      r.connect.disabled = !v.available || v.busy !== null;
      r.connect.textContent = s ? "選び直す" : "つなぐ";
      r.drop.disabled = !s;
      if (r.virtual) r.virtual.disabled = v.busy !== null;
    }
  }
}
