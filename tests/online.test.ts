// アカウントとセーブの同期（配達の草案 23.3、D6a）: 決まり、ログイン鍵、/api の窓口（D1 は node:sqlite の写し）。
import { describe, expect, it } from "vitest";
import { cleanCloudDoc, deriveLoginKey, loginIdProblem, MAX_DOC_CHARS, passwordProblem } from "../src/shared/online.ts";
import { LIMITS, MAX_SESSIONS } from "../worker/account.ts";
import { handleApi } from "../worker/api.ts";
import { handle, type Env } from "../worker/auth.ts";
import { memoryD1 } from "./d1-shim.ts";

const ORIGIN = "https://example.test";
const PEPPER = "0123456789abcdef0123456789abcdef-pepper";
const NOW = 1_800_000_000_000;
// テストでは回数を減らして速くする（形は本番と同じ）
const key = (id: string, pw: string) => deriveLoginKey(id, pw, 1000);

function makeEnv() {
  return { DB: memoryD1(), PASSWORD_PEPPER: PEPPER };
}

async function call(env: ReturnType<typeof makeEnv>, method: string, path: string, opts: { token?: string; body?: unknown; ip?: string; now?: number } = {}) {
  const headers: Record<string, string> = {};
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  if (opts.body !== undefined) headers["Content-Type"] = "application/json";
  if (opts.ip) headers["CF-Connecting-IP"] = opts.ip;
  const res = await handleApi(new Request(ORIGIN + path, { method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) }), env, opts.now ?? NOW);
  const text = await res.text();
  return { status: res.status, body: (text ? JSON.parse(text) : {}) as Record<string, unknown> };
}

async function signUp(env: ReturnType<typeof makeEnv>, id = "rider_01", pw = "correct horse 9") {
  const r = await call(env, "POST", "/api/auth/register", { body: { loginId: id, loginKey: await key(id, pw) } });
  expect(r.status).toBe(201);
  return r.body as { token: string; account: { loginId: string; regNo: number } };
}

const doc = (money: number) => ({ v: 1, worlds: { hokkaido: { version: 1, work: { money } } } });

describe("決まり", () => {
  it("ユーザー ID とパスワードの形", () => {
    expect(loginIdProblem("ab")).not.toBeNull();
    expect(loginIdProblem("日本語の名前")).not.toBeNull();
    expect(loginIdProblem("admin")).not.toBeNull();
    expect(loginIdProblem("rider_01")).toBeNull();
    expect(passwordProblem("short", "rider_01")).not.toBeNull();
    expect(passwordProblem("my rider_01 pw", "rider_01")).not.toBeNull();
    expect(passwordProblem("password1", "rider_01")).not.toBeNull();
    expect(passwordProblem("correct horse 9", "rider_01")).toBeNull();
  });

  it("ログイン鍵は ID の大小文字によらず同じで、パスワードが違えば違う", async () => {
    const a = await key("Rider_01", "correct horse 9");
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(await key("rider_01", "correct horse 9")).toBe(a);
    expect(await key("rider_01", "correct horse 8")).not.toBe(a);
  });

  it("セーブ一式の形: 知らない世界・配列・版の違いは受けない", () => {
    expect(cleanCloudDoc(doc(5))).toEqual(doc(5));
    expect(cleanCloudDoc({ v: 1, worlds: { generated: null } })).toEqual({ v: 1, worlds: {} });
    expect(cleanCloudDoc({ v: 2, worlds: {} })).toBeNull();
    expect(cleanCloudDoc({ v: 1, worlds: { mars: {} } })).toBeNull();
    expect(cleanCloudDoc({ v: 1, worlds: { hokkaido: [] } })).toBeNull();
    expect(cleanCloudDoc([])).toBeNull();
  });
});

