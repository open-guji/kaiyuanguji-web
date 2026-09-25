/**
 * @jest-environment node
 *
 * 反馈公开读的三件事（G-23 第一批）：
 *   1. 取到的是**最新**的——KV 按 key 升序分页，旧写法第一页是最旧的
 *   2. 按 resourceId 过滤不因 key 多而漏（旧写法只扫前 256 个）
 *   3. 隐藏的、测试的不公开；contact 只给站方看
 * 以及：带管理凭证读时全量原样返回（/admin/feedback 靠它），且新字段的写入要凭证、要白名单。
 */

const g = globalThis as unknown as Record<string, unknown>;

// 仿真 KV：按 key 升序、每页至多 limit 条、cursor 为下一页起点
const store = new Map<string, string>();
const kv = {
    async get(k: string) {
        const v = store.get(k);
        return v ? JSON.parse(v) : null;
    },
    async put(k: string, v: string) {
        store.set(k, v);
    },
    async list(opts: { prefix?: string; limit?: number; cursor?: string }) {
        const all = [...store.keys()].filter((k) => k.startsWith(opts.prefix || '')).sort();
        const start = opts.cursor ? Number(opts.cursor) : 0;
        const limit = Math.min(opts.limit || 256, 256);
        const page = all.slice(start, start + limit);
        const end = start + page.length;
        return { keys: page.map((key) => ({ key })), complete: end >= all.length, cursor: end >= all.length ? '' : String(end) };
    },
};

const T0 = 1_700_000_000_000;
function seed(n: number, extra: (i: number) => Record<string, unknown> = () => ({})) {
    for (let i = 0; i < n; i += 1) {
        const id = `fb_${T0 + i * 1000}_x${i}`;
        store.set(id, JSON.stringify({
            id, type: 'bug', content: `#${i}`, pageUrl: '', resourceId: '',
            createdAt: new Date(T0 + i * 1000).toISOString(), status: 'pending', reply: '', ...extra(i),
        }));
    }
}

