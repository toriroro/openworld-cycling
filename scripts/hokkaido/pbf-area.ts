// 北海道の PBF から、範囲の道路・水・土地利用・地名・建物を取り出す（北海道の草案 18.1）。
// Overpass の `(way(bbox); ...); out body; >; out skel qt;` と同じ形（OsmData）にして返す。
//
// 1 回目: 関係だけ見て、水・土地利用・建物の多角形の部品の道の番号を集める。
// 2 回目: 範囲（の周りの余白も含む）の点、使う道を集める。
// 3 回目: 範囲にかかる水・土地利用の多角形の部品で、余白の外にある点を集める（大きな森・川の多角形を閉じるため）。
// 道は、点が 1 つでも範囲の中にあれば取る（Overpass の bbox と同じ）。範囲の外の点は余白の分だけ持つ。

import type { RawBuilding } from "./buildings.ts";
import type { OsmData, OsmNode, OsmRelation, OsmWay, Tags } from "./osm.ts";
import { readPbf } from "./pbf.ts";
import { project } from "./projection.ts";
import type { LatLonBox } from "./area.ts";

export interface PbfArea {
  roads: OsmData;
  water: OsmData;
  landuse: OsmData;
  places: OsmData;
  buildings: RawBuilding[];
  stats: Record<string, number>;
}

type Kind = "roads" | "water" | "landuse" | "places" | "building";
const KINDS: Exclude<Kind, "building">[] = ["roads", "water", "landuse", "places"];

const isWaterTags = (t: Tags) => t.natural === "coastline" || t.natural === "water" || !!t.waterway;
const isLanduseTags = (t: Tags) => !!t.landuse || ["wood", "scrub", "grassland", "heath", "bare_rock"].includes(t.natural ?? "");
const isPlaceTags = (t: Tags) => !!t.place || t.amenity === "cafe" || t.tourism === "viewpoint" || t.mountain_pass === "yes" || t.natural === "peak";
const isBuildingTags = (t: Tags) => !!t.building && t.building !== "no";

/** 建物で使う札（extract-buildings.ts と同じ） */
const BUILDING_KEEP = ["building", "building:levels", "building:levels:underground", "height", "roof:shape", "roof:levels", "amenity", "shop", "name"];

function wayKinds(t: Tags): Kind[] {
  const out: Kind[] = [];
  if (t.highway || t.railway) out.push("roads");
  if (isWaterTags(t)) out.push("water");
  if (isLanduseTags(t)) out.push("landuse");
  if (t.amenity === "cafe" || t.tourism === "viewpoint") out.push("places");
  if (isBuildingTags(t)) out.push("building");
  return out;
}

function relationKinds(t: Tags): Kind[] {
  const out: Kind[] = [];
  if (t.type === "multipolygon" || t.type === "waterway") {
    if (t.natural === "water" || t.waterway) out.push("water");
    if (t.landuse || t.natural === "wood") out.push("landuse");
    if (t.type === "multipolygon" && isBuildingTags(t)) out.push("building");
  }
  return out;
}

/**
 * box の中の要素を取り出す。marginDeg は範囲の外の点を持つ余白（度）。範囲の端で切れる道・多角形を閉じるため。
 */
