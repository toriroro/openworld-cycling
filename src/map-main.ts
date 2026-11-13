// map.html の入口。地図、凡例、道路の縦断図と数値。

import "./ui/map.css";
import { ROAD_CLASSES, WORLD_SEED } from "./shared/world/constants.ts";
import type { Road } from "./shared/world/types.ts";
import { GRADE_COLORS, GRADE_STEPS, POI_COLORS, roadPoint, WorldMap } from "./ui/world-map.ts";

const q = new URLSearchParams(location.search);
const num = (k: string, d: number) => (q.has(k) ? Number(q.get(k)) : d);
const seed = num("seed", WORLD_SEED);
const mark = q.has("mark") ? q.get("mark")!.split(",").map(Number) : null;

const canvas = document.getElementById("map") as HTMLCanvasElement;
const statusEl = document.getElementById("status")!;
const panel = document.getElementById("road")!;
const legend = document.getElementById("legend")!;

legend.innerHTML = [
  `<div class="lg-title">勾配</div>`,
  ...GRADE_COLORS.map((c, i) => {
    const lo = i === 0 ? 0 : Math.round(GRADE_STEPS[i - 1] * 100);
    const hi = GRADE_STEPS[i] !== undefined ? `${Math.round(GRADE_STEPS[i] * 100)}%` : "";
    return `<div class="lg-row"><span class="sw" style="background:${c}"></span>${lo}${hi ? "–" + hi : "% 超"}</div>`;
  }),
  `<div class="lg-title">等級</div>`,
  ...ROAD_CLASSES.map((c) => `<div class="lg-row">${c.name} ${c.width}m・${Math.round(c.maxGrade * 100)}%・R${c.minRadius}</div>`),
  `<div class="lg-title">地点</div>`,
  `<div class="lg-row"><span class="sw" style="background:${POI_COLORS.cafe}"></span>喫茶店</div>`,
  `<div class="lg-row"><span class="sw tri" style="border-bottom-color:${POI_COLORS.pass}"></span>峠</div>`,
  `<div class="lg-row"><span class="sw dia" style="background:${POI_COLORS.viewpoint}"></span>展望地</div>`,
  `<div class="lg-row"><span class="sw dot" style="background:#c0262d"></span>町 <span class="sw dot" style="background:#f2f2f2"></span>集落</div>`,
  `<div class="lg-row"><span class="sw br"></span>橋</div>`,
].join("");

const map = new WorldMap(canvas, {
  seed,
  x: num("x", 0),
  z: num("z", 0),
  mpp: num("mpp", 20),
  mark: mark ? { x: mark[0], z: mark[1], r: mark[2] ?? 15000 } : undefined,
  onSelect: showRoad,
  onStatus: (s) => {
    const km = (s.mpp * 100) / 1000;
    statusEl.textContent =
      `種 ${seed}  x ${Math.round(s.x)}  z ${Math.round(s.z)}  100px = ${km < 1 ? Math.round(km * 1000) + "m" : km.toFixed(1) + "km"}` +
      `  道路 ${s.roads}本` +
      (s.pendingBlocks ? `  道路を生成中 残り${s.pendingBlocks}区画` : "") +
      (s.pendingTiles ? `  地形 残り${s.pendingTiles}` : "");
  },
});
(window as unknown as { __map: WorldMap }).__map = map;

if (window.innerWidth < 700) legend.classList.add("hidden");
document.getElementById("toggle-legend")!.addEventListener("click", () => legend.classList.toggle("hidden"));
document.getElementById("close-road")?.addEventListener("click", () => map.select(null));

