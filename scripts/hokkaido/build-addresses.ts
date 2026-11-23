// 丁目の点だけを作り直す（build.ts の一部。PBF の読み込みだけで済む。配達の草案 13 章）。
//   npx tsx scripts/hokkaido/build-addresses.ts h2
import { readdirSync, writeFileSync } from "node:fs";
import { buildAddresses } from "./addresses.ts";
import { H0_BOX, H2_BOX, SOURCE_DIR } from "./area.ts";
import { loadPbfArea } from "./pbf-area.ts";
import { project } from "./projection.ts";

const AREA = process.argv[2] ?? "h2";
const BOX = AREA === "h2" ? H2_BOX : H0_BOX;
const pbfName = readdirSync(`${SOURCE_DIR}/pbf`).filter((f) => f.endsWith(".osm.pbf")).sort().at(-1)!;
const osm = loadPbfArea(`${SOURCE_DIR}/pbf/${pbfName}`, BOX);
const a = project(BOX.north, BOX.west);
const b = project(BOX.south, BOX.east);
const out = buildAddresses(osm.places, (x, z) => x >= a.x && x <= b.x && z >= a.z && z <= b.z);
writeFileSync(`public/data/hokkaido/${AREA}/addresses.json`, JSON.stringify(out.points));
console.log(out.stats);
