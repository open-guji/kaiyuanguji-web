/**
 * @jest-environment node
 *
 * GUJI-561：/api/charfix。校验（new_char 单字／组字式）、同来源覆盖、管理读按前缀、公开读被拒、限速（独立前缀）、专名意见。
 */

const g = globalThis as unknown as Record<string, unknown>;

const store = new Map<string, string>();
const listCalls: Array<{ prefix?: string; limit?: number; cursor?: string }> = [];
const kv = {
    async get(k: string) {
        const v = store.get(k);
        return v ? JSON.parse(v) : null;
    },
    async put(k: string, v: string) {
        store.set(k, v);
    },
    async list(opts: { prefix?: string; limit?: number; cursor?: string }) {
        listCalls.push(opts);
        const all = [...store.keys()].filter((k) => k.startsWith(opts.prefix || '')).sort();
        return { keys: all.slice(0, opts.limit || 256).map((key) => ({ key })), complete: true, cursor: '' };
    },
};

const fix = { book_id: 'd59f2870u874', volume: '002', text_version: '1.0.0', cell_id: '4:3:8a', old_char: '於', new_char: '于', basis: '宋本作于', aid: 'aid_abcdefgh1234' };
const ent = {
    kind: 'entity', book_id: 'd59f2870u874', volume: '002', entity_id: 'e01384', entity_version: '1.8.12',
    anchor: { start: '4:3:8', end: '4:3:9' }, text: '紀昀', note: '應作紀曉嵐', aid: 'aid_abcdefgh1234',
};