export function loadPbfArea(path: string, box: LatLonBox, marginDeg = 0.05): PbfArea {
  const t0 = performance.now();
  // ---- 1 回目: 関係 ----
  const rels: { r: OsmRelation; kinds: Kind[] }[] = [];
  const memberKinds = new Map<number, Kind[]>();
  readPbf(path, {
    nodeTags: false,
    relation(r) {
      const kinds = relationKinds(r.tags);
      if (!kinds.length) return;
      rels.push({ r: { id: r.id, members: r.members, tags: r.tags }, kinds });
      for (const m of r.members) {
        if (m.type !== "way") continue;
        const l = memberKinds.get(m.ref) ?? [];
        for (const k of kinds) if (!l.includes(k)) l.push(k);
        memberKinds.set(m.ref, l);
      }
    },
  });
  const t1 = performance.now();

  // ---- 2 回目: 点と道 ----
  const s = box.south - marginDeg;
  const n = box.north + marginDeg;
  const w = box.west - marginDeg;
  const e = box.east + marginDeg;
  let cap = 1 << 23;
  let ids = new Float64Array(cap);
  let xs = new Float32Array(cap);
  let zs = new Float32Array(cap);
  let inner = new Uint8Array(cap);
  let count = 0;
  let lastId = -Infinity;
  const tagged = new Map<number, Tags>();
  const ways: { w: OsmWay; kinds: Kind[] }[] = [];
  readPbf(path, {
    nodeTags: true,
    node(p) {
      if (p.lat < s || p.lat > n || p.lon < w || p.lon > e) return;
      if (count === cap) {
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
        const d = new Uint8Array(cap);
        d.set(inner);
        inner = d;
      }
      if (p.id < lastId) throw new Error("点が番号の順に並んでいない");
      lastId = p.id;
      const q = project(p.lat, p.lon);
      const isIn = p.lat >= box.south && p.lat <= box.north && p.lon >= box.west && p.lon <= box.east;
      ids[count] = p.id;
      xs[count] = q.x;
      zs[count] = q.z;
      inner[count] = isIn ? 1 : 0;
      if (isIn && p.tags && isPlaceTags(p.tags)) tagged.set(p.id, p.tags);
      count++;
    },
    way(wy) {
      const kinds = wayKinds(wy.tags);
      for (const k of memberKinds.get(wy.id) ?? []) if (!kinds.includes(k)) kinds.push(k);
      if (!kinds.length) return;
      ways.push({ w: { id: wy.id, nodes: wy.refs, tags: wy.tags }, kinds });
    },
  });
  const t2 = performance.now();

  const find = (id: number): number => {
    let lo = 0;
    let hi = count - 1;
    while (lo <= hi) {
      const m = (lo + hi) >> 1;
      if (ids[m] === id) return m;
      if (ids[m] < id) lo = m + 1;
      else hi = m - 1;
    }
    return -1;
  };
  /** 余白の外の点（3 回目で読む） */
  const extra = new Map<number, { x: number; z: number }>();
  const hits = (refs: number[]) => {
    for (const id of refs) {
      const k = find(id);
      if (k >= 0 && inner[k]) return true;
    }
    return false;
  };

  const out: Record<Exclude<Kind, "building">, OsmData> = {
    roads: { nodes: new Map(), ways: new Map(), relations: [] },
    water: { nodes: new Map(), ways: new Map(), relations: [] },
    landuse: { nodes: new Map(), ways: new Map(), relations: [] },
    places: { nodes: new Map(), ways: new Map(), relations: [] },
  };
  const addNodes = (d: OsmData, refs: number[]) => {
    for (const id of refs) {
      if (d.nodes.has(id)) continue;
      const k = find(id);
      if (k < 0) {
        const p = extra.get(id);
        if (p) d.nodes.set(id, { id, x: p.x, z: p.z });
        continue;
      }
      const node: OsmNode = { id, x: xs[k], z: zs[k] };
      const t = tagged.get(id);
      if (t) node.tags = t;
      d.nodes.set(id, node);
    }
  };
  const wayById = new Map<number, OsmWay>();
  const buildingWays: OsmWay[] = [];
  const inBox = new Set<number>();
  for (const { w: wy, kinds } of ways) {
    wayById.set(wy.id, wy);
    const hit = hits(wy.nodes);
    if (hit) inBox.add(wy.id);
    for (const k of kinds) {
      if (k === "building") {
        if (isBuildingTags(wy.tags)) buildingWays.push(wy);
        continue;
      }
      // 関係の部品は、関係が範囲にかかれば取る（下で）
      if (!hit) continue;
      if (k === "water" && !isWaterTags(wy.tags)) continue;
      if (k === "landuse" && !isLanduseTags(wy.tags)) continue;
      out[k].ways.set(wy.id, wy);
      addNodes(out[k], wy.nodes);
    }
  }
  // 関係: 部品の道のどれかが範囲にかかれば、部品を全部入れる。余白の外の点は 3 回目で読む
  const keptRels = rels.filter(({ r, kinds }) => kinds.some((k) => k !== "building") && r.members.some((m) => m.type === "way" && inBox.has(m.ref)));
  const missing = new Set<number>();
  for (const { r } of keptRels)
    for (const m of r.members) {
      if (m.type !== "way") continue;
      for (const id of wayById.get(m.ref)?.nodes ?? []) if (find(id) < 0) missing.add(id);
    }
  if (missing.size)
    readPbf(path, {
      nodeTags: false,
      node(p) {
        if (missing.has(p.id)) extra.set(p.id, project(p.lat, p.lon));
      },
    });
  const t3 = performance.now();
  for (const { r, kinds } of keptRels) {
    const parts = r.members.filter((m) => m.type === "way").map((m) => wayById.get(m.ref));
    for (const k of kinds) {
      if (k === "building") continue;
      out[k].relations.push(r);
      for (const p of parts) {
        if (!p) continue;
        if (!out[k].ways.has(p.id)) out[k].ways.set(p.id, p);
        addNodes(out[k], p.nodes);
      }
    }
  }
  // 地名・地点の点（範囲の中）
  for (const [id, t] of tagged) {
    const k = find(id);
    out.places.nodes.set(id, { id, x: xs[k], z: zs[k], tags: t });
  }

  // ---- 建物（extract-buildings.ts と同じ。点が全部範囲の中にある物だけ。関係は外側の輪が 1 本の閉じた道の物だけ） ----
  const ring = (refs: number[]): number[] | null => {
    const m = refs[0] === refs[refs.length - 1] ? refs.length - 1 : refs.length;
    if (m < 3) return null;
    const r: number[] = [];
    for (let i = 0; i < m; i++) {
      const k = find(refs[i]);
      if (k < 0 || !inner[k]) return null;
      r.push(Math.round(xs[k] * 10) / 10, Math.round(zs[k] * 10) / 10);
    }
    return r;
  };
  const pick = (t: Tags) => Object.fromEntries(BUILDING_KEEP.filter((k) => t[k] !== undefined).map((k) => [k, t[k]]));
  const buildings: RawBuilding[] = [];
  let bOutside = 0;
  for (const wy of buildingWays) {
    const r = ring(wy.nodes);
    if (!r) {
      bOutside++;
      continue;
    }
    buildings.push({ id: `w${wy.id}`, ring: r, tags: pick(wy.tags) });
  }
  let relSkipped = 0;
  for (const { r, kinds } of rels) {
    if (!kinds.includes("building")) continue;
    const outer = r.members.filter((m) => m.type === "way" && m.role === "outer").map((m) => m.ref);
    const refs = outer.length === 1 ? wayById.get(outer[0])?.nodes : undefined;
    const rr = refs && refs[0] === refs[refs.length - 1] ? ring(refs) : null;
    if (!rr) {
      relSkipped++;
      continue;
    }
    buildings.push({ id: `r${r.id}`, ring: rr, tags: pick(r.tags) });
  }
  const stats: Record<string, number> = {
    seconds: +((performance.now() - t0) / 1000).toFixed(1),
    passRelations: +((t1 - t0) / 1000).toFixed(1),
    passNodesWays: +((t2 - t1) / 1000).toFixed(1),
    passOuterNodes: +((t3 - t2) / 1000).toFixed(1),
    outerNodes: extra.size,
    nodesInMargin: count,
    buildings: buildings.length,
    buildingsCut: bOutside,
    buildingRelationsSkipped: relSkipped,
  };
  for (const k of KINDS) {
    stats[`${k}Ways`] = out[k].ways.size;
    stats[`${k}Nodes`] = out[k].nodes.size;
    stats[`${k}Relations`] = out[k].relations.length;
  }
  return { ...out, buildings, stats };
}
