/**
 * @jest-environment node
 *
 * #605 A 块步 2：category／assignee／claimedAt／routedIssue 的写入、白名单、公开读透出。
 */

const g = globalThis as unknown as Record<string, unknown>;
const store = new Map<string, string>();
const kv = {
    async get(k: string) {
        const v = store.get(k);
        return v ? JSON.parse(v) : null;
    },
    async put(k: string, v: string) {
        store.set(k, v);
    },
    async list(opts: { prefix?: string }) {
        const all = fbKeys().filter((k) => k.startsWith(opts.prefix || '')).sort();
        return { keys: all.map((key) => ({ key })), complete: true, cursor: '' };
    },
};
const fbKeys = () => [...store.keys()].filter((k) => k.startsWith('fb_'));
const ADMIN = { Authorization: 'Bearer right' };
const post = (body: unknown) => ({
    request: new Request('https://x/api/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    }),
    waitUntil: (p: Promise<unknown>) => p.catch(() => {}),
});
const patch = (id: string, body: unknown) => ({
    request: new Request(`https://x/api/feedback/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', ...ADMIN },
        body: JSON.stringify(body),
    }),
});
const list = (admin = false) => ({
    request: new Request('https://x/api/feedback?limit=50', { headers: admin ? ADMIN : {} }),
});
const json = async (res: Response) => JSON.parse(await res.text());
const update = (id: string, extra: Record<string, unknown>) =>
    fn.onRequestPost(post({ action: 'update', id, token: 'right', ...extra }));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let fn: any;
beforeAll(async () => {
    g.FEEDBACK_KV = kv;
    fn = await import('../../../../edge-functions/api/feedback.js');
});
beforeEach(() => {
    store.clear();
    delete g.__kygFeedbackListCache;
    g.FEEDBACK_ADMIN_TOKEN = 'right';
});
afterEach(() => { delete g.FEEDBACK_ADMIN_TOKEN; });

const stored = (id: string) => JSON.parse(store.get(id) as string);

describe('提交时写 category', () => {
    it('阅读页 bug → typo，且不带 assignee／claimedAt', async () => {
        await fn.onRequestPost(post({ type: 'bug', content: '错字', pageUrl: 'https://www.openguji.com/read/abc' }));
        const rec = stored(fbKeys()[0]);
        expect(rec.category).toBe('typo');
        expect(rec.assignee).toBeUndefined();
        expect(rec.claimedAt).toBeUndefined();
    });
    it('contact → join；resource → entry', async () => {
        await fn.onRequestPost(post({ type: 'contact', content: '想参与' }));
        await fn.onRequestPost(post({ type: 'resource', content: '某书', pageUrl: 'https://www.openguji.com/book-index' }));
        const cats = fbKeys().map((k) => stored(k).category).sort();
        expect(cats).toEqual(['entry', 'join']);
    });
    it('pageUrl 畸形也能提交成功（落 other）', async () => {
        const res = await fn.onRequestPost(post({ type: 'bug', content: 'x', pageUrl: 'http://[bad' }));
        expect(res.status).toBe(200);
        expect(stored(fbKeys()[0]).category).toBe('other');
    });
});

describe('认领：assignee／claimedAt', () => {
    let id: string;
    beforeEach(async () => {
        await fn.onRequestPost(post({ type: 'bug', content: '错字', pageUrl: 'https://www.openguji.com/read/abc' }));
        id = fbKeys()[0];
    });

    it('非法 assignee／category／routedIssue 一律 400，且不落库', async () => {
        for (const extra of [{ assignee: 'Tamsin' }, { category: 'nope' }, { routedIssue: 'overview#1' }, { routedIssue: 'a/b#x' }]) {
            const res = await update(id, extra);
            expect(res.status).toBe(400);
        }
        const res = await fn.onRequestPatch(patch(id, { assignee: 'nobody' }));
        expect(res.status).toBe(400);
        expect(stored(id).assignee).toBeUndefined();
    });

    it('首次认领写 claimedAt；换人不改；清空后两者都没了', async () => {
        expect((await update(id, { assignee: 'text' })).status).toBe(200);
        const t1 = stored(id).claimedAt;
        expect(stored(id).assignee).toBe('text');
        expect(typeof t1).toBe('string');

        await new Promise((r) => setTimeout(r, 5));
        await update(id, { assignee: 'catalog' });
        expect(stored(id).assignee).toBe('catalog');
        expect(stored(id).claimedAt).toBe(t1);

        await update(id, { assignee: '' });
        expect(stored(id).assignee).toBeUndefined();
        expect(stored(id).claimedAt).toBeUndefined();
    });

    it('PATCH 路径同样认领，且可改 category；claimedAt 不接受客户端传入', async () => {
        const res = await fn.onRequestPatch(patch(id, { assignee: 'web', category: 'site', claimedAt: '2000-01-01T00:00:00.000Z' }));
        expect(res.status).toBe(200);
        const rec = stored(id);
        expect(rec.assignee).toBe('web');
        expect(rec.category).toBe('site');
        expect(rec.claimedAt).not.toBe('2000-01-01T00:00:00.000Z');
    });

    it('routedIssue 合法值落库，空串清除', async () => {
        await update(id, { routedIssue: 'open-guji-core/overview#605' });
        expect(stored(id).routedIssue).toBe('open-guji-core/overview#605');
        await update(id, { routedIssue: '' });
        expect(stored(id).routedIssue).toBeUndefined();
    });
});

describe('公开读透出', () => {
    it('带 category／assignee／claimedAt，不带 routedIssue／contact；管理读原样', async () => {
        await fn.onRequestPost(post({ type: 'bug', content: '错字', pageUrl: 'https://www.openguji.com/read/abc', contact: 'a@b.cc' }));
        const id = fbKeys()[0];
        await update(id, { assignee: 'text', routedIssue: 'open-guji-core/overview#605' });
        const pub = (await json(await fn.onRequestGet(list()))).items[0];
        expect(pub.category).toBe('typo');
        expect(pub.assignee).toBe('text');
        expect(typeof pub.claimedAt).toBe('string');
        expect(pub).not.toHaveProperty('routedIssue');
        expect(pub).not.toHaveProperty('contact');
        const full = (await json(await fn.onRequestGet(list(true)))).items[0];
        expect(full.routedIssue).toBe('open-guji-core/overview#605');
    });

    it('contact 类型仍不公开，即便已认领', async () => {
        await fn.onRequestPost(post({ type: 'contact', content: '想参与' }));
        await update(fbKeys()[0], { assignee: 'owner' });
        expect((await json(await fn.onRequestGet(list()))).items).toHaveLength(0);
    });

    it('旧记录（无 category）读时按 type 推，不抛、不回写', async () => {
        const old = { id: 'fb_1_old', type: 'bug', content: '旧', pageUrl: '', resourceId: '', createdAt: '2026-10-01T00:00:00.000Z', status: 'pending', reply: '' };
        store.set(old.id, JSON.stringify(old));
        store.set('fb_2_old2', JSON.stringify({ ...old, id: 'fb_2_old2', type: 'resource' }));
        const items = (await json(await fn.onRequestGet(list()))).items;
        expect(items.map((i: { category: string }) => i.category).sort()).toEqual(['entry', 'site']);
        expect(stored('fb_1_old').category).toBeUndefined();
    });
});