function post(body: unknown, ip: string | null = '1.2.3.4') {
    const request = new Request('https://x/api/charfix', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    if (ip !== null) (request as unknown as { eo: unknown }).eo = { clientIp: ip };
    return { request };
}
function get(qs: string, headers: Record<string, string> = {}) {
    return { request: new Request(`https://x/api/charfix?${qs}`, { headers }) };
}
const ADMIN = { Authorization: 'Bearer right' };
const keysOf = (p: string) => [...store.keys()].filter((k) => k.startsWith(p));
async function json(res: Response) {
    return JSON.parse(await res.text());
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let fn: any;
beforeAll(async () => {
    g.FEEDBACK_KV = kv;
    fn = await import('../../../../edge-functions/api/charfix.js');
});
beforeEach(() => { store.clear(); listCalls.length = 0; g.FEEDBACK_ADMIN_TOKEN = 'right'; });
afterEach(() => { delete g.FEEDBACK_ADMIN_TOKEN; });

describe('改字 POST', () => {
    it('写入 cf:<book>:<volume>:<text_version>:<cell_id>:<voter>，值不含 aid 与 IP，不带 mismatch', async () => {
        const res = await fn.onRequestPost(post(fix));
        expect(res.status).toBe(200);
        const keys = keysOf('cf:');
        expect(keys).toHaveLength(1);
        expect(keys[0]).toMatch(/^cf:d59f2870u874:002:1\.0\.0:4:3:8a:[0-9a-f]{16}$/);
        const rec = JSON.parse(store.get(keys[0])!);
        expect(rec).toMatchObject({ v: 1, kind: 'char', cell_id: '4:3:8a', old_char: '於', new_char: '于', basis: '宋本作于', entity_ids: [] });
        expect(rec).not.toHaveProperty('mismatch');
        expect(JSON.stringify(rec)).not.toContain('aid_abcdefgh1234');
        expect(JSON.stringify(rec)).not.toContain('1.2.3.4');
    });

    it('同来源对同一格再提：覆盖；换格或换来源：新增', async () => {
        await fn.onRequestPost(post(fix));
        await fn.onRequestPost(post({ ...fix, new_char: '乎' }));
        expect(keysOf('cf:')).toHaveLength(1);
        expect(JSON.parse(store.get(keysOf('cf:')[0])!).new_char).toBe('乎');
        await fn.onRequestPost(post({ ...fix, cell_id: '4:3:9' }));
        expect(keysOf('cf:')).toHaveLength(2);
        await fn.onRequestPost(post(fix, '5.6.7.8'));
        expect(keysOf('cf:')).toHaveLength(3);
    });

    it('new_char：单字（含扩展区）与 {{组字式}} 收，其余拒', async () => {
        for (const ok of ['于', '𠀀', '{{⿰虫斤}}', '{{虫+斤}}']) {
            const res = await fn.onRequestPost(post({ ...fix, cell_id: '1:1:1', new_char: ok }));
            expect(res.status).toBe(200);
        }
        for (const bad of ['', '于乎', ' ', '{{}}', '{{ 虫 }}', '{于}', '{{a}', 'ab', 5, null, '​', '{{' + 'x'.repeat(31) + '}}']) {
            const res = await fn.onRequestPost(post({ ...fix, new_char: bad }));
            expect(res.status).toBe(400);
        }
    });

    it('必填与格式：缺 book_id／volume／text_version／cell_id／new_char，或坐标非法都 400；建议字等于原字也拒', async () => {
        for (const k of ['book_id', 'volume', 'text_version', 'cell_id', 'new_char', 'aid']) {
            const b = { ...fix } as Record<string, unknown>;
            delete b[k];
            expect((await fn.onRequestPost(post(b))).status).toBe(400);
        }
        expect((await fn.onRequestPost(post({ ...fix, cell_id: '4:3' }))).status).toBe(400);
        expect((await fn.onRequestPost(post({ ...fix, cell_id: '4:3:8c' }))).status).toBe(400);
        expect((await fn.onRequestPost(post({ ...fix, new_char: fix.old_char }))).status).toBe(400);
        expect((await fn.onRequestPost(post({ ...fix, basis: 'x'.repeat(501) }))).status).toBe(400);
        expect((await fn.onRequestPost(post({ ...fix, kind: 'other' }))).status).toBe(400);
        expect(keysOf('cf:')).toHaveLength(0);
    });

    it('old_char 可缺；entity_ids 去重，非法则拒', async () => {
        const { old_char: _o, ...noOld } = fix;
        expect((await fn.onRequestPost(post(noOld))).status).toBe(200);
        const res = await fn.onRequestPost(post({ ...fix, cell_id: '2:2:2', entity_ids: ['e00001', 'e00001', 'e00002'] }));
        expect(res.status).toBe(200);
        const rec = JSON.parse(store.get(keysOf('cf:').find((k) => k.includes(':2:2:2:'))!)!);
        expect(rec.entity_ids).toEqual(['e00001', 'e00002']);
        expect((await fn.onRequestPost(post({ ...fix, entity_ids: ['hixhd'] }))).status).toBe(400);
    });

    it('限速：每 IP 每 10 分钟 30 次，第 31 次 429；不占精校的 cellreview 名额', async () => {
        for (let i = 0; i < 30; i++) expect((await fn.onRequestPost(post({ ...fix, cell_id: `1:1:${i + 1}` }))).status).toBe(200);
        const res = await fn.onRequestPost(post(fix));
        expect(res.status).toBe(429);
        expect(res.headers.get('Retry-After')).toBeTruthy();
        expect([...store.keys()].some((k) => k.startsWith('ratelimit:cf:'))).toBe(true);
        expect([...store.keys()].some((k) => k.startsWith('ratelimit:cr:'))).toBe(false);
    });
});

describe('专名意见 POST（kind=entity）', () => {
    it('写入 ce:<book>:<volume>:<entity_id>:<voter>，存 anchor／text／entity_version；target 单独一栏', async () => {
        const res = await fn.onRequestPost(post({ ...ent, target: { entity_id: 'hixhd3a1b2c' } }));
        expect(res.status).toBe(200);
        const keys = keysOf('ce:');
        expect(keys[0]).toMatch(/^ce:d59f2870u874:002:e01384:[0-9a-f]{16}$/);
        expect(JSON.parse(store.get(keys[0])!)).toMatchObject({
            kind: 'entity', entity_id: 'e01384', entity_version: '1.8.12', anchor: { start: '4:3:8', end: '4:3:9' },
            text: '紀昀', note: '應作紀曉嵐', target: { entity_id: 'hixhd3a1b2c' },
        });
        // 同来源再提覆盖
        await fn.onRequestPost(post({ ...ent, note: '改了' }));
        expect(keysOf('ce:')).toHaveLength(1);
    });

    it('缺 entity_id／anchor／text／note／entity_version 或格式不对 400', async () => {
        for (const k of ['entity_id', 'entity_version', 'anchor', 'text', 'note']) {
            const b = { ...ent } as Record<string, unknown>;
            delete b[k];
            expect((await fn.onRequestPost(post(b))).status).toBe(400);
        }
        expect((await fn.onRequestPost(post({ ...ent, entity_id: 'hixhd3a1b2c' }))).status).toBe(400);
        expect((await fn.onRequestPost(post({ ...ent, anchor: { start: 'x', end: '4:3:9' } }))).status).toBe(400);
        expect((await fn.onRequestPost(post({ ...ent, target: { entity_id: 'e01384!' } }))).status).toBe(400);
    });
});

describe('GET 管理读', () => {
    beforeEach(async () => {
        await fn.onRequestPost(post(fix));
        await fn.onRequestPost(post({ ...fix, volume: '003', cell_id: '1:1:1' }));
        await fn.onRequestPost(post({ ...fix, text_version: '1.0.1', cell_id: '1:1:2' }));
        await fn.onRequestPost(post(ent));
    });

    it('没凭证 401，错 token 401，不返回任何记录', async () => {
        const r1 = await fn.onRequestGet(get('book=d59f2870u874'));
        expect(r1.status).toBe(401);
        expect(await r1.text()).not.toContain('于');
        expect((await fn.onRequestGet(get('book=d59f2870u874', { Authorization: 'Bearer wrong' }))).status).toBe(401);
    });

    it('按 book／volume／text_version 前缀列，不全库 list；kind=entity 另列', async () => {
        const all = await json(await fn.onRequestGet(get('book=d59f2870u874', ADMIN)));
        expect(all.items).toHaveLength(3);
        expect(listCalls[0].prefix).toBe('cf:d59f2870u874:');
        const v2 = await json(await fn.onRequestGet(get('book=d59f2870u874&volume=002', ADMIN)));
        expect(v2.items).toHaveLength(2);
        const v2v = await json(await fn.onRequestGet(get('book=d59f2870u874&volume=002&text_version=1.0.0', ADMIN)));
        expect(v2v.items).toHaveLength(1);
        expect(listCalls[listCalls.length - 1].prefix).toBe('cf:d59f2870u874:002:1.0.0:');
        const es = await json(await fn.onRequestGet(get('book=d59f2870u874&kind=entity', ADMIN)));
        expect(es.items).toHaveLength(1);
        expect(es.items[0].entity_id).toBe('e01384');
    });

    it('book 必填；text_version 须与 volume 同用；kind 无效 400；响应不缓存', async () => {
        expect((await fn.onRequestGet(get('volume=002', ADMIN))).status).toBe(400);
        expect((await fn.onRequestGet(get('book=d59f2870u874&text_version=1.0.0', ADMIN))).status).toBe(400);
        expect((await fn.onRequestGet(get('book=d59f2870u874&kind=x', ADMIN))).status).toBe(400);
        const ok = await fn.onRequestGet(get('book=d59f2870u874', ADMIN));
        expect(ok.headers.get('Cache-Control')).toBe('no-store');
    });
});

describe('isNewChar', () => {
    it('导出供前端同口径校验', () => {
        expect(fn.isNewChar('于')).toBe(true);
        expect(fn.isNewChar('{{⿰虫斤}}')).toBe(true);
        expect(fn.isNewChar('于乎')).toBe(false);
    });
});

export {};
