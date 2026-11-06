import { diffChars } from '../diff';
import { wikiChars } from '../wikitext';
import { classify } from '../classify';
import { cnNumber, volumeNo, wikiFileOf, splitVolumes, nextContinues, type BaseCell } from '../volumes';
import { compareChapter, trimWikiToBase } from '../compare';
import { buildVariantTest } from '../variants';
import { parseCmp, formatCmp } from '../url';

const arr = (s: string) => Array.from(s);
const cellsOf = (s: string, page = 1): BaseCell[] => arr(s).map((c, i) => ({ c, a: `${page}:${Math.floor(i / 20) + 1}:${(i % 20) + 1}` }));

describe('diffChars', () => {
    it('相同文本无差异', () => expect(diffChars(arr('天地玄黃'), arr('天地玄黃'))).toEqual([]));
    it('替换、增、删', () => {
        expect(diffChars(arr('天地玄黃'), arr('天地元黃'))).toEqual([{ i1: 2, i2: 3, j1: 2, j2: 3 }]);
        expect(diffChars(arr('天地黃'), arr('天地玄黃'))).toEqual([{ i1: 2, i2: 2, j1: 2, j2: 3 }]);
        expect(diffChars(arr('天地玄黃'), arr('天地黃'))).toEqual([{ i1: 2, i2: 3, j1: 2, j2: 2 }]);
    });
    it('相邻的删与增合并成一处替换', () => {
        expect(diffChars(arr('甲乙丙丁'), arr('甲XY丁'))).toEqual([{ i1: 1, i2: 3, j1: 1, j2: 3 }]);
    });
    it('生僻字（代理对）按码点算一个字', () => {
        const hs = diffChars(arr('𡚁之'), arr('弊之'));
        expect(hs).toEqual([{ i1: 0, i2: 1, j1: 0, j2: 1 }]);
    });
    it('差异超过上限返回 null', () => {
        expect(diffChars(arr('abcdefghij'), arr('klmnopqrst'), 5)).toBeNull();
    });
});

describe('wikiChars', () => {
    it('去卷标题行、整理状态行、井号与全部标点空白，保留标题文字', () => {
        const md = '## 卷001\n\n## 經部總敍\n經稟聖裁，垂型萬世。\n有标点，简繁转换错误。\n好\n## 《子夏易傳》 十一卷\n「內府」藏本\n已修正。\n';
        expect(wikiChars(md).join('')).toBe('經部總敍經稟聖裁垂型萬世子夏易傳十一卷內府藏本');
    });
    it('□ 保留', () => expect(wikiChars('甲□乙。').join('')).toBe('甲□乙'));
});

describe('classify', () => {
    const isVariant = buildVariantTest({ pairs: '葢蓋\n畧略' });
    const base = arr('葢天按');
    it('异体', () => expect(classify({ i1: 0, i2: 1, j1: 0, j2: 1 }, base, arr('蓋天案'), { isVariant })).toBe('glyph'));
    it('用字不同（含通假）', () => expect(classify({ i1: 2, i2: 3, j1: 2, j2: 3 }, base, arr('蓋天案'), { isVariant })).toBe('word'));
    it('表没载入时都算用字不同', () => expect(classify({ i1: 0, i2: 1, j1: 0, j2: 1 }, base, arr('蓋天案'), { isVariant: null })).toBe('word'));
    it('增、删、卷端署题', () => {
        expect(classify({ i1: 1, i2: 1, j1: 1, j2: 2 }, base, arr('蓋X天案'), { isVariant })).toBe('add');
        expect(classify({ i1: 1, i2: 2, j1: 1, j2: 1 }, base, arr('葢案'), { isVariant })).toBe('omit');
        expect(classify({ i1: 0, i2: 1, j1: 0, j2: 0 }, base, arr('天按'), { isVariant, structEnd: 2 })).toBe('struct');
    });
    it('多字替换逐字判：全是异体才算异体', () => {
        expect(classify({ i1: 0, i2: 2, j1: 0, j2: 2 }, arr('葢畧'), arr('蓋略'), { isVariant })).toBe('glyph');
        expect(classify({ i1: 0, i2: 2, j1: 0, j2: 2 }, arr('葢按'), arr('蓋案'), { isVariant })).toBe('word');
    });
});

