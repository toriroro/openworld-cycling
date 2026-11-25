// D1 のうち、この Worker が使う所だけの型。Cloudflare の型定義を入れずに済ませ、Node のテストでは node:sqlite の写し（tests/d1-shim.ts）を渡す。

export interface D1Result<T = Record<string, unknown>> {
  results: T[];
  meta: { changes: number };
}

export interface D1Prepared {
  bind(...values: unknown[]): D1Prepared;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<D1Result<T>>;
  run(): Promise<D1Result>;
}

export interface D1Like {
  prepare(sql: string): D1Prepared;
  /** まとめて 1 つのトランザクションで流す */
  batch(statements: D1Prepared[]): Promise<D1Result[]>;
}
