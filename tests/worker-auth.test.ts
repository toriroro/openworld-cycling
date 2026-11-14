// 公開サイトの入口（worker/auth.ts）: パスワードを知らない人に何も渡さないこと。
import { describe, expect, it } from "vitest";
import { COOKIE_NAME, LOGIN_PATH, SESSION_SECONDS, handle, type Env } from "../worker/auth.ts";

const ORIGIN = "https://example.test";
const PASSWORD = "test-password-for-unit-tests";
const SECRET = "0123456789abcdef0123456789abcdef0123456789abcdef";
const NOW = 1_800_000_000_000;

function makeEnv(over: Partial<Env> = {}): Env & { served: string[] } {
  const served: string[] = [];
  return {
    served,
    ASSETS: {
      async fetch(request: Request) {
        served.push(new URL(request.url).pathname);
        return new Response("asset", { status: 200 });
      },
    },
    SITE_PASSWORD: PASSWORD,
    SESSION_SECRET: SECRET,
    ...over,
  };
}

function get(path: string, headers: Record<string, string> = {}): Request {
  return new Request(ORIGIN + path, { headers });
}

function post(fields: Record<string, string>, headers: Record<string, string> = {}): Request {
  return new Request(ORIGIN + LOGIN_PATH, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Origin: ORIGIN, ...headers },
    body: new URLSearchParams(fields).toString(),
  });
}

async function loginCookie(env: Env, now = NOW): Promise<string> {
  const res = await handle(post({ password: PASSWORD, next: "/" }), env, now);
  expect(res.status).toBe(303);
  const set = res.headers.get("Set-Cookie") ?? "";
  return set.split(";")[0];
}

describe("秘密が無い時", () => {
  it("パスワードが未登録なら誰も通さない", async () => {
    const env = makeEnv({ SITE_PASSWORD: undefined });
    const res = await handle(get("/", { Accept: "text/html" }), env, NOW);
    expect(res.status).toBe(503);
    expect(env.served).toEqual([]);
  });

  it("短いパスワードは未登録と同じに扱う", async () => {
    const env = makeEnv({ SITE_PASSWORD: "short" });
    expect((await handle(get("/"), env, NOW)).status).toBe(503);
    expect((await handle(post({ password: "short" }), env, NOW)).status).toBe(503);
    expect(env.served).toEqual([]);
  });

  it("署名用の秘密が無ければ誰も通さない", async () => {
    const env = makeEnv({ SESSION_SECRET: undefined });
    expect((await handle(post({ password: PASSWORD }), env, NOW)).status).toBe(503);
  });
});

describe("認証前", () => {
  it("ページを開くとパスワードの画面だけが返る", async () => {
    const env = makeEnv();
    const res = await handle(get("/map.html?x=1", { Accept: "text/html" }), env, NOW);
    expect(res.status).toBe(401);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    const html = await res.text();
    expect(html).toContain('name="password"');
    expect(html).toContain('value="/map.html?x=1"');
    expect(html).not.toContain(PASSWORD);
    expect(env.served).toEqual([]);
  });

  it("スクリプトや素材は返さない", async () => {
    const env = makeEnv();
    for (const path of ["/assets/main.js", "/assets/nature/tree_small_02.glb", "/index.html"]) {
      expect((await handle(get(path), env, NOW)).status).toBe(401);
    }
    expect(env.served).toEqual([]);
  });

  it("作り物・改ざんした Cookie では通らない", async () => {
    const env = makeEnv();
    const good = await loginCookie(env);
    const [name, value] = [good.slice(0, good.indexOf("=")), good.slice(good.indexOf("=") + 1)];
    const [v, exp, sig] = value.split(".");
    const flipped = sig.slice(0, -1) + (sig.endsWith("0") ? "1" : "0");
    const forged = [
      `${name}=${v}.${exp}.${flipped}`,
      `${name}=${v}.${Number(exp) + 1000}.${sig}`,
      `${name}=v1.9999999999.`,
      `${name}=`,
      `${name}=v1.abc.def`,
    ];
    for (const cookie of forged) {
      expect((await handle(get("/assets/main.js", { Cookie: cookie }), env, NOW)).status).toBe(401);
    }
    expect(env.served).toEqual([]);
  });
});

