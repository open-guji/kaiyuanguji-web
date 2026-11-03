/**
 * 下载本冊的生成规则与 book-text Python 生成器逐字节一致（夹具里的 expected 由 original_char.py 生成，见夹具 note）。
 * 夹具是四庫總目几册里挑的页：标题三级、双行夹注跨列合并、相邻专名、抬头、阙文、单行小注、图片格。
 */
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { frontMatter, renderLines, renderRich, GujiFormatError } from '../guji-md';

const DIR = join(__dirname, 'fixtures');
const fixtures = readdirSync(DIR).filter((f) => f.endsWith('.json')).map((f) => ({ name: f, ...JSON.parse(readFileSync(join(DIR, f), 'utf-8')) }));

describe('与 book-text original_char.py 逐字节一致', () => {
    it('夹具齐全', () => expect(fixtures.length).toBeGreaterThanOrEqual(3));
    for (const fx of fixtures) {
        describe(fx.name, () => {
            it('分行本 = render_lines', () => expect(renderLines(fx.char, fx.fig)).toBe(fx.expected.lines));
            it('专名本带链接 = render_rich', () => expect(renderRich(fx.char, fx.punct, fx.entity, { entities: 'linked', fig: fx.fig })).toBe(fx.expected.linked));
            it('专名本不带链接 = render_rich（实体去 href）', () => expect(renderRich(fx.char, fx.punct, fx.entity, { entities: 'plain', fig: fx.fig })).toBe(fx.expected.plain));
            it('标点本 = render_rich（只留书名、去 href）', () => expect(renderRich(fx.char, fx.punct, fx.entity, { entities: 'works', fig: fx.fig })).toBe(fx.expected.works));
        });
    }
});

describe('细节', () => {
    const char = { pages: [{ page: 1, columns: [{ cells: [{ a: '1:1:1', c: '晉' }, { a: '1:1:2', c: '郭' }, { a: '1:1:3', c: '璞' }, { a: '1:1:4', c: '註' }] }] }] };
    const punct = { punctuations: [{ mark: '。', kind: 'point', pos: 'after' as const, anchor: '1:1:4', pre_char: '註' }] };
    const entity = {
        entities: [
            { type: 'dynasty', text: '晉', anchor: { start: '1:1:1', end: '1:1:1' }, target: { status: 'matched', href: 'book-index://Entity/a' } },
            { type: 'people', text: '郭璞', anchor: { start: '1:1:2', end: '1:1:3' }, target: { status: 'matched', href: 'book-index://Entity/b' } },
        ],
    };
    it('相邻专名写 :zm[]', () => {
        expect(renderRich(char, punct, entity, { entities: 'plain' })).toBe('<!-- p1 -->:zm[晉]:zm[郭璞]註。\n');
        expect(renderRich(char, punct, entity, { entities: 'linked' })).toBe('<!-- p1 -->[:zm[晉]](book-index://Entity/a)[:zm[郭璞]](book-index://Entity/b)註。\n');
    });
    it('标点本不出专名号', () => expect(renderRich(char, punct, entity, { entities: 'works' })).toBe('<!-- p1 -->晉郭璞註。\n'));
    it('锚点对不上报错，不出半截文件', () => {
        expect(() => renderRich(char, { punctuations: [{ ...punct.punctuations[0], pre_char: '疏' }] }, null)).toThrow(GujiFormatError);
    });
    it('front matter：值加引号转义，空值不出', () => {
        expect(frontMatter([['title', '欽定四庫全書總目'], ['volume', 40], ['note', 'a"b:c'], ['empty', ''], ['none', undefined]]))
            .toBe('---\ntitle: "欽定四庫全書總目"\nvolume: 40\nnote: "a\\"b:c"\n---\n');
    });
});