describe('volumes', () => {
    it('汉字数字', () => {
        expect([cnNumber('一'), cnNumber('十'), cnNumber('十二'), cnNumber('二十'), cnNumber('一百二十'), cnNumber('一百零五'), cnNumber('二百'), cnNumber('一〇二')]).toEqual([1, 10, 12, 20, 120, 105, 200, 102]);
        expect(cnNumber('甲')).toBeNull();
    });
    it('一级标题 → 卷序号', () => {
        expect(volumeNo('卷一　經部一')).toBe(1);
        expect(volumeNo('卷一百二十　集部')).toBe(120);
        expect(volumeNo('卷首')).toBeNull();
    });
    it('卷序号 → 对照本章', () => {
        const ch = [{ file: '005', title: '卷001' }, { file: '006', title: '卷002' }];
        expect(wikiFileOf(2, ch)).toBe('006');
        expect(wikiFileOf(9, ch)).toBeNull();
    });
    const cells = cellsOf('甲'.repeat(60));
    const hs = [
        { level: 1, label: '卷一　經部一', anchor: '1:1:1' },
        { level: 2, label: '總敘', anchor: '1:1:6' },
        { level: 1, label: '卷二　經部二', anchor: '1:2:1' },
    ];
    it('按一级标题分卷，带卷端署题区', () => {
        const segs = splitVolumes(cells, hs, null, false);
        expect(segs.map((s) => [s.no, s.from, s.to, s.startsPartial, s.endsPartial, s.headEnd])).toEqual([
            [1, 0, 20, false, false, 5],
            [2, 20, 60, false, false, 20],
        ]);
    });
    it('册首在上一册的卷里：补一段接续；末卷可能延续到下一册', () => {
        const segs = splitVolumes(cells, [{ level: 1, label: '卷二', anchor: '1:2:1' }], 1, true);
        expect(segs.map((s) => [s.no, s.from, s.to, s.startsPartial, s.endsPartial])).toEqual([
            [1, 0, 20, true, false],
            [2, 20, 60, false, true],
        ]);
    });
    it('下一册是否接着本册最后一卷', () => {
        expect(nextContinues([{ level: 1, label: '卷五', anchor: '1:1:1' }])).toBe(false);
        expect(nextContinues([{ level: 1, label: '卷五', anchor: '3:2:1' }])).toBe(true);
        expect(nextContinues(undefined)).toBe(false);
    });
});

describe('trimWikiToBase', () => {
    const wiki = arr('０１２３４５６７８９'.repeat(0) + '子曰學而時習之不亦說乎有朋自遠方來不亦樂乎人不知而不慍不亦君子乎有子曰其為人也孝弟而好犯上者鮮矣');
    it('册首接续：把对照本裁到对应的位置', () => {
        const base = arr('有朋自遠方來不亦樂乎人不知而不慍不亦君子乎');
        const [a, b] = trimWikiToBase(base, wiki, true, true);
        expect(wiki.slice(a, b).join('')).toBe('有朋自遠方來不亦樂乎人不知而不慍不亦君子乎');
    });
    it('都不是接续就整卷', () => expect(trimWikiToBase(arr('x'), wiki, false, false)).toEqual([0, wiki.length]));
});

describe('compareChapter', () => {
    const isVariant = buildVariantTest({ pairs: '葢蓋' });
    const wikiMd = '## 卷001\n\n## 總敘\n葢天地，按之。\n有标点。\n';
    const run = (base: string, headings = [{ level: 1, label: '卷一　經部', anchor: '1:1:1' }], md: string | null = wikiMd) =>
        compareChapter({ cells: cellsOf(base), headings, prevVolNo: null, lastContinues: false, wikiChapters: [{ file: '005', title: '卷001' }], getWikiMd: async () => md, isVariant });
    it('分类、位置、上下文', async () => {
        const r = await run('總敘蓋天X地案之');
        expect(r.segments[0]).toMatchObject({ status: 'ok', wikiFile: '005' });
        expect(r.items.map((i) => [i.cat, i.type, i.base, i.reading, i.anchor.start])).toEqual([
            ['glyph', 'sub', '蓋', '葢', '1:1:3'],
            ['omit', 'del', 'X', '', '1:1:5'],
            ['word', 'sub', '案', '按', '1:1:7'],
        ]);
        expect(r.items[2].ctx.base).toEqual(['總敘蓋天X地', '之']);
    });
    it('纯增：锚点取插入点前一字', async () => {
        const r = await run('總敘葢天地按之'.replace('天地', '天'));
        const add = r.items.find((i) => i.type === 'ins');
        expect(add).toMatchObject({ cat: 'add', reading: '地', anchor: { start: '1:1:4', end: '1:1:4' }, i1: 4, i2: 4 });
    });
    it('卷找不到对照本、取不到、太不同都不报错，只标状态', async () => {
        expect((await run('甲乙', [{ level: 1, label: '卷九', anchor: '1:1:1' }])).segments[0].status).toBe('no-wiki');
        expect((await run('甲乙', undefined, null)).segments[0].status).toBe('fetch-failed');
    });
});

describe('cmp 参数', () => {
    it('解析', () => {
        expect(parseCmp('d59dh3vo9af4-wikisource')).toEqual({ id: 'd59dh3vo9af4', key: 'wikisource' });
        expect(parseCmp('d59dh3vo9af4-wikisource-2')).toEqual({ id: 'd59dh3vo9af4', key: 'wikisource-2' });
        expect(parseCmp('d59dh3vo9af4')).toEqual({ id: 'd59dh3vo9af4' });
        expect(parseCmp('a-x,b-y')).toEqual({ id: 'a', key: 'x' });
    });
    it('不合法返回 null', () => {
        for (const bad of ['', null, undefined, 'A-b', 'a-1x', 'a b', '-x', '../x']) expect(parseCmp(bad as string)).toBeNull();
    });
    it('格式化', () => expect(formatCmp({ id: 'a', key: 'x' })).toBe('a-x'));
});
