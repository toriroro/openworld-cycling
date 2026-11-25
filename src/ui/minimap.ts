// 小地図（モック仕様 7.4）: 進行方向が上の円形。近くの道路（走った区間は太く）、喫茶店、行き先の向き。
// 押すと世界地図を開く。sim の状態は読むだけ。

import type { Poi, Road } from "../shared/world/types.ts";
import type { RiddenLog } from "../sim/ridden.ts";
import { platform } from "../platform/index.ts";
import { drawLandmark, ROUTE_COLOR, TARGET_COLORS } from "./world-map.ts";

const RIDDEN = "#ff8a1f";
const ROAD = "rgba(245,245,240,0.85)";

export interface MinimapInput {
  roads: Iterable<{ road: Road; bounds: { x0: number; z0: number; x1: number; z1: number } }>;
  pois: Iterable<Poi>;
  ridden: RiddenLog;
  /** 立ち寄った店 */
  stamped: Set<string>;
  x: number;
  z: number;
  dx: number;
  dz: number;
  goal: { x: number; z: number } | null;
  /** 名所の印（円の中だけ描く） */
  landmarks?: { x: number; z: number; visited: boolean; goal: boolean }[];
  /** 仕事の印（道端の頼み事の人・旗の家。配達の草案 16 章）。円の中だけ描く */
  work?: { x: number; z: number }[];
  /** 配達の行き先（受け取り・届け先）。円の外なら縁に出す（配達の草案 26 章） */
  targets?: { x: number; z: number; kind: "pickup" | "dropoff"; active: boolean }[];
  /** 行き先までの経路の線（世界座標 x, z の交互の並び） */
  route?: number[] | null;
}

/** 小地図の半径 (m) の段（配達の草案 27 章）。＋で近く、－で遠く */
export const MINIMAP_RANGES = [200, 350, 700, 1200, 2000] as const;
const RANGE_KEY = "minimap-range";

export class Minimap {
  /** 小地図と＋－のボタンを入れる枠（置き場所は CSS の .minimap-wrap） */
  readonly wrap: HTMLDivElement;
  readonly root: HTMLButtonElement;
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private rangeEl: HTMLElement;
  private zoomIn: HTMLButtonElement;
  private zoomOut: HTMLButtonElement;
  private rangeTimer = 0;
  /** 半径に入れる距離 (m) */
  radiusM = 700;

