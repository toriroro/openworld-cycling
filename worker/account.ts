// アカウント: 登録・ログイン・ログアウト・パスワードの変更・削除・セッションの確認（配達の草案 23.3、D6a）。
// keirin-3D の worker/auth.ts を写して直した（期・記念品・ほかの表は持たない）。
// サイトのパスワードの門（worker/auth.ts）を通った要求だけがここへ来る。

import { type Account, type AuthResponse, LOGIN_KEY_RE, loginIdProblem, normalizeLoginId } from "../src/shared/online.ts";
import type { ApiEnv } from "./api.ts";
import { burnLoginKeyCheck, hashLoginKey, newToken, sha256Hex, TOKEN_RE, verifyLoginKey } from "./crypto.ts";
import { HttpError, json, noContent, readJson } from "./http.ts";

const DAY = 24 * 60 * 60 * 1000;
/** 最後に使ってからこの期間でログインが切れる（使うたびに延びる） */
export const SESSION_TTL = 60 * DAY;
/** 1 人が同時にログインしておける端末の数（古い物から消える） */
export const MAX_SESSIONS = 10;
const AUTH_BODY_MAX = 2000;

/** 試行の回数の上限 */
export const LIMITS = {
  /** 同じ ID へのパスワードの間違い（通れば戻す） */
  loginFailById: { max: 10, windowMs: 15 * 60 * 1000 },
  /** 同じ接続元からのログイン */
  loginByIp: { max: 30, windowMs: 15 * 60 * 1000 },
  /** 同じ接続元からの登録（使われている ID の確認を含む） */
  registerByIp: { max: 20, windowMs: 60 * 60 * 1000 },
  /** ログイン中の本人の確認（パスワードの変更・削除）の間違い */
  reauthFail: { max: 5, windowMs: 15 * 60 * 1000 },
};

interface UserRow {
  id: number;
  login_id: string;
  reg_no: number;
  created_at: number;
  password_hash: string;
  status: string;
}

export interface AuthedUser {
  id: number;
  account: Account;
  tokenHash: string;
}

const accountOf = (u: Pick<UserRow, "login_id" | "reg_no" | "created_at">): Account => ({ loginId: u.login_id, regNo: u.reg_no, createdAt: u.created_at });

function pepperOf(env: ApiEnv): string {
  // ペッパーが無いまま登録を受けると、後から設定した時に誰もログインできなくなる。必ず止める
  if (!env.PASSWORD_PEPPER || env.PASSWORD_PEPPER.length < 32) throw new HttpError(503, "not_configured", "ログインを使えない（サーバーの設定が無い）");
  return env.PASSWORD_PEPPER;
}

/** 接続元（IP はそのまま残さずハッシュに） */
async function ipKey(req: Request): Promise<string> {
  const ip = req.headers.get("CF-Connecting-IP") ?? "local";
  return (await sha256Hex("ip:" + ip)).slice(0, 32);
}

// ---- 試行の回数 ----

async function rateCount(env: ApiEnv, key: string, now: number): Promise<number> {
  const r = await env.DB.prepare("SELECT count FROM rate_limits WHERE key = ?1 AND reset_at > ?2").bind(key, now).first<{ count: number }>();
  return r?.count ?? 0;
}

async function rateHit(env: ApiEnv, key: string, windowMs: number, now: number): Promise<number> {
  const r = await env.DB.prepare(
    `INSERT INTO rate_limits (key, count, reset_at) VALUES (?1, 1, ?2)
     ON CONFLICT(key) DO UPDATE SET
       count = CASE WHEN rate_limits.reset_at <= ?3 THEN 1 ELSE rate_limits.count + 1 END,
       reset_at = CASE WHEN rate_limits.reset_at <= ?3 THEN ?2 ELSE rate_limits.reset_at END
     RETURNING count`,
  )
    .bind(key, now + windowMs, now)
    .first<{ count: number }>();
  // ときどき期限の切れた行を消す
  if (Math.random() < 0.02) await env.DB.prepare("DELETE FROM rate_limits WHERE reset_at <= ?1").bind(now).run();
  return r?.count ?? 1;
}

async function rateClear(env: ApiEnv, key: string) {
  await env.DB.prepare("DELETE FROM rate_limits WHERE key = ?1").bind(key).run();
}

const tooMany = () => new HttpError(429, "rate_limited", "試行が多すぎる。15 分ほど待ってから", { "Retry-After": "900" });

// ---- セッション ----

