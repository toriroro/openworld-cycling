// /api（アカウントとセーブ。配達の草案 23.3、D6a）を、wrangler dev の本物に近い D1 に流して確かめる。
// 先に: npm run db:migrate:local と、wrangler dev（.claude/launch.json の worker、ポート 8791）。.dev.vars の値を使う（画面に出さない）。
// npx tsx scripts/apitest.ts。毎回ちがうユーザー ID で登録し、最後に消す。

import { readFileSync } from "node:fs";
import { deriveLoginKey } from "../src/shared/online.ts";

const base = process.env.API_BASE || "http://127.0.0.1:8791";
const vars = Object.fromEntries(
  readFileSync(new URL("../.dev.vars", import.meta.url), "utf8")
    .split(/\r?\n/)
    .filter((l) => l.includes("="))
    .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
);

let failed = 0;
const check = (name: string, ok: boolean, detail: unknown = "") => {
  if (!ok) failed++;
  console.log(`${ok ? "ok  " : "NG  "} ${name}${ok ? "" : ` ${JSON.stringify(detail)}`}`);
};

// サイトのパスワードの門を通る
const gate = await fetch(`${base}/__auth/login`, {
  method: "POST",
  redirect: "manual",
  headers: { "Content-Type": "application/x-www-form-urlencoded", "Sec-Fetch-Site": "same-origin" },
  body: new URLSearchParams({ password: vars.SITE_PASSWORD, next: "/" }).toString(),
});
const cookie = (gate.headers.get("set-cookie") ?? "").split(";")[0];
check("門を通る", gate.status === 303 && cookie.startsWith("__Host-owc="), gate.status);

const noGate = await fetch(`${base}/api/me`);
check("門の Cookie が無い /api は 401", noGate.status === 401, noGate.status);

async function call(method: string, path: string, opts: { token?: string; body?: unknown } = {}) {
  const headers: Record<string, string> = { Cookie: cookie };
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  if (opts.body !== undefined) headers["Content-Type"] = "application/json";
  const res = await fetch(base + path, { method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) });
  const text = await res.text();
  let body: Record<string, unknown> = {};
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { text };
  }
  return { status: res.status, body };
}

const id = `t${Date.now().toString(36)}`.slice(0, 16);
const pw = "apitest horse 42";
const reg = await call("POST", "/api/auth/register", { body: { loginId: id, loginKey: await deriveLoginKey(id, pw) } });
check("登録", reg.status === 201 && typeof reg.body.token === "string", reg);
const token = reg.body.token as string;
check("同じ ID は 409", (await call("POST", "/api/auth/register", { body: { loginId: id.toUpperCase(), loginKey: await deriveLoginKey(id, pw) } })).status === 409);
const me = await call("GET", "/api/me", { token });
check("me", (me.body.account as { loginId?: string })?.loginId === id, me);

const doc = (n: number) => ({ v: 1, worlds: { hokkaido: { version: 1, odometer: n, work: { money: n } } } });
check("セーブはまだ無い", (await call("GET", "/api/save?have=-1", { token })).body.rev === 0);
const p1 = await call("PUT", "/api/save", { token, body: { baseRev: 0, data: doc(1) } });
check("保存 rev 1", p1.status === 200 && p1.body.rev === 1, p1);
const p2 = await call("PUT", "/api/save", { token, body: { baseRev: 1, data: doc(2) } });
check("保存 rev 2", p2.body.rev === 2, p2);
const c = await call("PUT", "/api/save", { token, body: { baseRev: 1, data: doc(3) } });
check("古い rev は 409 と最新", c.status === 409 && c.body.rev === 2 && JSON.stringify(c.body.data) === JSON.stringify(doc(2)), c);
check("同じ rev なら本文を省く", (await call("GET", "/api/save?have=2", { token })).body.data === undefined);

// 大きめの保存（走った道が多い時を見込んで 600KB）
const big = { v: 1, worlds: { hokkaido: { version: 1, ridden: { pad: "x".repeat(600_000) } } } };
const pb = await call("PUT", "/api/save", { token, body: { baseRev: 2, data: big } });
check("600KB の保存", pb.status === 200 && pb.body.rev === 3, { status: pb.status, body: pb.body.message });
const gb = await call("GET", "/api/save?have=-1", { token });
check("600KB を読み戻す", ((gb.body.data as typeof big)?.worlds.hokkaido.ridden.pad.length ?? 0) === 600_000);
const tooBig = { v: 1, worlds: { hokkaido: { pad: "x".repeat(800_000) } } };
check("800KB は 413", (await call("PUT", "/api/save", { token, body: { baseRev: 3, data: tooBig } })).status === 413);

const login = await call("POST", "/api/auth/login", { body: { loginId: id, loginKey: await deriveLoginKey(id, pw) } });
check("ログイン", login.status === 200, login);
check("違うパスワードは 401", (await call("POST", "/api/auth/login", { body: { loginId: id, loginKey: await deriveLoginKey(id, "wrong horse 1") } })).status === 401);
const del = await call("POST", "/api/account/delete", { token, body: { loginKey: await deriveLoginKey(id, pw) } });
check("削除", del.status === 204, del);
check("削除の後はログインできない", (await call("POST", "/api/auth/login", { body: { loginId: id, loginKey: await deriveLoginKey(id, pw) } })).status === 401);

console.log(failed ? `${failed} 件 NG` : "すべて ok");
process.exit(failed ? 1 : 0);