describe("/api", () => {
  it("登録 → me → ログアウトでトークンが使えなくなる。パスワードはサーバーに届かず、ハッシュだけが残る", async () => {
    const env = makeEnv();
    const { token, account } = await signUp(env);
    expect(account).toMatchObject({ loginId: "rider_01", regNo: 1 });
    expect((await call(env, "GET", "/api/me", { token })).body.account).toMatchObject({ loginId: "rider_01" });
    const row = await env.DB.prepare("SELECT password_hash FROM users").first<{ password_hash: string }>();
    expect(row!.password_hash).toMatch(/^v2\$/);
    const s = await env.DB.prepare("SELECT token_hash FROM sessions").first<{ token_hash: string }>();
    expect(s!.token_hash).not.toBe(token);
    expect((await call(env, "POST", "/api/auth/logout", { token })).status).toBe(204);
    expect((await call(env, "GET", "/api/me", { token })).status).toBe(401);
  });

  it("同じ ID（大小文字違いも）は登録できない。登録番号は通しで進む", async () => {
    const env = makeEnv();
    await signUp(env, "rider_01");
    const r = await call(env, "POST", "/api/auth/register", { body: { loginId: "RIDER_01", loginKey: await key("RIDER_01", "another pw 77") } });
    expect(r.status).toBe(409);
    expect((await signUp(env, "rider_02")).account.regNo).toBe(2);
  });

  it("ログイン: 正しい鍵で通り、違う鍵・無い ID は同じ答え。間違いが続くと止まる", async () => {
    const env = makeEnv();
    await signUp(env);
    const ok = await call(env, "POST", "/api/auth/login", { body: { loginId: "Rider_01", loginKey: await key("rider_01", "correct horse 9") } });
    expect(ok.status).toBe(200);
    const bad = await call(env, "POST", "/api/auth/login", { body: { loginId: "rider_01", loginKey: await key("rider_01", "wrong pw 1234") } });
    const none = await call(env, "POST", "/api/auth/login", { body: { loginId: "nobody_99", loginKey: await key("nobody_99", "wrong pw 1234") } });
    expect(bad.status).toBe(401);
    expect(none.status).toBe(401);
    expect(bad.body.message).toBe(none.body.message);
    const wrong = await key("rider_01", "wrong pw 1234");
    for (let i = 1; i < LIMITS.loginFailById.max; i++) await call(env, "POST", "/api/auth/login", { body: { loginId: "rider_01", loginKey: wrong }, ip: `10.0.0.${i}` });
    const locked = await call(env, "POST", "/api/auth/login", { body: { loginId: "rider_01", loginKey: await key("rider_01", "correct horse 9") }, ip: "10.0.1.1" });
    expect(locked.status).toBe(429);
  });

  it("ペッパーが無い・短い時は登録もログインも止める（D1 が無い時も）", async () => {
    const env = { DB: memoryD1(), PASSWORD_PEPPER: "short" };
    const r = await call(env, "POST", "/api/auth/register", { body: { loginId: "rider_01", loginKey: await key("rider_01", "correct horse 9") } });
    expect(r.status).toBe(503);
    const res = await handleApi(new Request(ORIGIN + "/api/me"), {}, NOW);
    expect(res.status).toBe(503);
  });

  it("ログインしている端末は 10 まで。古い物から切れる", async () => {
    const env = makeEnv();
    const first = (await signUp(env)).token;
    const k = await key("rider_01", "correct horse 9");
    for (let i = 0; i < MAX_SESSIONS; i++) await call(env, "POST", "/api/auth/login", { body: { loginId: "rider_01", loginKey: k }, ip: `10.0.0.${i}`, now: NOW + (i + 1) * 1000 });
    expect((await call(env, "GET", "/api/me", { token: first })).status).toBe(401);
  });

  it("セーブ: 保存 → 読む（同じ rev なら本文を省く）→ 古い rev の保存は 409 と最新を返す", async () => {
    const env = makeEnv();
    const { token } = await signUp(env);
    expect((await call(env, "GET", "/api/save?have=-1", { token })).body).toEqual({ rev: 0 });
    const p1 = await call(env, "PUT", "/api/save", { token, body: { baseRev: 0, data: doc(100) } });
    expect(p1.body.rev).toBe(1);
    expect((await call(env, "GET", "/api/save?have=-1", { token })).body.data).toEqual(doc(100));
    expect((await call(env, "GET", "/api/save?have=1", { token })).body.data).toBeUndefined();
    // 別の端末が rev 1 を元に保存した後、この端末が rev 0 を元に送る
    expect((await call(env, "PUT", "/api/save", { token, body: { baseRev: 1, data: doc(200) } })).body.rev).toBe(2);
    const c = await call(env, "PUT", "/api/save", { token, body: { baseRev: 1, data: doc(300) } });
    expect(c.status).toBe(409);
    expect(c.body).toMatchObject({ rev: 2, data: doc(200) });
  });

  it("セーブ: 形が違う・大きすぎる物は受けない。ほかのアカウントのセーブは見えない", async () => {
    const env = makeEnv();
    const a = await signUp(env, "rider_01");
    const b = await signUp(env, "rider_02");
    expect((await call(env, "PUT", "/api/save", { token: a.token, body: { baseRev: 0, data: { v: 1, worlds: { mars: {} } } } })).status).toBe(400);
    const big = { v: 1, worlds: { hokkaido: { pad: "x".repeat(MAX_DOC_CHARS) } } };
    expect((await call(env, "PUT", "/api/save", { token: a.token, body: { baseRev: 0, data: big } })).status).toBe(413);
    await call(env, "PUT", "/api/save", { token: a.token, body: { baseRev: 0, data: doc(1) } });
    expect((await call(env, "GET", "/api/save?have=-1", { token: b.token })).body).toEqual({ rev: 0 });
  });

  it("パスワードの変更でほかの端末は切れ、削除でセーブも消える", async () => {
    const env = makeEnv();
    const { token } = await signUp(env);
    const other = (await call(env, "POST", "/api/auth/login", { body: { loginId: "rider_01", loginKey: await key("rider_01", "correct horse 9") } })).body.token as string;
    await call(env, "PUT", "/api/save", { token, body: { baseRev: 0, data: doc(1) } });
    const wrong = await call(env, "POST", "/api/account/password", { token, body: { currentKey: await key("rider_01", "nope nope 1"), nextKey: await key("rider_01", "new horse 10") } });
    expect(wrong.status).toBe(403);
    const ch = await call(env, "POST", "/api/account/password", { token, body: { currentKey: await key("rider_01", "correct horse 9"), nextKey: await key("rider_01", "new horse 10") } });
    expect(ch.status).toBe(200);
    expect((await call(env, "GET", "/api/me", { token: other })).status).toBe(401);
    const t2 = ch.body.token as string;
    expect((await call(env, "POST", "/api/account/delete", { token: t2, body: { loginKey: await key("rider_01", "new horse 10") } })).status).toBe(204);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM saves").first()).toEqual({ n: 0 });
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM users").first()).toEqual({ n: 0 });
  });

  it("サイトのパスワードの門を通らない /api は 401（中身に届かない）", async () => {
    const env: Env = { ASSETS: { fetch: async () => new Response("asset") }, SITE_PASSWORD: "test-password-for-unit-tests", SESSION_SECRET: "0123456789abcdef0123456789abcdef0123456789abcdef", ...makeEnv() };
    const res = await handle(new Request(ORIGIN + "/api/me"), env, NOW);
    expect(res.status).toBe(401);
    expect(await res.text()).not.toContain("account");
  });
});
