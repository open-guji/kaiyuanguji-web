/**
 * overview#448 S0／S1：全站唯一的 toSimplified 入口。
 * 快照（异体字、繁简多对一、标点、组字式）＋长度相等＋不得用 s2t／tw2s／*p＋opencc-js 版本钉死。
 */
import * as fs from 'fs';
import * as path from 'path';
import VARIANT_CHARS from 'book-index-ui/variant-chars.json';
import { toSimplified } from '../simplify';
import { assertSameLength, codePointLength, createToSimplified, normalizeVariants } from '../../to-simplified-core.mjs';

const VARIANTS = VARIANT_CHARS as Record<string, string>;

// ── S1：快照 ──────────────────────────────────────────────────────────────

/** variant-chars.json 的典型异体字：固定取脂评、书目里用户报过的几个，加表里头尾各若干条、再加扩展区字 */
const VARIANT_SAMPLES = ['㫖', '縂', '寳', ...Object.keys(VARIANTS).slice(0, 12), ...Object.keys(VARIANTS).slice(-12), ...Object.keys(VARIANTS).filter((c) => c.codePointAt(0)! > 0xffff).slice(0, 4)];

/** 繁简多对一：简体一个字对应繁体多个字（后／後、发／發髮、里／裡裏……），及「著」「乾」这类不该乱转的字 */
const MANY_TO_ONE = ['後', '后', '發', '髮', '裡', '裏', '里', '於', '于', '雲', '云', '餘', '余', '乾', '幹', '榦', '麵', '面', '臺', '檯', '颱', '台', '著録', '所著', '乾隆', '干支', '瞭解', '嚮往', '徵', '征', '鬥', '斗'];

/** 标点：全角、书名号、引号、省略号、间隔号，须一个不动 */
const PUNCTUATION = '，。、；：？！「」『』《》〈〉（）［］【】〔〕……——·﹏“”‘’';

/** 组字式（CBETA／维基）：括号、星号、斜杠、字母数字必须原样，且字数不变 */
const COMPOSED = ['[口*恒]', '[薛/女]', '{宀兒}', '[B18D]', '[金*(咢-丂+八)]', '〔〕'];

describe('S1 快照', () => {
    it('variant-chars.json 的异体字', () => {
        expect(VARIANT_SAMPLES.map((c) => [c, toSimplified(c)])).toMatchSnapshot();
    });

    it('繁简多对一', () => {
        expect(MANY_TO_ONE.map((c) => [c, toSimplified(c)])).toMatchSnapshot();
    });

    it('标点一个不动', () => {
        expect(toSimplified(PUNCTUATION)).toBe(PUNCTUATION);
    });

    it('组字式：括号、符号、字母数字原样，字数不变', () => {
        const out = COMPOSED.map((s) => [s, toSimplified(s)]);
        expect(out).toMatchSnapshot();
        for (const [src, got] of out) {
            expect(got.replace(/[^\[\]{}()*\/+\-A-Za-z0-9〔〕]/g, '')).toBe(src.replace(/[^\[\]{}()*\/+\-A-Za-z0-9〔〕]/g, ''));
            expect(codePointLength(got)).toBe(codePointLength(src));
        }
    });

    it('整句：异体字归一＋t2cn＋标点', () => {
        const s = '凡例云：其㫖縂在風月寳鑑，後漢書於是乎著録；髮、麵、裡皆有之。';
        expect(toSimplified(s)).toMatchSnapshot();
    });
});

// ── S0：长度相等 ──────────────────────────────────────────────────────────

