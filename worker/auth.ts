// 公開サイトの入口。パスワードを知っている人にだけ静的ファイルを渡す。
//
// - パスワードの照合はこの Worker の中だけで行う。ブラウザへ送るコード（dist/）にパスワードは入らない。
// - 通った人には署名付きの Cookie を渡す。JavaScript から読めない（HttpOnly）。
// - 認証が通るまでは、ゲームの HTML・スクリプト・素材を一切返さない。
// - 秘密（SITE_PASSWORD・SESSION_SECRET）が無い時は誰も通さない。
//
// 型は DOM と共通の標準 API だけを使う（tests/ から Node でも動かすため）。
// 入口のモジュール（index.ts）はハンドラ以外を export できないので、中身はこのファイルに置く。

import { handleApi } from "./api.ts";
import type { D1Like } from "./db.ts";
import { loginPage, messagePage } from "./login-page.ts";

export interface RateLimiter {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

export interface Env {
  ASSETS: { fetch(request: Request): Promise<Response> };
  /** 遊ぶ人に伝えるパスワード。`wrangler secret put SITE_PASSWORD` で登録する。 */
  SITE_PASSWORD?: string;
  /** Cookie の署名に使う乱数。`wrangler secret put SESSION_SECRET` で登録する。 */
  SESSION_SECRET?: string;
  /** 同じ接続元からの試行の上限。 */
  LOGIN_LIMIT_IP?: RateLimiter;
  /** 全体の試行の上限（接続元を変えながらの総当たりを抑える）。 */
  LOGIN_LIMIT_ALL?: RateLimiter;
  /** アカウントとセーブ（配達の草案 23.3、D6a）。/api/* だけが使う */
  DB?: D1Like;
  /** ログイン鍵のハッシュに混ぜる秘密。`wrangler secret put PASSWORD_PEPPER` で登録する。一度決めたら変えない */
  PASSWORD_PEPPER?: string;
}

export const COOKIE_NAME = "__Host-owc";
export const LOGIN_PATH = "/__auth/login";
export const SESSION_SECONDS = 30 * 24 * 60 * 60;
export const MIN_PASSWORD_LENGTH = 12;
const MIN_SECRET_LENGTH = 32;
const MAX_PASSWORD_LENGTH = 200;
const MAX_BODY_BYTES = 4096;

const encoder = new TextEncoder();

async function hmac(secret: string, message: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(message)));
}

