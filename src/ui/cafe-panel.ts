// 喫茶店の立ち寄りの表示とスタンプ帳（モック仕様 7.1）。文言は操作・状態・事実情報だけ。

import type { Stamp } from "../shared/save.ts";

const h = <K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text = "", parent?: HTMLElement) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  parent?.appendChild(e);
  return e;
};

/** 立ち寄りの表示: 店名、標高、初めて来た日付、スタンプの数、「出発」 */
export class StopPanel {
  readonly root: HTMLElement;
  private nameEl: HTMLElement;
  private rows: HTMLElement;
  onDepart: () => void = () => {};

  constructor() {
    this.root = h("div", "stop-panel hidden");
    document.body.appendChild(this.root);
    this.nameEl = h("div", "stop-name", "", this.root);
    this.rows = h("dl", "stop-rows", "", this.root);
    const b = h("button", "btn stop-depart", "出発", this.root);
    b.type = "button";
    b.addEventListener("click", () => this.onDepart());
  }

  /** landmarks: 名所の立ち寄りの時の、行った名所の数と全部の数 */
  show(stamp: Stamp, total: number, landmarks?: { done: number; all: number }) {
    this.nameEl.textContent = stamp.name;
    this.rows.replaceChildren();
    const row = (k: string, v: string) => {
      h("dt", "", k, this.rows);
      h("dd", "", v, this.rows);
    };
    row("標高", `${Math.round(stamp.elevation)} m`);
    row("初めて来た日", stamp.date);
    row("来た回数", `${stamp.visits} 回`);
    if (landmarks) row("名所", `${landmarks.done} / ${landmarks.all}`);
    else row("スタンプ", `${total} 個`);
    this.root.classList.remove("hidden");
  }

  hide() {
    this.root.classList.add("hidden");
  }

  get visible() {
    return !this.root.classList.contains("hidden");
  }
}

/** スタンプ帳: 立ち寄った店の一覧。店を選ぶとそこから走る */
export class StampBook {
  readonly root: HTMLElement;
  private list: HTMLElement;
  onPick: (s: Stamp) => void = () => {};

  constructor() {
    this.root = h("div", "stamp-book hidden");
    document.body.appendChild(this.root);
    const head = h("div", "stamp-head", "", this.root);
    h("div", "stamp-title", "スタンプ帳", head);
    const close = h("button", "btn", "閉じる", head);
    close.type = "button";
    close.addEventListener("click", () => this.close());
    this.list = h("div", "stamp-list", "", this.root);
  }

  get isOpen() {
    return !this.root.classList.contains("hidden");
  }

  open(stamps: Stamp[]) {
    this.list.replaceChildren();
    if (!stamps.length) h("div", "stamp-empty", "立ち寄った店はまだない", this.list);
    for (const s of stamps) {
      const item = h("div", "stamp-item", "", this.list);
      const text = h("div", "stamp-text", "", item);
      h("div", "stamp-name", s.name, text);
      h("div", "stamp-meta", `${s.date}  標高 ${Math.round(s.elevation)} m  ${s.visits} 回`, text);
      const go = h("button", "btn", "ここから走る", item);
      go.type = "button";
      go.addEventListener("click", () => {
        this.close();
        this.onPick(s);
      });
    }
    this.root.classList.remove("hidden");
  }

  close() {
    this.root.classList.add("hidden");
  }
}
