// 住所（配達の草案 3 章・13 章）。札幌の世界では、OSM の丁目の点（「北3条西4丁目」など）のうち、位置にいちばん近い点の名前をその場所の住所にする。
// 札幌の中心の碁盤では丁目の点が街区のほぼ真ん中にあるので、いちばん近い点で分けると境目がおおむね道になる。
// DOM・Three.js に依存しない。距離の比較は 2 乗のまま行う（モック 4.2）。

/** 丁目の点 */
export interface AddressPoint {
  name: string;
  x: number;
  z: number;
  /** 札幌の碁盤の住所なら、北・南・大通 */
  ns?: "北" | "南" | "大通";
  /** 条（大通は 0） */
  jo?: number;
  ew?: "東" | "西";
  chome?: number;
}

/**
 * 配達の試作 D0 で住宅街の道も走れる道にした範囲（緯度経度。配達の草案 13 章）。
 * 大通・創成川の交わる所の周り。南北 約 4.2km、東西 約 4.1km（北 14 条あたり〜南 16 条あたり、西 20 丁目あたり〜東 13 丁目あたり）
 */
export const D0_STREET_BOX = { south: 43.04, west: 141.325, north: 43.078, east: 141.376 } as const;

const GRID_NAME = /^(?:(北|南)(\d+)条|(大通))(東|西)(\d+)丁目$/;

/** 「北3条西4丁目」「大通西6丁目」を読む。碁盤の住所でなければ null */
export function parseAddressName(name: string): Pick<AddressPoint, "ns" | "jo" | "ew" | "chome"> | null {
  const m = GRID_NAME.exec(name);
  if (!m) return null;
  const ns = (m[1] ?? m[3]) as "北" | "南" | "大通";
  return { ns, jo: m[2] ? Number(m[2]) : 0, ew: m[4] as "東" | "西", chome: Number(m[5]) };
}

/** 碁盤の位置（北・東が正。大通は 0、創成川の東 1 丁目が 1、西 1 丁目が −1） */
export function gridIndex(p: AddressPoint): { n: number; e: number } | null {
  if (p.jo === undefined || p.chome === undefined) return null;
  return { n: p.ns === "南" ? -p.jo : p.jo, e: p.ew === "西" ? -p.chome : p.chome };
}

/** 点を引く格子の一辺 (m) */
const CELL = 250;

export class AddressBook {
  private cells = new Map<string, AddressPoint[]>();
  readonly byName = new Map<string, AddressPoint>();

  constructor(readonly points: AddressPoint[]) {
    for (const p of points) {
      const k = `${Math.floor(p.x / CELL)},${Math.floor(p.z / CELL)}`;
      (this.cells.get(k) ?? this.cells.set(k, []).get(k)!).push(p);
      this.byName.set(p.name, p);
    }
  }

  /** 位置の住所（いちばん近い丁目の点）。maxD (m) より遠ければ null */
  at(x: number, z: number, maxD = 250): AddressPoint | null {
    const r = Math.ceil(maxD / CELL);
    const cx = Math.floor(x / CELL);
    const cz = Math.floor(z / CELL);
    let best: AddressPoint | null = null;
    let bd = maxD * maxD;
    for (let a = -r; a <= r; a++)
      for (let b = -r; b <= r; b++)
        for (const p of this.cells.get(`${cx + a},${cz + b}`) ?? []) {
          const d = (p.x - x) * (p.x - x) + (p.z - z) * (p.z - z);
          if (d < bd) {
            bd = d;
            best = p;
          }
        }
    return best;
  }
}
