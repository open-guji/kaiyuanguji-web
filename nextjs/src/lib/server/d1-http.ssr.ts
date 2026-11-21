// 经 Cloudflare REST API 访问 D1，对外长得像 Workers 里的 D1Database 绑定（prepare/bind/all/run/first/raw/batch/exec）。
// EdgeOne 函数没有 D1 的 Workers 绑定，这样 Better Auth 自带的 D1 支持（方言、内省、迁移）可以原样使用。
export type D1HttpConfig = { accountId: string; databaseId: string; apiToken: string };

type Meta = { changes?: number; last_row_id?: number; duration?: number; [k: string]: unknown };
type RawResult = { success?: boolean; results?: Record<string, unknown>[]; meta?: Meta };

async function post(cfg: D1HttpConfig, payload: unknown): Promise<RawResult[]> {
  const url = `https://api.cloudflare.com/client/v4/accounts/${cfg.accountId}/d1/database/${cfg.databaseId}/query`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${cfg.apiToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    cache: 'no-store',
  });
  const body = (await res.json().catch(() => null)) as { success?: boolean; errors?: { message: string }[]; result?: RawResult[] } | null;
  if (!res.ok || !body?.success) {
    throw new Error(`D1 ${res.status}: ${body?.errors?.map((e) => e.message).join('; ') || 'request failed'}`);
  }
  return body.result ?? [];
}

class Stmt {
  constructor(private cfg: D1HttpConfig, readonly sql: string, readonly params: unknown[] = []) {}
  bind(...params: unknown[]) { return new Stmt(this.cfg, this.sql, params); }
  async all() {
    const [r] = await post(this.cfg, { sql: this.sql, params: this.params });
    return { success: true, results: r?.results ?? [], meta: r?.meta ?? {} };
  }
  async run() { return this.all(); }
  async first(col?: string) {
    const { results } = await this.all();
    const row = results[0];
    if (!row) return null;
    return col ? row[col] ?? null : row;
  }
  async raw() {
    const { results } = await this.all();
    return results.map((r) => Object.values(r));
  }
}

export function d1Http(cfg: D1HttpConfig) {
  return {
    prepare: (sql: string) => new Stmt(cfg, sql),
    async batch(stmts: Stmt[]) {
      if (stmts.length === 0) return [];
      const out = await post(cfg, { batch: stmts.map((s) => ({ sql: s.sql, params: s.params })) });
      return out.map((r) => ({ success: true, results: r?.results ?? [], meta: r?.meta ?? {} }));
    },
    async exec(sql: string) {
      const out = await post(cfg, { sql, params: [] });
      return { count: out.length, duration: 0 };
    },
  };
}
