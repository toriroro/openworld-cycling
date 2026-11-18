// city.worker.ts の窓口（メインスレッド側）。種類（近くの建物・遠くの建物・走らない道）ごとに依頼は 1 つだけ送り、
// 返ってくる間に欲しい組が変わったら、返事は捨てて新しい組を頼み直す（古い組を作り続けて待たせないため）。
// Worker が使えない時は、同じ関数をメインスレッドで動かす（止まるが、絵は出る）。

import type { HokkaidoBuildings, HokkaidoStreets, HokkaidoTerrain } from "../shared/world/hokkaido.ts";
import type { CityRequest, CityResponse } from "../workers/city.worker.ts";
import { buildFar, buildNear, buildStreets, withoutExcluded } from "./city-build.ts";

type Kind = "near" | "far" | "streets";
export type CityResult<K extends Kind> = Extract<CityResponse, { type: K }>;

interface Slot {
  /** 送った依頼（番号と組の鍵） */
  inFlight: { id: number; key: string; ox: number; oz: number } | null;
  /** 欲しい組 */
  want: { key: string; cells: string[]; subCells?: string[]; ox: number; oz: number } | null;
  onDone: (key: string, r: CityResponse, ox: number, oz: number) => void;
}

export class CityClient {
  private worker: Worker | null = null;
  private slots = new Map<Kind, Slot>();
  private nextId = 1;
  workerError: string | null = null;

  constructor(
    base: string,
    seed: number,
    /** Worker が使えない時の、メインスレッドのデータ */
    private local: { buildings: HokkaidoBuildings | null; streets: HokkaidoStreets | null; terrain: HokkaidoTerrain },
  ) {
    try {
      this.worker = new Worker(new URL("../workers/city.worker.ts", import.meta.url), { type: "module" });
      this.worker.onmessage = (ev: MessageEvent<CityResponse>) => this.onMessage(ev.data);
      this.worker.onerror = (e) => {
        e.preventDefault();
        this.workerError = e.message;
        this.worker?.terminate();
        this.worker = null;
      };
      this.worker.postMessage({ type: "init", base, seed } satisfies CityRequest);
    } catch (e) {
      this.workerError = String(e);
      this.worker = null;
    }
  }

  /** 描かない建物（名所の模型で置き換える外形）。次に頼む組から効く */
  private excluded: number[][] = [];
  setExcluded(polys: number[][]) {
    this.excluded = polys;
    this.worker?.postMessage({ type: "exclude", polys } satisfies CityRequest);
  }

  /** 種類ごとの受け取り口 */
  on(kind: Kind, onDone: (key: string, r: CityResponse, ox: number, oz: number) => void) {
    this.slots.set(kind, { inFlight: null, want: null, onDone });
  }

  /** 作業中か（依頼を送っている・送る予定がある） */
  busy(kind: Kind): boolean {
    const s = this.slots.get(kind);
    return !!s && (!!s.inFlight || !!s.want);
  }

  request(kind: Kind, key: string, cells: string[], ox: number, oz: number, subCells?: string[]) {
    const s = this.slots.get(kind)!;
    s.want = { key, cells, subCells, ox, oz };
    if (!s.inFlight) this.send(kind, s);
  }

  private send(kind: Kind, s: Slot) {
    const w = s.want;
    if (!w) return;
    s.want = null;
    const id = this.nextId++;
    s.inFlight = { id, key: w.key, ox: w.ox, oz: w.oz };
    if (this.worker) {
      this.worker.postMessage({ type: kind, id, cells: w.cells, subCells: w.subCells, ox: w.ox, oz: w.oz } satisfies CityRequest);
      return;
    }
    // Worker なし: その場で作る
    const r = this.buildLocal(kind, id, w.cells, w.ox, w.oz);
    queueMicrotask(() => this.onMessage(r));
  }

  private buildLocal(kind: Kind, id: number, cells: string[], ox: number, oz: number): CityResponse {
    const t0 = performance.now();
    const { buildings, streets, terrain } = this.local;
    if (kind === "streets") {
      const pieces: [number, number, number, number][] = [];
      for (const k of cells) for (const p of streets?.index.pieces[k] ?? []) pieces.push(p);
      const r = buildStreets(streets!, terrain, pieces, ox, oz);
      return { type: "streets", id, ...r, pieces: pieces.length, ms: performance.now() - t0 };
    }
    let list: number[] = [];
    for (const k of cells) {
      const c = buildings?.index.cells[k];
      if (c) for (let i = c[0]; i < c[0] + c[1]; i++) list.push(i);
    }
    if (this.excluded.length && buildings) list = withoutExcluded(buildings, list, this.excluded);
    if (kind === "near") return { type: "near", id, ...buildNear(buildings!, terrain, list, ox, oz), buildings: list.length, ms: performance.now() - t0 };
    return { type: "far", id, ...buildFar(buildings!, terrain, list, ox, oz), buildings: list.length, ms: performance.now() - t0 };
  }

  private onMessage(r: CityResponse) {
    if (r.type === "error") {
      console.error("city worker", r.message);
      for (const s of this.slots.values()) if (s.inFlight?.id === r.id) s.inFlight = null;
      return;
    }
    const s = this.slots.get(r.type);
    if (!s || s.inFlight?.id !== r.id) return;
    const { key, ox, oz } = s.inFlight;
    s.inFlight = null;
    // 返事を待つ間に欲しい組が変わっていたら、この返事は使わずに頼み直す
    if (s.want && s.want.key !== key) {
      this.send(r.type, s);
      return;
    }
    s.want = null;
    s.onDone(key, r, ox, oz);
  }

  destroy() {
    this.worker?.terminate();
  }
}
