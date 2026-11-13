// 自転車と装いの設定画面（メニューから開く）。選ぶとすぐ onChange で新しい設定を渡す。
// 文言は操作・状態・事実だけ（モック仕様 8章）。押す対象は 44px 以上。

import "./outfit-panel.css";
import {
  type BikeOutfit,
  DEFAULT_OUTFIT,
  HAIR_COLORS,
  LENS_COLORS,
  type Outfit,
  PAINT_COLORS,
  PART_COLORS,
  type RiderOutfit,
  SKIN_COLORS,
  type Swatch,
  withOutfit,
} from "../shared/outfit.ts";

type Tab = "bike" | "rider";

interface ChoiceRow<K> {
  key: K;
  label: string;
  choices: { value: string; label: string }[];
}
interface ColorRow<K> {
  key: K;
  label: string;
  swatches: readonly Swatch[];
}
type Row<K> = ChoiceRow<K> | ColorRow<K>;

const BIKE_ROWS: Row<keyof BikeOutfit>[] = [
  { key: "frame", label: "フレーム", choices: [{ value: "aero", label: "エアロ" }, { value: "climb", label: "軽量" }, { value: "steel", label: "クロモリ" }] },
  { key: "frameColor", label: "フレームの色", swatches: PAINT_COLORS },
  { key: "accentColor", label: "差し色", swatches: PAINT_COLORS },
  { key: "wheels", label: "リムの高さ", choices: [{ value: "low", label: "22mm" }, { value: "mid", label: "42mm" }, { value: "deep", label: "60mm" }] },
  { key: "rimColor", label: "リムの色", swatches: PART_COLORS },
  { key: "tireWall", label: "タイヤの側面", choices: [{ value: "black", label: "黒" }, { value: "tan", label: "飴色" }] },
  { key: "tapeColor", label: "バーテープ", swatches: PART_COLORS },
  { key: "saddleColor", label: "サドル", swatches: PART_COLORS },
];

const RIDER_ROWS: Row<keyof RiderOutfit>[] = [
  { key: "jerseyPattern", label: "ジャージの柄", choices: [{ value: "plain", label: "無地" }, { value: "band", label: "胸の帯" }, { value: "shoulder", label: "肩" }, { value: "stripes", label: "縦じま" }] },
  { key: "jerseyColor", label: "ジャージの色", swatches: PAINT_COLORS },
  { key: "jerseyAccent", label: "ジャージの差し色", swatches: PAINT_COLORS },
  { key: "bibColor", label: "ビブの色", swatches: PART_COLORS },
  { key: "helmet", label: "ヘルメット", choices: [{ value: "road", label: "通常" }, { value: "aero", label: "エアロ" }] },
  { key: "helmetColor", label: "ヘルメットの色", swatches: PAINT_COLORS },
  { key: "lensColor", label: "レンズ", swatches: LENS_COLORS },
  { key: "shoeColor", label: "シューズ", swatches: PART_COLORS },
  { key: "sockLength", label: "ソックスの長さ", choices: [{ value: "short", label: "短い" }, { value: "long", label: "長い" }] },
  { key: "sockColor", label: "ソックスの色", swatches: PAINT_COLORS },
  { key: "skinColor", label: "肌", swatches: SKIN_COLORS },
  { key: "hairColor", label: "髪", swatches: HAIR_COLORS },
];

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text = "", parent?: HTMLElement) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  parent?.appendChild(e);
  return e;
}

export class OutfitPanel {
  readonly root: HTMLElement;
  private body: HTMLElement;
  private tabButtons: Record<Tab, HTMLButtonElement>;
  private tab: Tab = "bike";
  private outfit: Outfit;
  onChange: (o: Outfit) => void = () => {};
  onClose: () => void = () => {};

  constructor(parent: HTMLElement, outfit: Outfit) {
    this.outfit = outfit;
    this.root = el("div", "outfit-panel hidden", "", parent);
    this.root.setAttribute("role", "dialog");
    this.root.setAttribute("aria-label", "自転車と装い");
    const head = el("div", "of-head", "", this.root);
    const tabs = el("div", "of-tabs", "", head);
    tabs.setAttribute("role", "tablist");
    const mkTab = (t: Tab, label: string) => {
      const b = el("button", "of-btn of-tab", label, tabs);
      b.type = "button";
      b.setAttribute("role", "tab");
      b.addEventListener("click", () => this.show(t));
      return b;
    };
    this.tabButtons = { bike: mkTab("bike", "自転車"), rider: mkTab("rider", "ライダー") };
    const close = el("button", "of-btn of-close", "閉じる", head);
    close.type = "button";
    close.addEventListener("click", () => this.close());
    this.body = el("div", "of-body", "", this.root);
    const foot = el("div", "of-foot", "", this.root);
    const reset = el("button", "of-btn", "初期設定に戻す", foot);
    reset.type = "button";
    reset.addEventListener("click", () => {
      const keep = this.tab === "bike" ? { rider: this.outfit.rider } : { bike: this.outfit.bike };
      this.set(withOutfit(DEFAULT_OUTFIT, keep));
    });
    this.show("bike");
  }

  get isOpen() {
    return !this.root.classList.contains("hidden");
  }

  open(outfit?: Outfit) {
    if (outfit) this.outfit = outfit;
    this.render();
    this.root.classList.remove("hidden");
  }

  close() {
    if (!this.isOpen) return;
    this.root.classList.add("hidden");
    this.onClose();
  }

  private set(o: Outfit) {
    this.outfit = o;
    this.render();
    this.onChange(o);
  }

  private show(t: Tab) {
    this.tab = t;
    for (const [k, b] of Object.entries(this.tabButtons)) {
      b.classList.toggle("active", k === t);
      b.setAttribute("aria-selected", String(k === t));
    }
    this.render();
    this.body.scrollTop = 0;
  }

  private render() {
    const scroll = this.body.scrollTop;
    this.body.textContent = "";
    if (this.tab === "bike") for (const r of BIKE_ROWS) this.row(r, this.outfit.bike[r.key], (v) => this.set(withOutfit(this.outfit, { bike: { [r.key]: v } })));
    else for (const r of RIDER_ROWS) this.row(r, this.outfit.rider[r.key], (v) => this.set(withOutfit(this.outfit, { rider: { [r.key]: v } })));
    this.body.scrollTop = scroll;
  }

  private row<K extends string>(r: Row<K>, current: string, pick: (v: string) => void) {
    const row = el("div", "of-row", "", this.body);
    el("div", "of-label", r.label, row);
    const box = el("div", "choices" in r ? "of-choices" : "of-swatches", "", row);
    box.setAttribute("role", "radiogroup");
    box.setAttribute("aria-label", r.label);
    if ("choices" in r) {
      for (const c of r.choices) {
        const b = el("button", "of-btn of-choice", c.label, box);
        b.type = "button";
        b.setAttribute("role", "radio");
        b.setAttribute("aria-checked", String(c.value === current));
        b.classList.toggle("active", c.value === current);
        b.addEventListener("click", () => pick(c.value));
      }
    } else {
      for (const s of r.swatches) {
        const b = el("button", "of-swatch", "", box);
        b.type = "button";
        b.style.setProperty("--swatch", s.hex);
        b.setAttribute("role", "radio");
        b.setAttribute("aria-label", s.name);
        b.title = s.name;
        b.setAttribute("aria-checked", String(s.hex === current));
        b.classList.toggle("active", s.hex === current);
        b.addEventListener("click", () => pick(s.hex));
      }
    }
  }
}
