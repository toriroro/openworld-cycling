// 走行中の画面（モック仕様 8章）。横画面を基本に、縦でも重ならないように配置する（配置は game.css）。
// 文言は操作・状態・事実情報だけ。sim の状態は読むだけ。

import { CAMERA_LABELS, CAMERA_MODES, type CameraMode } from "../render/camera-rig.ts";
import type { Quality } from "../render/world-view.ts";
import type { Upcoming } from "../sim/ride.ts";
import type { Input } from "./input.ts";

export interface HudState {
  speed: number;
  watts: number;
  grade: number;
  odometer: number;
  climb: number;
  time: number;
  roadName: string;
  elevation: number;
  autoBrake: boolean;
  upcoming: Upcoming | null;
  canUTurn: boolean;
  watching: boolean;
  paused: boolean;
}

export interface Settings {
  power: number;
  quality: Quality;
  hour: number;
  camera: CameraMode;
}

const h = <K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text = "", parent?: HTMLElement) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  parent?.appendChild(e);
  return e;
};

function fmtTime(t: number) {
  const s = Math.floor(t);
  const hh = Math.floor(s / 3600);
  const mm = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  return hh ? `${hh}:${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}` : `${mm}:${String(ss).padStart(2, "0")}`;
}

export class Hud {
  readonly root: HTMLElement;
  private stats: Record<string, HTMLElement> = {};
  private branch: HTMLElement;
  private branchKey = "";
  private menu: HTMLElement;
  private menuBtn: HTMLButtonElement;
  private pauseEl: HTMLElement;
  private touch: HTMLElement;
  private uturnBtn: HTMLButtonElement;
  private roadEl: HTMLElement;
  private settingsEls: { power: HTMLInputElement; powerOut: HTMLElement; quality: HTMLSelectElement; hour: HTMLInputElement; hourOut: HTMLElement; camera: HTMLSelectElement };
  menuOpen = false;
  onSettings: (s: Partial<Settings>) => void = () => {};

  constructor(private input: Input, settings: Settings) {
    this.root = h("div", "hud-root");
    document.body.appendChild(this.root);

    // 左下（縦画面では上）: 走行情報
    const info = h("div", "ride-info", "", this.root);
    for (const [key, label, unit] of [
      ["speed", "速度", "km/h"],
      ["watts", "出力", "W"],
      ["grade", "勾配", "%"],
      ["dist", "距離", "km"],
      ["climb", "獲得標高", "m"],
      ["time", "走行時間", ""],
    ] as const) {
      const box = h("div", `stat stat-${key}`, "", info);
      h("span", "stat-label", label, box);
      const v = h("span", "stat-value", "0", box);
      if (unit) h("span", "stat-unit", unit, box);
      this.stats[key] = v;
    }
    this.roadEl = h("div", "road-name", "", this.root);

    // 上中央: 分岐の候補
    this.branch = h("div", "branch", "", this.root);
    this.uturnBtn = h("button", "btn uturn", "Uターン", this.root);
    this.uturnBtn.type = "button";
    this.uturnBtn.classList.add("hidden");
    this.input.bindTap(this.uturnBtn, "u-turn");

    // 左上: メニュー
    this.menuBtn = h("button", "btn menu-btn", "メニュー", this.root);
    this.menuBtn.type = "button";
    this.menuBtn.addEventListener("click", () => this.toggleMenu());
    this.menu = h("div", "menu hidden", "", this.root);
    const row = (label: string) => {
      const r = h("label", "menu-row", "", this.menu);
      h("span", "", label, r);
      return r;
    };
    const btns = h("div", "menu-buttons", "", this.menu);
    const mk = (label: string, action: Parameters<Input["push"]>[0]) => {
      const b = h("button", "btn", label, btns);
      b.type = "button";
      b.addEventListener("click", () => this.input.push(action));
      return b;
    };
    mk("一時停止", "pause");
    mk("視点", "camera");
    mk("眺める", "watch");
    const rp = row("出力");
    const power = h("input", "", "", rp);
    power.type = "range";
    power.min = "50";
    power.max = "400";
    power.step = "10";
    power.value = String(settings.power);
    const powerOut = h("span", "menu-value", `${settings.power} W`, rp);
    power.addEventListener("input", () => {
      powerOut.textContent = `${power.value} W`;
      this.onSettings({ power: Number(power.value) });
    });
    const rc = row("視点");
    const camera = h("select", "", "", rc);
    for (const m of CAMERA_MODES) {
      const o = h("option", "", CAMERA_LABELS[m], camera);
      o.value = m;
    }
    camera.value = settings.camera;
    camera.addEventListener("change", () => this.onSettings({ camera: camera.value as CameraMode }));
    const rq = row("画質");
    const quality = h("select", "", "", rq);
    for (const [v, l] of [
      ["standard", "標準"],
      ["light", "軽量"],
    ]) {
      const o = h("option", "", l, quality);
      o.value = v;
    }
    quality.value = settings.quality;
    quality.addEventListener("change", () => this.onSettings({ quality: quality.value as Quality }));
    const rh = row("時刻");
    const hour = h("input", "", "", rh);
    hour.type = "range";
    hour.min = "5";
    hour.max = "19";
    hour.step = "0.25";
    hour.value = String(settings.hour);
    const hourOut = h("span", "menu-value", fmtHour(settings.hour), rh);
    hour.addEventListener("input", () => {
      hourOut.textContent = fmtHour(Number(hour.value));
      this.onSettings({ hour: Number(hour.value) });
    });
    h("div", "menu-keys", "キー: Space 漕ぐ / Shift ブレーキ / ← ↑ → 分岐 / ↓ Uターン / A D 左右 / C 視点 / V 眺める / P 一時停止", this.menu);
    this.settingsEls = { power, powerOut, quality, hour, hourOut, camera };

    // 一時停止の表示
    this.pauseEl = h("div", "pause-banner hidden", "一時停止中", this.root);
    this.pauseEl.addEventListener("pointerdown", () => this.input.push("pause"));

    // タッチ端末: 右下に漕ぐ・ブレーキ、左下に左右位置
    this.touch = h("div", "touch", "", this.root);
    const right = h("div", "touch-right", "", this.touch);
    const brake = h("button", "btn touch-btn brake", "ブレーキ", right);
    const pedal = h("button", "btn touch-btn pedal", "漕ぐ", right);
    this.input.bindHold(pedal, (on) => (this.input.pedalTouch = on));
    this.input.bindHold(brake, (on) => (this.input.brakeTouch = on));
    const left = h("div", "touch-left", "", this.touch);
    const ll = h("button", "btn touch-btn lane", "◀ 左へ", left);
    const lr = h("button", "btn touch-btn lane", "右へ ▶", left);
    this.input.bindTap(ll, "lane-left");
    this.input.bindTap(lr, "lane-right");
    const coarse = matchMedia("(pointer: coarse)").matches || new URLSearchParams(location.search).get("touch") === "1";
    const showTouch = (on: boolean) => {
      this.touch.classList.toggle("hidden", !on);
      this.root.classList.toggle("has-touch", on);
    };
    showTouch(coarse);
    addEventListener("touchstart", () => showTouch(true), { once: true, passive: true });
  }

