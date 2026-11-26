// マイページ（配達の草案 32 章）: 今の自分の様子を一通り見る画面。メニューの上の列の「マイページ」から開く。
// 段（アルバイト・個人・経営）、お金と今日の稼ぎ、届けた件数、体の具合、自転車、装備、持っている注文、次の目標。
// 数字は src/game.ts が集めて渡す。この画面は表示だけ。文言は操作・状態・事実情報だけ。

import { chip, el, kpi, kpis, meter, progress, section, yen } from "./widgets.ts";

export interface MyPageInfo {
  /** 段の札（「アルバイト」「経営 ○○便（中堅）」など）と、その色 */
  stage: string;
  stageColor: string | null;
  /** 所持金（経営している時は業者の資金も） */
  money: number;
  companyCash: number | null;
  today: { weekday: string; delivered: number; earned: number };
  delivered: number;
  onTime: number;
  /** 常連になった店の数 */
  regulars: number;
  energy: number;
  legs: number;
  exhausted: boolean;
  care: { label: string; share: number }[];
  gear: string;
  carry: number;
  deliveries: { phase: "pickup" | "dropoff"; target: string; reward: number; remaining: number }[];
  /** 次の目標（開業の条件・次の段の人数など） */
  goal: { title: string; rows: { label: string; now: number; goal: number; unit: "yen" | "count" | "person" }[] } | null;
}

const fmtUnit = (u: "yen" | "count" | "person") => (n: number) => (u === "yen" ? yen(n) : u === "count" ? `${Math.round(n)} 件` : `${Math.round(n)} 人`);
const mmss = (s: number) => {
  const t = Math.max(0, Math.round(s));
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, "0")}`;
};

export class MyPage {
  readonly root: HTMLElement;
  private body: HTMLElement;
  private info: (() => MyPageInfo | null) | null = null;
  private timer = 0;

  constructor() {
    this.root = el("div", "stamp-book my-page hidden");
    document.body.appendChild(this.root);
    const head = el("div", "stamp-head", "", this.root);
    el("div", "stamp-title", "マイページ", head);
    const close = el("button", "btn", "閉じる", head);
    close.type = "button";
    close.addEventListener("click", () => this.close());
    this.body = el("div", "stamp-list my-page-body", "", this.root);
  }

  get isOpen() {
    return !this.root.classList.contains("hidden");
  }

  open(info: () => MyPageInfo | null) {
    this.info = info;
    this.render();
    this.root.classList.remove("hidden");
    clearInterval(this.timer);
    // 開いている間は 1 秒ごとに描き直す（残りの時間・体力が動く）
    this.timer = window.setInterval(() => this.render(), 1000);
  }

  close() {
    this.root.classList.add("hidden");
    clearInterval(this.timer);
  }

  private render() {
    const i = this.info?.();
    if (!i) return;
    const top = this.body.scrollTop;
    this.body.replaceChildren();
    const badge = el("div", "my-stage", "", this.body);
    const b = el("span", "w-badge", i.stage, badge);
    if (i.stageColor) {
      b.style.background = i.stageColor;
      b.style.color = "#fff";
    }

    const k = kpis(this.body);
    kpi(k, "所持金", yen(i.money), i.companyCash !== null ? `業者の資金 ${yen(i.companyCash)}` : "", "accent");
    kpi(k, `今日（${i.today.weekday}）の稼ぎ`, yen(i.today.earned), `${i.today.delivered} 件`, i.today.earned > 0 ? "good" : "plain");
    kpi(k, "届けた件数", `${i.delivered} 件`, `常連の店 ${i.regulars} 店`);
    kpi(k, "期限内", i.delivered ? `${Math.round((i.onTime / i.delivered) * 100)}%` : "−", `${i.onTime} 件`, i.delivered && i.onTime / i.delivered < 0.8 ? "bad" : "plain");

    const body = section(this.body, "体の具合", i.exhausted ? "脚が尽きた（20% まで抑える）" : "");
    meter(body, "体力", i.energy, `${Math.round(i.energy * 100)}%`);
    meter(body, "脚", i.legs, `${Math.round(i.legs * 100)}%`);

    const bike = section(this.body, "自転車", "直すのは自転車店");
    for (const c of i.care) meter(bike, c.label, c.share, `${Math.round(c.share * 100)}%`);
    const gear = el("div", "my-chips", "", bike);
    chip(gear, i.gear, "accent");
    chip(gear, `同時に ${i.carry} 件まで`);

    const dl = section(this.body, "持っている注文", `${i.deliveries.length} / ${i.carry} 件`);
    if (!i.deliveries.length) el("div", "w-note", "無い（配達アプリで受ける）", dl);
    for (const d of i.deliveries) {
      const card = el("div", "w-card", "", dl);
      const head = el("div", "w-card-head", "", card);
      chip(head, d.phase === "pickup" ? "受け取り" : "届け先", d.phase === "pickup" ? "warn" : "good");
      el("span", "w-card-title", d.target, head);
      el("span", "w-card-right", yen(d.reward), head);
      el("div", "w-note", `残り ${mmss(d.remaining)}`, card).classList.toggle("my-late", d.remaining < 60);
    }

    if (i.goal) {
      const g = section(this.body, "次の目標", i.goal.title);
      for (const r of i.goal.rows) progress(g, r.label, r.now, r.goal, fmtUnit(r.unit));
    }
    this.body.scrollTop = top;
  }
}
