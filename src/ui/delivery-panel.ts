// 配達の画面（配達の草案 13・15・16 章）。注文の表示、走っている間の行き先と残り時間、届けた結果、注文の知らせ。
// 文言は操作・状態・事実情報だけ。

import { type DeliveryOrder, type DeliveryResult, ORDER_KIND_LABELS, ORDER_SOURCE_LABELS } from "../shared/delivery.ts";

const h = <K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text = "", parent?: HTMLElement) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  parent?.appendChild(e);
  return e;
};

export function fmtDuration(s: number): string {
  const neg = s < 0;
  const t = Math.round(Math.abs(s));
  return `${neg ? "−" : ""}${Math.floor(t / 60)}:${String(t % 60).padStart(2, "0")}`;
}

const km = (m: number) => `${(m / 1000).toFixed(1)} km`;

/** 注文と結果の表示（左下。立ち寄りの表示と同じ形） */
export class DeliveryPanel {
  readonly root: HTMLElement;
  private title: HTMLElement;
  private rows: HTMLElement;
  private buttons: HTMLElement;
  onAccept: () => void = () => {};
  onOther: () => void = () => {};
  onClose: () => void = () => {};
  onMove: () => void = () => {};
  /** 受けている注文の i 件目をやめる・そちらへ向かう（リアキャリアで 2 件持てる。配達の草案 22.6 の 49） */
  onCancel: (i: number) => void = () => {};
  onFocus: (i: number) => void = () => {};
  /** リアキャリアを買う */
  onBuyGear: () => void = () => {};

  constructor() {
    this.root = h("div", "stop-panel delivery-panel hidden");
    document.body.appendChild(this.root);
    this.title = h("div", "stop-name", "", this.root);
    this.rows = h("dl", "stop-rows", "", this.root);
    this.buttons = h("div", "delivery-buttons", "", this.root);
  }

  get isOpen() {
    return !this.root.classList.contains("hidden");
  }

  private button(label: string, onClick: () => void, primary = false, disabled = false) {
    const b = h("button", `btn${primary ? " delivery-primary" : ""}`, label, this.buttons);
    b.type = "button";
    b.disabled = disabled;
    b.addEventListener("click", onClick);
  }

  private fill(title: string, rows: [string, string][]) {
    this.title.textContent = title;
    this.rows.replaceChildren();
    for (const [k, v] of rows) {
      h("dt", "", k, this.rows);
      h("dd", "", v, this.rows);
    }
    this.buttons.replaceChildren();
    this.root.classList.remove("hidden");
  }

  showOrder(o: DeliveryOrder, money: number) {
    this.fill("注文", [
      ["内容", ORDER_KIND_LABELS[o.kind]],
      ["受け取り", o.pickup.name],
      ["届け先", o.dropoff.name],
      ["受け取りまで", `直線 ${km(o.approach)}`],
      ["受け取りから届け先", `直線 ${km(o.distance)}`],
      ["期限", fmtDuration(o.limit)],
      ["報酬", `${o.reward} 円`],
      ["所持金", `${money} 円`],
    ]);
    this.button("受ける", () => this.onAccept(), true);
    this.button("ほかの注文", () => this.onOther());
    this.button("閉じる", () => this.onClose());
  }

  /** 受けている注文（メニューから開いた時）。先頭が向かっている注文。room ならもう 1 件受けられる */
  showActive(list: { o: DeliveryOrder; picked: boolean; remaining: number }[], room: boolean) {
    const rows: [string, string][] = [];
    list.forEach(({ o, picked, remaining }, i) => {
      const head = list.length > 1 ? `${i + 1} 件目${i === 0 ? "（向かっている）" : ""} ` : "";
      rows.push(
        [`${head}受け取り`, `${o.pickup.name}${picked ? "（済み）" : ""}`],
        [`${head}届け先`, o.dropoff.name],
        [`${head}残り`, `${fmtDuration(remaining)}  報酬 ${o.reward} 円`],
      );
    });
    this.fill("配達中", rows);
    this.button("閉じる", () => this.onClose(), true);
    for (let i = 1; i < list.length; i++) this.button(`${i + 1} 件目へ向かう`, () => this.onFocus(i));
    if (room) this.button("ほかの注文も受ける", () => this.onOther());
    list.forEach((_, i) => this.button(list.length > 1 ? `${i + 1} 件目をやめる` : "注文をやめる", () => this.onCancel(i)));
  }

  /** 自転車の装備（22.6 の 49） */
  showGear(gear: string, carry: number, money: number, price: number, has: boolean) {
    this.fill("装備", [
      ["今の装備", gear],
      ["同時に持てる注文", `${carry} 件`],
      ["大きめの小包（家からの発送）", has ? "運べる" : "リアキャリアが要る"],
      ["所持金", `${money} 円`],
    ]);
    if (!has) this.button(`リアキャリアを買う ${price.toLocaleString("ja-JP")} 円`, () => this.onBuyGear(), true, money < price);
    this.button("閉じる", () => this.onClose(), has);
  }

