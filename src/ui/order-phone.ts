// 配達アプリの画面（配達の草案 27・31 章）: スマートフォンの形（黒い縁・上の時刻と電波・電池の印・明るいアプリの画面・下のホームバー）。届いた注文が上から並び、それぞれの残りの時間の帯が縮んで、
// 期限が来ると薄くなって消える。押すと開いて「受ける」。見出しを押すと畳む（畳んだ時は件数だけ）。sim の状態は読むだけ。

import { platform } from "../platform/index.ts";
import { type DeliveryOrder, ORDER_KIND_LABELS, ORDER_SOURCE_LABELS } from "../shared/delivery.ts";
import { fmtDuration } from "./delivery-panel.ts";
import { chip, el, kpi, kpis, line, yen } from "./widgets.ts";

/** アプリの下のタブ（配達の草案 32 章）: 注文（届いた物の一覧）・配達中（持っている注文）・記録（今日と合わせての数） */
export type PhoneTab = "orders" | "active" | "record";
const PHONE_TABS: [PhoneTab, string][] = [
  ["orders", "注文"],
  ["active", "配達中"],
  ["record", "記録"],
];

/** 配達中・記録のタブの中身（src/game.ts が集める） */
export interface PhoneInfo {
  active: { no: number; phase: "pickup" | "dropoff"; target: string; reward: number; remaining: number; limit: number; heading: boolean }[];
  carry: number;
  today: { weekday: string; delivered: number; earned: number; onTime: number };
  total: { delivered: number; onTime: number; regulars: number };
  money: number;
  company: string | null;
}

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
  private clock: HTMLElement;
  private list: HTMLElement;
  private empty: HTMLElement;
  private rows = new Map<number, Row>();
  private selected: number | null = null;
  open = true;
  tab: PhoneTab = "orders";
  private pane: HTMLElement;
  private tabBtns = new Map<PhoneTab, HTMLButtonElement>();
  private paneKey = "";
  onAccept: (no: number) => void = () => {};
  /** 配達中のタブで「向かう」を押した（注文の番号） */
  onFocus: (no: number) => void = () => {};

  constructor(parent: HTMLElement) {
    this.root = h("div", "phone hidden", "", parent);
    const screen = h("div", "phone-screen", "", this.root);
    // 上の帯: 世界の時刻・カメラの穴・電波と電池の印（印は飾り）
    const status = h("div", "phone-status", "", screen);
    this.clock = h("span", "phone-clock", "", status);
    h("span", "phone-island", "", status);
    const icons = h("span", "phone-icons", "", status);
    const signal = h("span", "phone-signal", "", icons);
    for (let i = 0; i < 4; i++) h("i", "", "", signal);
    h("span", "phone-battery", "", icons);
    this.head = h("button", "phone-head", "", screen);
    this.head.type = "button";
    this.head.setAttribute("aria-label", "配達アプリを開く・畳む");
    h("span", "phone-app-icon", "", this.head);
    h("span", "phone-title", "配達アプリ", this.head);
    this.count = h("span", "phone-count", "", this.head);
    this.state = h("span", "phone-state", "", this.head);
    this.head.addEventListener("click", () => this.setOpen(!this.open));
    this.list = h("div", "phone-list", "", screen);
    this.empty = h("div", "phone-empty", "", this.list);
    // 配達中・記録のタブの中身（一覧と同じ所に、どちらかを出す）
    this.pane = h("div", "phone-list phone-pane hidden", "", screen);
    const bar = h("div", "phone-tabs", "", screen);
    for (const [k, label] of PHONE_TABS) {
      const b = h("button", `phone-tab tab-${k}`, "", bar);
      b.type = "button";
      h("span", "phone-tab-icon", "", b);
      h("span", "phone-tab-label", label, b);
      b.addEventListener("click", () => this.setTab(k));
      this.tabBtns.set(k, b);
    }
    h("div", "phone-home", "", screen);
    this.setTab("orders");
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

  /** タブを選ぶ */
  setTab(t: PhoneTab) {
    this.tab = t;
    for (const [k, b] of this.tabBtns) b.classList.toggle("selected", k === t);
    this.list.classList.toggle("hidden", t !== "orders");
    this.pane.classList.toggle("hidden", t === "orders");
    this.paneKey = "";
    if (t !== "orders" && this.lastInfo) this.setInfo(this.lastInfo);
  }

  private lastInfo: PhoneInfo | null = null;

  /** 配達中・記録のタブの中身。選んでいるタブで、中身が変わった時だけ描き直す */
  setInfo(info: PhoneInfo) {
    this.lastInfo = info;
    const ab = this.tabBtns.get("active")!;
    const n = info.active.length;
    ab.dataset.badge = n ? String(n) : "";
    if (this.tab === "orders" || !this.open) return;
    const key = this.tab === "active" ? JSON.stringify(info.active.map((a) => [a.no, a.phase, a.heading, Math.floor(a.remaining)])) : JSON.stringify([info.today, info.total, Math.round(info.money)]);
    if (key === this.paneKey) return;
    this.paneKey = key;
    const p = this.pane;
    const top = p.scrollTop;
    p.replaceChildren();
    if (this.tab === "active") {
      if (!n) el("div", "phone-empty", `持っている注文は無い（同時に ${info.carry} 件まで）`, p);
      for (const a of info.active) {
        const card = el("div", `phone-item phone-active${a.heading ? " heading" : ""}`, "", p);
        const top = el("div", "phone-top", "", card);
        el("span", "phone-reward", yen(a.reward), top);
        chip(top, a.phase === "pickup" ? "受け取り" : "届け先", a.phase === "pickup" ? "warn" : "good");
        const left = el("span", "phone-remain", `残り ${fmtDuration(a.remaining)}`, top);
        if (a.remaining < 60) left.classList.add("late");
        el("div", "phone-line", a.target, card);
        const track = el("div", "phone-track", "", card);
        el("div", "phone-bar", "", track).style.transform = `scaleX(${Math.max(0, Math.min(1, a.remaining / Math.max(1, a.limit)))})`;
        if (!a.heading) {
          const go = el("button", "btn delivery-primary phone-ok phone-go", "こちらへ向かう", card);
          go.type = "button";
          go.addEventListener("click", () => this.onFocus(a.no));
        } else el("div", "phone-line phone-limit", "向かっている", card);
      }
    } else {
      const k = kpis(p);
      k.classList.add("phone-kpis");
      kpi(k, `今日（${info.today.weekday}）`, yen(info.today.earned), `${info.today.delivered} 件`);
      kpi(k, "所持金", yen(info.money), info.company ?? "");
      const box = el("div", "phone-item phone-record", "", p);
      line(box, "今日 届けた", `${info.today.delivered} 件（期限内 ${info.today.onTime} 件）`);
      line(box, "合わせて 届けた", `${info.total.delivered} 件`);
      line(box, "期限内", info.total.delivered ? `${Math.round((info.total.onTime / info.total.delivered) * 100)}%` : "−");
      line(box, "常連の店", `${info.total.regulars} 店`);
    }
    p.scrollTop = top;
  }

  /** 上の帯の時刻（世界の時計。「11:24」） */
  setClock(text: string) {
    if (this.clock.textContent !== text) this.clock.textContent = text;
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
