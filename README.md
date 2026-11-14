# openworld-cycling

ほぼ無限に続く世界を自転車で走るゲーム。今はウェブ版・一人用のモック（M1〜M4 完了）と、河川の生成（R1）まで。

- 全体の仕様: [docs/history/specs/2026-11-13-openworld-cycling-overview.md](docs/history/specs/2026-11-13-openworld-cycling-overview.md)
- モックの仕様: [docs/history/specs/2026-11-13-mock.md](docs/history/specs/2026-11-13-mock.md)
- 次の段階の草案: [河川](docs/history/specs/2026-11-13-rivers-draft.md)、[都市と交通](docs/history/specs/2026-11-13-urban-and-traffic-draft.md)

## 起動

Node.js 22。プロジェクトのパスに `~` を含む Windows では、Vite がファイルの配信を断ることがある（回避策はモック仕様 3.1）。

```bash
npm install
```

```bash
npm run dev
```

ブラウザで表示された URL を開く（Claude Code の設定 `.claude/launch.json` では http://localhost:5180/ ）。

本番ビルドで確かめる時:

```bash
npm run build
```

```bash
npm run preview
```

## 公開

試作の公開先: https://openworld-cycling.kaerukun-dev.workers.dev/ （Cloudflare Workers の静的ファイル配信。設定は `wrangler.jsonc`）

```bash
npm run deploy
```

本番ビルドをしてから `wrangler deploy` を実行する。先に `npx wrangler login` で Cloudflare にログインしておく。試作の間は `public/_headers` で検索エンジンに載せない指定を付けている。

### パスワード

公開先はパスワードを知っている人だけが開ける。照合は Worker（`worker/auth.ts`）の中で行い、通るまではゲームの HTML・スクリプト・素材を返さない。ブラウザへ送るコードにパスワードは入らない。

- パスワードを決める・変える（12 文字以上。入力は画面に出ない）:

  ```bash
  npx wrangler secret put SITE_PASSWORD
  ```

  変えると、それまでにログインした人は全員入れ直しになる。12 文字未満や未登録の時は誰も開けない。
- `SESSION_SECRET` は Cookie の署名に使う乱数（32 文字以上）。人に伝える物ではない。登録し直すと全員が入れ直しになる。
- ログインは 30 日間有効。試行は同じ接続元から 1 分に 5 回、全体で 1 分に 30 回まで（Cloudflare の拠点ごとの概数）。
- 版ごとの URL（`preview_urls`）は切ってある。入れると認証の無い古い版が開ける。
- ローカルで Worker ごと動かす時は `node scripts/make-dev-vars.mjs` で確認用の秘密（`.dev.vars`）を作り、`npm run build` の後に `npx wrangler dev` を実行する。

## 遊び方

起動すると最初の画面が出る。

| ボタン | 動き |
|---|---|
| 続きから | 前回やめた所から走る（保存がある時だけ出る） |
| はじめから | 記録（位置・総距離・走った区間・スタンプ）を消して起点の町 葛郷 から。記録がある時は 2 回押す。設定と装いは残る |
| 眺める | 自動で走り続け、視点が切り替わる |
| 操作 | 操作の一覧 |

### 操作

| 操作 | キーボード | タッチ |
|---|---|---|
| 漕ぐ | Space を押している間 | 右下の「漕ぐ」 |
| ブレーキ | Shift | 右下の「ブレーキ」 |
| 分岐を選ぶ | ← ↑ → | 上に出る候補を押す |
| U ターン（止まっている時） | ↓ | 右上の「Uターン」 |
| 左右に寄る | A・D | 左下の「左へ」「右へ」 |
| 後ろを見る | Q（左）・R（右） | — |
| 視点を変える | C | メニューの「視点」 |
| 視点を回す | 画面をドラッグ | 画面をドラッグ |
| 眺める（自動で走る） | V | メニューの「眺める」 |
| 地図 | M | 右下の小地図を押す |
| 一時停止 | P | メニューの「一時停止」 |

- **分岐**: 交差点の 150m 手前から候補（向き・行き先の地名・距離）が出る。選ばなければ直進に近い道へ進む。曲がる時は交差点の口から口まで曲線で走る
- **地図**: 世界地図を押すと行き先になり、分岐を経路に沿って自動で選ぶ。走った道は太く描く
- **喫茶店**: 店の前で止まると立ち寄りになり、スタンプが残る。メニューの「スタンプ帳」から、立ち寄った店を選んでそこから走れる
- **保存**: 10 秒ごと、タブを隠した時、閉じる時に端末に残す
- **メニュー**: 一時停止、視点、眺める、自転車と装い、スタンプ帳、地図、操作、タイトルへ。設定は 出力（漕ぐ時と眺める時の W）、視点、画質（標準・軽量）、時刻、音量、消音、眺める進路（未走行の道を優先・道なり）、眺める時の fps

## できていること

