/**
 * @jest-environment node
 *
 * 反馈端点的鉴权闸。
 *
 * 2026-09-14 实测的洞：`POST {action:'update'}` 这条路**一点鉴权都没写**
 * （比 track-error 那个 fail-open 更彻底），而 `fb_` id 从公开的 GET 就能枚举，
 * `reply` 又会被 book-index-ui 当作站方回复渲染出来——
 * 合起来，任何人一条 curl 就能以站方口吻说话、并把任何反馈标成「已解决」。
 *
 * 这里盯四件：管理路要凭证、读要公开、提交要公开、PATCH 那个备用入口也得拦。
 * 后两件与前两件同样要紧：把公开的两条一起堵死，功能就废了，而且**不会报错**。
 */

const g = globalThis as unknown as Record<string, unknown>;

const kvStub = {
    store: new Map<string, string>(),
    async get(k: string) {
        const v = this.store.get(k);
        return v ? JSON.parse(v) : null;
    },
    async put(k: string, v: string) {
        this.store.set(k, v);
    },
    async list() {
        return { keys: [...this.store.keys()].map((key) => ({ key })), complete: true, cursor: '' };
    },
};

function post(body: unknown, url = 'https://x/api/feedback') {
    return {
        request: new Request(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        }),
    };
}

async function json(res: Response) {
    return JSON.parse(await res.text());
}

const FB = 'fb_1_a';
const record = () => JSON.parse(kvStub.store.get(FB)!);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let fn: any;

beforeAll(async () => {
    g.FEEDBACK_KV = kvStub;
    fn = await import('../../../../edge-functions/api/feedback.js');
});

beforeEach(() => {
    kvStub.store.clear();
    kvStub.store.set(
        FB,
        JSON.stringify({
            id: FB, type: 'bug', content: '读者提的问题', pageUrl: '', resourceId: '',
            createdAt: '2026-01-01T00:00:00.000Z', status: 'pending', reply: '',
        }),
    );
});

afterEach(() => {
    delete g.FEEDBACK_ADMIN_TOKEN;
});

describe('改状态 / 写回复（POST action=update）', () => {
    it('没配 FEEDBACK_ADMIN_TOKEN 时一律拒绝，记录不动', async () => {
        const res = await fn.onRequestPost(post({ action: 'update', id: FB, status: 'resolved', reply: '冒充站方' }));
        expect(res.status).toBe(503);
        expect(record().status).toBe('pending');
        expect(record().reply).toBe('');
    });

    it('配了变量、不带 token → 401 且记录不动', async () => {
        g.FEEDBACK_ADMIN_TOKEN = 'right';
        const res = await fn.onRequestPost(post({ action: 'update', id: FB, reply: '冒充站方' }));
        expect(res.status).toBe(401);
        expect(record().reply).toBe('');
    });

    it('token 不对 → 401 且记录不动', async () => {
        g.FEEDBACK_ADMIN_TOKEN = 'right';
        const res = await fn.onRequestPost(post({ action: 'update', id: FB, reply: '冒充站方', token: 'wrong' }));
        expect(res.status).toBe(401);
        expect(record().reply).toBe('');
    });

    it('token 对 → 改得动', async () => {
        g.FEEDBACK_ADMIN_TOKEN = 'right';
        const res = await fn.onRequestPost(
            post({ action: 'update', id: FB, status: 'resolved', reply: '已修复', token: 'right' }),
        );
        expect(res.status).toBe(200);
        expect((await json(res)).success).toBe(true);
        expect(record().status).toBe('resolved');
        expect(record().reply).toBe('已修复');
    });
});

describe('PATCH（EdgeOne 现在不路由，但留着就得一样拦）', () => {
    const patch = (body: unknown) => ({
        request: new Request(`https://x/api/feedback/${FB}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        }),
    });

    it('没配变量时拒绝', async () => {
        const res = await fn.onRequestPatch(patch({ status: 'resolved', reply: '冒充站方' }));
        expect(res.status).toBe(503);
        expect(record().reply).toBe('');
    });

    it('token 不对时拒绝', async () => {
        g.FEEDBACK_ADMIN_TOKEN = 'right';
        const res = await fn.onRequestPatch(patch({ reply: '冒充站方', token: 'wrong' }));
        expect(res.status).toBe(401);
        expect(record().reply).toBe('');
    });

    it('token 对 → 改得动', async () => {
        g.FEEDBACK_ADMIN_TOKEN = 'right';
        const res = await fn.onRequestPatch(patch({ status: 'resolved', token: 'right' }));
        expect(res.status).toBe(200);
        expect(record().status).toBe('resolved');
    });
});

describe('公开的两条路不能被误伤', () => {
    it('提交反馈：不带 token 也能提', async () => {
        const res = await fn.onRequestPost(post({ type: 'bug', content: '匿名提的问题' }));
        expect(res.status).toBe(200);
        expect((await json(res)).success).toBe(true);
    });

    it('提交反馈：配了 admin token 之后依然匿名可提', async () => {
        g.FEEDBACK_ADMIN_TOKEN = 'right';
        const res = await fn.onRequestPost(post({ type: 'resource', content: '还是匿名提' }));
        expect(res.status).toBe(200);
    });

    it('列出反馈：不带 token 也能读（站内反馈 tab 靠它渲染）', async () => {
        g.FEEDBACK_ADMIN_TOKEN = 'right';
        const res = await fn.onRequestGet({ request: new Request('https://x/api/feedback?limit=10') });
        expect(res.status).toBe(200);
        const j = await json(res);
        expect(j.success).toBe(true);
        expect(j.items.length).toBeGreaterThan(0);
    });
});
