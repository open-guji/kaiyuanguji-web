/**
 * chapter-font.ts：对读章生僻字子集字体（GUJI-701）——章条目字段校验、CSS、站内换章时注入（不重复、给不出地址就不加）。
 */
import { jest } from '@jest/globals';
import { chapterFontCss, chapterFontMeta, ensureChapterFont, isCssSafeUrl } from '../chapter-font';

const CH = { file: '002', font_file: '002.font.woff2', font_range: 'U+348B,U+20201-20203' };
const URL_ = 'https://data.test/current/items/b1/default/002.font.woff2?v=k1';

afterEach(() => { document.body.innerHTML = ''; });

describe('chapter-font', () => {
    it('字段校验：文件名只认 .woff2 单段名，range 只认 unicode-range 语法', () => {
        expect(chapterFontMeta(CH)).toEqual({ file: '002.font.woff2', range: 'U+348B,U+20201-20203' });
        expect(chapterFontMeta({ ...CH, font_file: '../x.woff2' })).toBeNull();
        expect(chapterFontMeta({ ...CH, font_file: '002.font.css' })).toBeNull();
        expect(chapterFontMeta({ ...CH, font_range: 'U+348B;}body{color:red' })).toBeNull();
        expect(chapterFontMeta(null)).toBeNull();
        expect(isCssSafeUrl(URL_)).toBe(true);
        expect(isCssSafeUrl('https://x/a"b')).toBe(false);
    });

    it('CSS：HanaMinA、HanaMinB 两条同地址的 @font-face', () => {
        const css = chapterFontCss({ href: URL_, range: 'U+348B' });
        expect(css.match(/@font-face/g)).toHaveLength(2);
        expect(css).toContain('font-family:"HanaMinB"');
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

    it('给不出地址（h1 布局／没有 getTextFileUrl）、章条目没有字段：什么都不加', async () => {
        await ensureChapterFont({ getTextFileUrl: async () => null }, 'b1', 'default', CH);
        await ensureChapterFont({}, 'b1', 'default', CH);
        const getTextFileUrl = jest.fn(async () => URL_);
        await ensureChapterFont({ getTextFileUrl }, 'b1', 'default', { file: '003' });
        expect(getTextFileUrl).not.toHaveBeenCalled();
        expect(document.querySelectorAll('style')).toHaveLength(0);
    });
});
