// 電柱・電線と街灯（北海道の草案 26 章）。OSM には電柱・街灯の位置がほとんど無いので、道に沿って決まった間隔で置く。
// - 電柱: 走る道（幹線・一般道、町の中・郊外の山道）と、車の通る走らない道（住宅街の道・未分類の道）の片側。
//   町の中は 30m、町の外は 40m ごと【初期値】。続く電柱を電線でつなぐ。店・ビルの多い街の中心（舗装の中心）には置かない（無電柱化）。
//   変圧器は 4 本に 1 本、防犯灯は街灯の無い道の 2 本に 1 本
// - 街灯（道路照明）: 町の中の歩道のある幹線・一般道の両側に、32m ごとに互い違い。腕は道路の方へ向ける
// - 歩道があれば縁石の近く（歩道の上）、無ければ路肩。建物・ほかの道の上・橋・トンネル・接続点の口の近くには置かない
//
// 出力は区画（cell m 四方）ごとの並び。点ごとに [x, y, z, tx, tz, 印]（POLE_REC）:
//   (tx, tz) は電柱なら道に沿う向きで、その向きに見て右 (−tz, tx) が道の方（防犯灯を道の方へ出す）。街灯なら腕の向き（道の中心の方）。y が NaN なら高さは描く側が地形から取る（走らない道の電柱）
//   印は POLE_FLAGS。同じ並びの続く電柱を電線でつなぐ。区画の境では、次の区画の最初の電柱を「電線の端だけ」の印で並びの最後に足す

import { POLE_FLAGS, POLE_REC, type HokkaidoStreetIndex } from "../../src/shared/world/hokkaido.ts";
import type { BuiltRoad } from "./roads.ts";
import { type BuildingIndex, coverageAt, type CoverageGrid, CURB, type RideIndex, type RoadsideSample, type StreetIndex } from "./sidewalks.ts";

/** 電柱の間隔 (m)【初期値】。町の中・町の外 */
const PITCH_TOWN = 30;
const PITCH_RURAL = 40;
/** 電線でつなぐ電柱の間の上限 (m) */
const MAX_SPAN = 48;
/** 街灯の間隔 (m)【初期値】（片側。両側で互い違い） */
const LAMP_PITCH = 32;
/** 接続点の口から空ける長さ (m)。横断歩道と停止線の分 */
const MOUTH_CLEAR = 8;
/** 電柱を置かない、店・ビルの込み具合（舗装の中心と同じ） */
const NO_POLE_COMMERCIAL = 0.15;

function hashUnit(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return (h >>> 0) / 4294967296;
}

class PoleWriter {
  readonly pts: number[] = [];
  readonly index: Record<string, [number, number][]> = {};
  private run: number[] = [];
  private runKey = "";
  stats = { poles: 0, lamps: 0, transformers: 0, streetlights: 0, wireKm: 0 };
  constructor(private cell: number) {}
  private keyOf(x: number, z: number) {
    return `${Math.floor(x / this.cell)},${Math.floor(z / this.cell)}`;
  }
  /** 電線でつなぐ並びに電柱を足す */
  pole(x: number, y: number, z: number, tx: number, tz: number, flags: number) {
    const key = this.keyOf(x, z);
    const n = this.run.length;
    if (n) {
      const lx = this.run[n - POLE_REC], lz = this.run[n - POLE_REC + 2];
      const d = Math.hypot(x - lx, z - lz);
      if (d > MAX_SPAN) this.end();
      else {
        this.stats.wireKm += d / 1000;
        if (key !== this.runKey) {
          // 区画の境: 次の電柱を電線の端だけ足して閉じ、次の並びを始める
          this.run.push(x, y, z, tx, tz, flags | POLE_FLAGS.anchor);
          this.flush();
        }
      }
    }
    this.runKey = key;
    this.run.push(x, y, z, tx, tz, flags);
    this.stats.poles++;
    if (flags & POLE_FLAGS.lamp) this.stats.lamps++;
    if (flags & POLE_FLAGS.transformer) this.stats.transformers++;
  }
  /** 電線の並びを終える */
  end() {
    this.flush();
  }
  private flush() {
    if (this.run.length) {
      const off = this.pts.length / POLE_REC;
      for (let i = 0; i < this.run.length; i++) {
        const v = this.run[i];
        this.pts.push(Number.isNaN(v) ? v : i % POLE_REC === 5 ? v : Math.round(v * 1000) / 1000);
      }
      (this.index[this.runKey] ??= []).push([off, this.run.length / POLE_REC]);
    }
    this.run = [];
  }
  /** 街灯（電線なし。1 本で 1 つの並び） */
  streetlight(x: number, y: number, z: number, tx: number, tz: number) {
    this.end();
    this.runKey = this.keyOf(x, z);
    this.run.push(x, y, z, tx, tz, POLE_FLAGS.streetlight);
    this.flush();
    this.stats.streetlights++;
  }
}

