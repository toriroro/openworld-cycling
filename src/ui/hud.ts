// 走行中の画面（モック仕様 8章）。横画面を基本に、縦でも重ならないように配置する（配置は game.css）。
// 文言は操作・状態・事実情報だけ。sim の状態は読むだけ。

import { CAMERA_LABELS, CAMERA_MODES, type CameraMode } from "../render/camera-rig.ts";
import { POWER_MAX, POWER_MIN } from "../sim/power.ts";
import type { Quality } from "../render/world-view.ts";
import type { Upcoming } from "../sim/ride.ts";
import type { Action, Input } from "./input.ts";
import { PACE_LABELS } from "../shared/stamina.ts";

export interface HudState {
  speed: number;
  watts: number;
  grade: number;
  odometer: number;
  climb: number;
  time: number;
  roadName: string;
  /** 今いる丁目・その丁目を持つ業者（配達の草案 27 章）。無ければ道の名前を大きく出す */
  address?: string | null;
  owner?: string | null;
  /** 進む向き（北から時計回りの度） */
  heading?: number;
  elevation: number;
  autoBrake: boolean;
  upcoming: Upcoming | null;
  canUTurn: boolean;
  watching: boolean;
  paused: boolean;
  /** 行き先までの直線距離 (m)。行き先がなければ null */
  goalDistance?: number | null;
  /** 行き先の名所の名前（名所帳から選んだ時） */
  goalName?: string | null;
  /** 世界の時刻（時） */
  hour?: number;
  /** 世界の曜日（時計を固定している時は無し） */
  weekday?: string | null;
  /** 天候の名前 */
  weather?: string;
  /** トレーナーのケイデンス (rpm)・心拍 (bpm)。無ければ null で、表示を隠す */
  cadence?: number | null;
  heartRate?: number | null;
  /** トレーナーの状態（問題がある時だけ） */
  trainerNote?: string | null;
  /** トレーナーで走っている（漕ぐボタンを隠す） */
  onTrainer?: boolean;
  /** 冒険の残り (m)。冒険でなければ null（冒険の草案 5 章） */
  adventure?: number | null;
  /** 冒険の距離が無くて止まっている時の知らせ */
  adventureNote?: string | null;
  /** ペース（0〜4）。null ならペースの列を隠す（配達の草案 14.1） */
  pace?: number | null;
  /** 脚・体力 (0〜1)。null なら隠す（草案 14.2） */
  legs?: number | null;
  energy?: number | null;
}