function showRoad(road: Road | null) {
  if (!road) {
    panel.classList.add("hidden");
    return;
  }
  panel.classList.remove("hidden");
  const n = road.points.length / 3;
  const ds = road.length / (n - 1);
  let up = 0;
  let down = 0;
  let maxG = 0;
  const W = 10; // 20m の区間で勾配を測る
  for (let i = 1; i < n; i++) {
    const d = road.points[i * 3 + 1] - road.points[i * 3 - 2];
    if (d > 0) up += d;
    else down -= d;
  }
  for (let i = W; i < n; i += 1) {
    const g = Math.abs(road.points[i * 3 + 1] - road.points[(i - W) * 3 + 1]) / (W * ds);
    if (g > maxG) maxG = g;
  }
  const y0 = road.points[1];
  const y1 = road.points[(n - 1) * 3 + 1];
  const pois = [...map.pois.values()].filter((p) => p.road === road.id);
  const spec = ROAD_CLASSES[road.cls];
  document.getElementById("road-name")!.textContent = road.name;
  document.getElementById("road-facts")!.innerHTML = [
    ["等級", `${spec.name}（${road.surface === "paved" ? "舗装" : "未舗装"}、幅 ${road.width}m）`],
    ["延長", `${(road.length / 1000).toFixed(2)} km`],
    ["標高", `${y0.toFixed(0)} m → ${y1.toFixed(0)} m`],
    ["平均勾配", `${((Math.abs(y1 - y0) / road.length) * 100).toFixed(1)} %（${((up + down) / road.length * 100).toFixed(1)} %：上下の合計 ÷ 延長）`],
    ["最大勾配", `${(maxG * 100).toFixed(1)} %（20m 区間）`],
    ["獲得標高", `${up.toFixed(0)} m（逆向き ${down.toFixed(0)} m）`],
    ["橋", `${road.spans.length} か所 ${road.spans.reduce((a, s) => a + s.to - s.from, 0).toFixed(0)} m`],
    ["地点", pois.map((p) => p.name).join("、") || "なし"],
    ["識別子", road.id],
  ]
    .map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`)
    .join("");
  drawProfile(road);
}

function drawProfile(road: Road) {
  const cv = document.getElementById("profile") as HTMLCanvasElement;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const r = cv.getBoundingClientRect();
  cv.width = Math.round(r.width * dpr);
  cv.height = Math.round(r.height * dpr);
  const ctx = cv.getContext("2d")!;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const W = r.width;
  const H = r.height;
  ctx.clearRect(0, 0, W, H);
  const n = road.points.length / 3;
  const ds = road.length / (n - 1);
  let lo = Infinity;
  let hi = -Infinity;
  const ground: number[] = [];
  for (let i = 0; i < n; i++) {
    const y = road.points[i * 3 + 1];
    lo = Math.min(lo, y);
    hi = Math.max(hi, y);
  }
  void ground;
  const pad = Math.max(20, (hi - lo) * 0.1);
  lo -= pad;
  hi += pad;
  const L = 34;
  const B = 18;
  const X = (s: number) => L + (s / road.length) * (W - L - 6);
  const Y = (y: number) => 6 + (1 - (y - lo) / (hi - lo)) * (H - 6 - B);
  // 橋
  ctx.fillStyle = "rgba(255,255,255,0.18)";
  for (const sp of road.spans) ctx.fillRect(X(sp.from), 6, Math.max(1, X(sp.to) - X(sp.from)), H - 6 - B);
  // 勾配で色分けした面
  const CH = 10;
  for (let i = 0; i < n - 1; i += CH) {
    const j = Math.min(n - 1, i + CH);
    const g = Math.abs(road.points[j * 3 + 1] - road.points[i * 3 + 1]) / ((j - i) * ds);
    let b = 0;
    while (b < GRADE_STEPS.length && g > GRADE_STEPS[b]) b++;
    ctx.fillStyle = GRADE_COLORS[b];
    ctx.beginPath();
    ctx.moveTo(X(i * ds), H - B);
    for (let k = i; k <= j; k++) ctx.lineTo(X(k * ds), Y(road.points[k * 3 + 1]));
    ctx.lineTo(X(j * ds), H - B);
    ctx.closePath();
    ctx.fill();
  }
  // 目盛り
  ctx.fillStyle = "#ddd";
  ctx.font = "11px system-ui, sans-serif";
  ctx.fillText(`${Math.round(hi)}m`, 0, 14);
  ctx.fillText(`${Math.round(lo)}m`, 0, H - B);
  ctx.fillText("0", L, H - 4);
  const end = `${(road.length / 1000).toFixed(1)}km`;
  ctx.fillText(end, W - 6 - ctx.measureText(end).width, H - 4);
  // 地点
  for (const p of map.pois.values()) {
    if (p.road !== road.id) continue;
    const pos = roadPoint(road, p.s);
    ctx.fillStyle = POI_COLORS[p.kind];
    ctx.strokeStyle = "#fff";
    ctx.beginPath();
    ctx.arc(X(p.s), Y(pos.y), 4, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  }
}
