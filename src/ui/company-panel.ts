// 経営の画面（配達の草案 21 章、D4。見た目は 32 章）: 開業、収支、配達員（応募から雇う）、乗り物、営業所、値段、畳む。
// 上に数字の札、項目はカード（見出し・右の値・小さな札・補足・釦）、収支は日ごとの棒グラフ、配達員の速さ・開業の条件は棒。
// 計算は src/shared/economy.ts の純粋な関数。この画面は表示と操作だけ。文言は操作・状態・事実情報だけ。

import {
  applicants,
  buyVehicle,
  CARRIER_FACTOR,
  CARRIER_PRICE,
  chomeInfo,
  closeDepot,
  type Company,
  crewPlan,
  DEPOT_OPEN,
  depotCheck,
  dismiss,
  estimate,
  hireDelta,
  BALANCE,
  giveCarrier,
  hire,
  KIND_LABELS,
  kindOf,
  nameChoices,
  OPEN_DELIVERED,
  OPEN_MONEY,
  openCheck,
  openDepot,
  PRICE_MAX,
  PRICE_MIN,
  PRICE_STEP,
  sellVehicle,
  setPrice,
  TRUCK_KINDS,
  vehicleCheck,
  VEHICLE_KINDS,
  VEHICLES,
} from "../shared/economy.ts";
import {
  addTruck,
  cancelContract,
  canRenew,
  contractEnd,
  contractEstimate,
  contractMax,
  type FreightDest,
  freightCheck,
  freightOffers,
  type FreightSummary,
  removeTruck,
  renewContract,
  takeContract,
  truckCheck,
  truckFor,
  freeTruckFor,
  trucksNeeded,
  truckState,
} from "../shared/freight.ts";
import { DAY_MS, WEEKDAYS, worldDay } from "../shared/world/weather.ts";
import type { Market } from "../sim/market.ts";
import { bars, chip, kpi, kpis, meter, progress, section, type Tone } from "./widgets.ts";

const h = <K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text = "", parent?: HTMLElement) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  parent?.appendChild(e);
  return e;
};

const yen = (n: number) => `${Math.round(n).toLocaleString("ja-JP")} 円`;
const signedN = (n: number) => `${n >= 0 ? "+" : "−"}${Math.abs(Math.round(n))}`;
const signed = (n: number) => `${n >= 0 ? "+" : "−"}${Math.abs(Math.round(n)).toLocaleString("ja-JP")} 円`;
const ha = (m2: number) => `${(m2 / 10000).toFixed(1)} ha`;
const weekday = (day: number) => WEEKDAYS[day - Math.floor(day / 7) * 7];

/** 画面を開いている間、操作のたびに読み直す今の様子 */
export interface CompanyContext {
  market: Market;
  /** 世界の今日（日の通し番号） */
  today: number;
  /** 所持金（経営していない時） */
  money: number;
  delivered: number;
  /** 今いる丁目（配達の範囲の外なら null） */
  here: string | null;
  /** 今の時刻（Unix ミリ秒） */
  now: number;
  /** 長距離の便の行き先（本店からの道。調べている間は null） */
  dests: FreightDest[] | null;
}

export type CompanyTab = "ledger" | "crew" | "vehicles" | "depots" | "freight";
type Tab = CompanyTab;
const TABS: [Tab, string][] = [
  ["ledger", "収支"],
  ["crew", "配達員"],
  ["vehicles", "乗り物"],
  ["depots", "営業所"],
  ["freight", "便"],
];
/** 現実の時間の長さ（分・時間） */
const span = (ms: number) => {
  const m = Math.max(0, Math.round(ms / 60_000));
  return m < 60 ? `${m} 分` : `${Math.floor(m / 60)} 時間 ${m - Math.floor(m / 60) * 60} 分`;
};

