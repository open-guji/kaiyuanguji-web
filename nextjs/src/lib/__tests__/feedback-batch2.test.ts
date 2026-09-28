/**
 * @jest-environment node
 *
 * G-23 第二批 §一·6/8/9：类型与状态扩充、updatedBy、新反馈推送。
 * 排序/分页/公开过滤/contact 隐私已在 feedback-listing.test.ts 钉住，这里只测新增的部分。
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

function get(qs: string, headers: Record<string, string> = {}) {
    return { request: new Request(`https://x/api/feedback?${qs}`, { headers }) };
}
/** M1：管理 token 只走 Authorization: Bearer（不再认 ?token=） */
const ADMIN = { Authorization: 'Bearer right' };
function post(body: unknown, headers: Record<string, string> = {}) {
    return {
        request: new Request('https://x/api/feedback', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...headers },
            body: JSON.stringify(body),
        }),
        // 模拟 EdgeOne 的 waitUntil：真等这个 promise，测试才能稳定断言推送是否发生
        waitUntil: (p: Promise<unknown>) => p.catch(() => {}),
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
// 只取反馈记录：store 里还有 M3 的限速计数（ratelimit:*）与推送节流状态（notify:*）
const fbKeys = () => [...store.keys()].filter((k) => k.startsWith('fb_'));
beforeEach(() => store.clear());
afterEach(() => {
    delete g.FEEDBACK_ADMIN_TOKEN;
    delete g.HEALTH_NOTIFY_WEBHOOK;
    delete g.HEALTH_NOTIFY_FORMAT;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (global as any).fetch;
});

describe('类型白名单扩充', () => {
    it('新类型（suggestion/contact/other）提交通过；非法类型 400', async () => {
        for (const type of ['suggestion', 'contact', 'other']) {
            store.clear();
            const res = await fn.onRequestPost(post({ type, content: `一条 ${type}` }));
            expect(res.status).toBe(200);
        }
        const bad = await fn.onRequestPost(post({ type: 'not-a-type', content: '乱来' }));
        expect(bad.status).toBe(400);
    });

    it('contact 类型永不出现在公开列表，即便 visibility 被手动设为 public', async () => {
        await fn.onRequestPost(post({ type: 'contact', content: '想参与项目' }));
        const id = fbKeys()[0];
        g.FEEDBACK_ADMIN_TOKEN = 'right';
        // 手滑把 visibility 设回 public，isPubliclyVisible 的 type 判断仍应拦住
        await fn.onRequestPost(post({ action: 'update', id, visibility: 'public', token: 'right' }));
        const pub = await json(await fn.onRequestGet(get('limit=20')));
        expect(pub.items).toHaveLength(0);
        const full = await json(await fn.onRequestGet(get('limit=20', ADMIN)));
        expect(full.items).toHaveLength(1);
    });
});

describe('状态白名单扩充 ＋ 标重复', () => {
    it('五种状态都能改；非法状态 400', async () => {
        await fn.onRequestPost(post({ type: 'bug', content: '原始记录' }));
        const id = fbKeys()[0];
        g.FEEDBACK_ADMIN_TOKEN = 'right';
        for (const status of ['pending', 'in_progress', 'resolved', 'wontfix']) {
            const res = await fn.onRequestPost(post({ action: 'update', id, status, token: 'right' }));
            expect(res.status).toBe(200);
        }
        const bad = await fn.onRequestPost(post({ action: 'update', id, status: 'not-a-status', token: 'right' }));
        expect(bad.status).toBe(400);
    });

    it('标重复：duplicateOf 指向不存在的 id 时 400；指向存在的记录时写入成功', async () => {
        await fn.onRequestPost(post({ type: 'bug', content: 'A' }));
        await fn.onRequestPost(post({ type: 'bug', content: 'B（和 A 重复）' }));
        const ids = fbKeys();
        g.FEEDBACK_ADMIN_TOKEN = 'right';
        const bad = await fn.onRequestPost(
            post({ action: 'update', id: ids[1], status: 'duplicate', duplicateOf: 'fb_no_such_id', token: 'right' }),
        );
        expect(bad.status).toBe(400);
        const ok = await fn.onRequestPost(
            post({ action: 'update', id: ids[1], status: 'duplicate', duplicateOf: ids[0], token: 'right' }),
        );
        expect(ok.status).toBe(200);
        expect(JSON.parse(store.get(ids[1])!).duplicateOf).toBe(ids[0]);
        expect(JSON.parse(store.get(ids[1])!).status).toBe('duplicate');
    });
});

