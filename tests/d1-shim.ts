// テスト用の D1 の写し: node:sqlite（Node 22）の上に、worker/db.ts の D1Like の形を作る。
// 本物の D1 との違い（型の扱い・制限）は scripts/apitest.ts で wrangler dev の D1 に流して確かめる。

import { readFileSync } from "node:fs";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import type { D1Like, D1Prepared, D1Result } from "../worker/db.ts";

type Value = null | number | bigint | string | Uint8Array;

class Prepared implements D1Prepared {
  constructor(
    private db: DatabaseSync,
    private sql: string,
    private values: Value[] = [],
  ) {}
  bind(...values: unknown[]): D1Prepared {
    return new Prepared(this.db, this.sql, values.map((v) => (typeof v === "boolean" ? Number(v) : (v as Value))));
  }
  private stmt(): StatementSync {
    return this.db.prepare(this.sql);
  }
  private returnsRows() {
    return /^\s*(SELECT|WITH)\b/i.test(this.sql) || /\bRETURNING\b/i.test(this.sql);
  }
  exec(): D1Result {
    if (this.returnsRows()) {
      const rows = this.stmt().all(...this.values) as Record<string, unknown>[];
      return { results: rows.map((r) => ({ ...r })), meta: { changes: rows.length } };
    }
    const r = this.stmt().run(...this.values);
    return { results: [], meta: { changes: Number(r.changes) } };
  }
  async first<T>(): Promise<T | null> {
    return (this.exec().results[0] as T | undefined) ?? null;
  }
  async all<T>(): Promise<D1Result<T>> {
    return this.exec() as D1Result<T>;
  }
  async run(): Promise<D1Result> {
    return this.exec();
  }
}

export function memoryD1(migrations = ["migrations/0001_accounts.sql"]): D1Like {
  const db = new DatabaseSync(":memory:");
  for (const m of migrations) db.exec(readFileSync(m, "utf8"));
  return {
    prepare: (sql) => new Prepared(db, sql),
    async batch(list) {
      db.exec("BEGIN");
      try {
        const out = list.map((p) => (p as Prepared).exec());
        db.exec("COMMIT");
        return out;
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
    },
  };
}
