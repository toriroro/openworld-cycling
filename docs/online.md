# アカウントとセーブの同期（D6a）

配達の草案 23 章の D6a。keirin-3D の `docs/online.md` の方式を写して直した。
ユーザー ID とパスワードだけの最小のアカウントで、ログインは任意。ゲストのままなら今までどおり端末の中だけで遊べる。

```
端末（src/online/）──HTTPS + Bearer トークン──▶ Worker（worker/）──▶ D1（migrations/）
                     └ サイトのパスワードの門（worker/auth.ts）の Cookie も送る
```

- Durable Object は使わない（Worker と D1 だけ）。ほかのプロジェクトで Durable Object の込みの分を超えているため（2026-11-25 のユーザーの話）。
- API はサイトのパスワードの門の内側に置く（草案 23.10）。門を通っていない要求は、/api も 401 で中身に届かない。

| 場所 | 中身 |
|---|---|
| `worker/auth.ts` | サイトのパスワードの門。通った要求のうち `/api/*` を `api.ts` へ回す |
| `worker/api.ts` | `/api/*` の振り分け |
| `worker/account.ts` | 登録・ログイン・ログアウト・パスワードの変更・削除・セッション・試行の回数 |
| `worker/save.ts` | セーブの保存と読み込み（rev で食い違いを見つける） |
| `worker/crypto.ts` | ログイン鍵のハッシュ（HMAC＋ペッパー）とトークン |
| `worker/http.ts`・`worker/db.ts` | 応答と本文の読み取り、D1 の使う所だけの型 |
| `src/shared/online.ts` | 端末とサーバーで共通: ID・パスワードの決まり、ログイン鍵、API の形、セーブ一式の形 |
| `src/online/api.ts` | API の呼び出し（ここからだけ呼ぶ。接続先は `platform.apiBase`） |
| `src/online/account.ts` | ログインの状態とセーブの同期 |
| `src/ui/account-panel.ts` | アカウントの画面（起動画面とメニューの「アカウント」） |
| `migrations/0001_accounts.sql` | D1 の表 |
| `tests/online.test.ts`・`tests/d1-shim.ts` | 単体の検査（D1 は node:sqlite の写し） |
| `scripts/apitest.ts` | wrangler dev の D1 に流す API の検査 |
| `scripts/account-check.mjs` | 2 つの端末での画面の確認（`artifacts/online/d6a`） |

## API

| メソッド・道 | 中身 |
|---|---|
| `POST /api/auth/register` `{loginId, loginKey}` | 登録 → `{token, account}`（201） |
| `POST /api/auth/login` `{loginId, loginKey}` | ログイン → `{token, account}` |
| `POST /api/auth/logout` | この端末のログインを終える |
| `GET /api/me` | ログイン中のアカウント |
| `POST /api/account/password` `{currentKey, nextKey}` | パスワードの変更（ほかの端末はログアウト、この端末には新しいトークン） |
| `POST /api/account/delete` `{loginKey}` | アカウントとセーブを消す |
| `GET /api/save?have=<rev>` | セーブ。手元の rev が最新なら本文を省く |
| `PUT /api/save` `{baseRev, data}` | セーブ。サーバーの rev が baseRev と違えば 409 と最新のセーブ |

`account` は `{loginId, regNo, createdAt}`。内部の番号は外に出さない。

## 安全

- **パスワード**: 端末で `PBKDF2-HMAC-SHA256(パスワード, "openworld-cycling/login-key/v1:" + 小文字の ID, 600,000 回)` の「ログイン鍵」を作り、それだけを送る。サーバーは `HMAC-SHA256(ペッパー, 乱数の salt ‖ ログイン鍵)` を `v2$salt$hash` で持つ。パスワードは端末の外に出ない。
  - ペッパーは Worker の秘密 `PASSWORD_PEPPER`（32 文字以上）。無い・短い時はログインの窓口を 503 で止める。**一度決めたら変えない**（変えると誰もログインできなくなる）。
