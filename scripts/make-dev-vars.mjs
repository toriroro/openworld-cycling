// ローカル確認用の .dev.vars を乱数で作る。値は画面に出さない。既にある時は何もしない。
import { randomBytes } from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";

const path = new URL("../.dev.vars", import.meta.url);
if (existsSync(path)) {
  console.log(".dev.vars は既にあります");
} else {
  const password = randomBytes(18).toString("base64url");
  const secret = randomBytes(32).toString("hex");
  writeFileSync(path, `SITE_PASSWORD=${password}\nSESSION_SECRET=${secret}\n`);
  console.log(".dev.vars を作りました");
}