describe("ログイン", () => {
  it("違うパスワードでは Cookie を渡さない", async () => {
    const env = makeEnv();
    for (const password of ["", "wrong-password-123", PASSWORD + "x", PASSWORD.slice(0, -1), "x".repeat(500)]) {
      const res = await handle(post({ password }), env, NOW);
      expect(res.status).toBe(401);
      expect(res.headers.get("Set-Cookie")).toBeNull();
    }
  });

  it("正しいパスワードで Cookie を受け取り、ファイルを読める", async () => {
    const env = makeEnv();
    const res = await handle(post({ password: PASSWORD, next: "/map.html" }), env, NOW);
    expect(res.status).toBe(303);
    expect(res.headers.get("Location")).toBe("/map.html");
    const set = res.headers.get("Set-Cookie") ?? "";
    expect(set.startsWith(`${COOKIE_NAME}=`)).toBe(true);
    for (const attr of ["HttpOnly", "Secure", "SameSite=Lax", "Path=/", `Max-Age=${SESSION_SECONDS}`]) expect(set).toContain(attr);
    expect(set).not.toContain(PASSWORD);

    const cookie = set.split(";")[0];
    expect((await handle(get("/assets/main.js", { Cookie: `other=1; ${cookie}` }), env, NOW)).status).toBe(200);
    expect(env.served).toEqual(["/assets/main.js"]);
  });

  it("期限を過ぎた Cookie では通らない", async () => {
    const env = makeEnv();
    const cookie = await loginCookie(env);
    const before = NOW + (SESSION_SECONDS - 10) * 1000;
    const after = NOW + (SESSION_SECONDS + 10) * 1000;
    expect((await handle(get("/", { Cookie: cookie }), env, before)).status).toBe(200);
    expect((await handle(get("/", { Cookie: cookie }), env, after)).status).toBe(401);
  });

  it("パスワードを変えると前の Cookie は無効になる", async () => {
    const cookie = await loginCookie(makeEnv());
    const changed = makeEnv({ SITE_PASSWORD: "another-password-456" });
    expect((await handle(get("/", { Cookie: cookie }), changed, NOW)).status).toBe(401);
  });

  it("署名用の秘密を変えると前の Cookie は無効になる", async () => {
    const cookie = await loginCookie(makeEnv());
    const changed = makeEnv({ SESSION_SECRET: SECRET.split("").reverse().join("") });
    expect((await handle(get("/", { Cookie: cookie }), changed, NOW)).status).toBe(401);
  });

  it("行き先はこのサイトの中だけ", async () => {
    const env = makeEnv();
    for (const next of ["https://evil.example/", "//evil.example/", "/\\evil.example", "javascript:alert(1)", "/__auth/login", "/a\r\nSet-Cookie: x=1"]) {
      const res = await handle(post({ password: PASSWORD, next }), env, NOW);
      expect(res.headers.get("Location")).toBe("/");
    }
  });

  it("ほかのサイトからの送信は受けない", async () => {
    const cross: Record<string, string>[] = [
      { Origin: "https://evil.example" },
      { Origin: "https://evil.example", "Sec-Fetch-Site": "cross-site" },
      { Origin: "null", "Sec-Fetch-Site": "cross-site" },
      { Origin: ORIGIN, "Sec-Fetch-Site": "same-site" },
    ];
    for (const headers of cross) {
      const res = await handle(post({ password: PASSWORD }, headers), makeEnv(), NOW);
      expect(res.status).toBe(403);
      expect(res.headers.get("Set-Cookie")).toBeNull();
    }
  });

  it("同じサイトのフォームからの送信は、Origin が null で届いても受ける", async () => {
    const same: Record<string, string>[] = [
      { Origin: "null", "Sec-Fetch-Site": "same-origin" },
      { Origin: ORIGIN, "Sec-Fetch-Site": "same-origin" },
      { Origin: "null" },
    ];
    for (const headers of same) {
      const res = await handle(post({ password: PASSWORD }, headers), makeEnv(), NOW);
      expect(res.status).toBe(303);
    }
  });

  it("試行の上限を超えたら、正しいパスワードでも通さない", async () => {
    const keys: string[] = [];
    const blocked = { limit: async (o: { key: string }) => (keys.push(o.key), { success: false }) };
    const open = { limit: async (o: { key: string }) => (keys.push(o.key), { success: true }) };
    for (const env of [makeEnv({ LOGIN_LIMIT_IP: blocked, LOGIN_LIMIT_ALL: open }), makeEnv({ LOGIN_LIMIT_IP: open, LOGIN_LIMIT_ALL: blocked })]) {
      const res = await handle(post({ password: PASSWORD }, { "CF-Connecting-IP": "203.0.113.7" }), env, NOW);
      expect(res.status).toBe(429);
      expect(res.headers.get("Set-Cookie")).toBeNull();
    }
    expect(keys).toContain("ip:203.0.113.7");
    expect(keys).toContain("all");
  });

  it("入力した文字を画面にそのまま埋め込まない", async () => {
    const res = await handle(get('/"><script>alert(1)</script>', { Accept: "text/html" }), makeEnv(), NOW);
    expect(await res.text()).not.toContain("<script>");
  });
});