export class CompanyPanel {
  readonly root: HTMLElement;
  private title: HTMLElement;
  private note: HTMLElement;
  private tabs: HTMLElement;
  private list: HTMLElement;
  private tab: Tab = "ledger";
  private ctx: (() => CompanyContext | null) | null = null;
  private pickedName: string | null = null;
  private confirmWindUp = false;
  private confirmCancel: string | null = null;
  /** 留守の間の便（開いた時に便の画面の上に出す。22.1 の 46） */
  away: FreightSummary | null = null;
  /** 廃業・畳んだ時の知らせ（次に開業の画面を出す時に見せる） */
  closedNote = "";
  /** 経営の形を変えた（保存・地図の描き直し） */
  onChange: () => void = () => {};
  /** 開業する（名前と今いる丁目） */
  onOpen: (name: string, chome: string) => void = () => {};
  /** 畳む */
  onWindUp: () => void = () => {};

  constructor() {
    this.root = h("div", "stamp-book ranking company hidden");
    document.body.appendChild(this.root);
    const head = h("div", "stamp-head", "", this.root);
    this.title = h("div", "stamp-title", "経営", head);
    const close = h("button", "btn", "閉じる", head);
    close.type = "button";
    close.addEventListener("click", () => this.close());
    this.note = h("div", "ranking-note company-note", "", this.root);
    this.tabs = h("div", "ranking-tabs", "", this.root);
    for (const [k, label] of TABS) {
      const b = h("button", "btn ranking-tab", label, this.tabs);
      b.type = "button";
      b.dataset.key = k;
      b.addEventListener("click", () => {
        this.tab = k;
        this.render();
      });
    }
    this.list = h("div", "stamp-list ranking-list", "", this.root);
  }

  get isOpen() {
    return !this.root.classList.contains("hidden");
  }

  open(ctx: () => CompanyContext | null, tab?: Tab) {
    this.ctx = ctx;
    if (tab) this.tab = tab;
    this.confirmWindUp = false;
    this.confirmCancel = null;
    this.render();
    this.root.classList.remove("hidden");
  }

  close() {
    this.root.classList.add("hidden");
    this.confirmWindUp = false;
    this.away = null;
  }

  /** 便の画面を開いていれば描き直す（トラックの様子） */
  refreshFreight() {
    if (this.isOpen && this.tab === "freight") this.render();
  }

  /** 開いていれば描き直す（世界の日が変わった時など） */
  refresh() {
    if (this.isOpen) this.render();
  }

  private changed() {
    this.onChange();
    this.render();
  }

  private button(parent: HTMLElement, label: string, onClick: () => void, disabled = false) {
    const b = h("button", "btn", label, parent);
    b.type = "button";
    b.disabled = disabled;
    b.addEventListener("click", onClick);
    return b;
  }

  /** カード: 見出し・右の値・小さな札・補足の行・釦の並び（釦の並びを返す） */
  private item(name: string, meta: string[], swatch?: string, opt: { right?: string; tone?: Tone; chips?: [string, Tone?][]; parent?: HTMLElement } = {}) {
    const card = h("div", "w-card company-card", "", opt.parent ?? this.list);
    const head = h("div", "w-card-head", "", card);
    if (swatch) h("span", "ranking-swatch", "", head).style.background = swatch;
    h("span", "w-card-title", name, head);
    if (opt.right) h("span", `w-card-right tone-${opt.tone ?? "plain"}`, opt.right, head);
    if (opt.chips?.length) {
      const row = h("div", "company-chips", "", card);
      for (const [t, tone] of opt.chips) chip(row, t, tone ?? "plain");
    }
    for (const m of meta) if (m) h("div", "w-note company-meta", m, card);
    return h("div", "w-card-actions", "", card);
  }

  /** 見出し（小さな欄の題） */
  private sub(text: string) {
    h("div", "company-sub", text, this.list);
  }

  private render() {
    const ctx = this.ctx?.();
    if (!ctx) return;
    const c = ctx.market.own();
    this.list.replaceChildren();
    this.tabs.classList.toggle("hidden", !c);
    if (!c) this.renderOpen(ctx);
    else this.renderOwn(ctx, c);
  }

  // ---- 開業の前 ----

