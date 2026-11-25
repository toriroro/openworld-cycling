// アカウントの画面（配達の草案 23.3、D6a）: ログイン・新しく作る・同期の状態・ログアウト・パスワードの変更・削除、
// ほかの端末の保存との食い違い、ゲストの保存を移すか。文言は操作・状態・事実情報だけ（CLAUDE.md）。

import * as acc from "../online/account.ts";
import { api, ApiError } from "../online/api.ts";
import { type CloudDoc, CLOUD_WORLDS, loginIdProblem, PASSWORD_MAX, passwordProblem } from "../shared/online.ts";
import { WORLD_LABELS } from "../world-choice.ts";

const h = <K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text = "", parent?: HTMLElement) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  parent?.appendChild(e);
  return e;
};

const btn = (label: string, parent: HTMLElement, cls = "") => {
  const b = h("button", `btn ${cls}`.trim(), label, parent);
  b.type = "button";
  return b;
};

const when = (ms: number) => (ms ? new Date(ms).toLocaleString("ja-JP", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "—");

/** 保存一式の中身の要約（世界ごと）。読めない項目は飛ばす */
export function docLines(d: CloudDoc): string[] {
  const out: string[] = [];
  for (const w of CLOUD_WORLDS) {
    const s = d.worlds[w] as { odometer?: unknown; savedAt?: unknown; work?: { money?: unknown; delivered?: unknown } } | undefined;
    if (!s) continue;
    const parts = [WORLD_LABELS[w]];
    if (typeof s.odometer === "number") parts.push(`${(s.odometer / 1000).toFixed(1)} km`);
    if (typeof s.work?.money === "number") parts.push(`所持金 ${Math.round(s.work.money).toLocaleString("ja-JP")} 円`);
    if (typeof s.work?.delivered === "number") parts.push(`届けた ${s.work.delivered} 件`);
    if (typeof s.savedAt === "string" && s.savedAt) parts.push(`保存 ${when(Date.parse(s.savedAt))}`);
    out.push(parts.join("・"));
  }
  return out.length ? out : ["保存なし"];
}

export class AccountPanel {
  readonly root: HTMLElement;
  private body: HTMLElement;
  private busy = false;
  /** 処理の間に同期の状態が変わった（終わってから描き直す） */
  private stale = false;
  /** ゲストの保存を移すかを聞いている間は描き直さない（答えると読み込み直す） */
  private asking = false;
  /** 読み込み直す。save: 今の状態を保存してから（false なら保存せずに。サーバーの保存を手元に入れた後） */
  onReload: (save: boolean) => void = () => {};
  /** 今の状態をすぐ保存する（ログイン・ログアウトの前） */
  onSaveNow: () => Promise<void> = async () => {};

  constructor() {
    this.root = h("div", "stamp-book account hidden");
    document.body.appendChild(this.root);
    const head = h("div", "stamp-head", "", this.root);
    h("div", "stamp-title", "アカウント", head);
    btn("閉じる", head).addEventListener("click", () => this.close());
    this.body = h("div", "stamp-list account-body", "", this.root);
    acc.onSyncState(() => {
      if (!this.isOpen || this.asking) return;
      if (this.busy) this.stale = true;
      else void this.render();
    });
  }

  get isOpen() {
    return !this.root.classList.contains("hidden");
  }

  open() {
    this.root.classList.remove("hidden");
    void this.render();
  }

  close() {
    this.root.classList.add("hidden");
  }

  private section(title: string) {
    h("div", "company-sub", title, this.body);
  }

  private row(k: string, v: string) {
    const r = h("div", "account-row", "", this.body);
    h("span", "account-key", k, r);
    h("span", "account-val", v, r);
  }

  private async render() {
    this.body.replaceChildren();
    const remote = acc.remoteDoc();
    if (remote) return this.renderRemote(remote);
    const a = acc.currentAccount();
    if (a) return this.renderSignedIn();
    const expired = acc.expiredAccount();
    if (expired) {
      h("div", "account-note", `${expired.loginId} のログインの期限が切れた。ログインし直すと、この端末で進めた分を送る。`, this.body);
      this.renderForm("login", expired.loginId);
      this.section("ゲストで遊ぶ");
      h("div", "account-note", "この端末のゲストの保存で走る。アカウントの保存はこの端末に残る。", this.body);
      btn("ゲストで遊ぶ", this.body).addEventListener("click", () => void this.run(async () => {
        await acc.signOut();
        this.onReload(false);
      }));
      return;
    }
    h("div", "account-note", "ログインすると、保存をサーバーに置き、ほかの端末でも同じ続きから走れる。メールを持たないので、パスワードを忘れると戻せない。", this.body);
    this.renderForm("login", acc.lastLoginId());
    this.section("新しく作る");
    this.renderForm("register", "");
  }

  /** ログイン・新しく作るの入力 */
  private renderForm(kind: "login" | "register", id0: string) {
    const form = h("form", "account-form", "", this.body);
    const field = (label: string, type: string, auto: string, value = "") => {
      const l = h("label", "account-field", "", form);
      h("span", "", label, l);
      const i = h("input", "", "", l);
      i.type = type;
      i.autocomplete = auto as AutoFill;
      i.value = value;
      i.maxLength = PASSWORD_MAX;
      i.spellcheck = false;
      i.autocapitalize = "off";
      return i;
    };
    const id = field("ユーザー ID", "text", "username", id0);
    const pw = field("パスワード", "password", kind === "login" ? "current-password" : "new-password");
    const pw2 = kind === "register" ? field("パスワード（もう一度）", "password", "new-password") : null;
    const err = h("div", "account-error", "", form);
    const submit = h("button", "btn primary", kind === "login" ? "ログイン" : "作ってログイン", form);
    submit.type = "submit";
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      if (this.busy) return;
      const loginId = id.value.trim();
      const problem = kind === "register" ? loginIdProblem(loginId) ?? passwordProblem(pw.value, loginId) ?? (pw.value !== pw2!.value ? "2 つのパスワードが違う" : null) : !loginId || !pw.value ? "ユーザー ID とパスワードを入れる" : null;
      if (problem) {
        err.textContent = problem;
        return;
      }
      err.textContent = "確かめている";
      void this.run(async () => {
        try {
          await this.onSaveNow();
          const res = kind === "login" ? await api.login(loginId, pw.value) : await api.register(loginId, pw.value);
          const r = await acc.signIn(res);
          if (r.canTakeGuest) this.renderTakeGuest();
          else if (r.check !== "conflict") this.onReload(false);
          else await this.render();
        } catch (e) {
          err.textContent = e instanceof ApiError ? e.message : "ログインできなかった";
        }
      });
    });
  }

  /** ゲストの保存を、作った（入った）アカウントへ移すか */
  private async renderTakeGuest() {
    this.asking = true;
    this.body.replaceChildren();
    this.section("この端末のゲストの保存");
    for (const l of docLines(await acc.guestSnapshot())) h("div", "account-note", l, this.body);
    h("div", "account-note", "このアカウントへ移すと、ゲストの方からは消える。", this.body);
    const actions = h("div", "account-actions", "", this.body);
    btn("このアカウントへ移す", actions, "primary").addEventListener("click", () => void this.run(async () => {
      await acc.takeGuestData();
      this.onReload(false);
    }));
    btn("移さない", actions).addEventListener("click", () => this.onReload(false));
  }

  private renderSignedIn() {
    const a = acc.currentAccount()!;
    this.row("ユーザー ID", a.loginId);
    this.row("登録番号", String(a.regNo));
    this.row("同期", acc.SYNC_LABELS[acc.syncState()]);
    const actions = h("div", "account-actions", "", this.body);
    btn("今すぐ送る", actions).addEventListener("click", () => void this.run(async () => {
      await this.onSaveNow();
      await acc.pushNow();
    }));
    btn("ログアウト", actions).addEventListener("click", () => void this.run(async () => {
      await this.onSaveNow();
      const sent = await acc.signOut();
      if (!sent) window.alert("送れていない保存はこの端末に残した。次にログインした時に送る。");
      this.onReload(false);
    }));

    this.section("パスワードを変える");
    const pf = h("form", "account-form", "", this.body);
    const input = (label: string, auto: string, form: HTMLElement) => {
      const l = h("label", "account-field", "", form);
      h("span", "", label, l);
      const i = h("input", "", "", l);
      i.type = "password";
      i.autocomplete = auto as AutoFill;
      i.maxLength = PASSWORD_MAX;
      return i;
    };
    const cur = input("今のパスワード", "current-password", pf);
    const next = input("新しいパスワード", "new-password", pf);
    const perr = h("div", "account-error", "", pf);
    h("button", "btn", "変える", pf).setAttribute("type", "submit");
    pf.addEventListener("submit", (e) => {
      e.preventDefault();
      const problem = passwordProblem(next.value, a.loginId);
      if (problem) {
        perr.textContent = problem;
        return;
      }
      perr.textContent = "確かめている";
      void this.run(async () => {
        try {
          await acc.changePassword(cur.value, next.value);
          perr.textContent = "変えた。ほかの端末はログアウトした";
          cur.value = next.value = "";
        } catch (err) {
          perr.textContent = err instanceof ApiError ? err.message : "変えられなかった";
        }
      });
    });

    this.section("アカウントを消す");
    h("div", "account-note", "サーバーの保存とアカウントを消す。この端末のゲストの保存は残る。戻せない。", this.body);
    const df = h("form", "account-form", "", this.body);
    const dpw = input("パスワード", "current-password", df);
    const derr = h("div", "account-error", "", df);
    const del = h("button", "btn danger", "消す", df);
    del.type = "submit";
    let armed = false;
    df.addEventListener("submit", (e) => {
      e.preventDefault();
      if (!armed) {
        armed = true;
        del.textContent = "もう一度押すと消す";
        return;
      }
      derr.textContent = "確かめている";
      void this.run(async () => {
        try {
          await acc.deleteAccount(dpw.value);
          this.onReload(false);
        } catch (err) {
          armed = false;
          del.textContent = "消す";
          derr.textContent = err instanceof ApiError ? err.message : "消せなかった";
        }
      });
    });
  }

  /** ほかの端末で進んだ保存、または食い違い */
  private async renderRemote(c: acc.Conflict) {
    const conflict = acc.syncState() === "conflict";
    this.row("同期", acc.SYNC_LABELS[acc.syncState()]);
    this.section(`サーバーの保存（${when(c.updatedAt)}）`);
    for (const l of docLines(c.data)) h("div", "account-note", l, this.body);
    this.section("この端末の保存");
    for (const l of docLines(await acc.localSnapshot())) h("div", "account-note", l, this.body);
    const actions = h("div", "account-actions", "", this.body);
    btn("サーバーの保存で読み込み直す", actions, "primary").addEventListener("click", () => void this.run(async () => {
      await acc.resolveConflict("server");
      this.onReload(false);
    }));
    if (conflict)
      btn("この端末の保存でサーバーを上書き", actions, "danger").addEventListener("click", () => void this.run(async () => {
        await acc.resolveConflict("local");
        await this.render();
      }));
  }

  private async run(f: () => Promise<void>) {
    if (this.busy) return;
    this.busy = true;
    this.stale = false;
    this.root.classList.add("busy");
    try {
      await f();
    } finally {
      this.busy = false;
      this.root.classList.remove("busy");
      if (this.stale && this.isOpen && !this.asking) void this.render();
    }
  }
}

