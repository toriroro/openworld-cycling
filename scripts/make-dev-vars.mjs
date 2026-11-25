// ローカル確認用の .dev.vars を乱数で作る。値は画面に出さない。既にある時は、足りない項目だけ足す。
// PASSWORD_PEPPER はアカウント（配達の草案 23.3、D6a）のログイン鍵のハッシュに混ぜる秘密。
import { randomBytes } from "node:crypto";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";

const path = new URL("../.dev.vars", import.meta.url);
const values = {
  SITE_PASSWORD: () => randomBytes(18).toString("base64url"),
  SESSION_SECRET: () => randomBytes(32).toString("hex"),
  PASSWORD_PEPPER: () => randomBytes(32).toString("hex"),
};
const have = existsSync(path) ? readFileSync(path, "utf8") : "";
const missing = Object.keys(values).filter((k) => !new RegExp(`^${k}=.+`, "m").test(have));
if (!missing.length) {
  console.log(".dev.vars は既にあります");
} else {
  const lines = missing.map((k) => `${k}=${values[k]()}\n`).join("");
  if (have) appendFileSync(path, (have.endsWith("\n") ? "" : "\n") + lines);
  else writeFileSync(path, lines);
  console.log(`.dev.vars に足しました: ${missing.join(", ")}`);
}
