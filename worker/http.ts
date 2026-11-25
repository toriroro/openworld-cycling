// API の応答と本文の読み取り（keirin-3D の worker/http.ts を写して直した）。
// ウェブ版は同じオリジンから呼ぶので CORS は付けない。iOS アプリ（概要仕様 9.5 の 6）の時にオリジンを足す。

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly headers: Record<string, string> = {},
  ) {
    super(message);
  }
}

const BASE_HEADERS: Record<string, string> = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "X-Robots-Tag": "noindex",
};

export function json(body: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...BASE_HEADERS, "Content-Type": "application/json; charset=utf-8", ...extra } });
}

export function noContent(): Response {
  return new Response(null, { status: 204, headers: BASE_HEADERS });
}

export function errorResponse(e: HttpError): Response {
  return json({ error: e.code, message: e.message }, e.status, e.headers);
}

/**
 * JSON の本文を読む。Content-Type は application/json に限る（ほかのサイトのフォームから直接送れないように）。
 * 大きすぎる本文は読み切る前に断る。
 */
export async function readJson(req: Request, maxChars: number): Promise<Record<string, unknown>> {
  const ct = req.headers.get("Content-Type") ?? "";
  if (!/^application\/json\b/i.test(ct)) throw new HttpError(415, "bad_content_type", "Content-Type は application/json");
  const len = Number(req.headers.get("Content-Length") ?? "0");
  if (len > maxChars * 3) throw new HttpError(413, "too_large", "データが大きすぎる");
  const text = await req.text();
  if (text.length > maxChars) throw new HttpError(413, "too_large", "データが大きすぎる");
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    throw new HttpError(400, "bad_json", "データの形が正しくない");
  }
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new HttpError(400, "bad_json", "データの形が正しくない");
  return v as Record<string, unknown>;
}