export function buildPoles(
  roads: BuiltRoad[],
  roadside: Map<string, RoadsideSample[]>,
  streets: { pts: Float32Array; index: HokkaidoStreetIndex },
  idx: { bidx: BuildingIndex; ridx: RideIndex; sidx: StreetIndex | null },
  trees: Float32Array,
  cov: CoverageGrid,
  commercial: CoverageGrid,
  cell: number,
) {
  const out = new PoleWriter(cell);
  const { bidx, ridx, sidx } = idx;
  // 街路樹の索引（電柱・街灯を木に重ねない）
  const treeCells = new Map<string, number[]>();
  for (let o = 0; o < trees.length; o += 5) {
    const k = `${Math.floor(trees[o] / 8)},${Math.floor(trees[o + 2] / 8)}`;
    (treeCells.get(k) ?? treeCells.set(k, []).get(k)!).push(trees[o], trees[o + 2]);
  }
  const nearTree = (x: number, z: number, r: number) => {
    for (let i = Math.floor((x - r) / 8); i <= Math.floor((x + r) / 8); i++)
      for (let j = Math.floor((z - r) / 8); j <= Math.floor((z + r) / 8); j++) {
        const l = treeCells.get(`${i},${j}`);
        if (l) for (let q = 0; q < l.length; q += 2) if (Math.hypot(l[q] - x, l[q + 1] - z) < r) return true;
      }
    return false;
  };
  // 置いた電柱・街灯（街灯を電柱に重ねない）
  const placed = new Map<string, number[]>();
  const mark = (x: number, z: number) => {
    const k = `${Math.floor(x / 8)},${Math.floor(z / 8)}`;
    (placed.get(k) ?? placed.set(k, []).get(k)!).push(x, z);
  };
  const nearPlaced = (x: number, z: number, r: number) => {
    for (let i = Math.floor((x - r) / 8); i <= Math.floor((x + r) / 8); i++)
      for (let j = Math.floor((z - r) / 8); j <= Math.floor((z + r) / 8); j++) {
        const l = placed.get(`${i},${j}`);
        if (l) for (let q = 0; q < l.length; q += 2) if (Math.hypot(l[q] - x, l[q + 1] - z) < r) return true;
      }
    return false;
  };
  let seq = 0;
  const flagsFor = (lampOk: boolean) => {
    seq++;
    let f = 0;
    if (hashUnit(`t${seq}`) < 0.25) f |= POLE_FLAGS.transformer;
    if (lampOk && hashUnit(`l${seq}`) < 0.5) f |= POLE_FLAGS.lamp;
    return f;
  };

  // ---- 走る道 ----
  roads.forEach((road, ri) => {
    if (road.kind === "cycleway" || road.surface !== "paved" || road.cls > 2) return;
    const hw = road.width / 2;
    const s0 = roadside.get(`${ri}|1`);
    const s1 = roadside.get(`${ri}|-1`);
    if (!s0 || !s1 || s0.length < 3) return;
    const sides: Record<string, RoadsideSample[]> = { "1": s0, "-1": s1 };
    const first = s0[0].s;
    const last = s0[s0.length - 1].s;
    const usable = (q: RoadsideSample) => q.s >= first + MOUTH_CLEAR && q.s <= last - MOUTH_CLEAR && !q.span;
    // 町の中の歩道のある幹線・一般道に街灯
    const lit = road.cls <= 1 && s0.concat(s1).filter((q) => q.walk > 0 && coverageAt(cov, q.x, q.z) >= 0.12).length >= (s0.length + s1.length) * 0.4;
    // 電柱: 片側（道ごとに決める）
    const side = hashUnit(road.id) < 0.5 ? "1" : "-1";
    const list = sides[side];
    let nextS = first + MOUTH_CLEAR + hashUnit(`${road.id}#p`) * 12;
    for (let k = 0; k < list.length; k++) {
      const q = list[k];
      if (q.s < nextS) continue;
      const c = coverageAt(cov, q.x, q.z);
      const town = c >= 0.06;
      if (road.cls === 2 && !town) {
        out.end();
        nextS = q.s + PITCH_RURAL;
        continue;
      }
      if (!usable(q) || coverageAt(commercial, q.x, q.z) >= NO_POLE_COMMERCIAL) {
        out.end();
        nextS = q.s + 4;
        continue;
      }
      const off = q.walk > 0 ? hw + 0.45 : hw + 0.6;
      const x = q.x + q.nx * off, z = q.z + q.nz * off;
      if (bidx.inside(x, z, 0.4) || ridx.onOther(x, z, ri, 0.5) || ridx.inside(x, z, -0.3) || (sidx && sidx.on(x, z, 0.6)) || nearTree(x, z, 2.5)) {
        nextS = q.s + 4;
        continue;
      }
      const y = q.walk > 0 ? q.y + CURB : q.y - 0.04;
      // 道に沿う向き。右 (−tz, tx) が道の方（外向きの法線の逆）になる向き
      out.pole(x, y, z, -q.nz, q.nx, flagsFor(!lit));
      mark(x, z);
      nextS = q.s + (town ? PITCH_TOWN : PITCH_RURAL);
    }
    out.end();
    if (!lit) return;
    // 街灯: 両側で互い違い
    for (const sd of ["1", "-1"]) {
      const L = sides[sd];
      let next = first + MOUTH_CLEAR + 4 + (sd === "1" ? 0 : LAMP_PITCH / 2);
      for (const q of L) {
        if (q.s < next) continue;
        if (!usable(q) || q.walk <= 0 || coverageAt(cov, q.x, q.z) < 0.12) {
          next = q.s + 4;
          continue;
        }
        const x = q.x + q.nx * (hw + 0.45), z = q.z + q.nz * (hw + 0.45);
        if (bidx.inside(x, z, 0.4) || ridx.onOther(x, z, ri, 0.5) || ridx.inside(x, z, -0.3) || nearTree(x, z, 2.5) || nearPlaced(x, z, 5)) {
          next = q.s + 4;
          continue;
        }
        out.streetlight(x, q.y + CURB, z, -q.nx, -q.nz);
        mark(x, z);
        next = q.s + LAMP_PITCH;
      }
    }
  });

  // ---- 車の通る走らない道（住宅街の道・未分類の道。幅 4m 以上）----
  const P = streets.pts;
  for (const list of Object.values(streets.index.pieces))
    for (const [off, count, w10, kind] of list) {
      if (kind !== 0 || w10 < 40 || count < 2) continue;
      const hw = w10 / 20;
      const id = `st${off}`;
      const side = hashUnit(id) < 0.5 ? 1 : -1;
      // 折れ線に沿って 2m ごとに進む
      let acc = 0;
      let next = 6 + hashUnit(`${id}#p`) * 14;
      for (let i = 0; i + 1 < count; i++) {
        const ax = P[(off + i) * 2], az = P[(off + i) * 2 + 1], bx = P[(off + i + 1) * 2], bz = P[(off + i + 1) * 2 + 1];
        const l = Math.hypot(bx - ax, bz - az);
        if (l < 1e-6) continue;
        const tx = (bx - ax) / l, tz = (bz - az) / l;
        for (let t = 0; t < l; t += 2) {
          const s = acc + t;
          if (s < next) continue;
          const cx = ax + tx * t, cz = az + tz * t;
          if (coverageAt(commercial, cx, cz) >= NO_POLE_COMMERCIAL) {
            out.end();
            next = s + 4;
            continue;
          }
          const nx = -tz * side, nz = tx * side;
          const x = cx + nx * (hw + 0.35), z = cz + nz * (hw + 0.35);
          // 曲がり角・ほかの道の口に近い所、走る道の近く、建物の中は避ける
          if (bidx.inside(x, z, 0.3) || ridx.onOther(x, z, -1, 1.5) || (sidx && sidx.on(x + nx * 0.8, z + nz * 0.8, 0.3)) || nearPlaced(x, z, 6)) {
            next = s + 2;
            continue;
          }
          // 右 (−tz, tx) が道の方になる向き（電柱は道の side の側にある）
          out.pole(x, Number.NaN, z, -side * tx, -side * tz, flagsFor(true));
          mark(x, z);
          next = s + (coverageAt(cov, cx, cz) >= 0.06 ? PITCH_TOWN : PITCH_RURAL);
        }
        acc += l;
      }
      out.end();
    }
  const st = out.stats;
  return {
    pts: Float32Array.from(out.pts),
    index: out.index,
    stats: { ...st, wireKm: Math.round(st.wireKm * 10) / 10, MB: +((out.pts.length * 4) / 1048576).toFixed(1) },
  };
}
