// 北海道の PBF から、範囲の中の建物の外形を取り出す（北海道の草案 15.1 の b）。
// H2 から build.ts は PBF を直接読む（pbf-area.ts）ので、この出力は使わない。H0 の時の手順の記録として残す。
//   npx tsx scripts/hokkaido/extract-buildings.ts
// 入力: assets-source/hokkaido/pbf/*.osm.pbf（Geofabrik の北海道の抽出）
// 出力: assets-source/hokkaido/h0/buildings.json（世界座標の外形と、使う札だけ。git に入れない）
// 範囲の端にかかる建物（点が範囲の外にあるもの）は捨てる。多角形の関係（建物の関係）は外側の輪だけ使う。

import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { H0_BOX, SOURCE_DIR } from "./area.ts";
import { readPbf } from "./pbf.ts";
import { project } from "./projection.ts";

const PBF_DIR = `${SOURCE_DIR}/pbf`;
const pbf = readdirSync(PBF_DIR).filter((f) => f.endsWith(".osm.pbf")).sort().at(-1);
if (!pbf) throw new Error(`${PBF_DIR} に .osm.pbf が無い`);
const OUT = `${SOURCE_DIR}/h0/buildings.json`;
/** 使う札 */
const KEEP = ["building", "building:levels", "building:levels:underground", "height", "roof:shape", "roof:levels", "amenity", "shop", "name"];

const t0 = performance.now();
const box = H0_BOX;
// 点: 番号の順に並んでいるので、型付きの配列に詰めて二分探索する
let cap = 1 << 22;
let ids = new Float64Array(cap);
let xs = new Float32Array(cap);
let zs = new Float32Array(cap);
let n = 0;
let lastId = -Infinity;
let sorted = true;
const ways: { id: number; refs: number[]; tags: Record<string, string> }[] = [];
const rels: { id: number; outer: number[]; tags: Record<string, string> }[] = [];
const relWays = new Set<number>();
const wayRefs = new Map<number, number[]>();

readPbf(`${PBF_DIR}/${pbf}`, {
  node(p) {
    if (p.lat < box.south || p.lat > box.north || p.lon < box.west || p.lon > box.east) return;
    if (n === cap) {
      cap *= 2;
      const a = new Float64Array(cap);
      a.set(ids);
      ids = a;
      const b = new Float32Array(cap);
      b.set(xs);
      xs = b;
      const c = new Float32Array(cap);
      c.set(zs);
      zs = c;
    }
    if (p.id < lastId) sorted = false;
    lastId = p.id;
    const q = project(p.lat, p.lon);
    ids[n] = p.id;
    xs[n] = q.x;
    zs[n] = q.z;
    n++;
  },
  way(w) {
    if (w.tags.building && w.tags.building !== "no") ways.push(w);
    else wayRefs.set(w.id, w.refs);
  },
  relation(r) {
    if (r.tags.type !== "multipolygon" || !r.tags.building) return;
    const outer = r.members.filter((m) => m.type === "way" && m.role === "outer").map((m) => m.ref);
    for (const id of outer) relWays.add(id);
    rels.push({ id: r.id, outer, tags: r.tags });
  },
});
if (!sorted) throw new Error("点が番号の順に並んでいない");
console.log(`読み込み ${((performance.now() - t0) / 1000).toFixed(0)}s、範囲の点 ${n}、建物の道 ${ways.length}、建物の関係 ${rels.length}`);

function find(id: number): number {
  let lo = 0;
  let hi = n - 1;
  while (lo <= hi) {
    const m = (lo + hi) >> 1;
    if (ids[m] === id) return m;
    if (ids[m] < id) lo = m + 1;
    else hi = m - 1;
  }
  return -1;
}
/** 点の列 → [x, z, ...]（範囲の外の点があれば null）。最後の点は最初と同じなら除く */
function ring(refs: number[]): number[] | null {
  const m = refs[0] === refs[refs.length - 1] ? refs.length - 1 : refs.length;
  if (m < 3) return null;
  const out: number[] = [];
  for (let i = 0; i < m; i++) {
    const k = find(refs[i]);
    if (k < 0) return null;
    out.push(Math.round(xs[k] * 10) / 10, Math.round(zs[k] * 10) / 10);
  }
  return out;
}
const pick = (t: Record<string, string>) => Object.fromEntries(KEEP.filter((k) => t[k] !== undefined).map((k) => [k, t[k]]));

const out: { id: string; ring: number[]; tags: Record<string, string> }[] = [];
let outside = 0;
for (const w of ways) {
  if (relWays.has(w.id) && !w.tags.building) continue;
  const r = ring(w.refs);
  if (!r) {
    outside++;
    continue;
  }
  out.push({ id: `w${w.id}`, ring: r, tags: pick(w.tags) });
}
// 関係: 外側の輪が 1 本の閉じた道ならその道を使う（複数の道をつなぐ輪は H0 では数えるだけ）
let relSkipped = 0;
for (const r of rels) {
  const refs = r.outer.length === 1 ? (wayRefs.get(r.outer[0]) ?? ways.find((w) => w.id === r.outer[0])?.refs) : undefined;
  const rr = refs && refs[0] === refs[refs.length - 1] ? ring(refs) : null;
  if (!rr) {
    relSkipped++;
    continue;
  }
  out.push({ id: `r${r.id}`, ring: rr, tags: pick(r.tags) });
}
mkdirSync(`${SOURCE_DIR}/h0`, { recursive: true });
writeFileSync(OUT, JSON.stringify({ source: pbf, license: "ODbL-1.0", attribution: "© OpenStreetMap contributors", bbox: box, buildings: out }));
console.log(`建物 ${out.length}（範囲の端で捨てた ${outside}、関係で使えなかった ${relSkipped}）→ ${OUT}、${((performance.now() - t0) / 1000).toFixed(0)}s`);
