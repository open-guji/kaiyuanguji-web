/**
 * @jest-environment node
 */
import { d1Http } from '../d1-http.ssr';

describe('认证库网关适配（像 D1 绑定）', () => {
  const calls: { url: string; body: any; auth: string }[] = [];
  beforeEach(() => {
    calls.length = 0;
    (global as any).fetch = jest.fn(async (url: string, init: any) => {
      const body = JSON.parse(init.body);
      calls.push({ url, body, auth: init.headers.Authorization });
      if (body.exec) return { ok: true, status: 200, json: async () => ({ count: 2 }) };
      return { ok: true, status: 200, json: async () => ({ results: body.stmts.map((_: unknown, i: number) => ({ results: [{ n: i }], meta: { changes: 1 } })) }) };
    });
  });
  const db = d1Http({ base: 'https://w.example/', token: 'tok' });

  test('all／first／raw 走一条语句，带令牌', async () => {
    const r = await db.prepare('SELECT ?1').bind('x').all();
    expect(r.results).toEqual([{ n: 0 }]);
    expect(await db.prepare('SELECT ?1').bind('x').first()).toEqual({ n: 0 });
    expect(await db.prepare('SELECT ?1').raw()).toEqual([[0]]);
    expect(calls[0]).toEqual({ url: 'https://w.example/v1/auth/d1', body: { stmts: [{ sql: 'SELECT ?1', params: ['x'] }] }, auth: 'Bearer tok' });
  });
  test('batch 一次请求，run 返回 meta', async () => {
    const out = await db.batch([db.prepare('A').bind(1), db.prepare('B')]);
    expect(out).toHaveLength(2);
    expect(calls).toHaveLength(1);
    expect((await db.prepare('C').run()).meta.changes).toBe(1);
  });
  test('exec 走 exec；HTTP 错误抛出', async () => {
    expect(await db.exec('CREATE TABLE t (a)')).toEqual({ count: 2 });
    (global as any).fetch = jest.fn(async () => ({ ok: false, status: 403, json: async () => ({ message: 'no' }) }));
    await expect(db.prepare('X').all()).rejects.toThrow('auth-d1 403');
  });
});
