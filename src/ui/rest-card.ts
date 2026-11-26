// 立ち寄る所の札（配達の草案 28・29 章）: 自販機・店・自転車店・車の整備の前で止まると出る。
// 品・頼める事ごとに値段・効き目・かかる時間と、押す釦。文言は操作・状態・事実情報だけ。中身は src/game.ts が作る。

import type { RestStop } from "../shared/rest-stops.ts";

const h = <K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text = "", parent?: HTMLElement) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  parent?.appendChild(e);
  return e;
};

/** 札の 1 行（押せる釦） */
export interface CardEntry {
  name: string;
  price: string;
  /** 効き目とかかる時間 */
  gain: string;
  /** 押せない理由（null なら押せる） */
  why: string | null;
  onClick: () => void;
}

export function fmtSeconds(s: number): string {
  return s < 60 ? `${s} 秒` : `${Math.round(s / 60)} 分`;
}

export class RestCard {
  readonly root: HTMLElement;
  private title: HTMLElement;
  private state: HTMLElement;
  private rows: HTMLElement;
  private list: HTMLElement;
  private note: HTMLElement;
  /** いま出している所 */
  stop: RestStop | null = null;
  onClose: () => void = () => {};

  constructor(parent: HTMLElement) {
    this.root = h("div", "offer-card rest-card hidden", "", parent);
    const head = h("div", "offer-head", "", this.root);
    this.title = h("span", "offer-title", "", head);
    this.state = h("span", "offer-timer", "", head);
    this.rows = h("dl", "stop-rows rest-rows", "", this.root);
    this.list = h("div", "rest-items", "", this.root);
    this.note = h("div", "rest-note", "", this.root);
    const btns = h("div", "delivery-buttons", "", this.root);
    const close = h("button", "btn", "閉じる", btns);
    close.type = "button";
    close.addEventListener("click", () => this.onClose());
  }

  get isOpen() {
    return !this.root.classList.contains("hidden");
  }

  /** 出す・出し直す。state は見出しの右、rows は具合などの行、entries は押せる釦の並び */
  show(stop: RestStop, state: string, rows: [string, string][], entries: CardEntry[], note = "") {
    this.stop = stop;
    this.title.textContent = stop.name;
    this.state.textContent = state;
    this.rows.replaceChildren();
    for (const [k, v] of rows) {
      h("dt", "", k, this.rows);
      h("dd", "", v, this.rows);
    }
    this.list.replaceChildren();
    for (const e of entries) {
      const b = h("button", "btn rest-item", "", this.list);
      b.type = "button";
      b.disabled = !!e.why;
      h("span", "rest-name", e.name, b);
      h("span", "rest-price", e.price, b);
      if (e.gain) h("span", "rest-gain", e.gain, b);
      if (e.why) h("span", "rest-why", e.why, b);
      b.addEventListener("click", e.onClick);
    }
    this.note.textContent = note;
    this.root.classList.remove("hidden");
  }

  hide() {
    this.stop = null;
    this.root.classList.add("hidden");
  }
}
