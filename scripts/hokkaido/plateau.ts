// PLATEAU（3D都市モデル 札幌市 2020 年度、CityGML v4）の建物を、変換の建物の外形として読む（配達の草案 19 章・20 章）。
// 入力: assets-source/hokkaido/plateau/bldg/*.gml.gz（3 次メッシュの区画ごと。取得は草案 19.1）。
// 外形は屋根の縁（lod0RoofEdge）の多角形のうち一番広い物。属性は用途・計測高さ・地上階数・建築年（9999・0001 は不明として捨てる）。
// 出典: 3D都市モデル（Project PLATEAU）札幌市／国土交通省（CC BY 4.0）

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import type { RawBuilding } from "./buildings.ts";
import { project } from "./projection.ts";

export const PLATEAU_DIR = "assets-source/hokkaido/plateau/bldg";

export interface PlateauStats {
  files: number;
  parsed: number;
  kept: number;
  noFootprint: number;
  byUsage: Record<string, number>;
}

/** rect（世界座標）の中に重心がある建物。ファイルが無ければ null */
export function loadPlateau(rect: { x0: number; z0: number; x1: number; z1: number }, dir = PLATEAU_DIR): { buildings: RawBuilding[]; stats: PlateauStats } | null {
  if (!existsSync(dir)) return null;
  const files = readdirSync(dir).filter((n) => n.endsWith(".gml.gz")).sort();
  if (!files.length) return null;
  const st: PlateauStats = { files: files.length, parsed: 0, kept: 0, noFootprint: 0, byUsage: {} };
  const out: RawBuilding[] = [];
  const seen = new Set<string>();
  for (const f of files) {
    const text = gunzipSync(readFileSync(`${dir}/${f}`)).toString("utf8");
    const parts = text.split("<bldg:Building ");
    for (let i = 1; i < parts.length; i++) {
      const s = parts[i];
      const end = s.indexOf("</bldg:Building>");
      const body = end >= 0 ? s.slice(0, end) : s;
      st.parsed++;
      const id = /gml:id="([^"]+)"/.exec(body)?.[1] ?? `${f}#${i}`;
      if (seen.has(id)) continue;
      const e0 = body.indexOf("<bldg:lod0RoofEdge");
      const e1 = body.indexOf("</bldg:lod0RoofEdge>");
      if (e0 < 0 || e1 < 0) {
        st.noFootprint++;
        continue;
      }
      // 屋根の縁の多角形（外周だけ）のうち一番広い物
      let ring: number[] | null = null;
      let best = 0;
      let cx = 0;
      let cz = 0;
      const re = /<gml:exterior>\s*<gml:LinearRing>\s*<gml:posList>([^<]+)<\/gml:posList>/g;
      const edge = body.slice(e0, e1);
      for (let m = re.exec(edge); m; m = re.exec(edge)) {
        const v = m[1].trim().split(/\s+/).map(Number);
        const r: number[] = [];
        for (let k = 0; k + 2 < v.length; k += 3) {
          const p = project(v[k], v[k + 1]);
          r.push(p.x, p.z);
        }
        // 閉じた点（最初と同じ最後の点）は外す
        if (r.length >= 4 && r[0] === r[r.length - 2] && r[1] === r[r.length - 1]) r.length -= 2;
        const n = r.length / 2;
        if (n < 3) continue;
        let a2 = 0;
        let sx = 0;
        let sz = 0;
        for (let k = 0, j = n - 1; k < n; j = k++) {
          const c = r[j * 2] * r[k * 2 + 1] - r[k * 2] * r[j * 2 + 1];
          a2 += c;
          sx += (r[j * 2] + r[k * 2]) * c;
          sz += (r[j * 2 + 1] + r[k * 2 + 1]) * c;
        }
        if (Math.abs(a2) / 2 > best) {
          best = Math.abs(a2) / 2;
          ring = r;
          cx = sx / (3 * a2);
          cz = sz / (3 * a2);
        }
      }
      if (!ring) {
        st.noFootprint++;
        continue;
      }
      if (cx < rect.x0 || cx > rect.x1 || cz < rect.z0 || cz > rect.z1) continue;
      seen.add(id);
      const val = (re: RegExp) => re.exec(body)?.[1] ?? null;
      const usage = val(/<bldg:usage[^>]*>(\d+)</) ?? "461";
      const tags: Record<string, string> = { building: "yes", "plateau:usage": usage };
      const h = Number(val(/<bldg:measuredHeight[^>]*>([\d.]+)</));
      if (h > 0 && h < 9000) tags["plateau:height"] = String(h);
      const storeys = Number(val(/<bldg:storeysAboveGround>(\d+)</));
      if (storeys > 0 && storeys < 9000) tags["plateau:storeys"] = String(storeys);
      const year = Number(val(/<bldg:yearOfConstruction>(\d+)</));
      if (year > 1800 && year < 9000) tags["plateau:year"] = String(year);
      out.push({ id: `pl:${id}`, ring, tags });
      st.byUsage[usage] = (st.byUsage[usage] ?? 0) + 1;
      st.kept++;
    }
  }
  return { buildings: out, stats: st };
}