  private renderOpen(ctx: CompanyContext) {
    const m = ctx.market;
    const s = m.state;
    const joined = s.player.company ? s.companies.find((x) => x.id === s.player.company) : null;
    this.title.textContent = "開業";
    this.note.textContent = [this.closedNote, `段 ${joined ? `アルバイト（所属 ${joined.name}）` : "個人"}`].filter(Boolean).join("\n");
    const names = nameChoices(s, ctx.today);
    if (!this.pickedName || !names.includes(this.pickedName)) this.pickedName = names[0] ?? null;
    const cond = section(this.list, "開業の条件", "今いる丁目に営業所を 1 か所開く（開業の時は費用なし）");
    progress(cond, "所持金", ctx.money, OPEN_MONEY, (n) => yen(n));
    progress(cond, "届けた件数", ctx.delivered, OPEN_DELIVERED, (n) => `${Math.round(n)} 件`);
    h("div", "w-note", "開業すると、所持金がすべて業者の資金になる", cond);
    const info = ctx.here ? chomeInfo(m.arena, s, ctx.here, null) : null;
    this.item(`今いる丁目 ${ctx.here ?? "配達の範囲の外"}`, info ? [info.nearest ? `近いほかの営業所 ${info.nearest.name} ${Math.round(info.nearest.m)} m` : "近いほかの営業所 無し"] : [], undefined, info ? { right: `注文 約 ${info.base.toFixed(1)} 件/日`, chips: [["平日の見込み"]] } : {});
    this.sub("名前");
    const row = h("div", "company-names", "", this.list);
    for (const n of names) {
      const b = this.button(row, n, () => {
        this.pickedName = n;
        this.render();
      });
      b.classList.add("ranking-tab");
      b.classList.toggle("selected", n === this.pickedName);
    }
    const why = openCheck(m.arena, s, ctx.here, ctx.money, ctx.delivered);
    const act = h("div", "company-open", "", this.list);
    this.button(act, ctx.here ? `${ctx.here}で開業する` : "開業する", () => {
      if (this.pickedName && ctx.here) this.onOpen(this.pickedName, ctx.here);
    }, !!why || !this.pickedName);
    if (why) h("div", "stamp-meta", why, act);
    if (joined) h("div", "stamp-meta", `開業すると ${joined.name}をやめる`, act);
  }

  // ---- 経営 ----

  private renderOwn(ctx: CompanyContext, c: Company) {
    const m = ctx.market;
    const ent = m.now.entities.find((e) => e.id === c.id);
    this.title.textContent = c.name;
    this.note.textContent = "";
    // 上の数字の札: 資金・今日の見込みの利益・配達員と段・商圏
    const e = estimate(m.arena, m.state, c, ctx.today);
    const k = kpis(this.list);
    k.classList.add("company-kpis");
    kpi(k, "資金", yen(c.cash), `信頼 ${c.trust.toFixed(2)}`, c.cash < 0 ? "bad" : "accent");
    kpi(k, `今日（${weekday(ctx.today)}）の見込み`, signed(e.revenue - e.cost), `売上 ${yen(e.revenue)}`, e.revenue - e.cost >= 0 ? "good" : "bad");
    kpi(k, "配達員", `${c.staff} 人`, KIND_LABELS[kindOf(c.staff)]);
    kpi(k, "商圏", `${ent?.chomes ?? 0} 丁目`, ha(ent?.area ?? 0));
    for (const b of this.tabs.children) (b as HTMLElement).classList.toggle("selected", (b as HTMLElement).dataset.key === this.tab);
    if (this.tab === "ledger") this.renderLedger(ctx, c);
    else if (this.tab === "crew") this.renderCrew(ctx, c);
    else if (this.tab === "vehicles") this.renderVehicles(ctx, c);
    else if (this.tab === "freight") this.renderFreight(ctx, c);
    else this.renderDepots(ctx, c);
  }

