// 経済の場（配達の草案 18 章、D3）: 業者の状態を世界の日に合わせて進め、縄張りと順位を出す。描画・DOM には依存しない。
// 一人用の段階では端末で回す（保存は SaveData.work.economy）。

import { AWAY_MS, type FreightSummary, runFreight } from "../shared/freight.ts";
import { dayStartMs } from "../shared/world/weather.ts";
import { advance, Arena, type Company, createEconomy, type DayAlloc, type EconomyState, type Entity, MONTH, ownCompany, recordPlayer, territory, type Territory } from "../shared/economy.ts";

export class Market {
  state: EconomyState;
  /** 今日まで（今日を含む）と、昨日までの縄張り */
  now: Territory;
  yesterday: Territory;
  /** 縄張りが変わるたびに増える（地図を描き直すため） */
  version = 0;
  /** 経営していた業者が廃業した（進めた時に分かった物。読んだら null にする） */
  closed: Company | null = null;
  /** 留守の間の便（閉じていた・進めていなかった間にまとめて進めた分。読んだら null にする。22.1 の 46） */
  away: FreightSummary | null = null;
  private cache = new Map<number, DayAlloc>();

  constructor(
    readonly arena: Arena,
    seed: number,
    today: number,
    saved: EconomyState | null,
    now = dayStartMs(today),
  ) {
    this.state = saved && saved.seed === seed ? saved : createEconomy(arena, seed, today);
    this.now = this.yesterday = this.compute(today);
    this.update(today, now);
  }

  private compute(end: number): Territory {
    return territory(this.arena, this.state, end, this.cache);
  }

  /**
   * 世界の日が変わっていれば、昨日まで進めて縄張りを計算し直す。長距離の便は now（Unix ミリ秒）まで進める
   * （日をまたぐ分は、その日を締める前にその日の終わりまで）。進めた日数を返す
   */
  update(today: number, now = dayStartMs(today)): number {
    const own = this.state.player.company;
    const was = ownCompany(this.state)?.freightAt;
    const sums: FreightSummary[] = [];
    const run = (t: number) => {
      const r = runFreight(this.state, t);
      if (r) sums.push(r);
    };
    const n = advance(this.arena, this.state, today - 1, (d) => run(Math.min(now, dayStartMs(d + 1))));
    run(now);
    if (was !== undefined && now - was > AWAY_MS && sums.length) {
      const a: FreightSummary = { from: was, to: now, trips: 0, late: 0, accidents: 0, dropped: 0, sales: 0, fuel: 0, fee: 0, ended: [] };
      for (const x of sums) {
        a.trips += x.trips;
        a.late += x.late;
        a.accidents += x.accidents;
        a.dropped += x.dropped;
        a.sales += x.sales;
        a.fuel += x.fuel;
        a.fee += x.fee;
        a.ended.push(...x.ended);
      }
      if (a.trips || a.dropped || a.ended.length) this.away = a;
    }
    if (own) {
      const c = this.state.companies.find((x) => x.id === own);
      if (c?.player && c.closed !== null) {
        this.state.player.company = null;
        this.closed = c;
      }
    }
    const mine = ownCompany(this.state);
    if (mine) mine.seen = today;
    if (n > 0 || this.now.day !== today) {
      for (const d of this.cache.keys()) if (d <= today - MONTH - 1) this.cache.delete(d);
      this.now = this.compute(today);
      this.yesterday = this.compute(today - 1);
      this.version++;
    }
    return n;
  }

  /** プレイヤーが届けた。届け先の丁目が場の中なら件数に入れ、縄張りを計算し直す */
  record(today: number, chome: string, reward: number, late = false): boolean {
    if (!this.arena.index.has(chome)) return false;
    recordPlayer(this.state, today, chome, reward, late);
    this.now = this.compute(today);
    this.version++;
    return true;
  }

  /** 経営している業者 */
  own(): Company | null {
    return ownCompany(this.state);
  }

  /** 経営の形を変えた後（営業所・名前の表示を描き直す） */
  touch(today: number) {
    this.now = this.compute(today);
    this.version++;
  }

  /** 丁目の持ち主 */
  ownerOf(chome: string): Entity | null {
    const i = this.arena.index.get(chome);
    if (i === undefined) return null;
    const e = this.now.owner[i];
    return e >= 0 ? this.now.entities[e] : null;
  }

  /** 営業所（世界座標と業者） */
  depots(): { x: number; z: number; name: string; color: string; company: string }[] {
    const out: { x: number; z: number; name: string; color: string; company: string }[] = [];
    for (const c of this.state.companies) {
      if (c.closed !== null) continue;
      for (const d of c.depots) {
        const i = this.arena.index.get(d);
        if (i === undefined) continue;
        const ch = this.arena.chomes[i];
        out.push({ x: ch.x, z: ch.z, name: d, color: c.color, company: c.name });
      }
    }
    return out;
  }

  /** 昨日から持ち主が変わった丁目の数 */
  changedSinceYesterday(): number {
    let n = 0;
    const a = this.now;
    const b = this.yesterday;
    for (let i = 0; i < a.owner.length; i++) {
      const x = a.owner[i] >= 0 ? a.entities[a.owner[i]].id : "";
      const y = b.owner[i] >= 0 ? b.entities[b.owner[i]].id : "";
      if (x !== y) n++;
    }
    return n;
  }
}