  toggleMenu(open = !this.menuOpen) {
    this.menuOpen = open;
    this.menu.classList.toggle("hidden", !open);
    this.menuBtn.classList.toggle("active", open);
  }

  syncSettings(s: Partial<Settings>) {
    if (s.camera) this.settingsEls.camera.value = s.camera;
    if (s.quality) this.settingsEls.quality.value = s.quality;
    if (s.power !== undefined) {
      this.settingsEls.power.value = String(s.power);
      this.settingsEls.powerOut.textContent = `${s.power} W`;
    }
  }

  setVisible(v: boolean) {
    this.root.classList.toggle("faded", !v);
  }

  update(st: HudState) {
    this.stats.speed.textContent = (st.speed * 3.6).toFixed(1);
    this.stats.watts.textContent = String(Math.round(st.watts));
    this.stats.grade.textContent = (st.grade * 100).toFixed(1);
    this.stats.dist.textContent = (st.odometer / 1000).toFixed(2);
    this.stats.climb.textContent = String(Math.round(st.climb));
    this.stats.time.textContent = fmtTime(st.time);
    this.roadEl.textContent = `${st.roadName}  標高 ${Math.round(st.elevation)} m${st.watching ? "  眺める" : ""}${st.autoBrake ? "  自動減速" : ""}`;
    this.pauseEl.classList.toggle("hidden", !st.paused);
    this.uturnBtn.classList.toggle("hidden", !st.canUTurn);
    this.updateBranch(st.upcoming);
  }

  private updateBranch(u: Upcoming | null) {
    if (!u || u.choices.length < 2) {
      if (this.branchKey) {
        this.branch.replaceChildren();
        this.branchKey = "";
      }
      this.branch.classList.add("hidden");
      return;
    }
    this.branch.classList.remove("hidden");
    const active = u.selected ?? u.defaultIndex;
    const key = `${u.junction.id}|${active}|${Math.round(u.distance / 10)}`;
    if (key === this.branchKey) return;
    const sameJunction = this.branchKey.startsWith(u.junction.id + "|");
    this.branchKey = key;
    if (!sameJunction || this.branch.childElementCount !== u.choices.length + 1) {
      this.branch.replaceChildren();
      h("div", "branch-dist", "", this.branch);
      u.choices.forEach((c, i) => {
        const b = h("button", "btn choice", "", this.branch);
        b.type = "button";
        const arrow = h("span", "arrow", "↑", b);
        arrow.style.transform = `rotate(${(c.angle * 180) / Math.PI}deg)`;
        h("span", "dest", c.destination, b);
        h("span", "far", `${(c.distance / 1000).toFixed(1)} km`, b);
        b.addEventListener("pointerdown", (e) => {
          e.preventDefault();
          this.input.lastActivity = performance.now();
          // 選択は Game が読む
          this.chosen = i;
        });
      });
    }
    (this.branch.firstChild as HTMLElement).textContent = `分岐まで ${Math.round(u.distance)} m`;
    [...this.branch.querySelectorAll(".choice")].forEach((el, i) => el.classList.toggle("selected", i === active));
  }

  /** 候補を押した時の番号（Game が取り出す） */
  chosen: number | null = null;
}

function fmtHour(hh: number) {
  const m = Math.round((hh % 1) * 60);
  return `${Math.floor(hh)}:${String(m).padStart(2, "0")}`;
}
