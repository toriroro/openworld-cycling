// ログインの状態と、セーブの同期（端末をまたいだ引き継ぎ。配達の草案 23.3、D6a）。keirin-3D の src/online/account.ts を写して直した。
//
// - 同期するのは、世界ごとの一人用の保存データ（save・save-hokkaido）。走った記録の書き出し用の記録は送らない。
// - ログインしている間は、端末の保存の鍵の後ろに「@r<登録番号>」を付けて、ゲストの保存と分ける（scopeSuffix）。
// - サーバーのセーブには rev（書くたびに +1）がある。端末は元にした rev と、その後に手元で変わったか（dirty）を覚える。
// - 手元で保存が書き換わると少し待ってから送る。続けて遊んでいる間は 60 秒に 1 回まで。サーバーの rev が元と違えば上書きせず「競合」にする。
// - サーバーのセーブを手元に入れるのは、ゲームが保存を読む前（起動の時）か、読み込み直す直前だけ。遊んでいる間に入れると、
//   遊んでいる状態の保存で上書きしてしまうため。

import { platform } from "../platform/index.ts";
import { type Account, type AuthResponse, CLOUD_DOC_VERSION, CLOUD_WORLDS, type CloudDoc, cleanCloudDoc, type CloudWorld } from "../shared/online.ts";
import { SAVE_KEYS } from "../world-choice.ts";
import { api, ApiError } from "./api.ts";

interface AuthStore {
  token: string | null;
  account: Account | null;
  lastLoginId?: string;
}

interface SyncMeta {
  rev: number;
  dirty: boolean;
  syncedAt: number;
  /** サーバーと同じ時のセーブ一式の指紋（保存し直しただけなら変わったとみなさない） */
  hash?: string;
}

export interface Conflict {
  rev: number;
  updatedAt: number;
  data: CloudDoc;
}

export type SyncState = "off" | "synced" | "pending" | "syncing" | "offline" | "conflict" | "remote" | "expired" | "too_large";

export const SYNC_LABELS: Record<SyncState, string> = {
  off: "ゲスト（この端末だけ）",
  synced: "同期済み",
  pending: "送る前",
  syncing: "送っている",
  offline: "サーバーにつながらない（つながったら送る）",
  conflict: "ほかの端末の保存と食い違っている",
  remote: "ほかの端末で進んだ保存がある",
  expired: "ログインの期限が切れた",
  too_large: "保存が大きすぎて送れない",
};

const AUTH_KEY = "auth";
const SYNC_KEY = "sync";
/** 書いてから送るまで（続けて書いた分をまとめる） */
const PUSH_DEBOUNCE_MS = 1500;
/** 続けて遊んでいる間の、送ってから次に送るまで */
const PUSH_GAP_MS = 60_000;
/** 送れなかった時の、次に送り直すまで（続けて失敗するほど延ばす。送れたら戻す） */
const RETRY_MS = [30_000, 60_000, 120_000, 300_000];
/** 遊んでいる間に、ほかの端末で進んでいないか確かめる間隔の下限 */
const CHECK_GAP_MS = 60_000;

let auth: AuthStore = { token: null, account: null };
let state: SyncState = "off";
let conflict: Conflict | null = null;
let seq = 0;
let pushTimer: ReturnType<typeof setTimeout> | null = null;
let pushing: Promise<void> | null = null;
let lastPushAt = 0;
let lastCheckAt = 0;
let retryAt = 0;
let pushFails = 0;
/** ゲームが保存を読んだ後か（それより後は、起動の時の確かめでもサーバーの保存を手元に入れない） */
let started = false;
const listeners = new Set<(s: SyncState) => void>();

const scopeOf = (a: Account) => `@r${a.regNo}`;
let scope = "";

/** ゲームが保存を読み始める（main.ts。起動の時の確かめが長引いても、ここから後は手元に入れない） */
export function markStarted() {
  started = true;
}

/** 端末の保存の鍵の後ろに付ける印（ゲストは ""） */
export function scopeSuffix(): string {
  return scope;
}

function setState(s: SyncState) {
  state = s;
  for (const f of listeners) f(s);
}
export const syncState = () => state;
export function onSyncState(f: (s: SyncState) => void): () => void {
  listeners.add(f);
  return () => listeners.delete(f);
}
export const currentAccount = (): Account | null => (auth.token ? auth.account : null);
export const isLoggedIn = () => !!auth.token && !!auth.account;
export const lastLoginId = () => auth.lastLoginId ?? auth.account?.loginId ?? "";
/** 期限の切れたアカウント（再ログインを勧める） */
export const expiredAccount = (): Account | null => (state === "expired" ? auth.account : null);
export const pendingConflict = (): Conflict | null => (state === "conflict" ? conflict : null);

