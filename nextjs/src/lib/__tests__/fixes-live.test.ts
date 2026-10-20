/**
 * @jest-environment node
 *
 * GUJI-597：/api/fixes 公开直读。刚写进 KV 的意见、表态、回复马上读到；形状与每日清单（fixes-sync 的 toPublicFix）一致；
 * 公开口径（voter 只给 6 位、联系方式脱敏、无 aid／IP）；只读本书本册；坏参数 400。
 */
const g = globalThis as unknown as Record<string, unknown>;
const store = new Map<string, string>();
const kv = {
    async get(k: string) { const v = store.get(k); return v ? JSON.parse(v) : null; },
    async put(k: string, v: string) { store.set(k, v); },
    async list(opts: { prefix?: string; limit?: number }) {
        const all = [...store.keys()].filter((k) => k.startsWith(opts.prefix || '')).sort();
        return { keys: all.slice(0, opts.limit || 256).map((key) => ({ key })), complete: true, cursor: '' };
    },
};
const get = (qs: string) => ({ request: new Request(`https://x/api/fixes?${qs}`) });
const put = (k: string, v: unknown) => store.set(k, JSON.stringify(v));
const V = 'a1b2c3d4e5f60718';
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let fn: any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let sync: any;
beforeAll(async () => {
    g.FEEDBACK_KV = kv;
    fn = await import('../../../../edge-functions/api/fixes.js');
    sync = await import('../../../scripts/lib/fixes-sync.mjs');
});
beforeEach(() => store.clear());

const span = { v: 1, kind: 'span', book_id: '96mid1ogzk', volume: '002', text_version: '1.0.1', start: '3:1:9', end: '3:1:9', sub: 'missing', old_text: '卷', new_text: '卷一', note: '联系 test@example.com', voter: V, ts: 1000 };
const char = { v: 1, kind: 'char', book_id: '96mid1ogzk', volume: '002', text_version: '1.0.1', cell_id: '2:3:4', old_char: '巡', new_char: '輅', basis: '原书如此', voter: V, ts: 500 };

describe('GET /api/fixes', () => {
    it('刚写的意见马上读到：按格位排序，形状同每日清单', async () => {
        put(`cs:96mid1ogzk:002:1.0.1:3:1:9-3:1:9:missing:${V}`, span);
        put(`cf:96mid1ogzk:002:1.0.1:2:3:4:${V}`, char);
        const res = await fn.onRequestGet(get('book=96mid1ogzk&volume=002'));
        expect(res.status).toBe(200);
        expect(res.headers.get('Cache-Control')).toBe('no-store');
        const body = JSON.parse(await res.text());
        expect(body.success).toBe(true);
        expect(body.volumes['002'].map((x: { at: string }) => x.at)).toEqual(['2:3:4', '3:1:9']);
        expect(body.volumes['002']).toEqual(JSON.parse(JSON.stringify([char, span].map(sync.toPublicFix))));
    });

    it('公开口径：voter 只给 6 位、正文脱敏、不出 aid／IP', async () => {
        put(`cs:96mid1ogzk:002:1.0.1:3:1:9-3:1:9:missing:${V}`, { ...span, aid: 'aid_secret', ip: '1.2.3.4' });
        const text = await (await fn.onRequestGet(get('book=96mid1ogzk&volume=002'))).text();
        expect(text).not.toContain(V);
        expect(text).not.toContain('test@example.com');
        expect(text).not.toContain('aid_secret');
        expect(text).not.toContain('1.2.3.4');
        expect(JSON.parse(text).volumes['002'][0].who).toBe(V.slice(0, 6));
    });

    it('讨论：表态计数、回复按时间，target 与意见对得上；回复也脱敏', async () => {
        put(`cs:96mid1ogzk:002:1.0.1:3:1:9-3:1:9:missing:${V}`, span);
        const target = sync.targetOf(span);
        put(`tv:96mid1ogzk:002:${target}:v1`, { book_id: '96mid1ogzk', volume: '002', target, stance: 'agree', voter: 'v1', ts: 1 });
        put(`tv:96mid1ogzk:002:${target}:v2`, { book_id: '96mid1ogzk', volume: '002', target, stance: 'disagree', voter: 'v2', ts: 2 });
        put(`tm:96mid1ogzk:002:${target}:b-v2`, { book_id: '96mid1ogzk', volume: '002', target, stance: 'reply', name: '乙', text: '再看 a@b.cn', voter: 'v2', ts: 20 });
        put(`tm:96mid1ogzk:002:${target}:a-v1`, { book_id: '96mid1ogzk', volume: '002', target, stance: 'reply', name: '甲', text: '原书作卷一', voter: 'v1', ts: 10 });
        const body = JSON.parse(await (await fn.onRequestGet(get('book=96mid1ogzk&volume=002'))).text());
        const th = body.threads['002'][target];
        expect(th).toMatchObject({ agree: 1, disagree: 1 });
        expect(th.replies.map((r: { name: string }) => r.name)).toEqual(['甲', '乙']);
        expect(JSON.stringify(th)).not.toContain('a@b.cn');
    });

    it('只读本书本册；没有意见给空清单', async () => {
        put(`cf:96mid1ogzk:003:1.0.1:2:3:4:${V}`, { ...char, volume: '003' });
        put(`cf:othr0000:002:1.0.1:2:3:4:${V}`, { ...char, book_id: 'othr0000' });
        const body = JSON.parse(await (await fn.onRequestGet(get('book=96mid1ogzk&volume=002'))).text());
        expect(body.volumes['002']).toEqual([]);
        expect(body.threads).toBeUndefined();
    });

    it('坏参数 400', async () => {
        for (const qs of ['volume=002', 'book=96mid1ogzk', 'book=BAD!&volume=002', 'book=96mid1ogzk&volume=a/b']) {
            expect((await fn.onRequestGet(get(qs))).status).toBe(400);
        }
    });
});
