// 走った道路の区間の記録（モック仕様 7.3・7.4）。道路ごとに 10m の区切りで持つ。描画に依存しない。

export const RIDDEN_BIN = 10;

export class RiddenLog {
  private bins = new Map<string, Set<number>>();
  /** 記録が変わるたびに増える（地図の描き直しの判定用） */
  version = 0;

  /** 道路 road の道のり s を走った。新しい区切りなら true */
  mark(road: string, s: number): boolean {
    const b = Math.floor(s / RIDDEN_BIN);
    let set = this.bins.get(road);
    if (!set) this.bins.set(road, (set = new Set()));
    if (set.has(b)) return false;
    set.add(b);
    this.version++;
    return true;
  }

  has(road: string, s: number): boolean {
    return this.bins.get(road)?.has(Math.floor(s / RIDDEN_BIN)) ?? false;
  }

  /** 道路 road のうち走った長さの割合（0〜1） */
  fraction(road: string, length: number): number {
    const set = this.bins.get(road);
    if (!set) return 0;
    return Math.min(1, (set.size * RIDDEN_BIN) / Math.max(RIDDEN_BIN, length));
  }

  /** 道路 road の走った区間 [s0, s1] の列（道のりの順） */
  runs(road: string): [number, number][] {
    const set = this.bins.get(road);
    if (!set) return [];
    const list = [...set].sort((a, b) => a - b);
    const out: [number, number][] = [];
    for (const b of list) {
      const last = out[out.length - 1];
      if (last && last[1] === b * RIDDEN_BIN) last[1] = (b + 1) * RIDDEN_BIN;
      else out.push([b * RIDDEN_BIN, (b + 1) * RIDDEN_BIN]);
    }
    return out;
  }

  roads(): IterableIterator<string> {
    return this.bins.keys();
  }

  /** 保存用: 道路ごとに区切りの番号の連続 [始め, 終わり, 始め, 終わり, ...] */
  toJSON(): Record<string, number[]> {
    const out: Record<string, number[]> = {};
    for (const [road, set] of this.bins) {
      const list = [...set].sort((a, b) => a - b);
      const runs: number[] = [];
      for (const b of list) {
        if (runs.length && runs[runs.length - 1] === b - 1) runs[runs.length - 1] = b;
        else runs.push(b, b);
      }
      out[road] = runs;
    }
    return out;
  }

  static fromJSON(value: unknown): RiddenLog {
    const log = new RiddenLog();
    if (typeof value !== "object" || value === null) return log;
    for (const [road, runs] of Object.entries(value as Record<string, unknown>)) {
      if (!Array.isArray(runs)) continue;
      const set = new Set<number>();
      for (let i = 0; i + 1 < runs.length; i += 2) {
        const a = Number(runs[i]);
        const b = Number(runs[i + 1]);
        if (!Number.isInteger(a) || !Number.isInteger(b) || b < a || b - a > 100000) continue;
        for (let k = a; k <= b; k++) set.add(k);
      }
      if (set.size) log.bins.set(road, set);
    }
    return log;
  }
}