- **決まり**: ID は 4〜16 文字の半角英数字と `_`。パスワードは 8〜64 文字の半角英数字・記号で、ID を含む物・よくある物は使えない（端末で確かめる）。メールを持たないので、忘れたら戻せない。
- **セッション**: 32 バイトの乱数のトークン。D1 には SHA-256 だけを持つ。`Authorization: Bearer` で送る。最後に使ってから 60 日で切れる。1 人 10 端末まで。パスワードの変更でほかの端末はログアウト。
- **試行の回数**（`rate_limits`）: 同じ ID への間違い 10 回／15 分、同じ接続元のログイン 30 回／15 分、登録 20 回／時、本人の確認（変更・削除）の間違い 5 回／15 分。IP はハッシュにしてから使う。
- **ID の有無を悟らせない**: ログインの失敗は、無い ID でも同じ文言・同じ計算をする。
- **本文**: `application/json` だけ。大きさの上限は認証 2KB、セーブ 768KB（JSON の文字数）。セーブは形（版・世界の名前・中身が物であること）だけを確かめ、中身は読まない。端末は読み込む時に `parseSave` で確かめ直す。
- **割り切り**: 一人用の保存は端末で計算するので、書き換えは防げない。オンラインの世界（D6b）では所持金・経済をサーバーが持ち、この保存を持ち込まない（草案 23.5 の 54・55）。

## セーブの同期

- 同期するのは、世界ごとの一人用の保存（`save`・`save-hokkaido`）。トレーナーの走った記録の書き出し用の記録は送らない。
- ログインしている間、端末の保存の鍵の後ろに `@r<登録番号>` を付けて、ゲストの保存と分ける。
- 走っている間は 10 秒ごとに保存する（今までどおり）。送るのは書いてから 1.5 秒後、続けて遊んでいる間は 60 秒に 1 回まで。裏に回る時はすぐ送る（64KB までは keepalive）。送れない時は 30・60・120・300 秒と間を延ばして送り直す。保存した時刻だけが違う保存は送らない。
- サーバーの保存を手元に入れるのは、起動の時（ゲームが保存を読む前。8 秒で先へ進む）と、読み込み直す直前だけ。遊んでいる間に入れると、遊んでいる状態の保存で上書きしてしまうため。
  - 遊んでいる間にほかの端末で進んでいたら「ほかの端末で進んだ保存がある」とアカウントの画面を出し、「サーバーの保存で読み込み直す」で入れる。
  - 両方で進んでいたら「食い違っている」と出し、サーバーの保存で読み込み直すか、この端末の保存で上書きするかを選ぶ。
- 初めてログインした時、アカウントにも手元にも保存が無く、ゲストの保存があれば、移すか聞く（移したらゲストの方は消す）。
- ログインの期限が切れたら、アカウントの保存のまま手元で遊べる。ログインし直すと送る。「ゲストで遊ぶ」でゲストの保存に戻る。

D1 の書き込み: 1 人が走っている間、1 分に 1 行ほど。Workers Paid の込みの分（行の書き込みの数で数える）に対して小さい。

## 開発

```
npm run db:migrate:local        # ローカルの D1 に表を作る（.wrangler/ に置かれる）
node scripts/make-dev-vars.mjs  # .dev.vars に足りない秘密を乱数で足す（PASSWORD_PEPPER を含む）
npm run build                   # 画面の確認は dist を wrangler dev で配る
npx wrangler dev --port 8791    # .claude/launch.json の worker
npx tsx scripts/apitest.ts      # API の検査
node scripts/account-check.mjs  # 2 つの端末での画面の確認
```

Vite の開発サーバー（5180）には API が無い。ゲストのままなら今までどおり動く（ログインの画面は「サーバーにつながらない」になる）。

## 本番への初回の準備（まだしていない）

本番の D1 を作るまで、`wrangler.jsonc` の `database_id` は仮の値（すべて 0）で、`npm run deploy` は通らない見込み【未確認】。

1. `npx wrangler d1 create openworld-cycling` で出た `database_id` を `wrangler.jsonc` に書く。
2. `npm run db:migrate`（本番の D1 に表を作る）。
3. `npx wrangler secret put PASSWORD_PEPPER`（32 文字以上の乱数。一度決めたら変えない）。
4. `npm run deploy`。
