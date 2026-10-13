/**
 * @jest-environment node
 *
 * A 块步 1：classifyFeedback。金标＝overview 分块-A-输入 §一 对线上 9 条的重分类（目录 5／网站 2／join 2／typo 0）。
 */
// @ts-expect-error edge-functions 是纯 JS
import { classifyFeedback, legacyCategory, suggestAssignee, QUOTE_MARK, CATEGORIES, ASSIGNEES } from '../../../../edge-functions/api/feedback-classify.js';
import { buildFeedbackBody, QUOTE_MARK as FRONT_QUOTE_MARK } from '../feedback';

const H = 'https://www.openguji.com';

describe('classifyFeedback', () => {
    test('contact → join', () => {
        expect(classifyFeedback({ type: 'contact', pageUrl: `${H}/join`, content: '想参与' })).toBe('join');
    });
    test('阅读页 /read/ → typo', () => {
        expect(classifyFeedback({ type: 'bug', pageUrl: `${H}/read/98y5qfl7nl`, content: '这里错了' })).toBe('typo');
    });
    test('/item/x 带选中原文 → typo', () => {
        const content = `${QUOTE_MARK}某字某句\n\n应作某`;
        expect(classifyFeedback({ type: 'bug', pageUrl: `${H}/item/98y5qfl7nl?tab=text`, content })).toBe('typo');
    });
    test('/item/x 带阅读器锚点 → typo；非法锚点不算', () => {
        expect(classifyFeedback({ type: 'bug', pageUrl: `${H}/item/98y5qfl7nl#rd-e-3`, content: 'x' })).toBe('typo');
        expect(classifyFeedback({ type: 'bug', pageUrl: `${H}/item/98y5qfl7nl#foo`, content: 'x' })).toBe('entry');
    });
    test('/item/x 无引用 → entry', () => {
        expect(classifyFeedback({ type: 'bug', pageUrl: `${H}/item/98y5qfl7nl`, content: '版本信息错' })).toBe('entry');
    });
    test('resource → entry（含旧格式 book-index?id=）', () => {
        expect(classifyFeedback({ type: 'resource', pageUrl: `${H}/book-index?q=x`, content: '武职选簿.整理本' })).toBe('entry');
    });
    test('首页／搜索页 bug、suggestion → site', () => {
        expect(classifyFeedback({ type: 'bug', pageUrl: `${H}/`, content: '加载是空白' })).toBe('site');
        expect(classifyFeedback({ type: 'suggestion', pageUrl: `${H}/book-index`, content: '加个搜索框' })).toBe('site');
    });
    test('正文「我想加入」的 bug → join（关键词只纠偏）', () => {
        expect(classifyFeedback({ type: 'bug', pageUrl: `${H}/intelligence`, content: '我也想加入，我是出版社编辑' })).toBe('join');
    });
    test('邮箱形态 → join', () => {
        expect(classifyFeedback({ type: 'resource', pageUrl: `${H}/assistant`, content: '请联系 a.b@example.com' })).toBe('join');
    });
    test('选中的原文里含「参与」不触发 join', () => {
        const content = `${QUOTE_MARK}共同参与其事\n\n此处缺字`;
        expect(classifyFeedback({ type: 'bug', pageUrl: `${H}/read/x`, content })).toBe('typo');
    });
    test('空／畸形输入不抛，bug 无法判路径落 other', () => {
        expect(classifyFeedback(undefined)).toBe('other');
        expect(classifyFeedback({})).toBe('other');
        expect(classifyFeedback({ type: 'bug', pageUrl: '', content: 'x' })).toBe('other');
        expect(classifyFeedback({ type: 'bug', pageUrl: 'http://[bad', content: 'x' })).toBe('other');
        expect(classifyFeedback({ type: 'other', pageUrl: `${H}/`, content: 'x' })).toBe('other');
        expect(classifyFeedback({ type: 'bug', pageUrl: `${H}/`, content: null })).toBe('site');
    });
    test('所有输出都在 CATEGORIES 内', () => {
        for (const type of ['bug', 'resource', 'suggestion', 'contact', 'other', 'zzz', undefined]) {
            expect(CATEGORIES).toContain(classifyFeedback({ type, pageUrl: `${H}/item/a`, content: 'x' }));
        }
    });
});

describe('金标：线上 9 条（10-13 实测）重分类', () => {
    // [id 尾, type, pageUrl 片段, 期望]。pageUrl 取自 /api/feedback；旧式 book-index?id= 页按目录页算
    const rows: [string, string, string, string, string][] = [
        ['xvsa', 'bug', `${H}/intelligence`, '我也想加入，我是出版社古籍编辑，我的邮箱***@***', 'join'],
        ['buq5', 'resource', `${H}/assistant`, '我想要加入古籍自动排版的项目里面去', 'join'],
        ['xdmh', 'bug', `${H}/book-index?id=1evimvfwvwr9c&tab=feedback`, '怎么找不到原文', 'site'],
        ['pb1x', 'resource', `${H}/book-index?q=x`, '武职选簿.整理本', 'entry'],
        ['ll6u', 'bug', `${H}/book-index?id=d59df01avcw0&tab=feedback`, '缺少更多刻本', 'site'],
        ['94kz', 'bug', `${H}/book-index?tab=feedback`, '玉匣记未录入', 'site'],
    ];
    test.each(rows)('%s %s', (_id, type, pageUrl, content, want) => {
        expect(classifyFeedback({ type, pageUrl, content })).toBe(want);
    });
    // 注：xdmh／ll6u／94kz 在线上是目录问题，但旧式 pageUrl（/book-index）没有 /item/ 路径，入口自动判会落 site；
    // 这三条与 8mh1／82bl／cm71 由回填脚本（步 6）按金标人工指定，不靠函数。此处钉住「函数不会瞎猜」。
});

describe('legacyCategory／suggestAssignee', () => {
    test('旧记录按 type 推', () => {
        expect([legacyCategory('bug'), legacyCategory('resource'), legacyCategory('contact'), legacyCategory('x')])
            .toEqual(['site', 'entry', 'join', 'other']);
    });
    test('建议块都在 ASSIGNEES 内', () => {
        for (const c of CATEGORIES) expect(ASSIGNEES).toContain(suggestAssignee(c));
        expect(suggestAssignee('typo')).toBe('text');
    });
});

describe('与前端 quotePrefix 对表', () => {
    test('前端拼出的正文以后端认的 QUOTE_MARK 开头', () => {
        const body = buildFeedbackBody({
            type: 'bug', text: '应作某', pageUrl: `${H}/item/abc`,
            context: { quote: '某字某句' },
        });
        expect(body.content.startsWith(QUOTE_MARK)).toBe(true);
        expect(FRONT_QUOTE_MARK).toBe(QUOTE_MARK);
        expect(classifyFeedback({ type: 'bug', pageUrl: body.pageUrl, content: body.content })).toBe('typo');
    });
});