describe('S0 转换前后长度相等', () => {
    const ALL = [...VARIANT_SAMPLES, ...MANY_TO_ONE, PUNCTUATION, ...COMPOSED, '𠮓𠀀𪚥', '凡例云：其㫖縂在風月寳鑑'];

    it('每个样本码点数不变（简体下标＝原文下标）', () => {
        for (const s of ALL) expect(codePointLength(toSimplified(s))).toBe(codePointLength(s));
        const joined = ALL.join('');
        expect(codePointLength(toSimplified(joined))).toBe(codePointLength(joined));
    });

    it('整张 variant-chars 表也等长', () => {
        const all = Object.keys(VARIANTS).join('');
        assertSameLength(all, toSimplified(all));
    });

    it('assertSameLength 抛错、codePointLength 按码点算', () => {
        expect(codePointLength('𠮓a')).toBe(2);
        expect(() => assertSameLength('abc', 'ab')).toThrow(/长度/);
        expect(assertSameLength('𠮓a', '甲a')).toBe('甲a');
    });

    it('转换器若改变了长度：退回逐码点转换，仍等长', () => {
        const warn = jest.fn();
        // 假转换器：把「ab」整词压成「X」（长度变短），单字原样
        const fn = createToSimplified({ createConverter: () => (t: string) => t.replace(/ab/g, 'X'), variants: {}, warn });
        const out = fn('xaby');
        expect(out).toBe('xaby');
        expect(codePointLength(out)).toBe(4);
        expect(warn).toHaveBeenCalledTimes(1);
    });

    it('逐码点仍不等长：只做异体字归一', () => {
        const fn = createToSimplified({ createConverter: () => (t: string) => t + '!', variants: { 寳: '寶' }, warn: () => {} });
        expect(fn('寳')).toBe('寶');
    });

    it('转换器建不出来：原样返回，不抛', () => {
        const warn = jest.fn();
        const fn = createToSimplified({ createConverter: () => { throw new Error('boom'); }, variants: {}, warn });
        expect(fn('寳')).toBe('寳');
        expect(warn).toHaveBeenCalled();
        expect(fn('')).toBe('');
    });

    it('normalizeVariants 按码位，扩展区字也换', () => {
        const astral = Object.keys(VARIANTS).find((c) => c.codePointAt(0)! > 0xffff)!;
        expect(normalizeVariants(`甲${astral}乙`, VARIANTS)).toBe(`甲${VARIANTS[astral]}乙`);
    });
});

// ── S0：方向与版本护栏 ────────────────────────────────────────────────────

const REPO = path.resolve(__dirname, '../../../../..');

function walk(dir: string, out: string[] = []): string[] {
    for (const name of fs.readdirSync(dir, { withFileTypes: true })) {
        if (name.name === 'node_modules' || name.name === '.next' || name.name === '.git') continue;
        const p = path.join(dir, name.name);
        if (name.isDirectory()) walk(p, out);
        else if (/\.(m?js|tsx?)$/.test(name.name)) out.push(p);
    }
    return out;
}

describe('S0 护栏', () => {
    const files = [...walk(path.join(REPO, 'nextjs/src')), ...walk(path.join(REPO, 'nextjs/scripts')), ...walk(path.join(REPO, 'indexer'))].filter(
        (f) => !f.includes('__tests__') && !/\.test\.(m?js|tsx?)$/.test(f),
    );

    it('不用 s2t／tw2s／*p 预设（存储文本绝不转繁；著録 不能变 着录）', () => {
        const bad = /to:\s*['"](t|tw|twp|hk|hkp|jp)['"]|from:\s*['"](cn|tw|twp|hk|hkp|jp)['"]|\b(s2t|s2tw|s2twp|s2hk|t2tw|tw2s|tw2sp|hk2s|cn2t)\b/;
        // 核心文件的注释里会写到这些名字（说明为什么不用），不算
        const hits = files.filter((f) => !f.endsWith('to-simplified-core.mjs') && bad.test(fs.readFileSync(f, 'utf-8'))).map((f) => path.relative(REPO, f));
        expect(hits).toEqual([]);
    });

    it('只有入口文件自己 new Converter（其余都经 toSimplified）', () => {
        const hits = files.filter((f) => !f.endsWith('to-simplified-core.mjs') && /\bConverter\s*\(\s*\{/.test(fs.readFileSync(f, 'utf-8'))).map((f) => path.relative(REPO, f)).sort();
        expect(hits).toEqual(['indexer/full-reindex.mjs', 'nextjs/scripts/lib/to-simplified.mjs', 'nextjs/src/lib/server/simplify.ts']);
    });

    it('opencc-js 钉死同一个精确版本：nextjs、indexer 的 package.json 与已装版本一致', () => {
        const web = JSON.parse(fs.readFileSync(path.join(REPO, 'nextjs/package.json'), 'utf-8')).dependencies['opencc-js'];
        const idx = JSON.parse(fs.readFileSync(path.join(REPO, 'indexer/package.json'), 'utf-8')).dependencies['opencc-js'];
        expect(web).toMatch(/^\d+\.\d+\.\d+$/);
        expect(idx).toBe(web);
        const installed = JSON.parse(fs.readFileSync(path.join(REPO, 'nextjs/node_modules/opencc-js/package.json'), 'utf-8')).version;
        expect(installed).toBe(web);
    });

    it('indexer 里的副本与网站的核心逻辑、异体字表逐字相同', () => {
        const read = (p: string) => fs.readFileSync(path.join(REPO, p), 'utf-8');
        expect(read('indexer/lib/to-simplified-core.mjs')).toBe(read('nextjs/src/lib/to-simplified-core.mjs'));
        expect(JSON.parse(read('indexer/lib/variant-chars.json'))).toEqual(VARIANTS);
    });
});