  private renderLedger(ctx: CompanyContext, c: Company) {
    const m = ctx.market;
    const e = estimate(m.arena, m.state, c, ctx.today);
    // 今日の見込み（今の形で 1 日分）
    const today = section(this.list, `今日（${weekday(ctx.today)}）の見込み`, "世界の 1 日の終わりに締める");
    const tk = kpis(today);
    kpi(tk, "運ぶ件数", `${Math.round(e.served)} 件`, `場の注文の ${((e.served / Math.max(1, e.demand)) * 100).toFixed(1)}%`);
    kpi(tk, "あふれ", `${Math.round(e.lost)} 件`, "運びきれない注文", e.lost > 0 ? "bad" : "plain");
    kpi(tk, "売上", yen(e.revenue));
    kpi(tk, "費用", yen(e.cost));
    // この 7 日の利益
    const ledger7 = [...(c.ledger ?? [])].slice(-7);
    if (ledger7.length) {
      const chart = section(this.list, "締めた日の利益", `${ledger7.length} 日`);
      const profit = (l: (typeof ledger7)[number]) => l.sales + l.own + l.fsales - (l.wages + l.depots + l.vehicles + l.dist + l.fuel + l.fee);
      bars(chart, ledger7.map(profit), ledger7.map((l) => weekday(l.day)), (v) => `${v >= 0 ? "" : "−"}${Math.abs(Math.round(v / 1000))}千`);
    }
    const pr = this.item("値段 1 件", [`${yen(PRICE_MIN)}〜${yen(PRICE_MAX)}。高いほど取れる注文が減る`], undefined, { right: yen(c.price), tone: "accent" });
    this.button(pr, "−", () => {
      setPrice(c, c.price - PRICE_STEP);
      this.changed();
    }, c.price <= PRICE_MIN);
    this.button(pr, "+", () => {
      setPrice(c, c.price + PRICE_STEP);
      this.changed();
    }, c.price >= PRICE_MAX);
    this.sub("締めた日");
    const ledger = [...(c.ledger ?? [])].reverse().slice(0, 7);
    if (!ledger.length) h("div", "stamp-empty", "締めた日はまだ無い", this.list);
    for (const l of ledger) {
      const cost = l.wages + l.depots + l.vehicles + l.dist + l.fuel + l.fee;
      const sales = l.sales + l.own + l.fsales;
      this.item(
        `${weekday(l.day)}曜`,
        [
          `売上 ${yen(sales)}（配達員 ${l.served} 件 ${yen(l.sales)}、自分 ${l.ownCount} 件 ${yen(l.own)}${l.trips || l.dropped ? `、便 ${l.trips} 便 ${yen(l.fsales)}` : ""}）`,
          `費用 ${yen(cost)}（給料 ${yen(l.wages)}・営業所 ${yen(l.depots)}・乗り物 ${yen(l.vehicles)}・距離 ${yen(l.dist)}${l.fuel ? `・燃料 ${yen(l.fuel)}` : ""}${l.fee ? `・違約金 ${yen(l.fee)}` : ""}）`,
          `締めた後の資金 ${yen(l.cash)}`,
        ],
        undefined,
        { right: signed(sales - cost), tone: sales - cost >= 0 ? "good" : "bad", chips: [[`あふれ ${l.lost} 件`, l.lost ? "bad" : "plain"], ...(l.late ? [[`便の遅れ ${l.late}`, "warn"] as [string, Tone]] : []), ...(l.dropped ? [[`落とした荷 ${l.dropped}`, "bad"] as [string, Tone]] : [])] },
      );
    }
  }

