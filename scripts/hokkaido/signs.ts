// 道路標識（北海道の草案 27 章）。OSM には標識の位置がほとんど無いので、道の等級・接続点・一方通行・速度の札から決める。
// 日本の道は左側を走るので、標識は進む向きの左の道端に、向かってくる車の方へ向けて立てる。
// - 規制標識: 止まれ（下位の道が上位の道に出る所。住宅街の道が走る道に出る所）、横断歩道（横断歩道の両端）、
//   一方通行（入る端、板は道に沿う向き）と進入禁止（出る端）、最高速度（OSM の maxspeed。無ければ等級と町の中かで決める）
// - 案内標識: 幹線を含む接続点の手前の、幹線・一般道の上に張り出す青い板。文字は分岐の表示と同じく、腕の道路名と方向だけ
//
// 出力は区画（cell m 四方）ごとの番号の並び。点ごとに [x, y, z, fx, fz, 種類, 値, 張り出し]（SIGN_REC）:
//   (fx, fz) は板の表の向き（向かってくる車の方）。一方通行だけは矢印の向き（板は道に沿う）。
//   y が NaN なら高さは描く側が地形から取る（住宅街の道の止まれ）。
//   値は最高速度 (km/h) か、案内標識の文字の番号（guides の [左, 直進, 右]）。張り出しは案内標識の柱から板の中心まで (m)

import { SIGN_REC, SIGN_TYPES, type HokkaidoStreetIndex } from "../../src/shared/world/hokkaido.ts";
import type { JunctionShape } from "../../src/sim/junction-shape.ts";
import type { BuiltRoad } from "./roads.ts";
import { type BuildingIndex, coverageAt, type CoverageGrid, type CrossMark, CURB, type RideIndex, type RoadsideSample, type StreetIndex } from "./sidewalks.ts";

/** 道ごとの OSM の札から分かること。forward は一方通行の向きが道のりの増える向きか（分からなければ null） */
export interface WayInfo {
  maxspeed: number | null;
  forward: boolean | null;
}

/** 最高速度の標識の間隔 (m)【初期値】 */
const SPEED_EVERY = 1000;
/** 最高速度の標識を立てる道の長さの下限 (m)【初期値】（接続点の多い町の中で、区間ごとに立てすぎない） */
const SPEED_MIN_ROAD = 200;
/** 案内標識の、接続点の口からの距離 (m)【初期値】 */
const GUIDE_AHEAD = 50;

