/**
 * 「下载本冊」对照测试：手编小样本 × 每种选项，输出与标准答案逐字节比对，防止以后改动悄悄变了输出。
 *
 * cases/<样本>/input.json  手编的 char／punct／entity（／fig），note 写这个样本覆盖哪些情况
 * cases/<样本>/{lines,works,plain,linked}[.nofig].md
 *     正文标准答案，由 book-text 的 Python 生成器出：python3 nextjs/scripts/export-golden.py --book-text <book-text 检出>
 * cases/<样本>/full/*.md
 *     整个下载文件（front matter ＋ 正文 ＋ 字形转换）和文件名，由本测试生成：UPDATE_GOLDEN=1 npx jest src/lib/export
 *
 * 改了生成规则：两套答案都重出，在 PR 里逐个看 .md 的改动是否都是预期的。
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { renderLines, renderRich, type EntityMode } from '../guji-md';
import { buildExport, type ExportChapter, type ExportFormat, type ExportGlyph } from '../download';
import { normalizeVariants, toSimplified } from '@/lib/server/simplify';

const DIR = join(__dirname, 'cases');
const UPDATE = process.env.UPDATE_GOLDEN === '1';

interface Case { name: string; note: string; char: any; punct: any; entity: any; fig?: any } // eslint-disable-line @typescript-eslint/no-explicit-any
const cases: Case[] = readdirSync(DIR).filter((d) => existsSync(join(DIR, d, 'input.json'))).sort()
    .map((name) => ({ name, ...JSON.parse(readFileSync(join(DIR, name, 'input.json'), 'utf-8')) }));
const read = (...p: string[]) => readFileSync(join(DIR, ...p), 'utf-8');

const MODES: EntityMode[] = ['works', 'plain', 'linked'];

/* ── 一、正文：与 Python 生成器逐字节一致 ─────────────────────────────── */

describe('正文与 book-text Python 生成器一致', () => {
    it('样本齐全', () => expect(cases.length).toBeGreaterThanOrEqual(10));
    for (const c of cases) {
        describe(`${c.name}（${c.note}）`, () => {
            const variants: [string, unknown][] = [['', c.fig ?? null]];
            if (c.fig !== undefined) variants.push(['.nofig', null]);
            for (const [suffix, fig] of variants) {
                const tag = suffix ? '，不给 fig.json' : '';
                it(`分行本${tag}`, () => expect(renderLines(c.char, fig as never)).toBe(read(c.name, `lines${suffix}.md`)));
                for (const m of MODES) {
                    it(`${m}${tag}`, () => expect(renderRich(c.char, c.punct, c.entity, { entities: m, fig: fig as never })).toBe(read(c.name, `${m}${suffix}.md`)));
                }
            }
        });
    }
});

/* ── 二、字形转换只动字，不动记号 ───────────────────────────────────── */

