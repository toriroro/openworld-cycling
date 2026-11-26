// 画面の部品（配達の草案 32 章）: 数字の札（KPI）・棒（メーター）・小さな札（チップ）・日ごとの棒グラフ・見出しの欄。
// マイページ・経営の画面・配達アプリの画面で使う。文言は呼ぶ側が決める（操作・状態・事実情報だけ）。

export const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text = "", parent?: HTMLElement) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  parent?.appendChild(e);
  return e;
};

export type Tone = "plain" | "good" | "bad" | "warn" | "accent";

export const yen = (n: number) => `${Math.round(n).toLocaleString("ja-JP")} 円`;
export const signedYen = (n: number) => `${n >= 0 ? "+" : "−"}${Math.abs(Math.round(n)).toLocaleString("ja-JP")} 円`;

/** 見出しの付いた欄 */
export function section(parent: HTMLElement, title: string, right = ""): HTMLElement {
  const box = el("section", "w-section", "", parent);
  const head = el("div", "w-section-head", "", box);
  el("span", "w-section-title", title, head);
  if (right) el("span", "w-section-right", right, head);
  return box;
}

/** 数字の札を並べる枠（2〜4 列） */
export function kpis(parent: HTMLElement): HTMLElement {
  return el("div", "w-kpis", "", parent);
}

/** 数字の札: 小さな名前・大きな値・下の補足 */
export function kpi(parent: HTMLElement, label: string, value: string, sub = "", tone: Tone = "plain"): HTMLElement {
  const box = el("div", `w-kpi tone-${tone}`, "", parent);
  el("div", "w-kpi-label", label, box);
  el("div", "w-kpi-value", value, box);
  if (sub) el("div", "w-kpi-sub", sub, box);
  return box;
}

/** 棒: 名前・割合（0〜1）・右の値。割合で色を変える（低いと赤） */
export function meter(parent: HTMLElement, label: string, share: number, value: string, tone?: Tone): HTMLElement {
  const s = Math.max(0, Math.min(1, share));
  const t: Tone = tone ?? (s < 0.25 ? "bad" : s < 0.5 ? "warn" : "good");
  const row = el("div", `w-meter tone-${t}`, "", parent);
  el("span", "w-meter-label", label, row);
  const track = el("span", "w-meter-track", "", row);
  el("span", "w-meter-fill", "", track).style.width = `${Math.round(s * 100)}%`;
  el("span", "w-meter-value", value, row);
  return row;
}

/** 小さな札 */
export function chip(parent: HTMLElement, text: string, tone: Tone = "plain"): HTMLElement {
  return el("span", `w-chip tone-${tone}`, text, parent);
}

/** 名前と値の行（表の 1 行） */
export function line(parent: HTMLElement, label: string, value: string, tone: Tone = "plain"): HTMLElement {
  const row = el("div", `w-line tone-${tone}`, "", parent);
  el("span", "w-line-label", label, row);
  el("span", "w-line-value", value, row);
  return row;
}

/** 日ごとの棒グラフ（プラスは上へ緑、マイナスは下へ赤）。labels は棒の下の字 */
export function bars(parent: HTMLElement, values: number[], labels: string[], format: (v: number) => string): HTMLElement {
  const box = el("div", "w-bars", "", parent);
  const max = Math.max(1, ...values.map((v) => Math.abs(v)));
  const anyNeg = values.some((v) => v < 0);
  values.forEach((v, i) => {
    const col = el("div", "w-bar-col", "", box);
    col.title = `${labels[i]} ${format(v)}`;
    el("div", "w-bar-value", format(v), col);
    const area = el("div", `w-bar-area${anyNeg ? " has-neg" : ""}`, "", col);
    const bar = el("div", `w-bar ${v >= 0 ? "pos" : "neg"}`, "", area);
    bar.style.height = `${Math.max(2, (Math.abs(v) / max) * (anyNeg ? 50 : 100))}%`;
    el("div", "w-bar-label", labels[i], col);
  });
  return box;
}

/** 目標までの進み（今 / 目標） */
export function progress(parent: HTMLElement, label: string, now: number, goal: number, fmt: (n: number) => string): HTMLElement {
  return meter(parent, label, goal > 0 ? now / goal : 1, `${fmt(now)} / ${fmt(goal)}`, now >= goal ? "good" : "accent");
}
