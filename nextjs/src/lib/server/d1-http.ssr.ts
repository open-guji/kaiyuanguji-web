// 经 Worker 网关（data.open-guji.com 的 /v1/auth/d1）访问认证库 openguji-auth，对外长得像 Workers 里的 D1Database 绑定
// （prepare/bind/all/run/first/raw/batch/exec），让 Better Auth 自带的 D1 支持（方言、内省、迁移）原样可用。
// 为什么不直连 Cloudflare REST：REST 按账号限速，还要发 D1 令牌；Worker 用绑定直连，令牌只是它的 auth 角色，只能碰这一个库。
export type D1GatewayConfig = { base: string; token: string };

type Meta = { changes?: number; last_row_id?: number; [k: string]: unknown };
type StmtResult = { results?: Record<string, unknown>[]; meta?: Meta };

async function post(cfg: D1GatewayConfig, payload: unknown): Promise<unknown> {
  const res = await fetch(`${cfg.base.replace(/\/+$/, '')}/v1/auth/d1`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${cfg.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    cache: 'no-store',
    signal: AbortSignal.timeout(8000),
  });
  const body = (await res.json().catch(() => null)) as { error?: string; message?: string } | null;
  if (!res.ok) throw new Error(`auth-d1 ${res.status}: ${body?.message || body?.error || 'request failed'}`);
  return body;
}
async function run(cfg: D1GatewayConfig, stmts: { sql: string; params: unknown[] }[]): Promise<StmtResult[]> {
  const out = (await post(cfg, { stmts })) as { results: StmtResult[] };
  return out.results;
}
const norm = (r: StmtResult | undefined) => ({ success: true, results: r?.results ?? [], meta: r?.meta ?? {} });

class Stmt {
  constructor(private cfg: D1GatewayConfig, readonly sql: string, readonly params: unknown[] = []) {}
  bind(...params: unknown[]) { return new Stmt(this.cfg, this.sql, params); }
  async all() { return norm((await run(this.cfg, [{ sql: this.sql, params: this.params }]))[0]); }
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

export function d1Http(cfg: D1GatewayConfig) {
  return {
    prepare: (sql: string) => new Stmt(cfg, sql),
    async batch(stmts: Stmt[]) {
      if (stmts.length === 0) return [];
      return (await run(cfg, stmts.map((s) => ({ sql: s.sql, params: s.params })))).map(norm);
    },
    async exec(sql: string) {
      return (await post(cfg, { exec: sql })) as { count: number };
    },
  };
}
