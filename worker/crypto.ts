// ログイン鍵のハッシュとトークン（keirin-3D の worker/crypto.ts を写した。Web Crypto だけなので Node のテストからも呼べる）。
//
// パスワードの重い計算（PBKDF2 600,000 回）は端末で済ませ、サーバーには「ログイン鍵」（32 バイト）だけが届く
// （src/shared/online.ts の deriveLoginKey）。保存するのは HMAC-SHA256(ペッパー, salt ‖ ログイン鍵)。
// ペッパーは Worker の秘密（PASSWORD_PEPPER）にだけ置くので、D1 だけが漏れても照合できない。保存の形は "v2$salt$hash"。

import { b64url } from "../src/shared/online.ts";

export { b64url };
const SALT_BYTES = 16;
const enc = new TextEncoder();

export function fromB64url(s: string): Uint8Array {
  const b = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4));
  const out = new Uint8Array(b.length);
  for (let i = 0; i < b.length; i++) out[i] = b.charCodeAt(i);
  return out;
}

export function randomBytes(n: number): Uint8Array {
  const a = new Uint8Array(n);
  crypto.getRandomValues(a);
  return a;
}

/** 中身によらず同じ手数で比べる */
export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i];
  return d === 0;
}

export async function sha256Hex(s: string): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(s)));
  return Array.from(d, (b) => b.toString(16).padStart(2, "0")).join("");
}

async function mac(pepper: string, salt: Uint8Array, loginKey: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", enc.encode(pepper), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const k = enc.encode(loginKey);
  const msg = new Uint8Array(salt.length + k.length);
  msg.set(salt);
  msg.set(k, salt.length);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, msg));
}

export async function hashLoginKey(loginKey: string, pepper: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  return `v2$${b64url(salt)}$${b64url(await mac(pepper, salt, loginKey))}`;
}

/** 保存の形が読めない時も false（例外にしない） */
export async function verifyLoginKey(loginKey: string, stored: string, pepper: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 3 || parts[0] !== "v2") return false;
  try {
    return timingSafeEqual(await mac(pepper, fromB64url(parts[1]), loginKey), fromB64url(parts[2]));
  } catch {
    return false;
  }
}

/** 無いユーザーでも同じ計算をする（ユーザー ID の有無を応答の時間で悟らせない） */
const DUMMY_STORED = `v2$${"A".repeat(22)}$${"A".repeat(43)}`;
export async function burnLoginKeyCheck(loginKey: string, pepper: string) {
  await verifyLoginKey(loginKey, DUMMY_STORED, pepper);
}

/** セッションのトークン（ヘッダーにそのまま載せられる 43 文字） */
export function newToken(): string {
  return b64url(randomBytes(32));
}
export const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
