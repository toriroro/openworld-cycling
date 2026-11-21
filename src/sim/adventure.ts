// 冒険の乗り方（冒険の草案）: 冒険の距離の帳簿と、取り込んだ運動の記録の換算。描画にも端末の機能にも依存しない。
// 冒険の距離はまだ走っていない道を進む時だけ使う（草案 2.2）。走行の側の止まり方は ride.ts。

export type Sport = "run" | "walk" | "ride" | "ride-indoor" | "swim" | "other";

export const SPORT_LABELS: Record<Sport, string> = {
  run: "ラン",
  walk: "ウォーキング・ハイキング",
  ride: "自転車",
  "ride-indoor": "自転車（屋内）",
  swim: "水泳",
  other: "そのほか",
};

/** 種目ごとの倍率（実際の 1km → 冒険の km。草案 3.2【初期値】、2026-11-21 決定） */
export const RATES: Record<Sport, number> = { run: 10, walk: 6, ride: 2, "ride-indoor": 2, swim: 40, other: 3 };

/** 平均の速さの上限 (km/h)。超える記録は取り込まない（草案 3.1【初期値】） */
export const SPEED_LIMIT_KMH: Record<Sport, number> = { run: 25, walk: 10, ride: 70, "ride-indoor": 70, swim: 8, other: 70 };

/** 最初に持つ冒険の距離 (m)【初期値】 */
export const START_BALANCE = 20000;
/** 取り込める期間: 冒険を始めた日の何秒前から（7 日）【初期値】 */
export const IMPORT_WINDOW_S = 7 * 86400;
/** 同じ記録とみなす開始時刻の差 (s) */
export const SAME_START_S = 120;

/** ファイルなどから読んだ 1 件の運動の記録（合計だけ。位置は持たない） */
export interface ActivitySummary {
  sport: Sport | null;
  /** 開始（Unix 秒） */
  start: number;
  /** 距離 (m) */
  distance: number;
  /** 動いていた時間 (s) */
  seconds: number;
  source: "fit" | "gpx" | "tcx" | "healthkit";
  /** このアプリが書き出した記録（ゲームの中で走った分なので数えない。草案 9 章） */
  own?: boolean;
  /** 読んだファイルの名前（画面の表示用） */
  file?: string;
}

export interface ImportedActivity {
  id: string;
  sport: Sport;
  start: number;
  distance: number;
  seconds: number;
  /** 増えた冒険の距離 (m) */
  credit: number;
  source: ActivitySummary["source"];
}

export type Verdict = { ok: true; credit: number } | { ok: false; reason: "no-sport" | "no-distance" | "own" | "old" | "future" | "fast" | "duplicate" };

export const VERDICT_LABELS: Record<Exclude<Verdict, { ok: true }>["reason"], string> = {
  "no-sport": "種目を選ぶ",
  "no-distance": "距離が無い",
  own: "このアプリで走った記録",
  old: "冒険を始めた日の 7 日より前",
  future: "開始が今より後",
  fast: "平均の速さが種目の上限を超える",
  duplicate: "同じ種目・開始時刻の記録を取り込み済みか、この一覧の上にある",
};

export type AdventureMode = "free" | "adventure";

export class AdventureLedger {
  mode: AdventureMode = "adventure";
  /** 冒険を始めた日時（Unix 秒） */
  since: number;
  /** 残り (m) */
  balance = START_BALANCE;
  /** 使った合計 (m) */
  spent = 0;
  imports: ImportedActivity[] = [];

  constructor(since: number) {
    this.since = since;
  }

  get active(): boolean {
    return this.mode === "adventure";
  }

  /** 取り込めるか、取り込むと冒険の距離がいくら増えるか（now は Unix 秒） */
  evaluate(a: ActivitySummary, now: number, pending: ActivitySummary[] = []): Verdict {
    if (a.own) return { ok: false, reason: "own" };
    if (!a.sport) return { ok: false, reason: "no-sport" };
    if (!(a.distance > 0)) return { ok: false, reason: "no-distance" };
    if (a.start < this.since - IMPORT_WINDOW_S) return { ok: false, reason: "old" };
    if (a.start > now + 600) return { ok: false, reason: "future" };
    if (a.seconds > 0 && (a.distance / a.seconds) * 3.6 > SPEED_LIMIT_KMH[a.sport]) return { ok: false, reason: "fast" };
    const same = (s: number, t: number) => Math.abs(s - t) <= SAME_START_S;
    if (this.imports.some((i) => i.sport === a.sport && same(i.start, a.start))) return { ok: false, reason: "duplicate" };
    if (pending.some((p) => p !== a && p.sport === a.sport && same(p.start, a.start) && pending.indexOf(p) < pending.indexOf(a))) return { ok: false, reason: "duplicate" };
    return { ok: true, credit: a.distance * RATES[a.sport] };
  }

  /** 取り込む。増えた冒険の距離 (m) を返す（取り込めなければ 0） */
  add(a: ActivitySummary, now: number): number {
    const v = this.evaluate(a, now);
    if (!v.ok || !a.sport) return 0;
    this.imports.push({
      id: `${a.source}:${a.sport}:${a.start}`,
      sport: a.sport,
      start: a.start,
      distance: Math.round(a.distance),
      seconds: Math.round(a.seconds),
      credit: Math.round(v.credit),
      source: a.source,
    });
    this.imports.sort((x, y) => x.start - y.start);
    this.balance += v.credit;
    return v.credit;
  }

  /** 未走行の道を d m 進んだ */
  spend(d: number) {
    const used = Math.min(this.balance, Math.max(0, d));
    this.balance -= used;
    this.spent += used;
  }

  toJSON() {
    return { mode: this.mode, since: this.since, balance: Math.round(this.balance * 10) / 10, spent: Math.round(this.spent * 10) / 10, imports: this.imports };
  }

  /** 保存から戻す。壊れていれば null */
  static fromJSON(value: unknown): AdventureLedger | null {
    if (typeof value !== "object" || value === null) return null;
    const o = value as Record<string, unknown>;
    if (o.mode !== "free" && o.mode !== "adventure") return null;
    const num = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : d);
    const l = new AdventureLedger(num(o.since, 0));
    l.mode = o.mode;
    l.balance = num(o.balance, 0);
    l.spent = num(o.spent, 0);
    const sports = Object.keys(RATES);
    l.imports = (Array.isArray(o.imports) ? o.imports : [])
      .filter((i): i is Record<string, unknown> => typeof i === "object" && i !== null)
      .filter((i) => typeof i.sport === "string" && sports.includes(i.sport) && typeof i.start === "number")
      .map((i) => ({
        id: typeof i.id === "string" ? i.id.slice(0, 80) : "",
        sport: i.sport as Sport,
        start: i.start as number,
        distance: num(i.distance, 0),
        seconds: num(i.seconds, 0),
        credit: num(i.credit, 0),
        source: (["fit", "gpx", "tcx", "healthkit"].includes(i.source as string) ? i.source : "fit") as ImportedActivity["source"],
      }));
    return l;
  }
}
