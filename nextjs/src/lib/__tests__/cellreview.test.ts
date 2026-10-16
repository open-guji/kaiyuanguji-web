/**
 * @jest-environment node
 *
 * GUJI-551：/api/cellreview。校验（枚举、char 必填、rev 必带）、同格同来源覆盖、按 rev 前缀管理读、公开读被拒、限速。
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
        const start = opts.cursor ? all.findIndex((k) => k > opts.cursor!) : 0;
        const slice = start < 0 ? [] : all.slice(start, start + (opts.limit || 256));
        const complete = start < 0 || start + slice.length >= all.length;
        return { keys: slice.map((key) => ({ key })), complete, cursor: complete ? '' : slice[slice.length - 1] };
    },
};

const REV = 'vol01-r1';
const base = { book: 'd59f2870u874', vol: 'vol01', a: '12:3:7', rev: REV, aid: 'aid_abcdefgh1234', shown: '於' };

function post(body: unknown, ip: string | null = '1.2.3.4') {
    const request = new Request('https://x/api/cellreview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    if (ip !== null) (request as unknown as { eo: unknown }).eo = { clientIp: ip };
    return { request };
}
function get(qs: string, headers: Record<string, string> = {}) {
    return { request: new Request(`https://x/api/cellreview?${qs}`, { headers }) };
}
const ADMIN = { Authorization: 'Bearer right' };
const crKeys = () => [...store.keys()].filter((k) => k.startsWith('cr:'));
async function json(res: Response) {
    return JSON.parse(await res.text());
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let fn: any;
beforeAll(async () => {
    g.FEEDBACK_KV = kv;
    fn = await import('../../../../edge-functions/api/cellreview.js');
});
beforeEach(() => { store.clear(); listCalls.length = 0; g.FEEDBACK_ADMIN_TOKEN = 'right'; });
afterEach(() => { delete g.FEEDBACK_ADMIN_TOKEN; });

describe('POST 校验', () => {
    it('choice=char 带单字：写入 cr:<rev>:<book>:<a>:<voter>，值不含 aid 与 IP', async () => {
        const res = await fn.onRequestPost(post({ ...base, choice: 'char', char: '于', note: ' 看图是于 ' }));
        expect(res.status).toBe(200);
        const keys = crKeys();
        expect(keys).toHaveLength(1);
        expect(keys[0]).toMatch(new RegExp(`^cr:${REV}:d59f2870u874:12:3:7:[0-9a-f]{16}$`));
        const rec = JSON.parse(store.get(keys[0])!);
        expect(rec).toMatchObject({ v: 1, rev: REV, a: '12:3:7', choice: 'char', char: '于', note: '看图是于', shown: '於' });
        expect(JSON.stringify(rec)).not.toContain('aid_abcdefgh1234');
        expect(JSON.stringify(rec)).not.toContain('1.2.3.4');
    });

    it('六档里除 char 外都不必带 char；none／unsure／jiazhu／main 带 char 被拒', async () => {
        for (const choice of ['none', 'unsure', 'cut', 'jiazhu', 'main']) {
            const ok = await fn.onRequestPost(post({ ...base, a: `1:1:${choice.length}`, choice }));
            expect(ok.status).toBe(200);
        }
        for (const choice of ['none', 'unsure', 'jiazhu', 'main']) {
            const bad = await fn.onRequestPost(post({ ...base, choice, char: '于' }));
            expect(bad.status).toBe(400);
        }
        const cut = await fn.onRequestPost(post({ ...base, a: '9:9:9', choice: 'cut', char: '于' }));
        expect(cut.status).toBe(200);
    });

    it('非法 choice（含 damaged）、缺 rev、char 缺失／不止一个字／空白、非法坐标均 400', async () => {
        const cases: Array<Record<string, unknown>> = [
            { choice: 'damaged' },
            { choice: 'char' },
            { choice: 'char', char: '于之' },
            { choice: 'char', char: ' ' },
            { choice: 'char', char: '于', rev: undefined },
            { choice: 'char', char: '于', rev: '../x' },
            { choice: 'char', char: '于', a: '12:3' },
            { choice: 'char', char: '于', a: '12:3:7:x' },
            { choice: 'char', char: '于', book: 'a/b' },
            { choice: 'char', char: '于', aid: 'x' },
            { choice: 'none', note: 'x'.repeat(501) },
        ];
        for (const c of cases) {
            const res = await fn.onRequestPost(post({ ...base, ...c }));
            expect(res.status).toBe(400);
        }
        expect(crKeys()).toHaveLength(0);
    });

    it('BMP 外的单字（𠮷）算一个字', async () => {
        const res = await fn.onRequestPost(post({ ...base, choice: 'char', char: '𠮷' }));
        expect(res.status).toBe(200);
    });

    it('坏 JSON 回 400', async () => {
        const request = new Request('https://x/api/cellreview', { method: 'POST', body: '{oops' });
        expect((await fn.onRequestPost({ request })).status).toBe(400);
    });
});

describe('同格同来源覆盖', () => {
    it('同 aid＋同 IP 重复提交只留一票（最后一次）；换 aid 才是另一票', async () => {
        await fn.onRequestPost(post({ ...base, choice: 'char', char: '于' }));
        await fn.onRequestPost(post({ ...base, choice: 'none' }));
        expect(crKeys()).toHaveLength(1);
        expect(JSON.parse(store.get(crKeys()[0])!).choice).toBe('none');
        await fn.onRequestPost(post({ ...base, aid: 'aid_another_0001', choice: 'unsure' }));
        expect(crKeys()).toHaveLength(2);
    });

    it('同一 aid 换 IP 是另一票（voter＝sha256(aid+ip)）', async () => {
        await fn.onRequestPost(post({ ...base, choice: 'none' }, '1.1.1.1'));
        await fn.onRequestPost(post({ ...base, choice: 'none' }, '2.2.2.2'));
        expect(crKeys()).toHaveLength(2);
    });

    it('不同书同 rev 同坐标互不覆盖', async () => {
        await fn.onRequestPost(post({ ...base, choice: 'none' }));
        await fn.onRequestPost(post({ ...base, book: 'd59f2hl0cmio', choice: 'none' }));
        expect(crKeys()).toHaveLength(2);
    });
});

describe('GET 只开管理读', () => {
    beforeEach(async () => {
        await fn.onRequestPost(post({ ...base, choice: 'char', char: '于' }));
        await fn.onRequestPost(post({ ...base, a: '12:3:8', choice: 'none' }));
        await fn.onRequestPost(post({ ...base, rev: 'vol02-r1', choice: 'none' }));
    });

    it('没凭证 401，错 token 401，不返回任何票', async () => {
        const r1 = await fn.onRequestGet(get(`rev=${REV}`));
        expect(r1.status).toBe(401);
        expect(await r1.text()).not.toContain('12:3:7');
        const r2 = await fn.onRequestGet(get(`rev=${REV}`, { Authorization: 'Bearer wrong' }));
        expect(r2.status).toBe(401);
    });

    it('没配管理 token 时 fail-closed 503', async () => {
        delete g.FEEDBACK_ADMIN_TOKEN;
        const res = await fn.onRequestGet(get(`rev=${REV}`, ADMIN));
        expect(res.status).toBe(503);
    });

    it('?token= 查询串不认', async () => {
        const res = await fn.onRequestGet(get(`rev=${REV}&token=right`));
        expect(res.status).toBe(401);
    });

    it('管理读按 rev 前缀导出，只列该 rev，且 list 带的是 cr:<rev>: 前缀（不全库扫）', async () => {
        const res = await fn.onRequestGet(get(`rev=${REV}`, ADMIN));
        expect(res.status).toBe(200);
        const body = await json(res);
        expect(body.items.map((i: { a: string }) => i.a).sort()).toEqual(['12:3:7', '12:3:8']);
        expect(body.hasMore).toBe(false);
        expect(listCalls.every((c) => c.prefix === `cr:${REV}:`)).toBe(true);
    });

    it('缺 rev 400；limit 翻页靠 cursor', async () => {
        expect((await fn.onRequestGet(get('', ADMIN))).status).toBe(400);
        const p1 = await json(await fn.onRequestGet(get(`rev=${REV}&limit=1`, ADMIN)));
        expect(p1.items).toHaveLength(1);
        expect(p1.hasMore).toBe(true);
        const p2 = await json(await fn.onRequestGet(get(`rev=${REV}&limit=1&cursor=${encodeURIComponent(p1.cursor)}`, ADMIN)));
        expect(p2.items).toHaveLength(1);
        expect(p2.items[0].a).not.toBe(p1.items[0].a);
    });
});

describe('限速', () => {
    it('同 IP 超过窗口上限回 429＋Retry-After；换 IP 不受影响；取不到 IP 不限速', async () => {
        for (let i = 0; i < 120; i += 1) {
            const res = await fn.onRequestPost(post({ ...base, a: `1:1:${i + 1}`, choice: 'none' }));
            expect(res.status).toBe(200);
        }
        const over = await fn.onRequestPost(post({ ...base, a: '2:2:2', choice: 'none' }));
        expect(over.status).toBe(429);
        expect(Number(over.headers.get('Retry-After'))).toBeGreaterThan(0);
        const other = await fn.onRequestPost(post({ ...base, a: '2:2:3', choice: 'none' }, '9.9.9.9'));
        expect(other.status).toBe(200);
        const noIp = await fn.onRequestPost(post({ ...base, a: '2:2:4', choice: 'none' }, null));
        expect(noIp.status).toBe(200);
    });

    it('限速计数的 key 不以 cr: 开头（不污染管理读）', async () => {
        await fn.onRequestPost(post({ ...base, choice: 'none' }));
        const rl = [...store.keys()].filter((k) => k.startsWith('ratelimit:cr:'));
        expect(rl).toHaveLength(1);
        expect(rl[0]).not.toContain('1.2.3.4');
    });
});

describe('OPTIONS', () => {
    it('204 且允许 GET／POST', () => {
        const res = fn.onRequestOptions({ request: new Request('https://x/api/cellreview', { method: 'OPTIONS', headers: { origin: 'https://kaiyuanguji.com' } }) });
        expect(res.status).toBe(204);
        expect(res.headers.get('Access-Control-Allow-Methods')).toContain('POST');
    });
});