  /** 配達を受けられる範囲の外にいる */
  showOutside(area: string) {
    this.fill("注文", [["受けられる範囲", area]]);
    this.button("範囲へ移る", () => this.onMove(), true);
    this.button("閉じる", () => this.onClose());
  }

  showResult(r: DeliveryResult, money: number, count: number, onTime: number, extra: [string, string][] = []) {
    this.fill("届けた", [
      ["内容", `${ORDER_KIND_LABELS[r.order.kind]}（${ORDER_SOURCE_LABELS[r.order.source]}）`],
      ["届け先", r.order.dropoff.name],
      ["かかった時間", fmtDuration(r.elapsed)],
      ["期限", `${fmtDuration(r.order.limit)}${r.late ? "（遅れ）" : ""}`],
      ["走った距離", km(r.ridden)],
      ["報酬", `${r.reward} 円`],
      ["所持金", `${money} 円`],
      ["届けた数", `${count} 件（期限内 ${onTime} 件）`],
      ...extra,
    ]);
    this.button("次の注文", () => this.onOther(), true);
    this.button("閉じる", () => this.onClose());
  }

  hide() {
    this.root.classList.add("hidden");
  }
}

/** 走っている間の表示（左上、メニューの下）: いまの行き先の住所と残り時間、現在地の住所 */
export class DeliveryStrip {
  readonly root: HTMLElement;
  private target: HTMLElement;
  private time: HTMLElement;
  private note: HTMLElement;

  constructor(parent: HTMLElement) {
    this.root = h("div", "delivery-strip hidden", "", parent);
    this.target = h("div", "delivery-target", "", this.root);
    this.time = h("div", "delivery-time", "", this.root);
    this.note = h("div", "delivery-note", "", this.root);
  }

  update(st: { phase: "pickup" | "dropoff"; name: string; remaining: number; note: string; more?: number } | null) {
    this.root.classList.toggle("hidden", !st);
    if (!st) return;
    const t = `${st.phase === "pickup" ? "受け取り" : "届け先"} ${st.name}${st.more ? `（ほか ${st.more} 件）` : ""}`;
    if (this.target.textContent !== t) this.target.textContent = t;
    this.time.textContent = `残り ${fmtDuration(st.remaining)}`;
    this.time.classList.toggle("late", st.remaining < 0);
    if (this.note.textContent !== st.note) this.note.textContent = st.note;
  }
}

/**
 * 注文の知らせ（右上、U ターンの下）: 注文の要点と、受けるまでの残り秒（配達の草案 14.3）。
 * 配達アプリ・常連の店の知らせは時間で消え、道端の頼み事・家からの発送は離れるまで出しておく（秒は出さない）
 */
export class OfferCard {
  readonly root: HTMLElement;
  private body: HTMLElement;
  private title: HTMLElement;
  private timer: HTMLElement;
  private ok!: HTMLButtonElement;
  onAccept: () => void = () => {};
  onSkip: () => void = () => {};

  constructor(parent: HTMLElement) {
    this.root = h("div", "offer-card hidden", "", parent);
    const head = h("div", "offer-head", "", this.root);
    this.title = h("span", "offer-title", "配達アプリ", head);
    this.timer = h("span", "offer-timer", "", head);
    this.body = h("dl", "stop-rows offer-rows", "", this.root);
    const btns = h("div", "delivery-buttons", "", this.root);
    const ok = (this.ok = h("button", "btn delivery-primary", "受ける", btns));
    ok.type = "button";
    ok.addEventListener("click", () => this.onAccept());
    const no = h("button", "btn", "見送る", btns);
    no.type = "button";
    no.addEventListener("click", () => this.onSkip());
  }

  get isOpen() {
    return !this.root.classList.contains("hidden");
  }

  show(o: DeliveryOrder, fromHere: number, block: string | null = null) {
    this.body.replaceChildren();
    this.ok.disabled = !!block;
    this.title.textContent = ORDER_SOURCE_LABELS[o.source];
    this.timer.textContent = "";
    for (const [k, v] of [
      ["内容", ORDER_KIND_LABELS[o.kind]],
      ["受け取り", o.pickedAtStart ? "その場で" : `${o.pickup.name}  直線 ${km(fromHere)}`],
      ["届け先", `${o.dropoff.name}  直線 ${km(o.distance)}`],
      ["期限", fmtDuration(o.limit)],
      ["報酬", `${o.reward} 円`],
      ...(o.big ? [["大きさ", "大きめ"]] : []),
      ...(block ? [["受けられない", block]] : []),
    ]) {
      h("dt", "", k, this.body);
      h("dd", "", v, this.body);
    }
    this.root.classList.remove("hidden");
  }

  setTimer(s: number) {
    const t = `${Math.max(0, Math.ceil(s))} 秒`;
    if (this.timer.textContent !== t) this.timer.textContent = t;
  }

  hide() {
    this.root.classList.add("hidden");
  }
}
