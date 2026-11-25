// /api/* の振り分け（配達の草案 23.3・23.11、D6a）。サイトのパスワードの門（worker/auth.ts）を通った要求だけがここへ来る。
// Durable Object は使わない（Worker と D1 だけ。23 章、2026-11-25 のユーザーの考え）。

import { changePassword, deleteAccount, login, logout, me, register } from "./account.ts";
import type { D1Like } from "./db.ts";
import { errorResponse, HttpError, json } from "./http.ts";
import { getSave, putSave } from "./save.ts";

export interface ApiEnv {
  DB: D1Like;
  /** ログイン鍵のハッシュに混ぜる秘密（32 文字以上）。一度決めたら変えない（変えると誰もログインできなくなる） */
  PASSWORD_PEPPER?: string;
}

type Handler = (req: Request, env: ApiEnv, now: number) => Promise<Response>;

const ROUTES: Record<string, Handler> = {
  "POST /api/auth/register": register,
  "POST /api/auth/login": login,
  "POST /api/auth/logout": logout,
  "GET /api/me": me,
  "POST /api/account/password": changePassword,
  "POST /api/account/delete": deleteAccount,
  "GET /api/save": getSave,
  "PUT /api/save": putSave,
};

export async function handleApi(req: Request, env: { DB?: D1Like; PASSWORD_PEPPER?: string }, now: number): Promise<Response> {
  const path = new URL(req.url).pathname;
  const route = ROUTES[`${req.method} ${path}`];
  try {
    if (!route) throw new HttpError(404, "not_found", "無い窓口");
    if (!env.DB) throw new HttpError(503, "not_configured", "サーバーの設定が無い（D1）");
    return await route(req, { DB: env.DB, PASSWORD_PEPPER: env.PASSWORD_PEPPER }, now);
  } catch (e) {
    if (e instanceof HttpError) return errorResponse(e);
    console.error("api error", path, e);
    return json({ error: "internal", message: "サーバーのエラー" }, 500);
  }
}
