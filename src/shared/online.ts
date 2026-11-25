// アカウントとセーブの同期（配達の草案 23.3、D6a）で、端末とサーバー（worker/）が共有する決まりと形。
// keirin-3D の src/shared/online.ts を写して直した（期・選手の成績は持たない）。
// DOM・ブラウザ専用の API に依存しない（Workers と Node のテストでも動かす）。

// ---- ユーザー ID・パスワードの決まり ----

export const LOGIN_ID_MIN = 4;
export const LOGIN_ID_MAX = 16;
export const PASSWORD_MIN = 8;
export const PASSWORD_MAX = 64;
const LOGIN_ID_RE = /^[A-Za-z0-9_]+$/;
// 印字できる ASCII（空白を含む）。全角や絵文字は入力の差を生むので受け付けない
const PASSWORD_RE = /^[\x20-\x7e]+$/;
/** 使えない ID（運営・システムと紛らわしいもの）。小文字で比べる */
const RESERVED_IDS = ["admin", "administrator", "root", "system", "support", "guest", "official", "moderator", "staff", "test", "null", "undefined", "owc", "openworld"];
/** よく使われる弱いパスワード */
const WEAK_PASSWORDS = ["password", "password1", "12345678", "123456789", "1234567890", "11111111", "00000000", "qwertyui", "qwerty123", "abcd1234", "1q2w3e4r", "iloveyou", "asdfghjk", "aaaaaaaa", "abcdefgh", "passw0rd", "p@ssw0rd"];

/** 照合用の形（大文字と小文字を区別しない） */
export function normalizeLoginId(id: string): string {
  return id.trim().toLowerCase();
}

/** ユーザー ID の形を確かめる（問題が無ければ null、あれば理由） */
export function loginIdProblem(id: string): string | null {
  const t = id.trim();
  if (t.length < LOGIN_ID_MIN || t.length > LOGIN_ID_MAX) return `ユーザー ID は ${LOGIN_ID_MIN}〜${LOGIN_ID_MAX} 文字`;
  if (!LOGIN_ID_RE.test(t)) return "ユーザー ID に使えるのは半角英数字と _";
  if (RESERVED_IDS.includes(t.toLowerCase())) return "このユーザー ID は使えない";
  return null;
}

/** 新しいパスワードの強さを確かめる（問題が無ければ null） */
export function passwordProblem(pw: string, loginId: string): string | null {
  if (pw.length < PASSWORD_MIN) return `パスワードは ${PASSWORD_MIN} 文字以上`;
  if (pw.length > PASSWORD_MAX) return `パスワードは ${PASSWORD_MAX} 文字まで`;
  if (!PASSWORD_RE.test(pw)) return "パスワードに使えるのは半角の英数字・記号";
  const low = pw.toLowerCase();
  const id = normalizeLoginId(loginId);
  if (id && low.includes(id)) return "ユーザー ID を含むパスワードは使えない";
  if (WEAK_PASSWORDS.includes(low) || /^(.)\1+$/.test(pw)) return "推測されやすいパスワード";
  return null;
}

// ---- ログイン鍵（パスワードは端末の外に出さない） ----
// 重い計算（PBKDF2）は端末で行い、サーバーへは結果の「ログイン鍵」だけを送る。
// サーバーはログイン鍵に秘密の値（ペッパー）を混ぜた軽いハッシュを保存する（worker/crypto.ts）。
// 回数や方式を変える時は版（v1）を上げ、ログインの時に古い鍵で確かめてから新しい鍵に替える。

/** OWASP（2023）が PBKDF2-HMAC-SHA256 に勧める回数 */
export const LOGIN_KEY_ITERATIONS = 600_000;
const LOGIN_KEY_SALT = "openworld-cycling/login-key/v1:";
/** ログイン鍵の形（32 バイトの base64url = 43 文字） */
export const LOGIN_KEY_RE = /^[A-Za-z0-9_-]{43}$/;

export function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** ユーザー ID とパスワードからログイン鍵を作る（端末で。PC で 0.1 秒、スマホで 0.3〜1 秒ほど） */
export async function deriveLoginKey(loginId: string, password: string, iterations = LOGIN_KEY_ITERATIONS): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(password.normalize("NFC")), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: enc.encode(LOGIN_KEY_SALT + normalizeLoginId(loginId)), iterations }, key, 256);
  return b64url(new Uint8Array(bits));
}

// ---- API でやり取りする形 ----

export interface Account {
  loginId: string;
  /** 登録の通し番号（端末の保存をアカウントごとに分けるのに使う） */
  regNo: number;
  createdAt: number;
}

export interface AuthResponse {
  token: string;
  account: Account;
}

/** 同期する世界（world-choice.ts の WorldId と同じ） */
export const CLOUD_WORLDS = ["generated", "hokkaido"] as const;
export type CloudWorld = (typeof CLOUD_WORLDS)[number];

/**
 * サーバーに置くセーブ一式: 世界ごとの一人用の保存データ（src/shared/save.ts の SaveData）。
 * サーバーは中身を読まず、形と大きさだけを確かめる。端末は読む時に parseSave で確かめ直す。
 * 形を変える時は v を上げて両側で移す。
 */
export interface CloudDoc {
  v: 1;
  worlds: Partial<Record<CloudWorld, unknown>>;
}
export const CLOUD_DOC_VERSION = 1;
/** セーブ一式の上限（JSON の文字数）。経済の状態が約 30KB、走った道が走るほど増える */
export const MAX_DOC_CHARS = 768 * 1024;

export interface SaveResponse {
  /** 0 = まだ保存されていない */
  rev: number;
  updatedAt?: number;
  /** have=rev が最新なら省く */
  data?: CloudDoc;
}

/** セーブ一式の形を確かめる（サーバーと端末で同じ確かめ方）。だめなら null */
export function cleanCloudDoc(v: unknown): CloudDoc | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  if (o.v !== CLOUD_DOC_VERSION || !o.worlds || typeof o.worlds !== "object" || Array.isArray(o.worlds)) return null;
  const w = o.worlds as Record<string, unknown>;
  const worlds: CloudDoc["worlds"] = {};
  for (const k of Object.keys(w)) {
    if (!(CLOUD_WORLDS as readonly string[]).includes(k)) return null;
    const x = w[k];
    if (x === null) continue;
    if (typeof x !== "object" || Array.isArray(x)) return null;
    worlds[k as CloudWorld] = x;
  }
  return { v: CLOUD_DOC_VERSION, worlds };
}