  private renderCrew(ctx: CompanyContext, c: Company) {
    const s = ctx.market.state;
    const plan = crewPlan(c, ctx.today);
    const ck = kpis(this.list);
    kpi(ck, "配達員", `${plan.slots.length} 人`, plan.drivers.length ? `便の運転手 ${plan.drivers.length} 人` : "");
    kpi(ck, "1 日に運べる", `${Math.round(plan.cap)} 件`);
    kpi(ck, "給料 1 日", yen(plan.wages));
    this.sub("配達員");
    if (!plan.slots.length) h("div", "stamp-empty", "配達員がいない", this.list);
    const rows = [...plan.slots.map((sl) => ({ m: sl.crew, sl })), ...plan.drivers.map((m) => ({ m, sl: null }))].sort((a, b) => a.m.no - b.m.no);
    for (const { m, sl } of rows) {
      const bike = sl && (sl.vehicle === "own" || sl.vehicle === "ebike");
      const gear = m.carrier ? `リアキャリア${bike ? `（件数 ${CARRIER_FACTOR} 倍）` : ""}` : "背負い鞄";
      const act = this.item(sl ? `配達員 ${m.no}` : `運転手 ${m.no}`, sl ? [`1 日 ${Math.round(sl.cap)} 件`] : [], undefined, {
        right: `日給 ${yen(m.wage)}`,
        chips: sl ? [[VEHICLES[sl.vehicle].label, "accent"], [gear], [`土地勘 +${Math.round(sl.skill * 100)}%`, sl.skill > 0 ? "good" : "plain"]] : [["便の運転手", "accent"]],
      });
      meter(act.parentElement!, "速さ", m.speed / 1.3, `${m.speed.toFixed(2)} 倍`, m.speed >= 1 ? "good" : m.speed >= 0.85 ? "accent" : "warn");
      act.parentElement!.appendChild(act);
      if (!m.carrier)
        this.button(act, `リアキャリア ${yen(CARRIER_PRICE)}`, () => {
          giveCarrier(c, m.id);
          this.changed();
        }, c.cash < CARRIER_PRICE);
      this.button(act, "辞めてもらう", () => {
        dismiss(c, m.id);
        this.changed();
      });
    }
    this.sub(`今日（${weekday(ctx.today)}）の応募`);
    const list = applicants(s, c, ctx.today);
    if (!list.length) h("div", "stamp-empty", "今日の応募は無い", this.list);
    for (const a of list) {
      const d = hireDelta(ctx.market.arena, s, c, ctx.today, a);
      const gain = d.revenue - d.cost;
      const act = this.item("応募", [`自前の自転車で 1 日 ${Math.round(VEHICLES.own.cap * a.speed)} 件`, `雇うと今日の見込み: 運ぶ件数 ${signedN(d.served)} 件  売上 ${signed(d.revenue)}  費用 ${signed(d.cost)}`], undefined, {
        right: `日給 ${yen(a.wage)}`,
        chips: [[`雇うと利益 ${signed(gain)}/日`, gain >= 0 ? "good" : "bad"]],
      });
      meter(act.parentElement!, "速さ", a.speed / 1.3, `${a.speed.toFixed(2)} 倍`, a.speed >= 1 ? "good" : a.speed >= 0.85 ? "accent" : "warn");
      act.parentElement!.appendChild(act);
      this.button(act, "雇う", () => {
        hire(s, c, ctx.today, a.id);
        this.changed();
      }, c.cash < 0);
    }
  }

  private renderVehicles(ctx: CompanyContext, c: Company) {
    const plan = crewPlan(c, ctx.today);
    this.sub(`乗り物の費用 1 日 ${yen(plan.vehicles)}  届く距離 ${plan.reach.toFixed(2)} 倍（配達員の平均）`);
    for (const k of VEHICLE_KINDS) {
      const v = VEHICLES[k];
      const n = c.fleet?.[k] ?? 0;
      const used = plan.slots.filter((sl) => sl.vehicle === k).length;
      const act = this.item(v.label, [`買う ${yen(v.price)}  維持 1 日 ${yen(v.daily)}`], undefined, {
        right: `${n} 台`,
        chips: [[`割り当て ${used} 台`, used ? "accent" : "plain"], [`1 人 1 日 ${v.cap} 件`], [`届く距離 ${v.reach.toFixed(2)} 倍`]],
      });
      this.button(act, "買う", () => {
        buyVehicle(c, k);
        this.changed();
      }, !!vehicleCheck(c, k));
      this.button(act, `売る ${yen(v.price / 2)}`, () => {
        sellVehicle(c, k);
        this.changed();
      }, n === 0);
    }
    this.sub(`リアキャリア ${yen(CARRIER_PRICE)}: 自前の自転車・電動自転車の配達員の件数が ${CARRIER_FACTOR} 倍（配達員のタブで渡す）`);
    const own = plan.slots.filter((sl) => sl.vehicle === "own").length;
    this.item(VEHICLES.own.label, [], undefined, { right: `${own} 人`, chips: [["割り当ての無い配達員"], [`1 人 1 日 ${VEHICLES.own.cap} 件`], ["届く距離 1.00 倍"]] });
  }

