// 小地図（モック仕様 7.4）: 進行方向が上の円形。近くの道路（走った区間は太く）、喫茶店、行き先の向き。
// 押すと世界地図を開く。sim の状態は読むだけ。

import type { Poi, Road } from "../shared/world/types.ts";
import type { RiddenLog } from "../sim/ridden.ts";
import { drawLandmark } from "./world-map.ts";

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
}

export class Minimap {
  readonly root: HTMLButtonElement;
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  /** 半径に入れる距離 (m) */
  radiusM = 700;

  constructor(parent: HTMLElement, onTap: () => void) {
    this.root = document.createElement("button");
    this.root.type = "button";
    this.root.className = "minimap";
    this.root.setAttribute("aria-label", "地図を開く");
    this.canvas = document.createElement("canvas");
    this.root.appendChild(this.canvas);
    parent.appendChild(this.root);
    this.ctx = this.canvas.getContext("2d")!;
    this.root.addEventListener("click", onTap);
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