export interface Settings {
  power: number;
  /** ペダリングで体がぶれ始める出力 (W) */
  sway: number;
  quality: Quality;
  clock: "world" | "fixed";
  hour: number;
  weather: "world" | "clear" | "cloudy" | "fog";
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
  private swayInput!: HTMLInputElement;
  private swayOut!: HTMLElement;
  private menu: HTMLElement;
  private menuBtn: HTMLButtonElement;
  private pauseEl: HTMLElement;
  private touch: HTMLElement;
  private flashEl!: HTMLElement;
  private vignette!: HTMLElement;
  private flashTimer = 0;
  private pedalBtn!: HTMLButtonElement;
  private uturnBtn: HTMLButtonElement;
  private roadEl: HTMLElement;
  private statusEl: HTMLButtonElement;
  private statusSpeed: HTMLElement;
  private needle!: HTMLElement;
  private whereMain!: HTMLElement;
  private whereDir!: HTMLElement;
  private whereSub!: HTMLElement;
  private headingShown = NaN;
  private paceBar: HTMLElement;
  private paceRow: HTMLElement;
  private gauges: Record<"legs" | "energy", { root: HTMLElement; fill: HTMLElement; value: HTMLElement }> = {} as never;
  private settingsEls: {
    power: HTMLInputElement;
    powerOut: HTMLElement;
    quality: HTMLSelectElement;
    clock: HTMLSelectElement;
    hour: HTMLInputElement;
    hourOut: HTMLElement;
    weather: HTMLSelectElement;
    camera: HTMLSelectElement;
  };
  menuOpen = false;
  private keysEl!: HTMLElement;
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
      ["cadence", "ケイデンス", "rpm"],
      ["heart", "心拍", "bpm"],
      ["adventure", "冒険の残り", "km"],
      ["elev", "標高", "m"],
      ["clock", "時刻", ""],
    ] as const) {
      const box = h("div", `stat stat-${key}`, "", info);
      h("span", "stat-label", label, box);
      const v = h("span", "stat-value", "0", box);
      if (unit) h("span", "stat-unit", unit, box);
      this.stats[key] = v;
    }
    // 今いる所（配達の草案 27 章）: 方位磁針（上が進む向き、赤い印が北）、丁目と進む方角、2 行目に道の名前・標高など
    this.roadEl = h("div", "road-name", "", this.root);
    const comp = h("div", "where-compass", "", this.roadEl);
    this.needle = h("div", "where-needle", "", comp);
    h("span", "where-n", "北", this.needle);
    const txt = h("div", "where-text", "", this.roadEl);
    const main = h("div", "where-main", "", txt);
    this.whereMain = h("span", "where-place", "", main);
    this.whereDir = h("span", "where-dir", "", main);
    this.whereSub = h("div", "where-sub", "", txt);

    // 走りの要点（配達の草案 27.6）: 速さと、脚・体力の細い棒。押すと詳しい数字（ride-info）を開く・閉じる
    this.statusEl = h("button", "ride-status", "", this.root);
    this.statusEl.type = "button";
    this.statusEl.setAttribute("aria-label", "走りの数字を開く");
    const sp = h("span", "status-speed", "", this.statusEl);
    this.statusSpeed = h("span", "status-value", "0", sp);
    h("span", "status-unit", "km/h", sp);
    this.statusEl.addEventListener("click", () => this.root.classList.toggle("show-details"));
    info.addEventListener("click", () => this.root.classList.remove("show-details"));

    // 下中央: ペース（配達の草案 14.1）。脚・体力の棒（14.2）は走りの要点に
    this.paceBar = h("div", "pace-bar hidden", "", this.root);
    this.paceRow = h("div", "pace-row", "", this.paceBar);
    PACE_LABELS.forEach((label, i) => {
      const b = h("button", "btn pace-btn", label, this.paceRow);
      b.type = "button";
      this.input.bindTap(b, `pace-${i}` as Action);
    });
    const gauges = h("div", "pace-gauges", "", this.statusEl);
    for (const [key, label] of [
      ["legs", "脚"],
      ["energy", "体力"],
    ] as const) {
      const g = h("div", `gauge gauge-${key}`, "", gauges);
      h("span", "gauge-label", label, g);
      const track = h("span", "gauge-track", "", g);
      const fill = h("span", "gauge-fill", "", track);
      const value = h("span", "gauge-value", "", g);
      this.gauges[key] = { root: g, fill, value };
    }

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
    mk("自転車と装い", "outfit");
    h("div", "menu-head", "設定", this.menu);
    const rp = row("出力");
    const power = h("input", "", "", rp);
    power.type = "range";
    power.min = String(POWER_MIN);
    power.max = String(POWER_MAX);
    power.step = "10";
    power.value = String(settings.power);
    const powerOut = h("span", "menu-value", `${settings.power} W`, rp);
    power.addEventListener("input", () => {
      powerOut.textContent = `${power.value} W`;
      this.onSettings({ power: Number(power.value) });
    });
    // 体がぶれ始める出力（この出力から腰・肩・車体の左右の振れが出始め、2 倍で最大）
    const rs = row("体がぶれ始める出力");
    const sway = h("input", "", "", rs);
    sway.type = "range";
    sway.min = "100";
    sway.max = String(POWER_MAX);
    sway.step = "10";
    sway.value = String(settings.sway);
    const swayOut = h("span", "menu-value", `${settings.sway} W`, rs);
    sway.addEventListener("input", () => {
      swayOut.textContent = `${sway.value} W`;
      this.onSettings({ sway: Number(sway.value) });
    });
    this.swayInput = sway;
    this.swayOut = swayOut;
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
    // 時刻と天候: 世界のものか、自分の画面だけ固定するか（概要仕様 3.7）
    const sel = (r: HTMLElement, options: [string, string][], value: string) => {
      const e = h("select", "", "", r);
      for (const [v, l] of options) {
        const o = h("option", "", l, e);
        o.value = v;
      }
      e.value = value;
      return e;
    };
    const clock = sel(
      row("時刻"),
      [
        ["world", "世界の時計"],
        ["fixed", "固定"],
      ],
      settings.clock,
    );
    const rh = row("固定する時刻");
    const hour = h("input", "", "", rh);
    hour.type = "range";
    hour.min = "0";
    hour.max = "23.75";
    hour.step = "0.25";
    hour.value = String(settings.hour);
    hour.disabled = settings.clock === "world";
    const hourOut = h("span", "menu-value", fmtHour(settings.hour), rh);
    clock.addEventListener("change", () => {
      hour.disabled = clock.value === "world";
      // 固定にした時は、その時の時刻から始める（時刻は Game が決めて syncSettings で戻す）
      this.onSettings({ clock: clock.value as Settings["clock"] });
    });
    hour.addEventListener("input", () => {
      hourOut.textContent = fmtHour(Number(hour.value));
      this.onSettings({ hour: Number(hour.value) });
    });
    const weather = sel(
      row("天候"),
      [
        ["world", "世界の天候"],
        ["clear", "晴れに固定"],
        ["cloudy", "曇りに固定"],
        ["fog", "霧に固定"],
      ],
      settings.weather,
    );
    weather.addEventListener("change", () => this.onSettings({ weather: weather.value as Settings["weather"] }));
    // 足した設定の行はこの印の前に入る（キーの一覧は「操作」の画面へ移した）
    this.keysEl = h("div", "menu-end", "", this.menu);
    this.settingsEls = { power, powerOut, quality, clock, hour, hourOut, weather, camera };

    // 短い知らせ（受け取った・渡した・車に当たった）
    this.flashEl = h("div", "flash hidden", "", this.root);
    this.vignette = h("div", "hit-vignette hidden", "", this.root);

    // 一時停止の表示
    this.pauseEl = h("div", "pause-banner hidden", "一時停止中", this.root);
    this.pauseEl.addEventListener("pointerdown", () => this.input.push("pause"));

    // タッチ端末: 左下の角に「左へ」、右下の角に「右へ」、その左に漕ぐ・ブレーキ（配達の草案 26 章）。
    // 左右は押した時に少し動き、押している間は動き続ける
    this.touch = h("div", "touch", "", this.root);
    const left = h("div", "touch-left", "", this.touch);
    const ll = h("button", "btn touch-btn lane", "", left);
    h("span", "lane-arrow", "◀", ll);
    h("span", "lane-label", "左へ", ll);
    const right = h("div", "touch-right", "", this.touch);
    const brake = h("button", "btn touch-btn brake", "ブレーキ", right);
    const pedal = h("button", "btn touch-btn pedal", "漕ぐ", right);
    const lr = h("button", "btn touch-btn lane", "", right);
    h("span", "lane-arrow", "▶", lr);
    h("span", "lane-label", "右へ", lr);
    this.pedalBtn = pedal;
    this.input.bindHold(pedal, (on) => (this.input.pedalTouch = on));
    this.input.bindHold(brake, (on) => (this.input.brakeTouch = on));
    this.input.bindLane(ll, -1);
    this.input.bindLane(lr, 1);
    const coarse = matchMedia("(pointer: coarse)").matches || new URLSearchParams(location.search).get("touch") === "1";
    const showTouch = (on: boolean) => {
      this.touch.classList.toggle("hidden", !on);
      this.root.classList.toggle("has-touch", on);
    };
    showTouch(coarse);
    addEventListener("touchstart", () => showTouch(true), { once: true, passive: true });
  }

  /** メニューの最後（キーの説明の後）に要素を足す（データの出典など） */
  addMenuFooter(el: HTMLElement) {
    this.menu.appendChild(el);
  }

  /** メニューに選択の行を足す（キーの説明の前） */
  addSelect<T extends string>(label: string, options: [T, string][], value: T, onChange: (v: T) => void): HTMLSelectElement {
    const r = h("label", "menu-row");
    h("span", "", label, r);
    const sel = h("select", "", "", r);
    for (const [v, l] of options) {
      const o = h("option", "", l, sel);
      o.value = v;
    }
    sel.value = value;
    sel.addEventListener("change", () => onChange(sel.value as T));
    this.menu.insertBefore(r, this.keysEl);
    return sel;
  }

  /** メニューにボタンを足す */
  addButton(label: string, onClick: () => void): HTMLButtonElement {
    const btns = this.menu.querySelector(".menu-buttons")!;
    const b = h("button", "btn", label, btns as HTMLElement);
    b.type = "button";
    b.addEventListener("click", onClick);
    return b;
  }

  toggleMenu(open = !this.menuOpen) {
    this.menuOpen = open;
    this.menu.classList.toggle("hidden", !open);
    this.menuBtn.classList.toggle("active", open);
  }

  syncSettings(s: Partial<Settings>) {
    if (s.camera) this.settingsEls.camera.value = s.camera;
    if (s.quality) this.settingsEls.quality.value = s.quality;
    if (s.clock) {
      this.settingsEls.clock.value = s.clock;
      this.settingsEls.hour.disabled = s.clock === "world";
    }
    if (s.hour !== undefined) {
      this.settingsEls.hour.value = String(s.hour);
      this.settingsEls.hourOut.textContent = fmtHour(s.hour);
    }
    if (s.weather) this.settingsEls.weather.value = s.weather;
    if (s.power !== undefined) {
      this.settingsEls.power.value = String(s.power);
      this.settingsEls.powerOut.textContent = `${s.power} W`;
    }
    if (s.sway !== undefined) {
      this.swayInput.value = String(s.sway);
      this.swayOut.textContent = `${s.sway} W`;
    }
  }

  setVisible(v: boolean) {
    this.root.classList.toggle("faded", !v);
  }

  update(st: HudState) {
    this.stats.speed.textContent = (st.speed * 3.6).toFixed(1);
    const kmh = String(Math.round(st.speed * 3.6));
    if (this.statusSpeed.textContent !== kmh) this.statusSpeed.textContent = kmh;
    this.stats.elev.textContent = String(Math.round(st.elevation));
    this.stats.clock.parentElement!.classList.toggle("hidden", st.hour === undefined);
    if (st.hour !== undefined) this.stats.clock.textContent = `${st.weekday ? `${st.weekday} ` : ""}${fmtHour(st.hour)}${st.weather ? ` ${st.weather}` : ""}`;
    this.stats.watts.textContent = String(Math.round(st.watts));
    this.stats.grade.textContent = (st.grade * 100).toFixed(1);
    this.stats.dist.textContent = (st.odometer / 1000).toFixed(2);
    this.stats.climb.textContent = String(Math.round(st.climb));
    this.stats.time.textContent = fmtTime(st.time);
    const opt = (key: string, v: number | null | undefined) => {
      this.stats[key].parentElement!.classList.toggle("hidden", v == null);
      if (v != null) this.stats[key].textContent = String(Math.round(v));
    };
    opt("cadence", st.cadence);
    opt("heart", st.heartRate);
    for (const key of ["legs", "energy"] as const) {
      const v = st[key];
      const g = this.gauges[key];
      g.root.classList.toggle("hidden", v == null);
      if (v != null) {
        const pct = Math.max(0, Math.min(100, Math.round(v * 100)));
        g.fill.style.width = `${pct}%`;
        g.value.textContent = `${pct}%`;
        g.root.classList.toggle("low", v < 0.2);
      }
    }
    this.paceBar.classList.toggle("hidden", st.pace == null);
    if (st.pace != null) [...this.paceRow.children].forEach((el, i) => el.classList.toggle("selected", i === st.pace));
    this.stats.adventure.parentElement!.classList.toggle("hidden", st.adventure == null);
    if (st.adventure != null) this.stats.adventure.textContent = (st.adventure / 1000).toFixed(1);
    const main = st.address ?? st.roadName;
    if (this.whereMain.textContent !== main) this.whereMain.textContent = main;
    const hd = st.heading ?? 0;
    const dirText = `${COMPASS_8[Math.round(hd / 45) % 8]}へ`;
    if (this.whereDir.textContent !== dirText) this.whereDir.textContent = dirText;
    // 上が進む向きなので、北は −heading の向き（1° 以上変わった時だけ動かす）
    if (!(Math.abs(hd - this.headingShown) < 1)) {
      this.headingShown = hd;
      this.needle.style.transform = `rotate(${-hd}deg)`;
    }
    // 2 行目は道の名前・持ち主の業者・行き先までと、知らせだけ（標高・時刻・天候は詳しい数字の方へ。配達の草案 27.6）
    const sub = `${st.address && st.roadName ? st.roadName : ""}${st.owner ? `  ${st.owner}` : ""}${st.goalDistance != null ? `  ${st.goalName ?? "行き先"}まで ${(st.goalDistance / 1000).toFixed(1)} km` : ""}${st.watching ? "  眺める" : ""}${st.autoBrake ? "  自動減速" : ""}${st.trainerNote ? `  ${st.trainerNote}` : ""}${st.adventureNote ? `  ${st.adventureNote}` : ""}`;
    if (this.whereSub.textContent !== sub) this.whereSub.textContent = sub;
    this.pauseEl.classList.toggle("hidden", !st.paused);
    // ペースで漕ぐ間は「漕ぐ」を出さない（タッチの操作を減らす。配達の草案 27.6）
    this.pedalBtn.classList.toggle("hidden", !!st.onTrainer || st.pace != null);
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
    if (!sameJunction || this.branch.querySelectorAll(".choice").length !== u.choices.length) {
      this.branch.replaceChildren();
      h("div", "branch-dist", "", this.branch);
      // 候補は左に曲がる物から右に曲がる物へ並んでいる（ride.ts で角度の順）。1 行に並べる
      const row = h("div", "branch-row", "", this.branch);
      u.choices.forEach((c, i) => {
        const b = h("button", "btn choice", "", row);
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

  /** 短い知らせを画面の上の方に出す。hit は画面の縁を赤く光らせる */
  flash(text: string, tone: "ok" | "hit") {
    const f = this.flashEl;
    f.textContent = text;
    f.className = `flash flash-${tone}`;
    // 同じ知らせを続けて出しても動きを始めからにする
    void f.offsetWidth;
    f.classList.add("show");
    if (tone === "hit") {
      this.vignette.classList.remove("hidden", "show");
      void this.vignette.offsetWidth;
      this.vignette.classList.add("show");
    }
    clearTimeout(this.flashTimer);
    this.flashTimer = window.setTimeout(() => {
      f.classList.add("hidden");
      this.vignette.classList.add("hidden");
    }, 1600);
  }

  /** 候補を押した時の番号（Game が取り出す） */
  chosen: number | null = null;
}

/** 8 方位（北から時計回り） */
const COMPASS_8 = ["北", "北東", "東", "南東", "南", "南西", "西", "北西"] as const;

function fmtHour(hh: number) {
  const total = Math.floor(hh * 60 + 1e-6) % (24 * 60);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}
