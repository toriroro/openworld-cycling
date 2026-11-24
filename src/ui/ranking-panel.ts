// 順位と縄張り（配達の草案 14.5・18 章、D3）: 経済の場の業者とプレイヤーを、売上（1 週・1 か月）・従業員・商圏面積で並べる。
// 所属する業者を選べる。文言は操作・状態・事実情報だけ。

import { type Entity, KIND_LABELS, POLICY_LABELS, type Policy } from "../shared/economy.ts";

const h = <K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text = "", parent?: HTMLElement) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  parent?.appendChild(e);
  return e;
};

export type RankKey = "salesWeek" | "salesMonth" | "staff" | "area";
const KEYS: [RankKey, string][] = [
  ["salesWeek", "売上 1 週"],
  ["salesMonth", "売上 1 か月"],
  ["staff", "従業員"],
  ["area", "商圏面積"],
];

export interface RankingView {
  entities: Entity[];
  /** 昨日までの縄張り（商圏面積の差を出す） */
  yesterday: Entity[];
  /** 会社ごとの方針と営業所の数 */
  info: Map<string, { policy: Policy; depots: number }>;
  /** 所属・経営している業者の id（個人なら null） */
  company: string | null;
  /** 経営している（ほかの業者に入れない） */
  owns: boolean;
  /** 世界の日付の表示（「木曜」など）と、昨日から持ち主が変わった丁目の数 */
  weekday: string;
  changed: number;
}

const yen = (n: number) => `${Math.round(n / 1000).toLocaleString("ja-JP")} 千円`;
const ha = (m2: number) => `${(m2 / 10000).toFixed(1)} ha`;

export class RankingPanel {
  readonly root: HTMLElement;
  private title: HTMLElement;
  private note: HTMLElement;
  private tabs: HTMLElement;
  private list: HTMLElement;
  private key: RankKey = "area";
  private view: RankingView | null = null;
  onJoin: (id: string | null) => void = () => {};

  constructor() {
    this.root = h("div", "stamp-book ranking hidden");
    document.body.appendChild(this.root);
    const head = h("div", "stamp-head", "", this.root);
    this.title = h("div", "stamp-title", "順位", head);
    const close = h("button", "btn", "閉じる", head);
    close.type = "button";
    close.addEventListener("click", () => this.close());
    this.note = h("div", "ranking-note", "", this.root);
    this.tabs = h("div", "ranking-tabs", "", this.root);
    for (const [k, label] of KEYS) {
      const b = h("button", "btn ranking-tab", label, this.tabs);
      b.type = "button";
      b.dataset.key = k;
      b.addEventListener("click", () => {
        this.key = k;
        this.render();
      });
    }
    this.list = h("div", "stamp-list ranking-list", "", this.root);
  }

  get isOpen() {
    return !this.root.classList.contains("hidden");
  }

  open(v: RankingView) {
    this.view = v;
    this.render();
    this.root.classList.remove("hidden");
  }

  close() {
    this.root.classList.add("hidden");
  }

  private value(e: Entity): number {
    return this.key === "area" ? e.area : this.key === "staff" ? e.staff : e[this.key];
  }

  private render() {
    const v = this.view;
    if (!v) return;
    const mine = v.company ? v.entities.find((e) => e.id === v.company) : null;
    this.title.textContent = `順位  ${v.weekday}`;
    this.note.textContent = `${v.owns ? "経営" : "所属"} ${mine ? mine.name : "個人"}  昨日から持ち主が変わった丁目 ${v.changed}`;
    for (const b of this.tabs.children) (b as HTMLElement).classList.toggle("selected", (b as HTMLElement).dataset.key === this.key);
    const before = new Map(v.yesterday.map((e) => [e.id, e]));
    const rows = [...v.entities].sort((a, b) => this.value(b) - this.value(a));
    this.list.replaceChildren();
    rows.forEach((e, i) => {
      const me = e.kind === "player" || e.id === v.company;
      const item = h("div", `stamp-item ranking-item${me ? " mine" : ""}`, "", this.list);
      h("div", "ranking-rank", String(i + 1), item);
      const sw = h("span", "ranking-swatch", "", item);
      sw.style.background = e.color;
      const text = h("div", "stamp-text", "", item);
      const inf = v.info.get(e.id);
      h("div", "stamp-name", `${e.name}${e.id === v.company ? (v.owns ? "（経営）" : "（所属）") : ""}`, text);
      const prev = before.get(e.id);
      const dArea = prev ? e.area - prev.area : e.area;
      const meta = [
        e.kind === "player" ? "個人" : `${KIND_LABELS[e.kind]}  方針 ${inf ? POLICY_LABELS[inf.policy] : "—"}  営業所 ${inf?.depots ?? 0}`,
        `売上 1 週 ${yen(e.salesWeek)}  1 か月 ${yen(e.salesMonth)}`,
        `従業員 ${e.staff} 人  商圏 ${ha(e.area)}（${e.chomes} 丁目、昨日から ${dArea >= 0 ? "+" : "−"}${ha(Math.abs(dArea))}）`,
      ];
      for (const m of meta) h("div", "stamp-meta", m, text);
      if (e.kind !== "player" && !v.owns) {
        const join = h("button", "btn", e.id === v.company ? "やめる" : "入る", item);
        join.type = "button";
        join.addEventListener("click", () => this.onJoin(e.id === v.company ? null : e.id));
      }
    });
  }
}
