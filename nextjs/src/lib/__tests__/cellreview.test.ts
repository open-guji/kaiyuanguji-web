/**
 * @jest-environment node
 *
 * GUJI-551：/api/cellreview。校验（枚举、char 必填、item 必带、rev 忽略）、同条目同来源覆盖、按条目管理读、旧 rev 票只读、公开读被拒、限速。
 */

const g = globalThis as unknown as Record<string, unknown>;

import { installFakeInbox } from '../__fixtures__/fakeInbox';

const inbox = installFakeInbox(g);
const store = inbox.store;
const inboxGets = () => inbox.calls.filter((c) => c.method === 'GET').map((c) => new URL(c.url));

const REV = 'vol01-r1'; // 旧票的批号：只用来造「历史旧票」，新提交不带也不认
const base = { book: 'd59f2870u874', vol: 'vol01', a: '12:3:7', aid: 'aid_abcdefgh1234', shown: '於' };
/** 格号 → 稳定的条目 id（测试里一格一个条目；显式给 item 的不动） */
const itemFor = (a: string) => `pi_${[...a].reduce((h, ch) => (h * 131 + ch.charCodeAt(0)) % 0xffffffffffff, 7).toString(16).padStart(12, '0')}`;
/** 造一条旧的按 rev 记的票（cr:<rev>:<book>:<a>:<voter>），只供 GET ?rev= 的只读测试 */
function seedLegacy(rev: string, a: string, extra: Record<string, unknown> = {}, voter = 'aaaaaaaaaaaaaaaa') {
    const key = `cr:${rev}:d59f2870u874:${a}:${voter}`;
    const value = { v: 1, book: 'd59f2870u874', vol: '001', a, rev, choice: 'none', voter, ts: Date.now(), ...extra };
    inbox.rows.set(`cellreview\u0000${key}`, { kind: 'cellreview', key, value, ts: value.ts as number, seq: inbox.rows.size + 1000 });
    store.set(key, JSON.stringify(value));
}

function post(body: unknown, ip: string | null = '1.2.3.4') {
    const b = body as Record<string, unknown>;
    const withItem = !('item' in b) && typeof b.a === 'string' ? { item: itemFor(b.a), ...b } : b;
    const request = new Request('https://x/api/cellreview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(withItem),
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
    fn = await import('../../../../edge-functions/api/cellreview.js');
});
beforeEach(() => { fn.resetMemRateLimit(); inbox.reset(); inbox.install(); g.FEEDBACK_ADMIN_TOKEN = 'right'; });
afterEach(() => { delete g.FEEDBACK_ADMIN_TOKEN; });
afterAll(() => inbox.restore());

