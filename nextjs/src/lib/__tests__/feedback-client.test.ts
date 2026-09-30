/**
 * N7（overview#260）：前端反馈提交体的拼装。后端字段不变，上下文塞进 resourceId／pageUrl／正文开头。
 */
import {
    CONTACT_MAX,
    CONTENT_MAX,
    QUOTE_MAX,
    buildFeedbackBody,
    clampQuote,
    contentBudget,
    itemLabel,
    normalizeResourceId,
    readerFeedbackLabel,
    submitFeedback,
} from '../feedback';

const WORK = 'd59f20aowb9c'; // 史記（作品），12 位

describe('normalizeResourceId', () => {
    it('现行 12 位条目 id 原样保留（旧浮钮的 11 位正则把它丢了）', () => {
        expect(normalizeResourceId(WORK)).toBe(WORK);
    });
    it('不是条目 id 的给空串', () => {
        expect(normalizeResourceId('')).toBe('');
        expect(normalizeResourceId(undefined)).toBe('');
        expect(normalizeResourceId('book-index')).toBe(''); // 带连字符
        expect(normalizeResourceId('../etc')).toBe('');
        expect(normalizeResourceId('D59F20AOWB9C')).toBe('');
    });
});

describe('itemLabel', () => {
    it('书名 · 类型 · id', () => {
        expect(itemLabel(WORK, '史记')).toBe(`史记 · 作品 · ${WORK}`);
    });
    it('没书名时只写类型与 id', () => {
        expect(itemLabel(WORK)).toBe(`作品 · ${WORK}`);
        expect(itemLabel(WORK, '  ')).toBe(`作品 · ${WORK}`);
    });
});

describe('clampQuote', () => {
    it('压掉换行与多余空白', () => {
        expect(clampQuote('  高堂生\n所传   士礼也 ')).toBe('高堂生 所传 士礼也');
    });
    it(`超过 ${QUOTE_MAX} 字截断加省略号`, () => {
        const q = clampQuote('字'.repeat(QUOTE_MAX + 50));
        expect(q).toHaveLength(QUOTE_MAX + 1);
        expect(q.endsWith('…')).toBe(true);
    });
});

describe('contentBudget', () => {
    it('没有选中文字时是后端上限', () => {
        expect(contentBudget()).toBe(CONTENT_MAX);
    });
    it('扣掉「【原文】…」前缀，拼起来不超过后端上限', () => {
        const quote = '高堂生所传士礼也';
        const budget = contentBudget(quote);
        const body = buildFeedbackBody({ type: 'bug', text: '字'.repeat(budget), context: { quote }, pageUrl: 'x' });
        expect(body.content.length).toBe(CONTENT_MAX);
    });
});

describe('buildFeedbackBody', () => {
    const pageUrl = `https://www.kaiyuanguji.com/read/${WORK}?kind=collated&juan=juan%2F004.json`;

    it('条目 id 进 resourceId，卷号随 pageUrl，选中文字拼在正文开头', () => {
        const body = buildFeedbackBody({
            type: 'bug',
            text: '  标点应为……  ',
            context: { resourceId: WORK, label: '史记 · 作品', quote: '高堂生所传士礼也' },
            pageUrl,
        });
        expect(body).toEqual({
            type: 'bug',
            content: '【原文】高堂生所传士礼也\n\n标点应为……',
            pageUrl,
            resourceId: WORK,
        });
    });

    it('不带上下文时 resourceId 为空，正文不加前缀', () => {
        const body = buildFeedbackBody({ type: 'suggestion', text: '希望能调行距', context: null, pageUrl: 'https://x/' });
        expect(body.resourceId).toBe('');
        expect(body.content).toBe('希望能调行距');
    });

    it('联系方式去空白、限长；空的不发', () => {
        expect(buildFeedbackBody({ type: 'bug', text: 'a', contact: '   ', pageUrl: 'x' })).not.toHaveProperty('contact');
        expect(buildFeedbackBody({ type: 'bug', text: 'a', contact: ' me@example.org ', pageUrl: 'x' }).contact).toBe('me@example.org');
        expect(buildFeedbackBody({ type: 'bug', text: 'a', contact: 'x'.repeat(300), pageUrl: 'x' }).contact).toHaveLength(CONTACT_MAX);
    });

    it('不合法的 resourceId 丢掉', () => {
        expect(buildFeedbackBody({ type: 'bug', text: 'a', context: { resourceId: 'a/b' }, pageUrl: 'x' }).resourceId).toBe('');
    });
});

describe('readerFeedbackLabel', () => {
    it('整理本：卷文件名里的数字是卷号', () => {
        expect(readerFeedbackLabel('直斋书录解题', { kind: 'collated', juan: 'juan/004.json' })).toBe('直斋书录解题 · 整理本 · 卷4');
    });
    it('整理本地址里的短卷号（011）也认', () => {
        expect(readerFeedbackLabel('直斋书录解题', { kind: 'collated', juan: '011' })).toBe('直斋书录解题 · 整理本 · 卷11');
    });
    it('全文：章节 stem', () => {
        expect(readerFeedbackLabel('诗序', { kind: 'fulltext', juan: '012' })).toBe('诗序 · 全文 · 第 12 章');
    });
    it('没有卷号时不写', () => {
        expect(readerFeedbackLabel('诗序', { kind: 'fulltext' })).toBe('诗序 · 全文');
    });
});

describe('submitFeedback', () => {
    const body = buildFeedbackBody({ type: 'bug', text: 'a', pageUrl: 'x' });

    it('POST 同源 /api/feedback，JSON 体', async () => {
        const fetchImpl = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ success: true }) });
        await submitFeedback(body, fetchImpl as unknown as typeof fetch);
        expect(fetchImpl).toHaveBeenCalledWith('/api/feedback', expect.objectContaining({ method: 'POST' }));
        expect(JSON.parse(fetchImpl.mock.calls[0][1].body)).toEqual(body);
    });

    it('后端报错时抛出后端给的文案', async () => {
        const fetchImpl = jest.fn().mockResolvedValue({ ok: false, json: async () => ({ error: '提交太频繁，请稍后再试' }) });
        await expect(submitFeedback(body, fetchImpl as unknown as typeof fetch)).rejects.toThrow('提交太频繁，请稍后再试');
    });

    it('断网时给通用文案', async () => {
        const fetchImpl = jest.fn().mockRejectedValue(new TypeError('Failed to fetch'));
        await expect(submitFeedback(body, fetchImpl as unknown as typeof fetch)).rejects.toThrow('网络错误，请稍后重试');
    });
});

describe('阅读页位置锚点（v4 P2，overview#299）', () => {
    const ctx = { resourceId: WORK, quote: '易者象也' };
    it('anchor 拼在 pageUrl 的 # 后面，换掉原有的 #', () => {
        const body = buildFeedbackBody({ type: 'bug', text: '错字', context: { ...ctx, anchor: 'rd-e-3' }, pageUrl: 'https://x.test/read/a?kind=collated&juan=011#old' });
        expect(body.pageUrl).toBe('https://x.test/read/a?kind=collated&juan=011#rd-e-3');
    });
    it('没有 anchor 或 anchor 不合法就不动 pageUrl', () => {
        const url = 'https://x.test/read/a?juan=011';
        expect(buildFeedbackBody({ type: 'bug', text: 'x', context: ctx, pageUrl: url }).pageUrl).toBe(url);
        expect(buildFeedbackBody({ type: 'bug', text: 'x', context: { ...ctx, anchor: '"><script>' }, pageUrl: url }).pageUrl).toBe(url);
    });
});
