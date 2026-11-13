// 道路網に沿って進む位置（M2 の自動カメラ、M3 以降の走行の土台）。

import { type RoadNetwork, type RoadPosition } from "./road-network.ts";

/** 通った区間（道路・始め・終わり）。逆にたどると同じ道を戻れる */
export interface Leg {
  road: string;
  from: number;
  to: number;
}

export class RouteFollower {
  pos: RoadPosition;
  /** 進んだ総距離 (m) */
  travelled = 0;
  /** 通った区間の記録（record が true の間） */
  legs: Leg[] = [];
  record = false;
  private plan: Leg[] | null = null;
  private planIndex = 0;

  constructor(
    private net: RoadNetwork,
    start: RoadPosition,
  ) {
    this.pos = { ...start };
  }

  startRecording() {
    this.record = true;
    this.legs = [{ road: this.pos.road, from: this.pos.s, to: this.pos.s }];
  }

  /** 記録した区間の列をたどる（reverse で逆向き） */
  followPlan(legs: Leg[], reverse = false) {
    this.plan = reverse ? legs.map((l) => ({ road: l.road, from: l.to, to: l.from })).reverse() : legs.map((l) => ({ ...l }));
    this.planIndex = 0;
    const l = this.plan[0];
    this.pos = { road: l.road, s: l.from, dir: l.to >= l.from ? 1 : -1 };
  }

  get planDone(): boolean {
    return this.plan !== null && this.planIndex >= this.plan.length;
  }

  /** 道路が読み込まれていれば ds だけ進む。進めなかった分を返す */
  advance(ds: number): number {
    let left = ds;
    let guard = 0;
    while (left > 1e-9 && guard++ < 64) {
      if (this.plan) {
        if (this.planIndex >= this.plan.length) return left;
        const l = this.plan[this.planIndex];
        if (!this.net.roads.has(l.road)) return left;
        const dir: 1 | -1 = l.to >= l.from ? 1 : -1;
        this.pos.road = l.road;
        this.pos.dir = dir;
        const remain = (l.to - this.pos.s) * dir;
        if (remain > left) {
          this.pos.s += left * dir;
          this.travelled += left;
          return 0;
        }
        this.pos.s = l.to;
        this.travelled += Math.max(0, remain);
        left -= Math.max(0, remain);
        this.planIndex++;
        if (this.planIndex < this.plan.length) this.pos.s = this.plan[this.planIndex].from;
        continue;
      }
      const road = this.net.roads.get(this.pos.road);
      if (!road) return left;
      const end = this.pos.dir === 1 ? road.length : 0;
      const remain = (end - this.pos.s) * this.pos.dir;
      if (remain > left) {
        this.pos.s += left * this.pos.dir;
        this.travelled += left;
        if (this.record) this.legs[this.legs.length - 1].to = this.pos.s;
        return 0;
      }
      this.pos.s = end;
      this.travelled += remain;
      left -= remain;
      if (this.record) this.legs[this.legs.length - 1].to = end;
      const next = this.net.nextAtEnd(this.pos);
      if (!this.net.roads.has(next.road)) return left;
      this.pos = next;
      if (this.record) this.legs.push({ road: next.road, from: next.s, to: next.s });
    }
    return left;
  }
}