function token(): string {
  if (!auth.token) throw new ApiError(401, "unauthorized", "ログインしていない");
  return auth.token;
}

const parse = <T>(s: string | null, fallback: T): T => {
  try {
    return s ? (JSON.parse(s) as T) : fallback;
  } catch {
    return fallback;
  }
};

const saveAuth = () => platform.storage.save(AUTH_KEY, JSON.stringify(auth));
const readMeta = async (): Promise<SyncMeta | null> => parse<SyncMeta | null>(await platform.storage.load(SYNC_KEY + scope), null);
const writeMeta = (m: SyncMeta) => platform.storage.save(SYNC_KEY + scope, JSON.stringify(m));

/** 手元のセーブ一式（scope の保存） */
async function localDoc(sc = scope): Promise<CloudDoc> {
  const worlds: CloudDoc["worlds"] = {};
  for (const w of CLOUD_WORLDS) {
    const v = parse<unknown>(await platform.storage.load(SAVE_KEYS[w] + sc), null);
    if (v && typeof v === "object" && !Array.isArray(v)) worlds[w] = v;
  }
  return { v: CLOUD_DOC_VERSION, worlds };
}

const hasData = (d: CloudDoc) => Object.keys(d.worlds).length > 0;

/** セーブ一式の指紋（FNV-1a。保存した時刻は比べない） */
function docHash(d: CloudDoc): string {
  const s = JSON.stringify(d, (k, v) => (k === "savedAt" ? undefined : v));
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  return `${s.length}:${(h >>> 0).toString(36)}`;
}

/** サーバーのセーブで手元を置き換える（ゲームが保存を読む前か、読み込み直す直前だけ） */
async function applyDoc(doc: CloudDoc, rev: number) {
  for (const w of CLOUD_WORLDS) {
    const v = doc.worlds[w as CloudWorld];
    if (v) await platform.storage.save(SAVE_KEYS[w] + scope, JSON.stringify(v));
    else await platform.storage.remove(SAVE_KEYS[w] + scope);
  }
  await writeMeta({ rev, dirty: false, syncedAt: Date.now(), hash: docHash(await localDoc()) });
  seq++;
  setState("synced");
}

// ---- 送る ----

function schedulePush(ms = PUSH_DEBOUNCE_MS) {
  const now = Date.now();
  const at = retryAt > now ? retryAt : Math.max(now + ms, lastPushAt + PUSH_GAP_MS);
  if (pushTimer) clearTimeout(pushTimer);
  pushTimer = setTimeout(() => {
    pushTimer = null;
    void pushNow();
  }, at - now);
}

/** ゲームが保存を書いた（game.ts の onSaved） */
export async function noteLocalWrite() {
  if (!isLoggedIn() && state !== "expired") return;
  const m = (await readMeta()) ?? { rev: 0, dirty: true, syncedAt: 0 };
  if (!m.dirty && m.hash && m.hash === docHash(await localDoc())) return;
  m.dirty = true;
  await writeMeta(m);
  seq++;
  if (isLoggedIn() && state !== "conflict" && state !== "remote" && state !== "too_large") {
    setState("pending");
    schedulePush();
  }
}

/** 手元の変更をすぐ送る。leaving: 裏に回る・閉じる時（ページが閉じても届くように keepalive で送る。大きい物はふつうに送る） */
export async function pushNow(opts: { leaving?: boolean } = {}): Promise<void> {
  if (pushing) {
    await pushing;
    if (!((await readMeta())?.dirty ?? false)) return;
  }
  pushing = doPush(!!opts.leaving).finally(() => (pushing = null));
  return pushing;
}

async function doPush(leaving: boolean) {
  if (!isLoggedIn() || state === "conflict" || state === "remote") return;
  const m = (await readMeta()) ?? { rev: 0, dirty: true, syncedAt: 0 };
  if (!m.dirty) return;
  const at = seq;
  const sc = scope;
  const doc = await localDoc();
  lastPushAt = Date.now();
  setState("syncing");
  try {
    const res = await api.putSave(token(), m.rev, doc, leaving);
    pushFails = 0;
    retryAt = 0;
    if (scope !== sc) return;
    const dirty = seq !== at;
    await writeMeta({ rev: res.rev, dirty, syncedAt: Date.now(), hash: docHash(doc) });
    setState(dirty ? "pending" : "synced");
    if (dirty) schedulePush();
  } catch (e) {
    handleError(e, true);
  }
}

