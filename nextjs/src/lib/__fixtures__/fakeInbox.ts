/** 测试用假 D1 收件箱：把 global.fetch 接成 Worker /v1/web/inbox 的 POST／GET／DELETE（按 kind＋key、prefix、after、limit）。 */
export function installFakeInbox(g: Record<string, unknown>) {
    const rows = new Map<string, { kind: string; key: string; value: Record<string, unknown>; ts: number; seq: number }>();
    const store = new Map<string, string>(); // key → JSON(value)，便于测试直接看键
    const calls: Array<{ method: string; url: string }> = [];
    let seq = 0;
    const real = globalThis.fetch;
    const id = (k: string, key: string) => `${k}\u0000${key}`;
    const res = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
    const fake = async (input: unknown, init: RequestInit = {}) => {
        const url = new URL(String(input));
        const method = (init.method || 'GET').toUpperCase();
        calls.push({ method, url: String(input) });
        if (url.pathname !== '/v1/web/inbox') return res(404, {});
        if (method === 'POST') {
            const { items } = JSON.parse(String(init.body));
            for (const it of items) {
                rows.set(id(it.kind, it.key), { kind: it.kind, key: it.key, value: it.value, ts: it.ts || Date.now(), seq: ++seq });
                store.set(it.key, JSON.stringify(it.value));
            }
            return res(201, { written: items.length, seq_to: seq });
        }
        if (method === 'DELETE') {
            const k = url.searchParams.get('kind') || '';
            const key = url.searchParams.get('key') || '';
            const had = rows.delete(id(k, key));
            store.delete(key);
            return res(200, { deleted: had ? 1 : 0 });
        }
        const kind = url.searchParams.get('kind') || '';
        const prefix = url.searchParams.get('prefix') || '';
        const after = Number(url.searchParams.get('after') || '0');
        const limit = Number(url.searchParams.get('limit') || '200');
        const all = [...rows.values()].filter((r) => r.kind === kind && r.key.startsWith(prefix) && r.seq > after).sort((a, b) => a.seq - b.seq);
        const page = all.slice(0, limit);
        const more = all.length > limit;
        return res(200, { items: page, next: more ? page[page.length - 1].seq : null, hasMore: more });
    };
    return {
        store, rows, calls,
        install() { g.fetch = fake; g.WEB_INBOX_URL = 'https://w.example'; g.WEB_INBOX_TOKEN = 't'; },
        reset() { rows.clear(); store.clear(); calls.length = 0; seq = 0; },
        restore() { g.fetch = real; delete g.WEB_INBOX_URL; delete g.WEB_INBOX_TOKEN; },
    };
}
