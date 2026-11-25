// サーバー（worker/api.ts）の API を呼ぶ窓口（配達の草案 23.3、D6a）。API はここからだけ呼ぶ（概要仕様 9.5 の 6）。
// keirin-3D の src/online/api.ts を写して直した。
// ウェブ版はサイトのパスワードの門の内側にあるので、門の Cookie は送る（credentials: same-origin）。アカウントの認証は Bearer のトークン。

import { platform } from "../platform/index.ts";
import { type Account, type AuthResponse, type CloudDoc, deriveLoginKey, type SaveResponse } from "../shared/online.ts";

export class ApiError extends Error {
  constructor(
    /** 0 = 通信できなかった */
    readonly status: number,
    readonly code: string,
    message: string,
    readonly body: Record<string, unknown> = {},
  ) {
    super(message);
  }
  get offline() {
    return this.status === 0;
  }
}

/** keepalive で送れる本文の大きさ（ブラウザの上限は 64KiB） */
const KEEPALIVE_MAX_BYTES = 60_000;

async function call<T>(method: string, path: string, opts: { token?: string | null; body?: unknown; timeoutMs?: number; keepalive?: boolean } = {}): Promise<T> {
  const headers: Record<string, string> = {};
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  if (opts.body !== undefined) headers["Content-Type"] = "application/json";
  const body = opts.body === undefined ? undefined : JSON.stringify(opts.body);
  const keepalive = !!opts.keepalive && !!body && new Blob([body]).size <= KEEPALIVE_MAX_BYTES;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), opts.timeoutMs ?? 12000);
  let res: Response;
  try {
    res = await fetch(platform.apiBase + path, { method, headers, body, signal: ctl.signal, cache: "no-store", credentials: "same-origin", ...(keepalive ? { keepalive } : {}) });
  } catch {
    throw new ApiError(0, "offline", "サーバーにつながらない");
  } finally {
    clearTimeout(timer);
  }
  if (res.status === 204) return undefined as T;
  // API の無いサーバー（Vite の開発サーバーなど）は HTML を返す。つながらないのと同じに扱う
  if (res.ok && !(res.headers.get("Content-Type") ?? "").includes("application/json")) throw new ApiError(0, "offline", "サーバーにつながらない（API が無い）");
  let json: Record<string, unknown> = {};
  try {
    json = (await res.json()) as Record<string, unknown>;
  } catch {
    /* 本文が JSON でない（門の 401 など） */
  }
  if (!res.ok) {
    const msg = typeof json.message === "string" ? json.message : `サーバーのエラー（${res.status}）`;
    throw new ApiError(res.status, typeof json.error === "string" ? json.error : "error", msg, json);
  }
  return json as T;
}

// パスワードはサーバーへ送らず、端末で作ったログイン鍵（deriveLoginKey）だけを送る
export const api = {
  register: async (loginId: string, password: string) => call<AuthResponse>("POST", "/api/auth/register", { body: { loginId, loginKey: await deriveLoginKey(loginId, password) } }),
  login: async (loginId: string, password: string) => call<AuthResponse>("POST", "/api/auth/login", { body: { loginId, loginKey: await deriveLoginKey(loginId, password) } }),
  logout: (token: string) => call<void>("POST", "/api/auth/logout", { token, timeoutMs: 5000 }),
  me: (token: string) => call<{ account: Account }>("GET", "/api/me", { token, timeoutMs: 6000 }),
  changePassword: async (token: string, loginId: string, current: string, next: string) =>
    call<AuthResponse>("POST", "/api/account/password", { token, body: { currentKey: await deriveLoginKey(loginId, current), nextKey: await deriveLoginKey(loginId, next) } }),
  deleteAccount: async (token: string, loginId: string, password: string) => call<void>("POST", "/api/account/delete", { token, body: { loginKey: await deriveLoginKey(loginId, password) } }),
  getSave: (token: string, have: number, timeoutMs?: number) => call<SaveResponse>("GET", `/api/save?have=${have}`, { token, timeoutMs }),
  putSave: (token: string, baseRev: number, data: CloudDoc, keepalive = false) => call<SaveResponse>("PUT", "/api/save", { token, body: { baseRev, data }, keepalive, timeoutMs: 20000 }),
};
