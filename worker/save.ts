// セーブの同期（端末をまたいだ引き継ぎ。配達の草案 23.3、D6a）。keirin-3D の worker/save.ts を写して直した。
// 中身（一人用の保存データ）は読まず、形と大きさだけを確かめて 1 行に置く。rev で後勝ちの上書きを防ぐ。

import { cleanCloudDoc, CLOUD_DOC_VERSION, MAX_DOC_CHARS, type SaveResponse } from "../src/shared/online.ts";
import { requireUser } from "./account.ts";
import type { ApiEnv } from "./api.ts";
import { HttpError, json, readJson } from "./http.ts";

/** GET /api/save?have=<rev>: 手元の rev が最新なら本文を省く */
export async function getSave(req: Request, env: ApiEnv, now: number): Promise<Response> {
  const user = await requireUser(req, env, now);
  const have = Number(new URL(req.url).searchParams.get("have") ?? "-1");
  const row = await env.DB.prepare("SELECT rev, updated_at FROM saves WHERE user_id = ?1").bind(user.id).first<{ rev: number; updated_at: number }>();
  if (!row) return json({ rev: 0 } satisfies SaveResponse);
  if (row.rev === have) return json({ rev: row.rev, updatedAt: row.updated_at } satisfies SaveResponse);
  const full = await env.DB.prepare("SELECT data FROM saves WHERE user_id = ?1").bind(user.id).first<{ data: string }>();
  return json({ rev: row.rev, updatedAt: row.updated_at, data: JSON.parse(full!.data) } satisfies SaveResponse);
}

/**
 * PUT /api/save { baseRev, data }
 * baseRev がサーバーの rev と同じ時だけ保存する（ほかの端末で先に進んでいたら 409 と最新のセーブを返す）。
 */
export async function putSave(req: Request, env: ApiEnv, now: number): Promise<Response> {
  const user = await requireUser(req, env, now);
  const body = await readJson(req, MAX_DOC_CHARS + 1000);
  const baseRev = body.baseRev;
  if (typeof baseRev !== "number" || !Number.isInteger(baseRev) || baseRev < 0) throw new HttpError(400, "bad_rev", "rev が正しくない");
  const doc = cleanCloudDoc(body.data);
  if (!doc) throw new HttpError(400, "bad_save", "セーブの形が正しくない");
  const data = JSON.stringify(doc);
  if (data.length > MAX_DOC_CHARS) throw new HttpError(413, "too_large", "セーブが大きすぎる");
  const rev = baseRev + 1;
  const res = await env.DB.prepare(
    `INSERT INTO saves (user_id, rev, doc_version, data, updated_at) VALUES (?1, ?2, ?3, ?4, ?5)
     ON CONFLICT(user_id) DO UPDATE SET rev = excluded.rev, doc_version = excluded.doc_version, data = excluded.data, updated_at = excluded.updated_at
     WHERE saves.rev = ?6`,
  )
    .bind(user.id, rev, CLOUD_DOC_VERSION, data, now, baseRev)
    .run();
  if (!res.meta.changes) {
    // ほかの端末が先に保存していた（または、まだ無いのに baseRev が 0 でない）
    const cur = await env.DB.prepare("SELECT rev, updated_at, data FROM saves WHERE user_id = ?1").bind(user.id).first<{ rev: number; updated_at: number; data: string }>();
    const conflict: SaveResponse = cur ? { rev: cur.rev, updatedAt: cur.updated_at, data: JSON.parse(cur.data) } : { rev: 0 };
    return json({ error: "conflict", message: "ほかの端末で先に保存されている", ...conflict }, 409);
  }
  return json({ rev, updatedAt: now } satisfies SaveResponse);
}
