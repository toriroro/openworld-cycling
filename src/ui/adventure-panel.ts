// 冒険の画面（冒険の草案 5 章）: 冒険の残り、取り込んだ記録、記録の取り込み（ファイルを選ぶ → 一覧で確かめる → 取り込む）、旅に出る、自由にする。
// 文言は操作・状態・事実情報だけ。帳簿の計算は Game と sim/adventure.ts が行い、ここは表示と押した操作を伝えるだけ。

import { type ImportedActivity, type Sport, SPORT_LABELS } from "../sim/adventure.ts";

const h = <K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text = "", parent?: HTMLElement) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  parent?.appendChild(e);
  return e;
};

export interface AdventureView {
  /** 冒険で始めた世界か（自由で始めた世界は null） */
  mode: "free" | "adventure" | null;
  balance: number;
  spent: number;
  imports: ImportedActivity[];
}

/** 取り込む前の一覧の 1 行 */
export interface PreviewRow {
  file: string;
  sport: Sport | null;
  start: number;
  distance: number;
  seconds: number;
  /** 取り込める時の増える冒険の距離 (m)。取り込めない時は null */
  credit: number | null;
  /** 取り込めない理由 */
  reason: string;
}

const km = (m: number) => `${(m / 1000).toFixed(1)} km`;
const date = (unix: number) => {
  const d = new Date(unix * 1000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};
const dur = (s: number) => `${Math.floor(s / 3600)}:${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}`;

export class AdventurePanel {
  readonly root: HTMLElement;
  private summary: HTMLElement;
  private actions: HTMLElement;
  private preview: HTMLElement;
  private list: HTMLElement;
  private input: HTMLInputElement;
  private freeArmed = false;
  onFiles: (files: File[]) => void = () => {};
  onSport: (index: number, sport: Sport) => void = () => {};
  onConfirm: () => void = () => {};
  onCancelPreview: () => void = () => {};
  onJourney: () => void = () => {};
  onFree: () => void = () => {};

  constructor() {
    this.root = h("div", "stamp-book adventure-panel hidden");
    document.body.appendChild(this.root);
    const head = h("div", "stamp-head", "", this.root);
    h("div", "stamp-title", "冒険", head);
    const close = h("button", "btn", "閉じる", head);
    close.type = "button";
    close.addEventListener("click", () => this.close());
    const body = h("div", "stamp-list", "", this.root);
    this.summary = h("dl", "stop-rows adventure-summary", "", body);
    this.actions = h("div", "adventure-actions", "", body);
    this.preview = h("div", "adventure-preview hidden", "", body);
    h("div", "menu-head", "取り込んだ記録", body);
    this.list = h("div", "", "", body);
    this.input = h("input", "hidden", "", this.root);
    this.input.type = "file";
    this.input.multiple = true;
    this.input.accept = ".fit,.gpx,.tcx,.zip";
    this.input.addEventListener("change", () => {
      const files = [...(this.input.files ?? [])];
      this.input.value = "";
      if (files.length) this.onFiles(files);
    });
  }

  get isOpen() {
    return !this.root.classList.contains("hidden");
  }

  open(v: AdventureView) {
    this.freeArmed = false;
    this.update(v);
    this.root.classList.remove("hidden");
  }

  close() {
    this.root.classList.add("hidden");
  }

  /** 残りと使った距離だけ書き直す（走っている間に何度も呼ぶ。ボタンは作り直さない） */
  updateSummary(v: AdventureView) {
    this.summary.replaceChildren();
    const row = (k: string, val: string) => {
      h("dt", "", k, this.summary);
      h("dd", "", val, this.summary);
    };
    if (v.mode !== "adventure") {
      row("この世界", "自由（全部の道を走れる）");
      if (v.mode === "free") row("冒険で使った距離", km(v.spent));
    } else {
      row("この世界", "冒険（まだ走っていない道を進むと減る）");
      row("冒険の残り", km(v.balance));
      row("使った距離", km(v.spent));
    }
  }

  update(v: AdventureView) {
    this.updateSummary(v);
    this.actions.replaceChildren();
    const btn = (label: string, on: () => void, cls = "") => {
      const b = h("button", `btn ${cls}`.trim(), label, this.actions);
      b.type = "button";
      b.addEventListener("click", on);
      return b;
    };
    if (v.mode !== "adventure") {
      h("div", "stamp-meta", "冒険は、起動画面の「はじめから」で選ぶ。", this.actions);
    } else {
      btn("記録を取り込む", () => this.input.click(), "primary");
      btn("旅に出る（眺める・未走行の道を優先）", () => this.onJourney());
      const free = btn(this.freeArmed ? "もう一度押すと自由にする（冒険には戻せない）" : "自由にする", () => {
        if (!this.freeArmed) {
          this.freeArmed = true;
          this.update(v);
          return;
        }
        this.freeArmed = false;
        this.onFree();
      });
      if (this.freeArmed) free.classList.add("danger");
      h("div", "stamp-meta", "取り込めるファイル: FIT・GPX・TCX と、それらの入った zip（Garmin Connect・Strava などの書き出し）。読むのは種目・日時・距離・時間だけで、位置は残さない。", this.actions);
    }
    this.list.replaceChildren();
    if (!v.imports.length) h("div", "stamp-empty", "まだ無い", this.list);
    for (const i of [...v.imports].reverse().slice(0, 50)) {
      const item = h("div", "stamp-item", "", this.list);
      const t = h("div", "stamp-text", "", item);
      h("div", "stamp-name", `${SPORT_LABELS[i.sport]}  ${km(i.distance)}`, t);
      h("div", "stamp-meta", `${date(i.start)}  ${dur(i.seconds)}  冒険 +${km(i.credit)}`, t);
    }
  }

  /** 取り込む前の一覧（rows が空なら閉じる） */
  showPreview(rows: PreviewRow[], error = "") {
    this.preview.replaceChildren();
    this.preview.classList.toggle("hidden", !rows.length && !error);
    if (error) h("div", "trainer-note", error, this.preview);
    if (!rows.length) return;
    h("div", "menu-head", "取り込む記録", this.preview);
    rows.forEach((r, idx) => {
      const item = h("div", "stamp-item", "", this.preview);
      const t = h("div", "stamp-text", "", item);
      h("div", "stamp-name", `${r.sport ? SPORT_LABELS[r.sport] : "種目なし"}  ${km(r.distance)}`, t);
      h("div", "stamp-meta", `${date(r.start)}  ${dur(r.seconds)}  ${r.file}`, t);
      h("div", "stamp-meta", r.credit !== null ? `冒険 +${km(r.credit)}` : `取り込まない: ${r.reason}`, t);
      if (!r.sport || r.reason === "種目を選ぶ") {
        const sel = h("select", "", "", item);
        h("option", "", "種目を選ぶ", sel).value = "";
        for (const s of Object.keys(SPORT_LABELS) as Sport[]) h("option", "", SPORT_LABELS[s], sel).value = s;
        sel.value = r.sport ?? "";
        sel.addEventListener("change", () => sel.value && this.onSport(idx, sel.value as Sport));
      }
    });
    const total = rows.reduce((a, r) => a + (r.credit ?? 0), 0);
    const btns = h("div", "adventure-actions", "", this.preview);
    const ok = h("button", "btn primary", `取り込む（冒険 +${km(total)}）`, btns);
    ok.type = "button";
    ok.disabled = total <= 0;
    ok.addEventListener("click", () => this.onConfirm());
    const cancel = h("button", "btn", "やめる", btns);
    cancel.type = "button";
    cancel.addEventListener("click", () => this.onCancelPreview());
  }
}