describe('updatedBy', () => {
    it('token 鉴权：updatedBy 记为 token', async () => {
        await fn.onRequestPost(post({ type: 'bug', content: 'x' }));
        const id = fbKeys()[0];
        g.FEEDBACK_ADMIN_TOKEN = 'right';
        await fn.onRequestPost(post({ action: 'update', id, status: 'resolved', token: 'right' }));
        expect(JSON.parse(store.get(id)!).updatedBy).toBe('token');
    });

    it('updatedBy 是内部字段：公开 GET 一律不带出（哪怕记录本身公开），带凭证读才有', async () => {
        await fn.onRequestPost(post({ type: 'bug', content: 'x' }));
        const id = fbKeys()[0];
        g.FEEDBACK_ADMIN_TOKEN = 'right';
        await fn.onRequestPost(post({ action: 'update', id, visibility: 'public', reply: '已处理', token: 'right' }));
        const pub = await json(await fn.onRequestGet(get('limit=20')));
        expect(pub.items).toHaveLength(1);
        expect('updatedBy' in pub.items[0]).toBe(false);
        const full = await json(await fn.onRequestGet(get('limit=20', ADMIN)));
        expect(full.items[0].updatedBy).toBe('token');
    });
});

describe('新反馈推送（G-23 第二批 §一·8）', () => {
    function mockFetch(impl: (url: string, init: RequestInit) => Promise<Response> | Response) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (global as any).fetch = jest.fn(impl);
    }

    it('webhook 未配置：不推送，提交仍 200', async () => {
        mockFetch(() => new Response('{}', { status: 200 }));
        const req = post({ type: 'bug', content: '没配置 webhook 时' });
        const res = await fn.onRequestPost(req);
        await req.waitUntil(Promise.resolve());
        expect(res.status).toBe(200);
        expect((global as unknown as { fetch: jest.Mock }).fetch).not.toHaveBeenCalled();
    });

    it('test=true：不推送，提交仍 200', async () => {
        g.HEALTH_NOTIFY_WEBHOOK = 'https://hook.example/notify';
        mockFetch(() => new Response('{}', { status: 200 }));
        const req = post({ type: 'bug', content: '测试数据', test: true });
        const res = await fn.onRequestPost(req);
        await new Promise((r) => setTimeout(r, 0));
        expect(res.status).toBe(200);
        expect((global as unknown as { fetch: jest.Mock }).fetch).not.toHaveBeenCalled();
    });

    it('webhook 已配置且非测试数据：推送一次，内容含类型与前 40 字', async () => {
        g.HEALTH_NOTIFY_WEBHOOK = 'https://hook.example/notify';
        let sentBody = '';
        mockFetch((_url, init) => {
            sentBody = String(init.body);
            return new Response('{}', { status: 200 });
        });
        const req = post({ type: 'bug', content: '首页搜索点不动了，试了三次都一样' });
        const res = await fn.onRequestPost(req);
        await new Promise((r) => setTimeout(r, 0));
        expect(res.status).toBe(200);
        expect((global as unknown as { fetch: jest.Mock }).fetch).toHaveBeenCalledTimes(1);
        expect(sentBody).toContain('错误反馈');
        expect(sentBody).toContain('/admin/feedback');
    });

    it.each([
        ['裸 token', 'tok_abc123'],
        ['含 token= 的 URL', 'https://www.pushplus.plus/send?token=tok_abc123'],
    ])('pushplus（%s）：发往固定端点，token 放 body，带标题', async (_label, value) => {
        g.HEALTH_NOTIFY_WEBHOOK = value;
        g.HEALTH_NOTIFY_FORMAT = 'pushplus';
        let sentUrl = '';
        let sent: Record<string, unknown> = {};
        mockFetch((url, init) => {
            sentUrl = String(url);
            sent = JSON.parse(String(init.body));
            return new Response('{"code":200}', { status: 200 });
        });
        const res = await fn.onRequestPost(post({ type: 'suggestion', content: '希望加上按朝代筛选' }));
        await new Promise((r) => setTimeout(r, 0));
        expect(res.status).toBe(200);
        expect(sentUrl).toBe('https://www.pushplus.plus/send');
        expect(sent.token).toBe('tok_abc123');
        expect(sent.title).toBe('新反馈：功能建议');
        expect(String(sent.content)).toContain('希望加上按朝代筛选');
        expect(sent.template).toBe('txt');
    });

    it('webhook 超时/网络错误：不影响提交返回 200', async () => {
        g.HEALTH_NOTIFY_WEBHOOK = 'https://hook.example/notify';
        mockFetch(() => Promise.reject(new Error('network timeout')));
        const req = post({ type: 'bug', content: '推送会超时' });
        const res = await fn.onRequestPost(req);
        await new Promise((r) => setTimeout(r, 0));
        expect(res.status).toBe(200);
        expect((await json(res)).success).toBe(true);
    });

    it('非法提交（校验不通过）：从不触发推送——等价于蜜罐/丢弃场景（记录未落库就不会通知）', async () => {
        g.HEALTH_NOTIFY_WEBHOOK = 'https://hook.example/notify';
        mockFetch(() => new Response('{}', { status: 200 }));
        const res = await fn.onRequestPost(post({ type: 'not-a-type', content: '会被 400 挡住' }));
        await new Promise((r) => setTimeout(r, 0));
        expect(res.status).toBe(400);
        expect((global as unknown as { fetch: jest.Mock }).fetch).not.toHaveBeenCalled();
    });
});