  // ---- 長距離の便（22 章） ----

  private renderFreight(ctx: CompanyContext, c: Company) {
    const s = ctx.market.state;
    const plan = crewPlan(c, ctx.today);
    const a = this.away;
    if (a) {
      this.item(`留守の間の便（${span(a.to - a.from)}）`, [
        `着いた ${a.trips} 便（遅れ ${a.late}、事故 ${a.accidents}）  落とした荷 ${a.dropped}`,
        `運賃 ${yen(a.sales)}  燃料 ${yen(a.fuel)}${a.fee ? `  違約金 ${yen(a.fee)}` : ""}`,
        ...(a.ended.length ? [`期間が終わった契約 ${a.ended.join("、")}`] : []),
      ]);
    }
    // トラック（2 トン・3 トン・10 トン）
    this.sub("トラック  運転手は遅い配達員から回す。世界の 1 日待たせた荷は落とし、運賃の半分を違約金で払う");
    for (const v of TRUCK_KINDS) {
      const tv = VEHICLES[v];
      const n = c.fleet?.[v] ?? 0;
      const used = (c.contracts ?? []).reduce((a, k) => a + k.runs.filter((r) => r.v === v).length, 0);
      const why = vehicleCheck(c, v);
      const ta = this.item(`トラック ${tv.label}`, [`持っている ${n} 台（便に付けている ${used} 台）`, `積める ${tv.tons} トン  ${yen(tv.price)}  1 日 ${yen(tv.daily)}  燃料 1 km ${tv.fuel} 円`, ...(why && why !== "資金が足りない" ? [why] : [])]);
      this.button(ta, "買う", () => {
        buyVehicle(c, v);
        this.changed();
      }, !!why);
      this.button(ta, `売る ${yen(tv.price / 2)}`, () => {
        sellVehicle(c, v);
        this.changed();
      }, n <= used);
    }
    // 契約
    const list = c.contracts ?? [];
    this.sub(`契約 ${list.length} / ${contractMax(c.staff)} 本`);
    if (!list.length) h("div", "stamp-empty", "契約は無い", this.list);
    const driverNos = plan.drivers.map((m) => m.no);
    let di = 0;
    for (const k of list) {
      const end = contractEnd(k);
      const left = Math.max(0, (end - ctx.now) / DAY_MS);
      const nos = driverNos.slice(di, di + k.runs.length);
      di += k.runs.length;
      const runs = k.runs.map((r, i) => {
        const st = truckState(r, ctx.now);
        return `${i + 1} 台目（${VEHICLES[r.v].label}） ${st.leg === "home" ? "営業所" : st.leg === "out" ? (ctx.now < r.arr ? `${k.town}へ 着くまで ${span(r.arr - ctx.now)}` : `${k.town}で降ろしている`) : `戻る 着くまで ${span(r.free - ctx.now)}`}`;
      });
      const endDay = worldDay(end).day;
      const act = this.item(`${k.town}へ ${k.cargo}（${k.shipper}）`, [
        `1 日 ${k.loads} 便  荷 ${k.tons} トン（${VEHICLES[truckFor(k.tons) ?? "t10"].label}から）  1 便 ${yen(k.rate)}  片道 ${k.km.toFixed(1)} km・${Math.round(k.min)} 分`,
        `残り 世界の ${left.toFixed(1)} 日（${weekday(endDay)}曜まで）${canRenew(k, ctx.now) ? "  更新できる" : ""}`,
        `トラック ${k.runs.length} 台（1 日 ${k.loads} 便に要る ${trucksNeeded(k)} 台）${nos.length ? `  運転手 ${nos.map((n) => `${n} 番`).join("・")}` : ""}`,
        ...runs,
        `これまで 着いた ${k.sum.trips} 便（遅れ ${k.sum.late}）  落とした荷 ${k.sum.dropped}  運賃 ${yen(k.sum.sales)}`,
      ]);
      this.button(act, "−", () => {
        removeTruck(k);
        this.changed();
      }, !k.runs.length);
      const why = truckCheck(c, k);
      this.button(act, "+", () => {
        addTruck(c, k, ctx.now);
        this.changed();
      }, !!why || k.next >= k.total).title = why ?? "";
      if (canRenew(k, ctx.now))
        this.button(act, "更新", () => {
          renewContract(k, ctx.now);
          this.changed();
        });
      if (k.next < k.total)
        this.button(act, this.confirmCancel === k.id ? "やめる" : "やめる…", () => {
          if (this.confirmCancel !== k.id) {
            this.confirmCancel = k.id;
            this.render();
            return;
          }
          this.confirmCancel = null;
          cancelContract(k);
          this.changed();
        });
    }
    // 今日の申し込み
    this.sub(`今日（${weekday(ctx.today)}）の申し込み`);
    const why = freightCheck(c);
    if (why) h("div", "stamp-meta", why, this.list);
    if (!ctx.dests) {
      h("div", "stamp-empty", "行き先までの道を調べている", this.list);
      return;
    }
    const offers = freightOffers(s, c, ctx.today, ctx.dests);
    if (!offers.length) h("div", "stamp-empty", "今日の申し込みは無い", this.list);
    const wage = plan.drivers[0]?.wage ?? 7000;
    for (const o of offers) {
      const need = trucksNeeded(o);
      const e = contractEstimate(o, need, wage);
      const act = this.item(`${o.town}へ ${o.cargo}（${o.shipper}）`, [
        `1 日 ${o.loads} 便  荷 ${o.tons} トン（${VEHICLES[truckFor(o.tons) ?? "t10"].label}から${freeTruckFor(c, o.tons) ? "。空いたトラックあり" : ""}）  1 便 ${yen(o.rate)}  片道 ${o.km.toFixed(1)} km・${Math.round(o.min)} 分  期間 世界の 28 日`,
        `トラック ${need} 台で 1 日 ${e.trips.toFixed(1)} 便。見込み 1 日 運賃 ${yen(e.sales)} − 燃料 ${yen(e.fuel)} − トラック ${yen(e.trucks)} − 運転手 ${yen(e.wages)} = ${signed(e.profit)}`,
      ]);
      this.button(act, "契約する", () => {
        if (ctx.dests) takeContract(s, c, ctx.today, ctx.now, ctx.dests, o.id);
        this.changed();
      }, !!why);
    }
  }

