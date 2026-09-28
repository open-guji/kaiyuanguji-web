/**
 * @jest-environment node
 *
 * F1（Q1-01）：公开读的 content/reply 正文脱敏。
 *   - 32 卡 Q1 巡检查出真实一例：`GET /api/feedback` 公开返回的正文里带着读者自己写的
 *     真实邮箱（fb_1789543011290_xvsa）。W3 只剔除了 contact 字段，没管正文。
 *   - 管理读（token / 成员 cookie）必须原样、不脱敏。
 *   - 存储里的原文不改（这里用同一份仿真 KV 断言 put 之后取出的原始值不变）。
 *   - 普通文本（书名里的数字、年份、卷数等）不能被误伤。
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
function seedOne(content: string, extra: Record<string, unknown> = {}) {
    const id = `fb_${T0}_x0`;
    store.set(id, JSON.stringify({
        id, type: 'bug', content, pageUrl: '', resourceId: '',
        createdAt: new Date(T0).toISOString(), status: 'pending', reply: '', ...extra,
    }));
    return id;
}

function get(qs: string, headers: Record<string, string> = {}) {
    return { request: new Request(`https://x/api/feedback?${qs}`, { headers }) };
}
/** M1：管理 token 只走 Authorization: Bearer（不再认 ?token=） */
const ADMIN = { Authorization: 'Bearer right' };
async function json(res: Response) {
    return JSON.parse(await res.text());
}
async function publicContent(): Promise<string> {
    const j = await json(await fn.onRequestGet(get('limit=20')));
    return j.items[0].content;
}
async function adminContent(): Promise<string> {
    g.FEEDBACK_ADMIN_TOKEN = 'right';
    const j = await json(await fn.onRequestGet(get('limit=20', ADMIN)));
    return j.items[0].content;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let fn: any;
beforeAll(async () => {
    g.FEEDBACK_KV = kv;
    fn = await import('../../../../edge-functions/api/feedback.js');
});
beforeEach(() => store.clear());
afterEach(() => { delete g.FEEDBACK_ADMIN_TOKEN; });

describe('公开读脱敏：各样式命中', () => {
    it('邮箱 → ***@***', async () => {
        seedOne('联系我 me@example.com 谢谢');
        expect(await publicContent()).toBe('联系我 ***@*** 谢谢');
    });

    it('手机号（纯 11 位）→ 1**********', async () => {
        seedOne('可以打我电话13812345678');
        expect(await publicContent()).toBe('可以打我电话1**********');
    });

    it('手机号（带 +86）→ 整体替换为 1**********', async () => {
        seedOne('号码 +86 13812345678 随时找我');
        expect(await publicContent()).toBe('号码 1********** 随时找我');
    });

    it('QQ 号（提示词后紧跟数字）→ 提示词保留，号码变 ***', async () => {
        seedOne('QQ:123456789 有空加一下');
        expect(await publicContent()).toBe('QQ:*** 有空加一下');
    });

    it('微信号（提示词后紧跟账号）→ 提示词保留，账号变 ***', async () => {
        seedOne('微信 abc_123 找我要资源');
        expect(await publicContent()).toBe('微信 *** 找我要资源');
    });

    it('vx/wx（带分隔符）→ 提示词保留，账号变 ***', async () => {
        seedOne('加我vx: laoli_2024 细聊');
        expect(await publicContent()).toBe('加我vx: *** 细聊');
    });

    it('身份证号（18 位）→ ***', async () => {
        seedOne('身份证 110105199003078515 可核实');
        expect(await publicContent()).toBe('身份证 *** 可核实');
    });

    it('reply 字段同样脱敏', async () => {
        const id = seedOne('原文无害', { reply: '已通过邮箱 fixer@kaiyuanguji.com 联系你' });
        const j = await json(await fn.onRequestGet(get('limit=20')));
        expect(j.items.find((x: { id: string }) => x.id === id).reply).toBe('已通过邮箱 ***@*** 联系你');
    });

    it('一条正文里出现两种样式，都各自被替换', async () => {
        seedOne('邮箱 a@b.com 或者电话13912345678都行');
        expect(await publicContent()).toBe('邮箱 ***@*** 或者电话1**********都行');
    });
});

describe('管理读：原样不脱敏', () => {
    it('邮箱在管理读里原样返回', async () => {
        seedOne('联系我 me@example.com 谢谢');
        expect(await adminContent()).toBe('联系我 me@example.com 谢谢');
    });

    it('手机号在管理读里原样返回', async () => {
        seedOne('可以打我电话13812345678');
        expect(await adminContent()).toBe('可以打我电话13812345678');
    });

    it('身份证号在管理读里原样返回', async () => {
        seedOne('身份证 110105199003078515 可核实');
        expect(await adminContent()).toBe('身份证 110105199003078515 可核实');
    });
});

describe('存储原文不改（不回写 KV）', () => {
    it('公开读一遍之后，KV 里的原始记录仍是明文', async () => {
        const id = seedOne('联系我 me@example.com 电话13812345678');
        await fn.onRequestGet(get('limit=20')); // 触发一次公开读
        const raw = JSON.parse(store.get(id)!);
        expect(raw.content).toBe('联系我 me@example.com 电话13812345678');
    });
});

describe('普通文本不被误伤（反例，至少 10 条）', () => {
    const cases: [string, string][] = [
        ['书名数字', '《四庫全書總目提要》共二百卷，另附存目'],
        ['中文数字年份', '这部书是一九八二年出版的，校勘很仔细'],
        ['阿拉伯数字年份', '1982年的校订本比较可靠'],
        ['卷数', '第38卷第12页有一处错字'],
        ['ISBN带分隔符', 'ISBN 978-7-101-01219-6 这本买不到了'],
        ['古籍索引条目id（含数字字母混合但非18位）', '条目 d59f2ofu9i4i 的作者信息有误'],
        ['日期', '这条记录的创建时间是2026-09-27，晚了几天'],
        ['价格', '这本书卖12345678901元也太贵了'], // 11位但不是 1[3-9] 开头式手机号
        ['提示词后无号码-微信', '微信读书这个APP阅读体验不错'],
        ['提示词后无号码-QQ', 'QQ音乐上能听到相关的讲座录音'],
        ['英文单词含vx但无分隔符', '这个项目用了wxWidgets做界面，和反馈无关'],
        ['纯数字但不足18/11位', '页码是1234567，不是手机号也不是身份证'],
    ];
    it.each(cases)('%s：公开读原样不变', async (_label, text) => {
        seedOne(text);
        expect(await publicContent()).toBe(text);
    });
});