describe('POST 校验', () => {
    it('choice=char 带单字：写入 cr:i:<book>:<item>:<voter>，值不含 aid 与 IP', async () => {
        const res = await fn.onRequestPost(post({ ...base, choice: 'char', char: '于', note: ' 看图是于 ' }));
        expect(res.status).toBe(200);
        const keys = crKeys();
        expect(keys).toHaveLength(1);
        expect(keys[0]).toMatch(new RegExp(`^cr:i:d59f2870u874:${itemFor('12:3:7')}:[0-9a-f]{16}$`));
        const rec = JSON.parse(store.get(keys[0])!);
        expect(rec).toMatchObject({ v: 1, item: itemFor('12:3:7'), a: '12:3:7', choice: 'char', char: '于', note: '看图是于', shown: '於' });
        expect(JSON.stringify(rec)).not.toContain('aid_abcdefgh1234');
        expect(JSON.stringify(rec)).not.toContain('1.2.3.4');
    });

    it('章号存三位：vol01／1／001 都存 001，别的章名原样（人裁事件规范 §9 O-4）', async () => {
        for (const [vol, want] of [['vol01', '001'], ['1', '001'], ['001', '001'], ['VOL12', '012'], ['juan-a', 'juan-a']]) {
            inbox.reset();
            const res = await fn.onRequestPost(post({ ...base, vol, choice: 'none' }));
            expect(res.status).toBe(200);
            expect(JSON.parse(store.get(crKeys()[0])!).vol).toBe(want);
        }
    });

    it('八档里除 char 外都不必带 char；也都能同时带一个字（用户 10-21：切分错了也先给字），带的字须恰好一个', async () => {
        for (const choice of ['none', 'unsure', 'cut', 'jiazhu', 'main', 'damaged']) {
            const ok = await fn.onRequestPost(post({ ...base, a: `1:1:${choice.length}`, choice }));
            expect(ok.status).toBe(200);
        }
        for (const choice of ['none', 'unsure', 'cut', 'jiazhu', 'main', 'damaged']) {
            const withChar = await fn.onRequestPost(post({ ...base, a: `2:1:${choice.length}`, choice, char: '于', pick_src: 'cand', pick_rank: 2 }));
            expect(withChar.status).toBe(200);
            const rec = JSON.parse(store.get(crKeys().find((k) => k.includes(itemFor(`2:1:${choice.length}`)))!)!);
            expect(rec).toMatchObject({ choice, char: '于', pick_src: 'cand', pick_rank: 2 });
            const bad = await fn.onRequestPost(post({ ...base, a: '3:1:1', choice, char: '于之' }));
            expect(bad.status).toBe(400);
        }
    });

    it('choice=unrec（认不出的字，char v0.5 unk）：不带字、可带 unk（trim、空不存）；带了 char 也丢掉；unk 太长或不是字符串 400', async () => {
        const ok = await fn.onRequestPost(post({ ...base, a: '77:9:15', choice: 'unrec', unk: ' 左王右旦 ', char: '旦', pick_src: 'cand' }));
        expect(ok.status).toBe(200);
        const rec = JSON.parse(store.get(crKeys()[0])!);
        expect(rec).toMatchObject({ choice: 'unrec', unk: '左王右旦', a: '77:9:15' });
        expect(rec.char).toBeUndefined();
        expect(rec.pick_src).toBeUndefined();
        expect((await fn.onRequestPost(post({ ...base, choice: 'unrec' }))).status).toBe(200);
        expect((await fn.onRequestPost(post({ ...base, choice: 'unrec', unk: 'x'.repeat(61) }))).status).toBe(400);
        expect((await fn.onRequestPost(post({ ...base, choice: 'unrec', unk: 5 }))).status).toBe(400);
    });

    it('choice=figure（是图形，不是字，GUJI-742）：不带字、可带 alt（trim、空不存）；带了 char 也丢掉；alt 太长或不是字符串 400', async () => {
        const ok = await fn.onRequestPost(post({ ...base, a: '148:2:14', choice: 'figure', alt: ' 左半圈连一实点 ', char: '于', pick_src: 'cand' }));
        expect(ok.status).toBe(200);
        const rec = JSON.parse(store.get(crKeys()[0])!);
        expect(rec).toMatchObject({ choice: 'figure', alt: '左半圈连一实点', a: '148:2:14' });
        expect(rec.char).toBeUndefined();
        expect(rec.pick_src).toBeUndefined();
        // 不带 alt／空 alt：照收，不存 alt 键
        inbox.reset();
        for (const alt of [undefined, '', '   ']) {
            expect((await fn.onRequestPost(post({ ...base, choice: 'figure', alt }))).status).toBe(200);
            expect(JSON.parse(store.get(crKeys()[0])!).alt).toBeUndefined();
        }
        // 不是 figure 的档带 alt 忽略
        inbox.reset();
        expect((await fn.onRequestPost(post({ ...base, choice: 'none', alt: 'x' }))).status).toBe(200);
        expect(JSON.parse(store.get(crKeys()[0])!).alt).toBeUndefined();
        expect((await fn.onRequestPost(post({ ...base, choice: 'figure', alt: 'x'.repeat(61) }))).status).toBe(400);
        expect((await fn.onRequestPost(post({ ...base, choice: 'figure', alt: 5 }))).status).toBe(400);
    });

    it('非法 choice、缺 item、char 缺失／不止一个字／空白、非法坐标均 400', async () => {
        const cases: Array<Record<string, unknown>> = [
            { choice: 'bogus' },
            { choice: 'char' },
            { choice: 'char', char: '于之' },
            { choice: 'char', char: ' ' },
            { choice: 'char', char: '于', item: undefined },
            { choice: 'char', char: '于', item: 'pi_zzz' },
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

    it('cands_by：点 cands 候选时原样存；带控制字符／超长 400；没带字的档不存', async () => {
        const by = 'cv0.9.12 a=… c=r5@… ctx=siku@bb25260d/w0.005 fuse=f1';
        const ok = await fn.onRequestPost(post({ ...base, choice: 'char', char: '弊', pick_src: 'cand', pick_rank: 2, cands_by: by }));
        expect(ok.status).toBe(200);
        const rec = JSON.parse(store.get(crKeys()[0])!);
        expect(rec).toMatchObject({ pick_src: 'cand', pick_rank: 2, cands_by: by });
        for (const bad of [{ cands_by: 'a\nb' }, { cands_by: 'x'.repeat(121) }, { cands_by: 5 }]) {
            const res = await fn.onRequestPost(post({ ...base, a: '2:2:2', choice: 'char', char: '于', pick_src: 'cand', ...bad }));
            expect(res.status).toBe(400);
        }
        await fn.onRequestPost(post({ ...base, a: '3:3:3', choice: 'none', pick_src: 'cand', pick_rank: 1, cands_by: by }));
        expect(JSON.parse(store.get(crKeys().find((k) => k.includes(itemFor('3:3:3')))!)!).cands_by).toBeUndefined();
    });

    it('选字来源 pick_src／pick_rank／pivot：合法的原样存；非法 400；没带字的档带了不存；不带照常收', async () => {
        const ok = await fn.onRequestPost(post({ ...base, choice: 'char', char: '弊', pick_src: 'alt', pick_rank: 3, pivot: '𡚁' }));
        expect(ok.status).toBe(200);
        const rec = JSON.parse(store.get(crKeys()[0])!);
        expect(rec).toMatchObject({ choice: 'char', char: '弊', pick_src: 'alt', pick_rank: 3, pivot: '𡚁' });
        for (const bad of [{ pick_src: 'zitools' }, { pick_src: 'alt', pick_rank: 0 }, { pick_src: 'alt', pick_rank: 1.5 }, { pick_src: 'alt', pick_rank: 100 }, { pick_src: 'alt', pivot: '弊病' }]) {
            const res = await fn.onRequestPost(post({ ...base, a: '2:2:2', choice: 'char', char: '于', ...bad }));
            expect(res.status).toBe(400);
        }
        await fn.onRequestPost(post({ ...base, a: '3:3:3', choice: 'none', pick_src: 'cand', pick_rank: 1 }));
        const none = JSON.parse(store.get(crKeys().find((k) => k.includes(itemFor('3:3:3')))!)!);
        expect(none.pick_src).toBeUndefined();
        expect(none.pick_rank).toBeUndefined();
        await fn.onRequestPost(post({ ...base, a: '4:4:4', choice: 'char', char: '于' }));
        const plain = JSON.parse(store.get(crKeys().find((k) => k.includes(itemFor('4:4:4')))!)!);
        expect(plain.pick_src).toBeUndefined();
    });

    it('零宽字符、控制符、全角空格不算字', async () => {
        for (const ch of ['\u200b', '\u200d', '\ufeff', '\u007f', '\u0085', '\u3000']) {
            const res = await fn.onRequestPost(post({ ...base, choice: 'char', char: ch }));
            expect(res.status).toBe(400);
        }
    });

    it('配了 CELLREVIEW_IP_KEY：记录带 iph（HMAC，不是明文／裸 sha256）：同 IP 换 aid 可事后去重', async () => {
        g.CELLREVIEW_IP_KEY = 'k1';
        try {
            await fn.onRequestPost(post({ ...base, choice: 'none' }));
            await fn.onRequestPost(post({ ...base, aid: 'aid_another_0001', choice: 'none' }));
            const recs = crKeys().map((k) => JSON.parse(store.get(k)!));
            expect(recs).toHaveLength(2);
            expect(recs[0].iph).toMatch(/^[0-9a-f]{16}$/);
            expect(recs[0].iph).toBe(recs[1].iph);
            expect(recs[0].voter).not.toBe(recs[1].voter);
            const { createHash } = await import('crypto');
            expect(recs[0].iph).not.toBe(createHash('sha256').update('1.2.3.4').digest('hex').slice(0, 16));
        } finally { delete g.CELLREVIEW_IP_KEY; }
    });

    it('没配 CELLREVIEW_IP_KEY：不存 iph，提交照常', async () => {
        const res = await fn.onRequestPost(post({ ...base, choice: 'none' }));
        expect(res.status).toBe(200);
        expect('iph' in JSON.parse(store.get(crKeys()[0])!)).toBe(false);
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

    it('不同书同条目 id 互不覆盖', async () => {
        await fn.onRequestPost(post({ ...base, choice: 'none' }));
        await fn.onRequestPost(post({ ...base, book: 'd59f2hl0cmio', choice: 'none' }));
        expect(crKeys()).toHaveLength(2);
    });
});

describe('GET 只开管理读（旧 rev 票只读）', () => {
    beforeEach(async () => {
        seedLegacy(REV, '12:3:7', { choice: 'char', char: '于' });
        seedLegacy(REV, '12:3:8');
        seedLegacy('vol02-r1', '12:3:7');
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

    it('旧票：管理读按 rev 前缀导出，只列该 rev，且读 D1 带的是 cr:<rev>: 前缀（不全库扫）', async () => {
        const res = await fn.onRequestGet(get(`rev=${REV}`, ADMIN));
        expect(res.status).toBe(200);
        expect(res.headers.get('Cache-Control')).toBe('no-store');
        const body = await json(res);
        expect(body.items.map((i: { a: string }) => i.a).sort()).toEqual(['12:3:7', '12:3:8']);
        expect(body.hasMore).toBe(false);
        expect(inboxGets().every((u) => u.searchParams.get('prefix') === `cr:${REV}:`)).toBe(true);
    });

    it('limit 超过 256 按 256 收', async () => {
        await fn.onRequestGet(get(`rev=${REV}&limit=500`, ADMIN));
        expect(inboxGets().pop()!.searchParams.get('limit')).toBe('256');
    });

    it('缺 rev 400（旧票读法）；limit 翻页靠 cursor', async () => {
        expect((await fn.onRequestGet(get('', ADMIN))).status).toBe(400);
        const p1 = await json(await fn.onRequestGet(get(`rev=${REV}&limit=1`, ADMIN)));
        expect(p1.items).toHaveLength(1);
        expect(p1.hasMore).toBe(true);
        const p2 = await json(await fn.onRequestGet(get(`rev=${REV}&limit=1&cursor=${encodeURIComponent(p1.cursor)}`, ADMIN)));
        expect(p2.items).toHaveLength(1);
        expect(p2.items[0].a).not.toBe(p1.items[0].a);
    });
});

describe('按条目记票（待审条目化）', () => {
    const ITEM = 'pi_0123456789ab';
    it('带 item／ver：key 是 cr:i:<book>:<item>:<voter>，记录带 item、ver；格号变了同一人覆盖同一票；旧页面带的 rev 忽略、不存', async () => {
        expect((await fn.onRequestPost(post({ ...base, rev: 'vol01-r1', item: ITEM, ver: 3, choice: 'char', char: '于' }))).status).toBe(200);
        expect((await fn.onRequestPost(post({ ...base, rev: 'vol01-r2', a: '12:3:9', item: ITEM, ver: 4, choice: 'none' }))).status).toBe(200);
        const keys = crKeys();
        expect(keys).toHaveLength(1);
        expect(keys[0]).toMatch(new RegExp(`^cr:i:d59f2870u874:${ITEM}:[0-9a-f]{16}$`));
        expect(JSON.parse(store.get(keys[0])!)).toMatchObject({ item: ITEM, ver: 4, choice: 'none', a: '12:3:9' });
        expect(JSON.parse(store.get(keys[0])!).rev).toBeUndefined();
    });
    it('坏 item／ver 400；不带 item 一律拒（不再有按 rev 记的路径）；a 可以不带', async () => {
        expect((await fn.onRequestPost(post({ ...base, item: 'pi_xyz', choice: 'none' }))).status).toBe(400);
        expect((await fn.onRequestPost(post({ ...base, item: ITEM, ver: 0, choice: 'none' }))).status).toBe(400);
        expect((await fn.onRequestPost(post({ ...base, item: undefined, choice: 'none' }))).status).toBe(400);
        expect((await fn.onRequestPost(post({ book: base.book, vol: base.vol, aid: base.aid, item: ITEM, choice: 'none' }))).status).toBe(200);
        expect(crKeys()[0]).toMatch(/^cr:i:/);
    });
    it('管理读 ?items=1&book= 按 cr:i:<book>: 前缀列；缺 book 400', async () => {
        await fn.onRequestPost(post({ ...base, item: ITEM, choice: 'none' }));
        seedLegacy(REV, '12:3:7');
        const body = await json(await fn.onRequestGet(get('items=1&book=d59f2870u874', ADMIN)));
        expect(body.items.map((i: { item: string }) => i.item)).toEqual([ITEM]);
        expect(inboxGets().pop()!.searchParams.get('prefix')).toBe('cr:i:d59f2870u874:');
        expect((await fn.onRequestGet(get('items=1', ADMIN))).status).toBe(400);
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

    it('提交只写 D1 一次，限速计数不进 D1', async () => {
        await fn.onRequestPost(post({ ...base, choice: 'none' }));
        expect(inbox.calls.filter((c) => c.method === 'POST')).toHaveLength(1);
        expect(crKeys()).toHaveLength(1);
        expect([...store.keys()].filter((k) => k.startsWith('ratelimit:cr:'))).toHaveLength(0);
    });
});

describe('OPTIONS', () => {
    it('204 且允许 GET／POST', () => {
        const res = fn.onRequestOptions({ request: new Request('https://x/api/cellreview', { method: 'OPTIONS', headers: { origin: 'https://kaiyuanguji.com' } }) });
        expect(res.status).toBe(204);
        expect(res.headers.get('Access-Control-Allow-Methods')).toContain('POST');
    });
});
