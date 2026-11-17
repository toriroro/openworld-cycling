// H0 の範囲で、PBF からの取り出し（pbf-area.ts）と Overpass の JSON の数を比べる（北海道の草案 18.1）。
//   npx tsx scripts/hokkaido/compare-pbf-h0.ts
import { readdirSync } from "node:fs";
import { H0_BOX, SOURCE_DIR } from "./area.ts";
import { loadOsm } from "./osm.ts";
import { loadPbfArea } from "./pbf-area.ts";

const pbf = readdirSync(`${SOURCE_DIR}/pbf`).filter((f) => f.endsWith(".osm.pbf")).sort().at(-1)!;
const a = loadPbfArea(`${SOURCE_DIR}/pbf/${pbf}`, H0_BOX);
console.log(a.stats);
for (const k of ["roads", "water", "landuse", "places"] as const) {
  const o = loadOsm(`${SOURCE_DIR}/h0/osm/${k}.json`);
  const p = a[k];
  const onlyO = [...o.ways.keys()].filter((id) => !p.ways.has(id));
  const onlyP = [...p.ways.keys()].filter((id) => !o.ways.has(id));
  console.log(k, `Overpass 道 ${o.ways.size}・関係 ${o.relations.length}・点 ${o.nodes.size}`, `PBF 道 ${p.ways.size}・関係 ${p.relations.length}・点 ${p.nodes.size}`, `Overpass だけ ${onlyO.length}（例 ${onlyO.slice(0, 5)}）`, `PBF だけ ${onlyP.length}（例 ${onlyP.slice(0, 5)}）`);
}
