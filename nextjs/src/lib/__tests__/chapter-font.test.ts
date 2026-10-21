/**
 * chapter-font.ts：章生僻字子集字体（GUJI-701／GUJI-721）——章条目字段校验（含切块 font_parts）、CSS、站内换章时注入（不重复、给不出地址就不加）。
 */
import { jest } from '@jest/globals';
import { chapterFontCss, chapterFontMeta, ensureChapterFont, isCssSafeUrl } from '../chapter-font';

const CH = { file: '002', font_file: '002.font.woff2', font_range: 'U+348B,U+20201-20203' };
const URL_ = 'https://data.test/current/items/b1/default/002.font.woff2?v=k1';

afterEach(() => { document.body.innerHTML = ''; });

describe('chapter-font', () => {
    it('字段校验：文件名只认 .woff2 单段名，range 只认 unicode-range 语法', () => {
        expect(chapterFontMeta(CH)).toEqual([{ file: '002.font.woff2', range: 'U+348B,U+20201-20203' }]);
        expect(chapterFontMeta({ ...CH, font_file: '../x.woff2' })).toBeNull();
        expect(chapterFontMeta({ ...CH, font_file: '002.font.css' })).toBeNull();
        expect(chapterFontMeta({ ...CH, font_range: 'U+348B;}body{color:red' })).toBeNull();
        expect(chapterFontMeta(null)).toBeNull();
        expect(isCssSafeUrl(URL_)).toBe(true);
        expect(isCssSafeUrl('https://x/a"b')).toBe(false);
    });

    it('切块：font_parts 里合规的跟在第 1 块后面，不合规的丢掉；第 1 块不合规整个不要', () => {
        const parts = [{ file: '002.font-2.woff2', range: 'U+20000-200FF' }, { file: '../x.woff2', range: 'U+1' }, null, { file: '002.font-3.woff2', range: 'U+30000' }];
        expect(chapterFontMeta({ ...CH, font_parts: parts })).toEqual([
            { file: '002.font.woff2', range: 'U+348B,U+20201-20203' }, parts[0], parts[3],
        ]);
        expect(chapterFontMeta({ file: '002', font_parts: parts })).toBeNull();
    });

    it('CSS：一块一条 KygZi 的 @font-face', () => {
        const css = chapterFontCss({ href: URL_, range: 'U+348B' });
        expect(css.match(/@font-face/g)).toHaveLength(1);
        expect(css).toContain('font-family:"KygZi"');
        expect(css).toContain(`src:url("${URL_}") format("woff2");unicode-range:U+348B}`);
    });

    it('换章注入：加在 body 末尾；同一地址（含服务端出的那条）不重复加', async () => {
        const getTextFileUrl = jest.fn(async () => URL_);
        await ensureChapterFont({ getTextFileUrl }, 'b1', 'default', CH);
        await ensureChapterFont({ getTextFileUrl }, 'b1', 'default', CH);
        const els = document.querySelectorAll('style[data-kyg-chapter-font]');
        expect(els).toHaveLength(1);
        expect(document.body.lastElementChild).toBe(els[0]);
        expect(getTextFileUrl).toHaveBeenCalledWith('b1', 'default', '002.font.woff2');

        document.body.innerHTML = `<style id="kyg-chapter-font">${chapterFontCss({ href: URL_, range: 'U+348B' })}</style>`;
        await ensureChapterFont({ getTextFileUrl }, 'b1', 'default', CH);
        expect(document.querySelectorAll('style')).toHaveLength(1);
    });

    it('切块的章：每块一条 style，各自的地址', async () => {
        const getTextFileUrl = jest.fn(async (_i: string, _k: string, f: string) => `https://data.test/current/items/b1/default/${f}?v=k1`);
        await ensureChapterFont({ getTextFileUrl }, 'b1', 'default', { ...CH, font_parts: [{ file: '002.font-2.woff2', range: 'U+20000-200FF' }] });
        const els = [...document.querySelectorAll('style[data-kyg-chapter-font]')];
        expect(els.map((e) => e.getAttribute('data-kyg-chapter-font'))).toEqual(['002.font.woff2', '002.font-2.woff2']);
        expect(els[1].textContent).toContain('002.font-2.woff2?v=k1") format("woff2");unicode-range:U+20000-200FF}');
    });

    it('给不出地址（h1 布局／没有 getTextFileUrl）、章条目没有字段：什么都不加', async () => {
        await ensureChapterFont({ getTextFileUrl: async () => null }, 'b1', 'default', CH);
        await ensureChapterFont({}, 'b1', 'default', CH);
        const getTextFileUrl = jest.fn(async () => URL_);
        await ensureChapterFont({ getTextFileUrl }, 'b1', 'default', { file: '003' });
        expect(getTextFileUrl).not.toHaveBeenCalled();
        expect(document.querySelectorAll('style')).toHaveLength(0);
    });
});