async function createSession(env: ApiEnv, req: Request, userId: number, now: number): Promise<string> {
  const token = newToken();
  const ua = (req.headers.get("User-Agent") ?? "").slice(0, 120);
  await env.DB.batch([
    env.DB.prepare("INSERT INTO sessions (token_hash, user_id, created_at, expires_at, last_seen_at, user_agent) VALUES (?1, ?2, ?3, ?4, ?3, ?5)").bind(await sha256Hex(token), userId, now, now + SESSION_TTL, ua),
    // 期限の切れた物と、上限を超えた古い物を消す
    env.DB.prepare(
      `DELETE FROM sessions WHERE user_id = ?1 AND (expires_at <= ?2 OR token_hash NOT IN (
         SELECT token_hash FROM sessions WHERE user_id = ?1 ORDER BY last_seen_at DESC LIMIT ?3))`,
    ).bind(userId, now, MAX_SESSIONS),
  ]);
  return token;
}

/** Authorization: Bearer <token> を確かめる。無効なら 401 */
export async function requireUser(req: Request, env: ApiEnv, now: number): Promise<AuthedUser> {
  const m = /^Bearer (.+)$/.exec(req.headers.get("Authorization") ?? "");
  if (!m || !TOKEN_RE.test(m[1])) throw new HttpError(401, "unauthorized", "ログインしていない");
  const tokenHash = await sha256Hex(m[1]);
  const row = await env.DB.prepare(
    `SELECT u.id, u.login_id, u.reg_no, u.created_at, u.status, s.last_seen_at
     FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = ?1 AND s.expires_at > ?2`,
  )
    .bind(tokenHash, now)
    .first<UserRow & { last_seen_at: number }>();
  if (!row || row.status !== "active") throw new HttpError(401, "unauthorized", "ログインの期限が切れた");
  // 使うたびに期限を延ばす（書き込みは 1 日 1 回まで）
  if (now - row.last_seen_at > DAY) await env.DB.prepare("UPDATE sessions SET last_seen_at = ?2, expires_at = ?3 WHERE token_hash = ?1").bind(tokenHash, now, now + SESSION_TTL).run();
  return { id: row.id, account: accountOf(row), tokenHash };
}

const isKey = (v: unknown): v is string => typeof v === "string" && LOGIN_KEY_RE.test(v);

/** ログイン中の本人の確認（パスワードの変更・削除の前） */
async function reauth(env: ApiEnv, user: AuthedUser, loginKey: unknown, now: number) {
  const key = `reauth:${user.id}`;
  if ((await rateCount(env, key, now)) >= LIMITS.reauthFail.max) throw tooMany();
  const pepper = pepperOf(env);
  const row = await env.DB.prepare("SELECT password_hash FROM users WHERE id = ?1").bind(user.id).first<{ password_hash: string }>();
  if (!row || !isKey(loginKey) || !(await verifyLoginKey(loginKey, row.password_hash, pepper))) {
    await rateHit(env, key, LIMITS.reauthFail.windowMs, now);
    throw new HttpError(403, "wrong_password", "パスワードが違う");
  }
  await rateClear(env, key);
}

// ---- 窓口 ----

export async function register(req: Request, env: ApiEnv, now: number): Promise<Response> {
  const pepper = pepperOf(env);
  if ((await rateHit(env, `register:${await ipKey(req)}`, LIMITS.registerByIp.windowMs, now)) > LIMITS.registerByIp.max) throw tooMany();
  const body = await readJson(req, AUTH_BODY_MAX);
  const loginId = typeof body.loginId === "string" ? body.loginId.trim() : "";
  const idErr = loginIdProblem(loginId);
  if (idErr) throw new HttpError(400, "bad_login_id", idErr);
  // パスワードの強さは端末で確かめる（サーバーにはパスワードが届かない）
  if (!isKey(body.loginKey)) throw new HttpError(400, "bad_login_key", "パスワードの形が正しくない");
  const norm = normalizeLoginId(loginId);
  const taken = () => new HttpError(409, "login_id_taken", "このユーザー ID は使われている");
  if (await env.DB.prepare("SELECT 1 AS x FROM users WHERE login_id_norm = ?1").bind(norm).first()) throw taken();
  const hash = await hashLoginKey(body.loginKey, pepper);
  // 登録番号を進めるのと作るのを 1 つのトランザクションで（失敗すれば番号も進まない）
  let user: UserRow | null;
  try {
    const res = await env.DB.batch([
      env.DB.prepare("UPDATE counters SET value = value + 1 WHERE name = 'reg_no'"),
      env.DB.prepare(
        `INSERT INTO users (login_id, login_id_norm, reg_no, password_hash, created_at, updated_at, password_changed_at, last_login_at)
         SELECT ?1, ?2, value, ?3, ?4, ?4, ?4, ?4 FROM counters WHERE name = 'reg_no'
         RETURNING id, login_id, reg_no, created_at, password_hash, status`,
      ).bind(loginId, norm, hash, now),
    ]);
    user = (res[1].results?.[0] as unknown as UserRow | undefined) ?? null;
  } catch (e) {
    // 同じ時に同じ ID で登録された
    if (String(e).includes("UNIQUE")) throw taken();
    throw e;
  }
  if (!user) throw new HttpError(500, "internal", "登録できなかった");
  const token = await createSession(env, req, user.id, now);
  return json({ token, account: accountOf(user) } satisfies AuthResponse, 201);
}