export function buildSigns(
  roads: BuiltRoad[],
  shapes: JunctionShape[],
  cross: Record<string, CrossMark[]>,
  roadIndex: Map<string, number>,
  roadside: Map<string, RoadsideSample[]>,
  streets: { pts: Float32Array; index: HokkaidoStreetIndex },
  idx: { bidx: BuildingIndex; ridx: RideIndex; sidx: StreetIndex | null },
  cov: CoverageGrid,
  wayInfo: (road: BuiltRoad) => WayInfo,
  cell: number,
) {
  const pts: number[] = [];
  const index: Record<string, number[]> = {};
  const guides: [string, string, string][] = [];
  const stats = { stop: 0, streetStop: 0, crosswalk: 0, oneway: 0, noEntry: 0, speed: 0, speedFromOsm: 0, guide: 0 };
  const { bidx, ridx } = idx;
  const info = roads.map((r) => wayInfo(r));
  const push = (x: number, y: number, z: number, fx: number, fz: number, type: number, value = 0, extra = 0) => {
    const k = `${Math.floor(x / cell)},${Math.floor(z / cell)}`;
    (index[k] ??= []).push(pts.length / SIGN_REC);
    const r = (v: number) => (Number.isNaN(v) ? v : Math.round(v * 1000) / 1000);
    pts.push(r(x), r(y), r(z), r(fx), r(fz), type, value, r(extra));
  };
  /** 走る道 ri の side 側の、道のり s に近い道端の点。歩道があれば歩道の上 */
  const roadsideAt = (ri: number, side: 1 | -1, s: number, sidewalkOff = 0.5, shoulderOff = 0.8) => {
    const list = roadside.get(`${ri}|${side}`);
    if (!list || !list.length) return null;
    let best = list[0];
    for (const q of list) if (Math.abs(q.s - s) < Math.abs(best.s - s)) best = q;
    if (Math.abs(best.s - s) > 4 || best.span) return null;
    const hw = roads[ri].width / 2;
    const off = best.walk > 0 ? hw + Math.min(sidewalkOff, best.walk - 0.3) : hw + shoulderOff;
    const x = best.x + best.nx * off, z = best.z + best.nz * off;
    if (bidx.inside(x, z, 0.2) || ridx.onOther(x, z, ri, 0.3)) return null;
    return { x, z, y: best.walk > 0 ? best.y + CURB : best.y - 0.04, q: best, off };
  };
  /** 一方通行で、腕 a から接続点へ入れないか（forward = 道のりの増える向きだけ走れる） */
  const noInbound = (ri: number, dir: 1 | -1) => {
    const r = roads[ri];
    const f = info[ri].forward;
    if (!r.oneway || f === null) return false;
    // 接続点へ入る = 外向き (dir) の逆へ走る
    return f ? dir > 0 : dir < 0;
  };

  // ---- 接続点ごと: 止まれ・横断歩道・案内標識 ----
  const guideAt = new Map<string, number[]>();
  for (const sh of shapes) {
    const n = sh.arms.length;
    if (n < 3) continue;
    const minCls = Math.min(...sh.arms.map((a) => a.road.cls));
    const marks = cross[sh.junction.id];
    // 案内標識を立てる接続点: 幹線を含み、等級 1 以上の腕に名前が 2 つ以上
    const names = new Set(sh.arms.filter((a) => a.road.cls <= 1 && a.road.name).map((a) => a.road.name));
    const guideJunction = minCls === 0 && names.size >= 2;
    for (const a of sh.arms) {
      const ri = roadIndex.get(a.road.id);
      if (ri === undefined) continue;
      const dir = a.arm.dir;
      const mark = marks?.[sh.junction.arms.indexOf(a.arm)] ?? 0;
      const ox = a.ox, oz = a.oz;
      // 止まれ: 下位の道（横断歩道の無い腕）
      if (a.road.cls > minCls && !mark && !noInbound(ri, dir)) {
        const p = roadsideAt(ri, dir, a.mouthS + dir * 2.5);
        if (p) {
          push(p.x, p.y, p.z, ox, oz, SIGN_TYPES.stop);
          stats.stop++;
        }
      }
      // 横断歩道の両端（両面）
      if (mark)
        for (const side of [1, -1] as const) {
          const p = roadsideAt(ri, side, a.mouthS + dir * 2.8, 0.45, 0.6);
          if (p) {
            push(p.x, p.y, p.z, ox, oz, SIGN_TYPES.crosswalk);
            stats.crosswalk++;
          }
        }
      // 案内標識
      if (guideJunction && a.road.cls <= 1 && a.road.surface === "paved" && !noInbound(ri, dir)) {
        const list = roadside.get(`${ri}|${dir}`);
        if (!list || list.length < 2) continue;
        const room = list[list.length - 1].s - list[0].s;
        if (room < 80) continue;
        const s = a.mouthS + dir * Math.min(GUIDE_AHEAD, room * 0.45);
        const p = roadsideAt(ri, dir, s, 0.6, 0.9);
        if (!p) continue;
        // 同じ道の同じ側に 100m 以内の案内標識があれば立てない
        const gk = `${ri}|${dir}`;
        const seen = guideAt.get(gk) ?? [];
        if (seen.some((t) => Math.abs(t - s) < 100)) continue;
        // 腕ごとの方向: 接続点へ入る向き h から見て、直進（50 度以内）・左・右。同じ方向には等級の高い腕
        const hx = -ox, hz = -oz;
        const slot: ({ name: string; cls: number } | null)[] = [null, null, null];
        for (const b of sh.arms) {
          if (b === a || !b.road.name) continue;
          const d = b.ux * hx + b.uz * hz;
          const left = b.ux * hz - b.uz * hx;
          const k = d > 0.64 ? 1 : left > 0 ? 0 : 2;
          if (!slot[k] || b.road.cls < slot[k]!.cls) slot[k] = { name: b.road.name, cls: b.road.cls };
        }
        const filled = slot.filter(Boolean);
        if (filled.length < 2 || filled.every((q) => q!.name === a.road.name)) continue;
        seen.push(s);
        guideAt.set(gk, seen);
        // 板の中心は左の車線の上（道の中心から半幅の半分）
        const reach = p.off - a.hw * 0.5;
        push(p.x, p.y, p.z, ox, oz, SIGN_TYPES.guide, guides.length, reach);
        guides.push([slot[0]?.name ?? "", slot[1]?.name ?? "", slot[2]?.name ?? ""]);
        stats.guide++;
      }
    }
  }

  // ---- 道ごと: 一方通行・進入禁止・最高速度 ----
  roads.forEach((road, ri) => {
    if (road.kind === "cycleway") return;
    const s0 = roadside.get(`${ri}|1`);
    if (!s0 || s0.length < 2) return;
    const first = s0[0].s, last = s0[s0.length - 1].s;
    const ds = road.length / (road.points.length / 3 - 1);
    // 道のりの増える向き（区間の点の向き）
    const tangent = (s: number) => {
      const P = road.points;
      const n = P.length / 3;
      const i = Math.max(0, Math.min(n - 2, Math.round(s / ds)));
      const tx = P[i * 3 + 3] - P[i * 3], tz = P[i * 3 + 5] - P[i * 3 + 2];
      const l = Math.hypot(tx, tz) || 1;
      return [tx / l, tz / l];
    };
    const f = info[ri].forward;
    if (road.oneway && f !== null && road.cls <= 2 && last - first > 20) {
      const sg = f ? 1 : -1;
      // 入る端: 進む向きの左に、矢印の板（道に沿う向き）
      const sIn = f ? first + 6 : last - 6;
      const pIn = roadsideAt(ri, sg > 0 ? -1 : 1, sIn);
      if (pIn) {
        const [tx, tz] = tangent(sIn);
        push(pIn.x, pIn.y, pIn.z, tx * sg, tz * sg, SIGN_TYPES.oneway);
        stats.oneway++;
      }
      // 出る端: 逆向きに入ってくる車の左に、進入禁止
      const sOut = f ? last - 3 : first + 3;
      const pOut = roadsideAt(ri, sg > 0 ? 1 : -1, sOut);
      if (pOut) {
        const [tx, tz] = tangent(sOut);
        push(pOut.x, pOut.y, pOut.z, tx * sg, tz * sg, SIGN_TYPES.noEntry);
        stats.noEntry++;
      }
    }
    if (road.cls <= 1 && road.surface === "paved" && last - first >= SPEED_MIN_ROAD) {
      const town = coverageAt(cov, s0[0].x, s0[0].z) >= 0.06;
      const osm = info[ri].maxspeed;
      const v = osm ?? (road.cls === 0 ? (town ? 50 : 60) : town ? 40 : 50);
      for (const sg of [1, -1] as const) {
        if (road.oneway && f !== null && (f ? sg < 0 : sg > 0)) continue;
        for (let k = 0; ; k++) {
          const s = sg > 0 ? first + 25 + k * SPEED_EVERY : last - 25 - k * SPEED_EVERY;
          if (s < first + 10 || s > last - 10) break;
          // 進む向きの左に、向かってくる車の方へ
          const p = roadsideAt(ri, sg > 0 ? -1 : 1, s);
          if (!p) continue;
          const [tx, tz] = tangent(s);
          push(p.x, p.y, p.z, -tx * sg, -tz * sg, SIGN_TYPES.speed, v);
          stats.speed++;
          if (osm !== null) stats.speedFromOsm++;
        }
      }
    }
  });

  // ---- 住宅街の道（車の通る走らない道、幅 4m 以上）が走る道に出る所: 止まれ ----
  const P = streets.pts;
  for (const list of Object.values(streets.index.pieces))
    for (const [off, count, w10, kind] of list) {
      if (kind !== 0 || w10 < 40 || count < 2) continue;
      const hw = w10 / 20;
      for (const end of [0, count - 1]) {
        const prev = end === 0 ? 1 : count - 2;
        const ex = P[(off + end) * 2], ez = P[(off + end) * 2 + 1];
        let dx = ex - P[(off + prev) * 2], dz = ez - P[(off + prev) * 2 + 1];
        const l = Math.hypot(dx, dz);
        if (l < 3) continue;
        dx /= l;
        dz /= l;
        if (!ridx.onOther(ex + dx * 2.5, ez + dz * 2.5, -1, 0.3)) continue;
        // 進む向きの左 (dz, −dx)
        const x = ex - dx * 2.5 + dz * (hw + 0.4), z = ez - dz * 2.5 - dx * (hw + 0.4);
        if (bidx.inside(x, z, 0.2) || ridx.onOther(x, z, -1, 0.3)) continue;
        push(x, Number.NaN, z, -dx, -dz, SIGN_TYPES.stop);
        stats.streetStop++;
      }
    }

  return { pts: Float32Array.from(pts), index, guides, stats: { ...stats, MB: +((pts.length * 4) / 1048576).toFixed(1) } };
}
