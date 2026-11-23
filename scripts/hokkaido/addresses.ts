// 住所の元になる丁目の点（配達の草案 13 章）。OSM の place=neighbourhood（「北3条西4丁目」など）を、名前を読み分けて書き出す。
// 実行時は、位置にいちばん近い点の名前をその場所の住所にする（src/shared/world/address.ts）。

import type { OsmData } from "./osm.ts";
import type { AddressPoint } from "../../src/shared/world/address.ts";
import { parseAddressName } from "../../src/shared/world/address.ts";

export function buildAddresses(places: OsmData, inside: (x: number, z: number) => boolean): { points: AddressPoint[]; stats: { points: number; grid: number } } {
  const seen = new Set<string>();
  const points: AddressPoint[] = [];
  for (const n of places.nodes.values()) {
    const name = n.tags?.name;
    if (n.tags?.place !== "neighbourhood" || !name || !inside(n.x, n.z)) continue;
    // 同じ名前の点が 2 つある時は先の物だけ（OSM の重複）
    if (seen.has(name)) continue;
    seen.add(name);
    points.push({ name, x: Math.round(n.x * 10) / 10, z: Math.round(n.z * 10) / 10, ...(parseAddressName(name) ?? {}) });
  }
  points.sort((a, b) => a.z - b.z || a.x - b.x);
  return { points, stats: { points: points.length, grid: points.filter((p) => p.jo !== undefined).length } };
}
