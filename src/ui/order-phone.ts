// 配達アプリの画面（配達の草案 27 章）: 右上に置くスマートフォンのような枠。届いた注文が上から並び、それぞれの残りの時間の帯が縮んで、
// 期限が来ると薄くなって消える。押すと開いて「受ける」。見出しを押すと畳む（畳んだ時は件数だけ）。sim の状態は読むだけ。

import { platform } from "../platform/index.ts";
import { type DeliveryOrder, ORDER_KIND_LABELS, ORDER_SOURCE_LABELS } from "../shared/delivery.ts";
import { fmtDuration } from "./delivery-panel.ts";

const h = <K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text = "", parent?: HTMLElement) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  parent?.appendChild(e);
  return e;
};
const km = (m: number) => `${(m / 1000).toFixed(1)} km`;
const OPEN_KEY = "phone-open";

export interface PhoneItem {
  order: DeliveryOrder;
  /** 一覧から消えるまで (s) と、載っている長さ (s) */
  remain: number;
  life: number;
  /** 今いる所から受け取りまでの直線 (m) */
  fromHere: number;
  /** 受けられない理由（持てる数・装備） */
  block: string | null;
  /** 目の前の頼み事・家からの発送（止まった所で頼まれた。消える時間の帯を出さない。配達の草案 30 章） */
  here?: boolean;
}

interface Row {
  root: HTMLElement;
  bar: HTMLElement;
  remain: HTMLElement;
  from: HTMLElement;
  ok: HTMLButtonElement;
  why: HTMLElement;
  gone: boolean;
}

export class OrderPhone {
  readonly root: HTMLElement;
  private head: HTMLButtonElement;
  private count: HTMLElement;
  private state: HTMLElement;
  private list: HTMLElement;
  private empty: HTMLElement;
  private rows = new Map<number, Row>();
  private selected: number | null = null;
  open = true;
  onAccept: (no: number) => void = () => {};

  constructor(parent: HTMLElement) {
    this.root = h("div", "phone hidden", "", parent);
    h("div", "phone-notch", "", this.root);
    this.head = h("button", "phone-head", "", this.root);
    this.head.type = "button";
    h("span", "phone-title", "配達アプリ", this.head);
    this.count = h("span", "phone-count", "", this.head);
    this.state = h("span", "phone-state", "", this.head);
    this.head.addEventListener("click", () => this.setOpen(!this.open));
    this.list = h("div", "phone-list", "", this.root);
    this.empty = h("div", "phone-empty", "", this.list);
    // 既定は大きな画面で開き、スマホの大きさでは畳む。端末に覚える
    this.setOpen(innerWidth >= 700 && innerHeight >= 500, false);
    void platform.storage.load(OPEN_KEY).then((t) => {
      if (t === "1" || t === "0") this.setOpen(t === "1", false);
    });
  }

  setOpen(on: boolean, remember = true) {
    this.open = on;
    this.root.classList.toggle("folded", !on);
    if (remember) void platform.storage.save(OPEN_KEY, on ? "1" : "0");
  }

  show(on: boolean) {
    this.root.classList.toggle("hidden", !on);
  }

  /** 一覧を描き直す（届いた物を足し、消えた物を薄くしてから外す） */
  update(items: PhoneItem[], note: string) {
    const n = items.length;
    const c = n ? `${n} 件` : "";
    if (this.count.textContent !== c) this.count.textContent = c;
    if (this.state.textContent !== note) this.state.textContent = note;
    this.root.classList.toggle("has-items", n > 0);
    const emptyText = n ? "" : note ? note : "注文を待っている";
    if (this.empty.textContent !== emptyText) this.empty.textContent = emptyText;
    this.empty.classList.toggle("hidden", n > 0);
    const live = new Set(items.map((x) => x.order.no));
    for (const [no, r] of this.rows) {
      if (live.has(no) || r.gone) continue;
      // 期限が来た・受けた: 薄くしてから外す
      r.gone = true;
      r.root.classList.add("gone");
      setTimeout(() => {
        r.root.remove();
        this.rows.delete(no);
      }, 450);
      if (this.selected === no) this.selected = null;
    }
    let prev: HTMLElement | null = null;
    for (const it of items) {
      let r = this.rows.get(it.order.no);
      if (!r || r.gone) {
        r = this.makeRow(it.order);
        this.rows.set(it.order.no, r);
        // 新しい物は上（prev の後ろ、無ければ先頭）
        if (prev) prev.after(r.root);
        else this.list.prepend(r.root);
      }
      prev = r.root;
      const left = it.here ? "目の前" : `残り ${fmtDuration(it.remain)}`;
      if (r.remain.textContent !== left) r.remain.textContent = left;
      r.bar.style.transform = `scaleX(${it.here ? 1 : Math.max(0, Math.min(1, it.remain / it.life))})`;
      r.root.classList.toggle("soon", !it.here && it.remain < 15);
      r.root.classList.toggle("here", !!it.here);
      const from = it.order.pickedAtStart ? "受け取り その場で" : `受け取り ${it.order.pickup.name}  ${km(it.fromHere)}`;
      if (r.from.textContent !== from) r.from.textContent = from;
      r.ok.disabled = !!it.block;
      const why = it.block ?? "";
      if (r.why.textContent !== why) r.why.textContent = why;
      r.root.classList.toggle("open", this.selected === it.order.no);
    }
  }

  private makeRow(o: DeliveryOrder): Row {
    const root = h("div", "phone-item new");
    setTimeout(() => root.classList.remove("new"), 600);
    const top = h("div", "phone-top", "", root);
    h("span", "phone-reward", `${o.reward} 円`, top);
    h("span", "phone-kind", o.source === "app" ? ORDER_KIND_LABELS[o.kind] : `${ORDER_KIND_LABELS[o.kind]}・${ORDER_SOURCE_LABELS[o.source]}`, top);
    if (o.big) h("span", "phone-kind", "大きめ", top);
    const remain = h("span", "phone-remain", "", top);
    const from = h("div", "phone-line", "", root);
    h("div", "phone-line", `届け先 ${o.dropoff.name}  ${km(o.distance)}`, root);
    h("div", "phone-line phone-limit", `期限 ${fmtDuration(o.limit)}`, root);
    const track = h("div", "phone-track", "", root);
    const bar = h("div", "phone-bar", "", track);
    const act = h("div", "phone-act", "", root);
    const ok = h("button", "btn delivery-primary phone-ok", "受ける", act);
    ok.type = "button";
    ok.addEventListener("click", (e) => {
      e.stopPropagation();
      this.onAccept(o.no);
    });
    const why = h("div", "phone-why", "", act);
    root.addEventListener("click", () => {
      this.selected = this.selected === o.no ? null : o.no;
      for (const [no, r] of this.rows) r.root.classList.toggle("open", this.selected === no);
    });
    return { root, bar, remain, from, ok, why, gone: false };
  }
}