function handleError(e: unknown, retry: boolean) {
  if (!(e instanceof ApiError)) {
    setState("offline");
    return;
  }
  if (e.status === 409 && e.body.data) {
    const data = cleanCloudDoc(e.body.data);
    if (data) {
      conflict = { rev: Number(e.body.rev), updatedAt: Number(e.body.updatedAt), data };
      setState("conflict");
      return;
    }
  }
  if (e.status === 401) {
    void expire();
  } else if (e.status === 413) {
    setState("too_large");
  } else {
    // 通信できない・サーバーの一時のエラー: 間を延ばしながら送り直す
    setState("offline");
    if (retry) {
      retryAt = Date.now() + RETRY_MS[Math.min(pushFails, RETRY_MS.length - 1)];
      pushFails++;
      schedulePush(0);
    }
  }
}

/** ログインの期限切れ。手元のデータ（送っていない分を含む）は残し、次にログインした時に送る */
async function expire() {
  auth = { token: null, account: auth.account, lastLoginId: auth.account?.loginId ?? auth.lastLoginId };
  await saveAuth();
  setState("expired");
}

// ---- サーバーとの突き合わせ ----

export type CheckResult = "same" | "updated" | "conflict" | "remote" | "offline" | "expired";

/**
 * サーバーのセーブが手元より新しいか確かめる。
 * apply: 手元に送っていない変更が無ければサーバーの物を手元に入れる（ログインの直後に読み込み直す時）。
 * boot: 起動の時。ゲームが保存を読み始める前（markStarted の前）だけ手元に入れる。
 * どちらでもない時（遊んでいる間）は入れずに "remote" にする。
 */
export async function checkRemote(opts: { force?: boolean; apply?: boolean; boot?: boolean } = {}): Promise<CheckResult> {
  if (!isLoggedIn()) return state === "expired" ? "expired" : "same";
  if (state === "conflict") return "conflict";
  if (state === "remote") return "remote";
  if (!opts.force && Date.now() - lastCheckAt < CHECK_GAP_MS) return "same";
  lastCheckAt = Date.now();
  if (pushing) await pushing;
  const m = await readMeta();
  try {
    const res = await api.getSave(token(), m?.rev ?? -1, 6000);
    const local = await localDoc();
    if (res.rev === 0) {
      // サーバーにまだ無い: 手元にあれば送る
      if (hasData(local)) {
        await writeMeta({ rev: 0, dirty: true, syncedAt: m?.syncedAt ?? 0 });
        await pushNow();
      } else setState("synced");
      return afterPush();
    }
    if (m && res.rev === m.rev) {
      if (m.dirty) {
        if (opts.force) await pushNow();
        else if (!pushTimer) schedulePush();
      } else setState("synced");
      return afterPush();
    }
    const data = res.data ? cleanCloudDoc(res.data) : null;
    if (!data) return "same";
    if (!m || !m.dirty || !hasData(local)) {
      if (opts.apply || (opts.boot && !started)) {
        await applyDoc(data, res.rev);
        return "updated";
      }
      conflict = { rev: res.rev, updatedAt: res.updatedAt ?? 0, data };
      setState("remote");
      return "remote";
    }
    conflict = { rev: res.rev, updatedAt: res.updatedAt ?? 0, data };
    setState("conflict");
    return "conflict";
  } catch (e) {
    handleError(e, false);
    const s = syncState();
    return s === "expired" ? "expired" : s === "conflict" ? "conflict" : "offline";
  }
}

function afterPush(): CheckResult {
  const s = syncState();
  return s === "conflict" ? "conflict" : s === "expired" ? "expired" : "same";
}

/** 食い違い・ほかの端末で進んだ保存の、サーバー側の中身 */
export const remoteDoc = (): Conflict | null => (state === "conflict" || state === "remote" ? conflict : null);

/** この端末の保存一式（食い違いの画面に出す） */
export const localSnapshot = () => localDoc();
/** この端末のゲスト（印なし）の保存一式 */
export const guestSnapshot = () => localDoc("");

/**
 * 食い違いを解く。server: サーバーの物を手元に入れる（この後すぐ読み込み直すこと）、local: この端末の物でサーバーを上書きする
 */
export async function resolveConflict(use: "server" | "local") {
  const c = conflict;
  conflict = null;
  if (!c) return;
  if (use === "server") await applyDoc(c.data, c.rev);
  else {
    await writeMeta({ rev: c.rev, dirty: true, syncedAt: Date.now() });
    setState("pending");
    await pushNow();
  }
}