| 段階 | 内容 | まとめ |
|---|---|---|
| M1 世界生成と 2D 地図 | 高さ関数、景観（海岸・平野・山岳）、結節点、道路網（主要道・枝道、等級、勾配・曲線の制限、橋）、立ち寄り地点、地名。同じ種なら同じ世界 | [m1-summary](artifacts/m1-summary.md) |
| M2 3D の地形と道路 | 地形の 3 段階のタイル、道路（区画線・補修跡・砂利道・ガードレール・橋）、空と時刻、原点の置き直し、画質 2 段階 | [m2-summary](artifacts/m2-summary.md) |
| M3 走行 | 物理、手動と自動の入力元、分岐、行き先までの経路、視点 3 種、画面（横・縦・タッチ）、植生 | [m3-summary](artifacts/m3-summary.md) |
| M4 立ち寄り・眺める・保存 | 喫茶店とスタンプ、眺める乗り方、保存と続き、小地図と世界地図、音、町の建物 | [m4-summary](artifacts/m4-summary.md) |
| その後の直し | 交差点（重なる主要道の合流、隅切り、曲線で曲がる）、ライダーと自転車の作り直しとパーツの設定、木の見え方、建物の写真素材、起動画面 | [junctions](artifacts/junctions/summary.md) |
| R1 河川の生成 | 大きな川を高さ関数に組み込む、橋、河川敷の自転車道、2D 地図の川（3D の水面は R2） | [r1-summary](artifacts/r1-summary.md) |
| 見本の街区（途中） | 町の中心を街区にする（区画道路・路地・歩道・敷地・電柱・街路樹）。建物は北海道・東北の町を手本に 8 つの型（一軒家・古い家・アパート・マンション・商店・古い商店・テナントビル・貸店舗）。見た目だけで、生成器は変えていない | [都市と交通の草案 12章](docs/history/specs/2026-11-13-urban-and-traffic-draft.md)、[画面写真](artifacts/district/) |
| 農地 | 平野を田・畑・牧草地にする（区画と作物を地形の材質で描く、防風林、牧草ロール、道路沿いの作物の株）。見た目だけで、生成器は変えていない | [farm](artifacts/farm/summary.md) |

## 確かめていないこと

- スマホ・タブレットの実機、Safari、Firefox での動作・性能・発熱・電池。画面の大きさの確認はデスクトップの Chrome で画面の大きさを変えたもの
- 音は信号の大きさを測っただけで、耳で聞いて確かめていない
- 川の 3D（水面・河原・堤防の描画）は R2

## 開発用

| 入口 | 用途 |
|---|---|
| `map.html` | 2D 地図（移動・拡大、道路を選ぶと縦断図） |
| `garage.html` | 自転車とライダーの確認（開発サーバーだけ） |
| `/?mode=m2` | M2 の確認（道路に沿って自動で進むカメラ） |
| `/?notitle=1` | 起動画面を出さない |
| `/?fresh=1` | 保存を使わない |
| `/?x=…&z=…` | 場所を指定して始める（起動画面と保存は使わない） |
| `/?dev=1` | 本番ビルドでも計測用の `window.__dev` を置く（開発サーバーと自動操作のブラウザでは常に置く） |

検査と計測:

```bash
npm run typecheck
```

```bash
npm test
```

`scripts/` のブラウザでの確認（開発サーバーが動いている前提、Playwright と Chrome を使う）: `m3-check.mjs`（画面の重なりと描画量）、`m4-check.mjs`（続き・眺める・喫茶店・音）、`m4-hour.mjs`（1 時間の無操作走行）、`junction-shots.mjs`、`buildings-shots.mjs`、`r1-shots.mjs`、`district-shots.mjs`（街区）、`building-style-shots.mjs`（建物の型ごと）、`district-budget.mjs`（街区の描画量）、`farm-shots.mjs`（農地）。世界の検査: `npm run world:report`、`scripts/junction-report.ts`、`scripts/river-report.ts`、`scripts/district-report.ts`、`scripts/farm-report.ts`。

## ディレクトリ

```
src/shared/world/  世界生成（DOM・Three.js に依存しない。分岐に関わる計算に sin・cos・exp・pow を使わない）
src/sim/           走行（物理、道路網の上の移動、交差点の形、経路、眺める進路、走った区間）
src/render/        Three.js の描画（地形・道路・植生・建物・ライダー）
src/workers/       道路生成と地形タイルの Worker
src/platform/      端末の機能の窓口（保存・常時点灯・振動・外部リンク）
src/audio/         音（WebAudio）
src/ui/            画面の部品
tests/             Vitest
scripts/           世界の検査・ブラウザでの確認
artifacts/         確認のまとめ・画面写真・計測値
```

素材の出典と権利: [public/assets/LICENSES.txt](public/assets/LICENSES.txt)（Poly Haven・MakeHuman の CC0 など）。