  constructor(parent: HTMLElement, onTap: () => void) {
    this.wrap = document.createElement("div");
    this.wrap.className = "minimap-wrap";
    this.root = document.createElement("button");
    this.root.type = "button";
    this.root.className = "minimap";
    this.root.setAttribute("aria-label", "地図を開く");
    this.canvas = document.createElement("canvas");
    this.root.appendChild(this.canvas);
    this.wrap.appendChild(this.root);
    const zoom = document.createElement("div");
    zoom.className = "minimap-zoom";
    const btn = (text: string, label: string, step: number) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "btn minimap-zoom-btn";
      b.textContent = text;
      b.setAttribute("aria-label", label);
      b.addEventListener("pointerdown", (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.step(step);
      });
      zoom.appendChild(b);
      return b;
    };
    this.zoomIn = btn("＋", "小地図を近く", -1);
    this.zoomOut = btn("－", "小地図を遠く", 1);
    this.wrap.appendChild(zoom);
    this.rangeEl = document.createElement("div");
    this.rangeEl.className = "minimap-range hidden";
    this.wrap.appendChild(this.rangeEl);
    parent.appendChild(this.wrap);
    this.ctx = this.canvas.getContext("2d")!;
    this.root.addEventListener("click", onTap);
    this.updateButtons();
    void platform.storage.load(RANGE_KEY).then((t) => {
      const v = Number(t);
      if (t && (MINIMAP_RANGES as readonly number[]).includes(v)) {
        this.radiusM = v;
        this.updateButtons();
      }
    });
  }

  /** 半径を 1 段変える（-1 で近く、1 で遠く）。端末に覚える */
  step(dir: number) {
    const i = Math.max(0, MINIMAP_RANGES.findIndex((r) => r >= this.radiusM));
    const next = MINIMAP_RANGES[Math.max(0, Math.min(MINIMAP_RANGES.length - 1, i + dir))];
    this.radiusM = next;
    this.updateButtons();
    void platform.storage.save(RANGE_KEY, String(next));
    // 変えた時だけ、半径を少しの間出す
    this.rangeEl.textContent = next >= 1000 ? `半径 ${next / 1000} km` : `半径 ${next} m`;
    this.rangeEl.classList.remove("hidden");
    clearTimeout(this.rangeTimer);
    this.rangeTimer = window.setTimeout(() => this.rangeEl.classList.add("hidden"), 1500);
  }

  private updateButtons() {
    this.zoomIn.disabled = this.radiusM <= MINIMAP_RANGES[0];
    this.zoomOut.disabled = this.radiusM >= MINIMAP_RANGES[MINIMAP_RANGES.length - 1];
  }

  draw(m: MinimapInput) {
    const r = this.root.getBoundingClientRect();
    if (r.width === 0) return;
    const dpr = Math.min(2, devicePixelRatio || 1);
    const W = Math.round(r.width * dpr);
    if (this.canvas.width !== W) {
      this.canvas.width = W;
      this.canvas.height = W;
    }
    const ctx = this.ctx;
    const R = W / 2;
    const k = R / this.radiusM;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, W, W);
    ctx.save();
    ctx.beginPath();
    ctx.arc(R, R, R - 1, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(22,30,26,0.78)";
    ctx.fill();
    ctx.clip();
    // 進行方向を上に: 世界 (x, z) → 画面。前 (dx, dz) が上 (−y)、右 (−dz, dx) が右 (+x)
    const fx = m.dx, fz = m.dz;
    const toScreen = (x: number, z: number): [number, number] => {
      const ox = x - m.x, oz = z - m.z;
      const right = ox * -fz + oz * fx;
      const fwd = ox * fx + oz * fz;
      return [R + right * k, R - fwd * k];
    };
    const near = (b: { x0: number; z0: number; x1: number; z1: number }) =>
      b.x1 >= m.x - this.radiusM && b.x0 <= m.x + this.radiusM && b.z1 >= m.z - this.radiusM && b.z0 <= m.z + this.radiusM;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    const roads: Road[] = [];
    for (const e of m.roads) if (near(e.bounds)) roads.push(e.road);
    // 道路（細く）
    ctx.strokeStyle = ROAD;
    for (const road of roads) {
      ctx.lineWidth = Math.max(1.5, road.width * k * 0.9) * (road.cls <= 1 ? 1.2 : 1);
      ctx.beginPath();
      const P = road.points;
      const n = P.length / 3;
      const step = 4;
      for (let i = 0; i < n; i += step) {
        const [sx, sy] = toScreen(P[i * 3] + road.origin[0], P[i * 3 + 2] + road.origin[1]);
        if (i === 0) ctx.moveTo(sx, sy);
        else ctx.lineTo(sx, sy);
      }
      const [ex, ey] = toScreen(P[(n - 1) * 3] + road.origin[0], P[(n - 1) * 3 + 2] + road.origin[1]);
      ctx.lineTo(ex, ey);
      ctx.stroke();
    }
    // 走った区間（太く）
    ctx.strokeStyle = RIDDEN;
    for (const road of roads) {
      const runs = m.ridden.runs(road.id);
      if (!runs.length) continue;
      ctx.lineWidth = Math.max(3, road.width * k * 1.4);
      const P = road.points;
      const n = P.length / 3;
      const ds = road.length / (n - 1);
      for (const [s0, s1] of runs) {
        const i0 = Math.max(0, Math.floor(s0 / ds));
        const i1 = Math.min(n - 1, Math.ceil(s1 / ds));
        ctx.beginPath();
        for (let i = i0; i <= i1; i += 2) {
          const [sx, sy] = toScreen(P[i * 3] + road.origin[0], P[i * 3 + 2] + road.origin[1]);
          if (i === i0) ctx.moveTo(sx, sy);
          else ctx.lineTo(sx, sy);
        }
        ctx.stroke();
      }
    }
    // 行き先までの経路
    const route = m.route;
    if (route && route.length >= 4) {
      ctx.beginPath();
      for (let i = 0; i < route.length; i += 2) {
        const [sx, sy] = toScreen(route[i], route[i + 1]);
        if (i === 0) ctx.moveTo(sx, sy);
        else ctx.lineTo(sx, sy);
      }
      ctx.strokeStyle = "rgba(4,24,32,0.9)";
      ctx.lineWidth = 6 * dpr;
      ctx.stroke();
      ctx.strokeStyle = ROUTE_COLOR;
      ctx.lineWidth = 3.4 * dpr;
      ctx.stroke();
    }
    // 喫茶店
    const byId = new Map(roads.map((rd) => [rd.id, rd]));
    for (const p of m.pois) {
      if (p.kind !== "cafe") continue;
      const rd = byId.get(p.road);
      if (!rd) continue;
      const P = rd.points;
      const n = P.length / 3;
      const i = Math.max(0, Math.min(n - 1, Math.round(p.s / (rd.length / (n - 1)))));
      const [sx, sy] = toScreen(P[i * 3] + rd.origin[0], P[i * 3 + 2] + rd.origin[1]);
      ctx.fillStyle = m.stamped.has(p.id) ? "#c98a3a" : "#8a4b16";
      ctx.strokeStyle = "#fff";
      ctx.lineWidth = 1.5 * dpr;
      const h = 5 * dpr;
      ctx.fillRect(sx - h, sy - h, h * 2, h * 2);
      ctx.strokeRect(sx - h, sy - h, h * 2, h * 2);
    }
    // 名所
    for (const lm of m.landmarks ?? []) {
      const [sx, sy] = toScreen(lm.x, lm.z);
      if ((sx - R) ** 2 + (sy - R) ** 2 > (R - 6 * dpr) ** 2) continue;
      drawLandmark(ctx, sx, sy, lm.visited, lm.goal, dpr * 0.8);
    }
    // 仕事の印（橙の菱形）
    for (const w of m.work ?? []) {
      const [sx, sy] = toScreen(w.x, w.z);
      if ((sx - R) ** 2 + (sy - R) ** 2 > (R - 6 * dpr) ** 2) continue;
      const h = 4.5 * dpr;
      ctx.beginPath();
      ctx.moveTo(sx, sy - h * 1.3);
      ctx.lineTo(sx + h, sy);
      ctx.lineTo(sx, sy + h * 1.3);
      ctx.lineTo(sx - h, sy);
      ctx.closePath();
      ctx.fillStyle = "#ff8a1f";
      ctx.fill();
      ctx.strokeStyle = "#3a1a00";
      ctx.lineWidth = 1.2 * dpr;
      ctx.stroke();
    }
    ctx.restore();
    // 行き先: 円の中なら印、外なら縁に向きの印
    if (m.goal) {
      let [gx, gy] = toScreen(m.goal.x, m.goal.z);
      const ddx = gx - R, ddy = gy - R;
      const d = Math.sqrt(ddx * ddx + ddy * ddy);
      const lim = R - 8 * dpr;
      if (d > lim) {
        gx = R + (ddx / d) * lim;
        gy = R + (ddy / d) * lim;
      }
      ctx.beginPath();
      ctx.arc(gx, gy, 5 * dpr, 0, Math.PI * 2);
      ctx.fillStyle = "#2fd0ff";
      ctx.fill();
      ctx.strokeStyle = "#08202a";
      ctx.lineWidth = 2 * dpr;
      ctx.stroke();
    }
    // 配達の行き先: 円の中なら大きめの丸、外なら縁に（いま向かっている方を後に描いて上に）
    for (const g of [...(m.targets ?? [])].sort((a, b) => Number(a.active) - Number(b.active))) {
      let [gx, gy] = toScreen(g.x, g.z);
      const ddx = gx - R, ddy = gy - R;
      const d = Math.sqrt(ddx * ddx + ddy * ddy);
      const lim = R - 9 * dpr;
      if (d > lim) {
        gx = R + (ddx / d) * lim;
        gy = R + (ddy / d) * lim;
      }
      ctx.beginPath();
      ctx.arc(gx, gy, (g.active ? 7 : 5) * dpr, 0, Math.PI * 2);
      ctx.fillStyle = TARGET_COLORS[g.kind];
      ctx.globalAlpha = g.active ? 1 : 0.6;
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.strokeStyle = "#ffffff";
      ctx.lineWidth = 2 * dpr;
      ctx.stroke();
    }
    // 自分（中心の矢印）
    ctx.beginPath();
    ctx.moveTo(R, R - 9 * dpr);
    ctx.lineTo(R + 6 * dpr, R + 6 * dpr);
    ctx.lineTo(R, R + 3 * dpr);
    ctx.lineTo(R - 6 * dpr, R + 6 * dpr);
    ctx.closePath();
    ctx.fillStyle = "#ffffff";
    ctx.fill();
    ctx.strokeStyle = "#111";
    ctx.lineWidth = 1.5 * dpr;
    ctx.stroke();
    // 縁
    ctx.beginPath();
    ctx.arc(R, R, R - 1, 0, Math.PI * 2);
    ctx.strokeStyle = "rgba(255,255,255,0.55)";
    ctx.lineWidth = 2 * dpr;
    ctx.stroke();
  }
}