// ---- ログイン・ログアウト ----

/** 起動の時（ゲームが保存を読む前）: 覚えているログインを読み、サーバーのセーブを手元に入れる */
export async function initAccount(): Promise<void> {
  if (typeof window !== "undefined") {
    window.addEventListener("online", () => {
      pushFails = 0;
      retryAt = 0;
      lastPushAt = 0;
      void readMeta().then((m) => {
        if (isLoggedIn() && m?.dirty) schedulePush(500);
      });
    });
    document.addEventListener("visibilitychange", () => {
      if (!isLoggedIn()) return;
      if (document.visibilityState === "hidden") {
        void readMeta().then((m) => {
          if (m?.dirty) void pushNow({ leaving: true });
        });
      } else void checkRemote();
    });
  }
  auth = parse<AuthStore>(await platform.storage.load(AUTH_KEY), { token: null, account: null });
  if (!auth.account) return;
  scope = scopeOf(auth.account);
  if (!auth.token) {
    setState("expired");
    return;
  }
  setState((await readMeta())?.dirty ? "pending" : "synced");
  try {
    const r = await api.me(auth.token);
    auth.account = r.account;
    await saveAuth();
    await checkRemote({ force: true, boot: true });
  } catch (e) {
    // 通信できない時はログインしたまま手元で遊ぶ
    handleError(e, false);
  }
}

/** ゲストの保存（このアカウントへ移せる物）がこの端末にあるか */
export async function guestHasData(): Promise<boolean> {
  return hasData(await localDoc(""));
}

export interface SignInResult {
  check: CheckResult;
  /** サーバーにも手元にもアカウントの保存が無く、ゲストの保存がある（移すか聞く） */
  canTakeGuest: boolean;
}

/** ログイン・登録が通った後 */
export async function signIn(res: AuthResponse): Promise<SignInResult> {
  auth = { token: res.token, account: res.account, lastLoginId: res.account.loginId };
  await saveAuth();
  conflict = null;
  scope = scopeOf(res.account);
  setState((await readMeta())?.dirty ? "pending" : "synced");
  const check = await checkRemote({ force: true, apply: true });
  const canTakeGuest = check !== "conflict" && !hasData(await localDoc()) && (await guestHasData());
  return { check, canTakeGuest };
}

/** ゲストの保存をこのアカウントへ移す（同じ記録が二つにならないよう、ゲストの方は消す） */
export async function takeGuestData() {
  for (const w of CLOUD_WORLDS) {
    const v = await platform.storage.load(SAVE_KEYS[w]);
    if (v === null) continue;
    await platform.storage.save(SAVE_KEYS[w] + scope, v);
    await platform.storage.remove(SAVE_KEYS[w]);
  }
  await noteLocalWrite();
  await pushNow();
}

/** ログアウト。送っていない変更があれば先に送る（送れなければ false。データはこの端末に残る） */
export async function signOut(): Promise<boolean> {
  let sent = true;
  if (isLoggedIn() && (await readMeta())?.dirty && state !== "conflict" && state !== "remote") {
    await pushNow();
    sent = !(await readMeta())?.dirty;
  }
  if (auth.token) await api.logout(auth.token).catch(() => undefined);
  auth = { token: null, account: null, lastLoginId: auth.account?.loginId ?? auth.lastLoginId };
  await saveAuth();
  conflict = null;
  scope = "";
  setState("off");
  return sent;
}

/** ログインが要る呼び出し。期限切れ（401）ならログインしていない状態にする */
async function authed<T>(f: (t: string) => Promise<T>): Promise<T> {
  try {
    return await f(token());
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) await expire();
    throw e;
  }
}

export async function changePassword(current: string, next: string) {
  const res = await authed((t) => api.changePassword(t, auth.account?.loginId ?? "", current, next));
  auth.token = res.token;
  await saveAuth();
}

/** アカウントの削除: サーバーのデータと、この端末に残したアカウントの保存を消す */
export async function deleteAccount(password: string) {
  await authed((t) => api.deleteAccount(t, auth.account?.loginId ?? "", password));
  for (const w of CLOUD_WORLDS) await platform.storage.remove(SAVE_KEYS[w] + scope);
  await platform.storage.remove(SYNC_KEY + scope);
  auth = { token: null, account: null };
  await saveAuth();
  conflict = null;
  scope = "";
  setState("off");
}