function get(qs: string, headers: Record<string, string> = {}) {
    return { request: new Request(`https://x/api/feedback?${qs}`, { headers }) };
}
function post(body: unknown, headers: Record<string, string> = {}) {
    return {
        request: new Request('https://x/api/feedback', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...headers },
            body: JSON.stringify(body),
        }),
    };
}
async function json(res: Response) {
    return JSON.parse(await res.text());
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let fn: any;
beforeAll(async () => {
    g.FEEDBACK_KV = kv;
    fn = await import('../../../../edge-functions/api/feedback.js');
});
beforeEach(() => store.clear());
afterEach(() => { delete g.FEEDBACK_ADMIN_TOKEN; });

describe('排序与分页', () => {
    it('300 条里 limit=20 取到的是最新的 20 条，倒序', async () => {
        seed(300);
        const j = await json(await fn.onRequestGet(get('limit=20')));
        expect(j.items).toHaveLength(20);
        expect(j.items[0].content).toBe('#299');
        expect(j.items[19].content).toBe('#280');
        expect(j.hasMore).toBe(true);
    });

    it('顺 cursor 翻页不重不漏', async () => {
        seed(45);
        const seen: string[] = [];
        let cursor = '';
        for (let k = 0; k < 10; k += 1) {
            const j = await json(await fn.onRequestGet(get(`limit=20${cursor ? `&cursor=${cursor}` : ''}`)));
            seen.push(...j.items.map((x: { content: string }) => x.content));
            if (!j.hasMore) break;
            cursor = j.cursor;
        }
        expect(seen).toHaveLength(45);
        expect(new Set(seen).size).toBe(45);
        expect(seen[0]).toBe('#44');
        expect(seen[44]).toBe('#0');
    });

    it('resourceId 在第 300 个 key 之后也查得到', async () => {
        seed(310, (i) => ({ resourceId: i === 305 ? 'GY4abcdefgh' : '' }));
        const j = await json(await fn.onRequestGet(get('resourceId=GY4abcdefgh')));
        expect(j.items.map((x: { content: string }) => x.content)).toEqual(['#305']);
    });
});

describe('公开读的过滤', () => {
    beforeEach(() => {
        seed(5, (i) => ({
            ...(i === 1 ? { visibility: 'hidden' } : {}),
            ...(i === 2 ? { test: true } : {}),
            ...(i === 3 ? { contact: 'reader@example.com' } : {}),
        }));
    });

    it('hidden 与 test 不出现，contact 被剔除，其余照常', async () => {
        const j = await json(await fn.onRequestGet(get('limit=20')));
        expect(j.items.map((x: { content: string }) => x.content)).toEqual(['#4', '#3', '#0']);
        expect(JSON.stringify(j)).not.toContain('reader@example.com');
        expect(j.items.every((x: object) => !('contact' in x))).toBe(true);
    });

    it('旧记录没有 visibility 字段：照旧公开（不能因加字段把存量全藏了）', async () => {
        const j = await json(await fn.onRequestGet(get('limit=20')));
        expect(j.items.some((x: { content: string }) => x.content === '#0')).toBe(true);
    });

    it('带管理 token 读：全量原样，含 hidden / test / contact', async () => {
        g.FEEDBACK_ADMIN_TOKEN = 'right';
        const j = await json(await fn.onRequestGet(get('limit=20&token=right')));
        expect(j.items).toHaveLength(5);
        expect(JSON.stringify(j)).toContain('reader@example.com');
    });

    it('token 错：按公开规则，不报错', async () => {
        g.FEEDBACK_ADMIN_TOKEN = 'right';
        const res = await fn.onRequestGet(get('limit=20&token=wrong'));
        expect(res.status).toBe(200);
        expect((await json(res)).items).toHaveLength(3);
    });
});

describe('提交：contact 与测试标记', () => {
    it('contact 落库（去空白、截 200 字），公开读看不到', async () => {
        const res = await fn.onRequestPost(post({ type: 'bug', content: '有错字', contact: `  me@example.com${' '.repeat(3)}` }));
        expect(res.status).toBe(200);
        const rec = JSON.parse([...store.values()][0]);
        expect(rec.contact).toBe('me@example.com');
        expect(rec.test).toBeUndefined();
        const j = await json(await fn.onRequestGet(get('limit=20')));
        expect(j.items).toHaveLength(1);
        expect(JSON.stringify(j)).not.toContain('me@example.com');
    });

    it('Origin 是 localhost：记为测试数据，公开读看不到', async () => {
        await fn.onRequestPost(post({ type: 'bug', content: '本地点了一下' }, { Origin: 'http://localhost:3000' }));
        expect(JSON.parse([...store.values()][0]).test).toBe(true);
        expect((await json(await fn.onRequestGet(get('limit=20')))).items).toHaveLength(0);
    });

    it('显式 test:true（探针）：同样不公开', async () => {
        await fn.onRequestPost(post({ type: 'bug', content: 'probe', test: true }));
        expect(JSON.parse([...store.values()][0]).test).toBe(true);
    });

    it('线上正常 Origin：不是测试数据', async () => {
        await fn.onRequestPost(post({ type: 'bug', content: '读者' }, { Origin: 'https://www.kaiyuanguji.com' }));
        expect(JSON.parse([...store.values()][0]).test).toBeUndefined();
    });
});

describe('update：隐藏 / 恢复 / 标测试', () => {
    beforeEach(() => seed(1));
    const ID = `fb_${T0}_x0`;
    const rec = () => JSON.parse(store.get(ID)!);

    it('不带凭证：401 且不动', async () => {
        g.FEEDBACK_ADMIN_TOKEN = 'right';
        const res = await fn.onRequestPost(post({ action: 'update', id: ID, visibility: 'hidden' }));
        expect(res.status).toBe(401);
        expect(rec().visibility).toBeUndefined();
    });

    it('带 token：可隐藏、可恢复、可标测试', async () => {
        g.FEEDBACK_ADMIN_TOKEN = 'right';
        await fn.onRequestPost(post({ action: 'update', id: ID, visibility: 'hidden', token: 'right' }));
        expect(rec().visibility).toBe('hidden');
        await fn.onRequestPost(post({ action: 'update', id: ID, visibility: 'public', token: 'right' }));
        expect(rec().visibility).toBe('public');
        await fn.onRequestPost(post({ action: 'update', id: ID, test: true, token: 'right' }));
        expect(rec().test).toBe(true);
    });

    it('非法值：400 且不动', async () => {
        g.FEEDBACK_ADMIN_TOKEN = 'right';
        expect((await fn.onRequestPost(post({ action: 'update', id: ID, visibility: 'private', token: 'right' }))).status).toBe(400);
        expect((await fn.onRequestPost(post({ action: 'update', id: ID, test: 'yes', token: 'right' }))).status).toBe(400);
        expect(rec().visibility).toBeUndefined();
        expect(rec().test).toBeUndefined();
    });
});