  private renderDepots(ctx: CompanyContext, c: Company) {
    const m = ctx.market;
    for (const d of c.depots) {
      const info = chomeInfo(m.arena, m.state, d, c);
      const act = this.item(`営業所 ${d}`, [], c.color, { right: `1 日 ${yen(BALANCE.depotCost)}`, chips: info ? [[`注文 約 ${info.base.toFixed(1)} 件/日（平日）`]] : [] });
      this.button(act, "閉じる", () => {
        closeDepot(c, d);
        this.changed();
      }, c.depots.length <= 1);
    }
    const why = depotCheck(m.arena, m.state, ctx.here, c);
    const info = ctx.here ? chomeInfo(m.arena, m.state, ctx.here, c) : null;
    const act = this.item(`今いる丁目 ${ctx.here ?? "配達の範囲の外"}`, [info ? `注文 1 日 約 ${info.base.toFixed(1)} 件（平日）` : "", info?.nearest ? `近いほかの営業所 ${info.nearest.name} ${Math.round(info.nearest.m)} m` : "", why ?? ""].filter(Boolean));
    this.button(act, `営業所を開く ${yen(DEPOT_OPEN)}`, () => {
      if (ctx.here) openDepot(m.arena, m.state, c, ctx.here);
      this.changed();
    }, !!why);
    this.sub("畳む");
    const w = this.item(this.confirmWindUp ? "もう一度押すと畳む" : "業者を畳む", ["乗り物を半値で売り、資金がプラスならそれが所持金。マイナスなら 0 円", "配達員は辞める。個人に戻る"]);
    this.button(w, this.confirmWindUp ? "畳む" : "畳む…", () => {
      if (!this.confirmWindUp) {
        this.confirmWindUp = true;
        this.render();
        return;
      }
      this.confirmWindUp = false;
      this.onWindUp();
    });
  }
}