export async function login(req: Request, env: ApiEnv, now: number): Promise<Response> {
  const pepper = pepperOf(env);
  if ((await rateHit(env, `login:${await ipKey(req)}`, LIMITS.loginByIp.windowMs, now)) > LIMITS.loginByIp.max) throw tooMany();
  const body = await readJson(req, AUTH_BODY_MAX);
  const loginId = typeof body.loginId === "string" ? body.loginId : "";
  const loginKey = body.loginKey;
  const fail = () => new HttpError(401, "bad_credentials", "ユーザー ID かパスワードが違う");
  if (!loginId.trim() || loginId.length > 64 || !isKey(loginKey)) throw fail();
  const norm = normalizeLoginId(loginId);
  const idKey = `loginfail:${await sha256Hex("id:" + norm)}`;
  if ((await rateCount(env, idKey, now)) >= LIMITS.loginFailById.max) throw tooMany();
  const user = await env.DB.prepare("SELECT id, login_id, reg_no, created_at, password_hash, status FROM users WHERE login_id_norm = ?1").bind(norm).first<UserRow>();
  if (!user) {
    await burnLoginKeyCheck(loginKey, pepper);
    await rateHit(env, idKey, LIMITS.loginFailById.windowMs, now);
    throw fail();
  }
  if (!(await verifyLoginKey(loginKey, user.password_hash, pepper)) || user.status !== "active") {
    await rateHit(env, idKey, LIMITS.loginFailById.windowMs, now);
    throw fail();
  }
  await rateClear(env, idKey);
  await env.DB.prepare("UPDATE users SET last_login_at = ?2 WHERE id = ?1").bind(user.id, now).run();
  const token = await createSession(env, req, user.id, now);
  return json({ token, account: accountOf(user) } satisfies AuthResponse);
}

export async function logout(req: Request, env: ApiEnv, now: number): Promise<Response> {
  const user = await requireUser(req, env, now);
  await env.DB.prepare("DELETE FROM sessions WHERE token_hash = ?1").bind(user.tokenHash).run();
  return noContent();
}

export async function me(req: Request, env: ApiEnv, now: number): Promise<Response> {
  const user = await requireUser(req, env, now);
  return json({ account: user.account });
}

/** パスワードの変更: ほかの端末のログインは切り、この端末には新しいトークンを渡す */
export async function changePassword(req: Request, env: ApiEnv, now: number): Promise<Response> {
  const user = await requireUser(req, env, now);
  const body = await readJson(req, AUTH_BODY_MAX);
  await reauth(env, user, body.currentKey, now);
  if (!isKey(body.nextKey)) throw new HttpError(400, "bad_login_key", "パスワードの形が正しくない");
  if (body.nextKey === body.currentKey) throw new HttpError(400, "same_password", "今と同じパスワード");
  const hash = await hashLoginKey(body.nextKey, pepperOf(env));
  await env.DB.batch([
    env.DB.prepare("UPDATE users SET password_hash = ?2, password_changed_at = ?3, updated_at = ?3 WHERE id = ?1").bind(user.id, hash, now),
    env.DB.prepare("DELETE FROM sessions WHERE user_id = ?1").bind(user.id),
  ]);
  const token = await createSession(env, req, user.id, now);
  return json({ token, account: user.account } satisfies AuthResponse);
}

/** アカウントの削除: ユーザーと、そのセーブ・セッションをすべて消す（App Store の要件） */
export async function deleteAccount(req: Request, env: ApiEnv, now: number): Promise<Response> {
  const user = await requireUser(req, env, now);
  const body = await readJson(req, AUTH_BODY_MAX);
  await reauth(env, user, body.loginKey, now);
  await env.DB.batch([
    env.DB.prepare("DELETE FROM saves WHERE user_id = ?1").bind(user.id),
    env.DB.prepare("DELETE FROM sessions WHERE user_id = ?1").bind(user.id),
    env.DB.prepare("DELETE FROM rate_limits WHERE key = ?1").bind(`reauth:${user.id}`),
    env.DB.prepare("DELETE FROM users WHERE id = ?1").bind(user.id),
  ]);
  return noContent();
}
