/**
 * @jest-environment node
 *
 * 反馈截图：校验（只收 jpeg/png/webp，看文件头；张数、大小上限）、限速按张数多算、
 * 公开读不带 images、取图只给管理凭证。
 */

export {};

function makeKv() {
    const store = new Map<string, string>();
    return {
        store,
        async get(k: string, t?: string) {
            const v = store.get(k);
            if (v === undefined) return null;
            return t === 'json' ? JSON.parse(v) : v;
        },
        async put(k: string, v: string) { store.set(k, v); },
        async list(opts: { prefix?: string } = {}) {
            const keys = [...store.keys()].filter((k) => k.startsWith(opts.prefix || '')).sort().map((key) => ({ key }));
            return { keys, complete: true, cursor: '' };
        },
    };
}

/* eslint-disable @typescript-eslint/no-explicit-any */
let fn: any;
let kv: ReturnType<typeof makeKv>;
let env: Record<string, unknown>;

beforeAll(async () => {
    fn = await import('../../../../edge-functions/api/feedback.js');
});
beforeEach(() => {
    delete (globalThis as Record<string, unknown>).__kygFeedbackListCache;
    kv = makeKv();
    env = { FEEDBACK_KV: kv, FEEDBACK_ADMIN_TOKEN: 'right' };
});

const b64 = (bytes: number[], pad = 0) => Buffer.from([...bytes, ...new Array(pad).fill(1)]).toString('base64');
const JPEG = (pad = 20) => `data:image/jpeg;base64,${b64([0xff, 0xd8, 0xff, 0xe0], pad)}`;
const PNG = `data:image/png;base64,${b64([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 8)}`;

function post(body: unknown, ip = '1.2.3.4') {
    const request = new Request('https://x/api/feedback', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    (request as any).eo = { clientIp: ip };
    return { env, request, waitUntil: () => {} };
}
const get = (qs: string, headers: Record<string, string> = {}) =>
    ({ env, request: new Request(`https://x/api/feedback?${qs}`, { headers }) });
const base = { type: 'bug', content: '有错' };

describe('提交带图', () => {
    it('合法截图：写图条目与 images 元数据', async () => {
        const res = await fn.onRequestPost(post({ ...base, images: [JPEG(), PNG] }));
        expect(res.status).toBe(200);
        const { id } = await res.json();
        const rec = JSON.parse(kv.store.get(id)!);
        expect(rec.images).toEqual([{ type: 'image/jpeg', size: 24 }, { type: 'image/png', size: 16 }]);
        expect(kv.store.has(`fbimg:${id}:0`)).toBe(true);
        expect(kv.store.has(`fbimg:${id}:1`)).toBe(true);
    });

    it.each([
        ['超过 3 张', { images: [JPEG(), JPEG(), JPEG(), JPEG()] }],
        ['不是数组', { images: 'x' }],
        ['svg', { images: ['data:image/svg+xml;base64,PHN2Zz48L3N2Zz4='] }],
        ['声明 jpeg 但文件头不是图', { images: [`data:image/jpeg;base64,${b64([1, 2, 3, 4], 30)}`] }],
        ['单张过大', { images: [JPEG(800 * 1024)] }],
    ])('拒绝：%s', async (_n, extra) => {
        const res = await fn.onRequestPost(post({ ...base, ...extra }));
        expect(res.status).toBe(400);
        expect([...kv.store.keys()].some((k) => k.startsWith('fb_'))).toBe(false);
    });

    it('限速：每张图多算一条，10 分钟 10 条', async () => {
        for (let i = 0; i < 3; i += 1) {
            expect((await fn.onRequestPost(post({ ...base, images: [JPEG(), JPEG(), JPEG()] }))).status).toBe(200); // 4×3=12 > 10 在第 3 次
            if (i === 1) break;
        }
        expect((await fn.onRequestPost(post({ ...base, images: [JPEG(), JPEG(), JPEG()] }))).status).toBe(429);
    });
});

describe('读', () => {
    it('公开列表不含 images，管理读含；取图只给管理凭证', async () => {
        const { id } = await (await fn.onRequestPost(post({ ...base, images: [JPEG()] }))).json();
        const pub = await (await fn.onRequestGet(get('fresh=1'))).json();
        expect(JSON.stringify(pub)).not.toContain('images');
        const adm = await (await fn.onRequestGet(get('fresh=1', { Authorization: 'Bearer right' }))).json();
        expect(adm.items[0].images).toHaveLength(1);

        expect((await fn.onRequestGet(get(`image=${id}.0`))).status).toBe(401);
        expect((await fn.onRequestGet(get(`image=${id}.0`, { Authorization: 'Bearer bad' }))).status).toBe(401);
        const ok = await fn.onRequestGet(get(`image=${id}.0`, { Authorization: 'Bearer right' }));
        expect(ok.status).toBe(200);
        expect(ok.headers.get('Content-Type')).toBe('image/jpeg');
        expect(ok.headers.get('Cache-Control')).toBe('private, no-store');
        expect((await ok.arrayBuffer()).byteLength).toBe(24);
        expect((await fn.onRequestGet(get(`image=${id}.2`, { Authorization: 'Bearer right' }))).status).toBe(404);
        expect((await fn.onRequestGet(get('image=../x.0', { Authorization: 'Bearer right' }))).status).toBe(404);
    });
});
