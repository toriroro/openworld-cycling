-- アカウントとセーブの同期（配達の草案 23.3、D6a）。keirin-3D の migrations/0001_accounts.sql を写して直した。
--
-- 方針
-- * 認証（users・sessions・rate_limits）と、遊びのデータ（saves）を分ける。
-- * 項目は ALTER TABLE ... ADD COLUMN（既定値つき）で足すだけにする。名前の変更・削除・型の変更はしない。
-- * 時刻はすべて UNIX ミリ秒（INTEGER）。

-- 通し番号（登録番号は、消したアカウントの分も使い直さない）
CREATE TABLE counters (
  name  TEXT PRIMARY KEY,
  value INTEGER NOT NULL
);
INSERT INTO counters (name, value) VALUES ('reg_no', 0);

-- 認証: ユーザー（内部の id は画面に出さない）
CREATE TABLE users (
  id                  INTEGER PRIMARY KEY,
  login_id            TEXT    NOT NULL,              -- 登録した時の表記（表示用）
  login_id_norm       TEXT    NOT NULL UNIQUE,       -- 小文字（重なりの確認・ログイン用）
  reg_no              INTEGER NOT NULL UNIQUE,       -- 登録番号（登録の順）
  password_hash       TEXT    NOT NULL,              -- "v2$salt$hash": 端末で作ったログイン鍵の HMAC（worker/crypto.ts）
  status              TEXT    NOT NULL DEFAULT 'active',
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL,
  password_changed_at INTEGER NOT NULL,
  last_login_at       INTEGER
);

-- 認証: ログイン中の端末。トークンそのものは持たず SHA-256 だけを持つ
CREATE TABLE sessions (
  token_hash   TEXT    PRIMARY KEY,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at   INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  user_agent   TEXT
);
CREATE INDEX sessions_user ON sessions(user_id);

-- 認証: 試行の回数（キーは「種類:対象」。IP はハッシュにしてから）
CREATE TABLE rate_limits (
  key      TEXT    PRIMARY KEY,
  count    INTEGER NOT NULL,
  reset_at INTEGER NOT NULL
);

-- 遊びのデータ: セーブ一式（src/shared/online.ts の CloudDoc）。rev で後勝ちの上書きを防ぐ
CREATE TABLE saves (
  user_id     INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  rev         INTEGER NOT NULL,
  doc_version INTEGER NOT NULL,
  data        TEXT    NOT NULL,
  updated_at  INTEGER NOT NULL
);
