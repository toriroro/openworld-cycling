// 旅の記録（冒険の草案 4.2）: 閉じている間に進めた旅を 1 枚にまとめる。計算している間の表示も持つ。
// 文言は事実だけ（CLAUDE.md）。

import type { JourneyLog } from "../sim/journey.ts";

const h = <K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text = "", parent?: HTMLElement) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  parent?.appendChild(e);
  return e;
};

const km = (m: number) => `${(m / 1000).toFixed(1)} km`;
const dur = (s: number) => {
  const t = Math.round(s);
  return `${Math.floor(t / 3600)}:${String(Math.floor((t % 3600) / 60)).padStart(2, "0")}:${String(t % 60).padStart(2, "0")}`;
};
const when = (unix: number) => {
  const d = new Date(unix * 1000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getMonth() + 1}/${d.getDate()} ${p(d.getHours())}:${p(d.getMinutes())}`;
};

export class JourneyPanel {
  readonly root: HTMLElement;
  private body: HTMLElement;
  private progress: HTMLElement;

  constructor() {
    this.root = h("div", "stamp-book journey-panel hidden");
    document.body.appendChild(this.root);
    const head = h("div", "stamp-head", "", this.root);
    h("div", "stamp-title", "旅の記録", head);
    const close = h("button", "btn", "閉じる", head);
    close.type = "button";
    close.addEventListener("click", () => this.close());
    this.body = h("div", "stamp-list", "", this.root);
    this.progress = h("div", "journey-progress hidden", "", document.body);
  }

  get isOpen() {
    return !this.root.classList.contains("hidden");
  }

  close() {
    this.root.classList.add("hidden");
  }

  /** まとめて進めている間の表示（null で消す） */
  setProgress(text: string | null) {
    this.progress.classList.toggle("hidden", text === null);
    if (text !== null && this.progress.textContent !== text) this.progress.textContent = text;
  }

  open(log: JourneyLog, balance: number) {
    const b = this.body;
    b.replaceChildren();
    const canvas = h("canvas", "journey-map", "", b);
    const rows = h("dl", "stop-rows", "", b);
    const row = (k: string, v: string) => {
      h("dt", "", k, rows);
      h("dd", "", v, rows);
    };
    row("期間", `${when(log.from)} 〜 ${when(log.from + log.seconds)}`);
    row("走った時間", dur(log.seconds));
    row("走った距離", km(log.distance));
    row("新しく走った道", km(log.explored));
    row("冒険の残り", `${km(balance)}${log.exhausted ? "（尽きた）" : ""}`);
    if (Number.isFinite(log.maxElevation) && log.maxElevation > -1e6) row("最高地点", `${Math.round(log.maxElevation)} m`);
    const list = (title: string, items: string[]) => {
      if (!items.length) return;
      h("div", "menu-head", title, b);
      h("div", "journey-list", items.join("・"), b);
    };
    list("通った町", log.towns);
    list("前を通った喫茶店（スタンプ）", log.cafes.map((c) => c.name));
    list("見えた名所", log.landmarks);
    this.root.classList.remove("hidden");
    this.drawPath(canvas, log.path);
  }

  /** 道筋を、北を上にして枠に収めて描く */
  private drawPath(canvas: HTMLCanvasElement, path: [number, number][]) {
    const dpr = Math.min(2, devicePixelRatio || 1);
    const w = canvas.clientWidth || 360;
    const hgt = canvas.clientHeight || 200;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(hgt * dpr);
    const c = canvas.getContext("2d");
    if (!c || path.length < 2) return;
    c.scale(dpr, dpr);
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (const [x, z] of path) {
      x0 = Math.min(x0, x);
      x1 = Math.max(x1, x);
      z0 = Math.min(z0, z);
      z1 = Math.max(z1, z);
    }
    const pad = 14;
    const k = Math.min((w - pad * 2) / Math.max(1, x1 - x0), (hgt - pad * 2) / Math.max(1, z1 - z0));
    const ox = (w - (x1 - x0) * k) / 2;
    const oz = (hgt - (z1 - z0) * k) / 2;
    const at = (x: number, z: number) => [ox + (x - x0) * k, oz + (z - z0) * k] as const;
    c.lineCap = "round";
    c.lineJoin = "round";
    c.strokeStyle = "#ff8a1f";
    c.lineWidth = 3;
    c.beginPath();
    path.forEach(([x, z], i) => (i ? c.lineTo(...at(x, z)) : c.moveTo(...at(x, z))));
    c.stroke();
    const dot = (p: [number, number], color: string) => {
      c.fillStyle = color;
      c.beginPath();
      c.arc(...at(p[0], p[1]), 5, 0, Math.PI * 2);
      c.fill();
    };
    dot(path[0], "#f2f2ea");
    dot(path[path.length - 1], "#2fa060");
  }
}