function toHex(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

/** 長さが同じ2つの列を、中身によらず同じ手数で比べる。 */
function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

function sameText(a: string, b: string): boolean {
  return sameBytes(encoder.encode(a), encoder.encode(b));
}

interface Secrets {
  password: string;
  secret: string;
}

function readSecrets(env: Env): Secrets | null {
  const password = env.SITE_PASSWORD ?? "";
  const secret = env.SESSION_SECRET ?? "";
  if (password.length < MIN_PASSWORD_LENGTH || secret.length < MIN_SECRET_LENGTH) return null;
  return { password, secret };
}

/** パスワードから作る札。Cookie の署名に混ぜるので、パスワードを変えると前の Cookie は無効になる。 */
function passwordTag(secret: string, password: string): Promise<Uint8Array> {
  return hmac(secret, `pw:${password}`);
}

async function signSession(s: Secrets, expires: number): Promise<string> {
  const tag = toHex(await passwordTag(s.secret, s.password));
  return toHex(await hmac(s.secret, `session:v1:${expires}:${tag}`));
}

export async function makeSessionCookie(s: Secrets, nowMs: number): Promise<string> {
  const expires = Math.floor(nowMs / 1000) + SESSION_SECONDS;
  const value = `v1.${expires}.${await signSession(s, expires)}`;
  return `${COOKIE_NAME}=${value}; Path=/; Max-Age=${SESSION_SECONDS}; HttpOnly; Secure; SameSite=Lax`;
}

function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get("Cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}

async function hasSession(request: Request, s: Secrets, nowMs: number): Promise<boolean> {
  const value = readCookie(request, COOKIE_NAME);
  if (!value || value.length > 200) return false;
  const parts = value.split(".");
  if (parts.length !== 3 || parts[0] !== "v1") return false;
  if (!/^[0-9]{1,12}$/.test(parts[1])) return false;
  const expires = Number(parts[1]);
  if (expires * 1000 <= nowMs) return false;
  return sameText(parts[2], await signSession(s, expires));
}

/** ログイン後の行き先。このサイトの中の道だけを通す。 */
function safeNext(raw: string | null): string {
  if (!raw || raw.length > 512) return "/";
  if (!raw.startsWith("/") || raw.startsWith("//") || raw.includes("\\")) return "/";
  if (raw.startsWith("/__auth/")) return "/";
  // 制御文字が入った行き先は使わない
  for (let i = 0; i < raw.length; i++) if (raw.charCodeAt(i) < 0x20) return "/";
  return raw;
}

const PAGE_HEADERS: Record<string, string> = {
  "Content-Type": "text/html; charset=utf-8",
  "Cache-Control": "no-store",
  "X-Robots-Tag": "noindex",
  "Referrer-Policy": "same-origin",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; img-src data:; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
};

function page(html: string, status: number, extra: Record<string, string> = {}): Response {
  return new Response(html, { status, headers: { ...PAGE_HEADERS, ...extra } });
}

function wantsHtml(request: Request): boolean {
  if (request.method !== "GET" && request.method !== "HEAD") return false;
  return (request.headers.get("Accept") ?? "").includes("text/html");
}

async function readForm(request: Request): Promise<URLSearchParams | null> {
  const type = request.headers.get("Content-Type") ?? "";
  if (!type.toLowerCase().startsWith("application/x-www-form-urlencoded")) return null;
  const declared = Number(request.headers.get("Content-Length") ?? "0");
  if (declared > MAX_BODY_BYTES) return null;
  const body = await request.text();
  if (body.length > MAX_BODY_BYTES) return null;
  return new URLSearchParams(body);
}

/**
 * ほかのサイトから送られた要求か。ブラウザが付ける Sec-Fetch-Site を先に見る。
 * Origin は設定によって "null" で届くことがあるので、Sec-Fetch-Site が無い時だけ使う。
 */
function isCrossSite(request: Request, url: URL): boolean {
  const site = request.headers.get("Sec-Fetch-Site");
  if (site !== null) return site !== "same-origin" && site !== "none";
  const origin = request.headers.get("Origin");
  return origin !== null && origin !== "null" && origin !== url.origin;
}

async function login(request: Request, env: Env, s: Secrets, url: URL, nowMs: number): Promise<Response> {
  if (request.method !== "POST") return new Response(null, { status: 303, headers: { Location: "/", "Cache-Control": "no-store" } });

  // ほかのサイトに置かれたフォームからの送信は受けない
  if (isCrossSite(request, url)) return page(messagePage("この送信元からは受け付けません"), 403);

  // 照合の前に回数を数える。上限を超えたら、正しいパスワードでも通さない。
  const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
  const checks = await Promise.all([
    env.LOGIN_LIMIT_IP ? env.LOGIN_LIMIT_IP.limit({ key: `ip:${ip}` }) : { success: true },
    env.LOGIN_LIMIT_ALL ? env.LOGIN_LIMIT_ALL.limit({ key: "all" }) : { success: true },
  ]);

  const form = await readForm(request);
  const next = safeNext(form?.get("next") ?? null);
  if (!checks.every((c) => c.success)) {
    return page(loginPage({ next, error: "試行が多すぎます。1 分待ってから入れ直してください" }), 429, { "Retry-After": "60" });
  }
  const given = form?.get("password") ?? "";
  if (!form || given.length === 0 || given.length > MAX_PASSWORD_LENGTH) {
    return page(loginPage({ next, error: "パスワードが違います" }), 401);
  }

  const [a, b] = await Promise.all([passwordTag(s.secret, given), passwordTag(s.secret, s.password)]);
  if (!sameBytes(a, b)) return page(loginPage({ next, error: "パスワードが違います" }), 401);

  return new Response(null, {
    status: 303,
    headers: { Location: next, "Set-Cookie": await makeSessionCookie(s, nowMs), "Cache-Control": "no-store" },
  });
}

export async function handle(request: Request, env: Env, nowMs: number): Promise<Response> {
  const s = readSecrets(env);
  if (!s) return page(messagePage("パスワードが設定されていないため、開けません"), 503);

  const url = new URL(request.url);
  if (url.pathname === LOGIN_PATH) return login(request, env, s, url, nowMs);

  if (await hasSession(request, s, nowMs)) {
    // API（D6a）も門の内側に置く（配達の草案 23.10）
    if (url.pathname.startsWith("/api/")) return handleApi(request, env, nowMs);
    return env.ASSETS.fetch(request);
  }

  if (wantsHtml(request)) return page(loginPage({ next: safeNext(url.pathname + url.search) }), 401);
  return new Response("認証が必要です", {
    status: 401,
    headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", "X-Robots-Tag": "noindex" },
  });
}
