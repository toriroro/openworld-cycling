// Overpass の JSON を読み、点を世界座標に変える。面（閉じた道・複数の道でできた多角形）を輪にまとめる。

import { readFileSync } from "node:fs";
import { project } from "./projection.ts";

export type Tags = Record<string, string>;

export interface OsmWay {
  id: number;
  nodes: number[];
  tags: Tags;
}

export interface OsmRelation {
  id: number;
  members: { type: string; ref: number; role: string }[];
  tags: Tags;
}

export interface OsmNode {
  id: number;
  x: number;
  z: number;
  tags?: Tags;
}

export interface OsmData {
  nodes: Map<number, OsmNode>;
  ways: Map<number, OsmWay>;
  relations: OsmRelation[];
}

interface RawElement {
  type: "node" | "way" | "relation";
  id: number;
  lat?: number;
  lon?: number;
  nodes?: number[];
  members?: { type: string; ref: number; role: string }[];
  tags?: Tags;
  center?: { lat: number; lon: number };
}

export function loadOsm(path: string): OsmData {
  const json = JSON.parse(readFileSync(path, "utf8")) as { elements: RawElement[] };
  const nodes = new Map<number, OsmNode>();
  const ways = new Map<number, OsmWay>();
  const relations: OsmRelation[] = [];
  for (const e of json.elements) {
    if (e.type === "node") {
      const p = project(e.lat!, e.lon!);
      const prev = nodes.get(e.id);
      nodes.set(e.id, { id: e.id, x: p.x, z: p.z, tags: e.tags ?? prev?.tags });
    } else if (e.type === "way") ways.set(e.id, { id: e.id, nodes: e.nodes ?? [], tags: e.tags ?? {} });
    else relations.push({ id: e.id, members: e.members ?? [], tags: e.tags ?? {} });
  }
  return { nodes, ways, relations };
}

/** 輪（閉じた折れ線の x, z の並び。最後の点は最初と同じにしない） */
export type Ring = Float64Array;

function ringOf(d: OsmData, ids: number[]): Ring | null {
  const n = ids[0] === ids[ids.length - 1] ? ids.length - 1 : ids.length;
  if (n < 3) return null;
  const out = new Float64Array(n * 2);
  for (let i = 0; i < n; i++) {
    const p = d.nodes.get(ids[i]);
    if (!p) return null;
    out[i * 2] = p.x;
    out[i * 2 + 1] = p.z;
  }
  return out;
}

/** 道の列を端でつないで閉じた輪にする（多角形の関係の outer・inner をまとめて扱う。塗りは偶奇で決める） */
function joinRings(d: OsmData, wayIds: number[]): Ring[] {
  const pieces = wayIds.map((id) => d.ways.get(id)?.nodes.slice()).filter((n): n is number[] => !!n && n.length >= 2);
  const rings: Ring[] = [];
  while (pieces.length) {
    let cur = pieces.pop()!;
    let grew = true;
    while (cur[0] !== cur[cur.length - 1] && grew) {
      grew = false;
      for (let k = 0; k < pieces.length; k++) {
        const p = pieces[k];
        const last = cur[cur.length - 1];
        if (p[0] === last) cur = cur.concat(p.slice(1));
        else if (p[p.length - 1] === last) cur = cur.concat(p.slice(0, -1).reverse());
        else if (p[p.length - 1] === cur[0]) cur = p.slice(0, -1).concat(cur);
        else if (p[0] === cur[0]) cur = p.slice(1).reverse().concat(cur);
        else continue;
        pieces.splice(k, 1);
        grew = true;
        break;
      }
    }
    if (cur[0] !== cur[cur.length - 1]) continue; // 閉じない（範囲の外で切れている）
    const r = ringOf(d, cur);
    if (r) rings.push(r);
  }
  return rings;
}

export interface Area {
  tags: Tags;
  rings: Ring[];
}

/** 面: 閉じた道と、多角形の関係 */
export function areasOf(d: OsmData, accept: (t: Tags) => boolean): Area[] {
  const out: Area[] = [];
  const inRelation = new Set<number>();
  for (const r of d.relations) {
    if (r.tags.type !== "multipolygon" || !accept(r.tags)) continue;
    const ids = r.members.filter((m) => m.type === "way").map((m) => m.ref);
    for (const id of ids) inRelation.add(id);
    const rings = joinRings(d, ids);
    if (rings.length) out.push({ tags: r.tags, rings });
  }
  for (const w of d.ways.values()) {
    if (w.nodes.length < 4 || w.nodes[0] !== w.nodes[w.nodes.length - 1] || !accept(w.tags)) continue;
    const r = ringOf(d, w.nodes);
    if (r) out.push({ tags: w.tags, rings: [r] });
  }
  return out;
}

/** 線: 道の点の x, z の並び */
export function lineOf(d: OsmData, w: OsmWay): Float64Array | null {
  const out = new Float64Array(w.nodes.length * 2);
  for (let i = 0; i < w.nodes.length; i++) {
    const p = d.nodes.get(w.nodes[i]);
    if (!p) return null;
    out[i * 2] = p.x;
    out[i * 2 + 1] = p.z;
  }
  return out;
}