describe('字形转换不碰标记', () => {
    // 记号（:zi[…] 的组字式、{type=单行}、图 id、链接）在转换前后应原样；正文汉字一对一替换，长度不变
    const MARKUP = /<!-- p\d+ -->|\]\(book-index:\/\/[^)]*\)|\{type=单行\}|\{id=[^}]*\}|\{guess=|:zi\[[^\]]*\]|::?tu\[|:zm\[|:jz\[|\[\[\]\]/g;
    for (const c of cases) {
        for (const m of MODES) {
            const text = renderRich(c.char, c.punct, c.entity, { entities: m, fig: c.fig });
            it(`${c.name} ${m}`, () => {
                for (const conv of [normalizeVariants, toSimplified]) {
                    const out = conv(text);
                    expect([...out].length).toBe([...text].length);
                    expect(out.match(MARKUP)).toEqual(text.match(MARKUP));
                }
            });
        }
    }
});

/* ── 三、整个下载文件：front matter ＋ 正文 ＋ 字形 ＋ 文件名 ─────────── */

const NOW = new Date('2026-11-02T12:00:00Z');
const FORMATS: { key: string; format: ExportFormat; links: boolean; body: string }[] = [
    { key: 'lines', format: 'lines', links: false, body: 'lines' },
    { key: 'punct', format: 'punct', links: true, body: 'works' },
    { key: 'entity-plain', format: 'entity', links: false, body: 'plain' },
    { key: 'entity-linked', format: 'entity', links: true, body: 'linked' },
];
const GLYPHS: ExportGlyph[] = ['original', 'traditional', 'simplified'];

/** 假的取数：章条目里写的文件名 → 样本里的层；记下取了哪些 */
function storageFor(c: Case) {
    const asked: string[] = [];
    const files: Record<string, unknown> = { 'c.char.json': c.char, 'c.punct.json': c.punct, 'c.entity.json': c.entity, 'c.fig.json': c.fig };
    return { asked, getTextFile: async (_id: string, _key: string, f: string) => { asked.push(f); return files[f] ?? null; } };
}

function chapterFor(c: Case, vol: string): ExportChapter {
    return {
        file: vol, title: '測試章', char_file: 'c.char.json', punct_file: 'c.punct.json', entity_file: 'c.entity.json',
        fig_file: c.fig !== undefined ? 'c.fig.json' : undefined,
        text_version: '0.3.1', punct_version: '0.2.0', entity_version: '0.4.12',
    };
}

const FULL: { case: string; vol: string; meta: object }[] = [
    // 元数据给全
    { case: '09-专名', vol: '009', meta: { versionLabel: '開源古籍自校本', edition: '文淵閣本', license: 'CC0 1.0', dataVersion: '2026.11.02', pageUrl: 'https://openguji.com/read/t1' } },
    { case: '10-字形', vol: '010', meta: { versionLabel: '開源古籍自校本', license: 'CC0 1.0', pageUrl: 'https://openguji.com/read/t1' } },
    // 元数据只给最少：没给的键不出；有图要取 fig.json
    { case: '06-插图', vol: '006', meta: {} },
];

describe('整个下载文件', () => {
    const filenames: Record<string, Record<string, string>> = {};
    for (const f of FULL) {
        const c = cases.find((x) => x.name === f.case)!;
        const goldenDir = join(DIR, f.case, 'full');
        const namesFile = join(goldenDir, 'filenames.json');
        const names: Record<string, string> = !UPDATE && existsSync(namesFile) ? JSON.parse(readFileSync(namesFile, 'utf-8')) : {};
        filenames[f.case] = names;
        describe(f.case, () => {
            for (const fm of FORMATS) {
                for (const g of GLYPHS) {
                    const key = `${fm.key}-${g}`;
                    it(key, async () => {
                        const s = storageFor(c);
                        const r = await buildExport({
                            id: 't1', versionKey: 'default', chapter: chapterFor(c, f.vol), bookTitle: '測試書',
                            format: fm.format, links: fm.links, glyph: g, now: NOW, ...f.meta,
                        }, s);
                        // 取数：分行本不取标点、专名；有图才取图
                        expect(s.asked.includes('c.punct.json')).toBe(fm.format !== 'lines');
                        expect(s.asked.includes('c.fig.json')).toBe(c.fig !== undefined);
                        // 原书字形时正文就是 Python 答案
                        const body = r.text.slice(r.text.indexOf('\n---\n') + 5);
                        if (g === 'original') expect(body).toBe(read(f.case, `${fm.body}.md`));
                        const file = join(goldenDir, `${key}.md`);
                        if (UPDATE) {
                            mkdirSync(goldenDir, { recursive: true });
                            writeFileSync(file, r.text);
                            names[key] = r.filename;
                        } else {
                            expect(r.text).toBe(readFileSync(file, 'utf-8'));
                            expect(r.filename).toBe(names[key]);
                        }
                    });
                }
            }
        });
    }
    afterAll(() => {
        if (!UPDATE) return;
        for (const [k, v] of Object.entries(filenames)) writeFileSync(join(DIR, k, 'full', 'filenames.json'), JSON.stringify(v, null, 1) + '\n');
    });
});

/* ── 四、坏数据：报错，不出半截文件 ─────────────────────────────────── */

describe('坏数据报错', () => {
    const c = cases.find((x) => x.name === '09-专名')!;
    const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));
    it('不认识的 lane', () => {
        const char = clone(c.char);
        char.pages[0].columns[0].cells[0].lane = 'side';
        expect(() => renderLines(char)).toThrow('不认识的 lane');
    });
    it('标点格位不在 char 里', () => {
        const punct = clone(c.punct);
        punct.punctuations[0].anchor = '99:1:1';
        expect(() => renderRich(c.char, punct, c.entity)).toThrow('不在 char 里');
    });
    it('标点校验字对不上', () => {
        const punct = clone(c.punct);
        punct.punctuations[0].pre_char = '經';
        expect(() => renderRich(c.char, punct, c.entity)).toThrow('校验字');
    });
    it('专名格位不在 char 里（标点本也报：整章校验）', () => {
        const entity = clone(c.entity);
        entity.entities[1].anchor.end = '99:1:1';
        expect(() => renderRich(c.char, c.punct, entity, { entities: 'works' })).toThrow('不在 char 里');
    });
    it('专名校验字对不上', () => {
        const entity = clone(c.entity);
        entity.entities[1].text = '鄭康成';
        expect(() => renderRich(c.char, c.punct, entity, { entities: 'plain' })).toThrow('校验字');
    });
    it('图的说明里有方括号', () => {
        const f = cases.find((x) => x.name === '06-插图')!;
        const fig = clone(f.fig);
        fig.figures[0].alt = '實[點]';
        expect(() => renderLines(f.char, fig)).toThrow('方括号');
    });
});
