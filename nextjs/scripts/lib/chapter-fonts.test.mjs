/**
 * chapter-fonts.test.mjs — 对读章生僻字子集（GUJI-701）：码位筛选、收字、写回 index.json、清理旧子集；
 * 依赖齐（HANAMIN_DIR＋python3 fonttools/brotli）时再跑一遍真生成，确认两次逐字节相同。
 * 用法：node --test scripts/lib/chapter-fonts.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
    applyFontResults, chapterFontContext, chapterSourceText, collectFontJobs, FONT_SUFFIX, hanaminRanges, inRanges, rareCodepoints, runFontJobs,
} from './chapter-fonts.mjs';

const CSS = `body{}
/* HANAMIN-BEGIN x */
@font-face { font-family: "HanaMinA"; unicode-range: U+3400-37FF; }
@font-face { font-family: "HanaMinB"; unicode-range: U+20000-203FF, U+2A700-2AAFF; }
/* HANAMIN-END */
@font-face { font-family: "Other"; unicode-range: U+4E00-9FFF; }`;

test('只取 HANAMIN 段的 unicode-range，排好序', () => {
    const r = hanaminRanges(CSS);
    assert.deepEqual(r, [[0x3400, 0x37ff], [0x20000, 0x203ff], [0x2a700, 0x2aaff]]);
    assert.equal(inRanges(0x348b, r), true);
    assert.equal(inRanges(0x4e00, r), false); // 常用字不在段里
    assert.throws(() => hanaminRanges('body{}'), /HANAMIN/);
});

test('码位：原字与转换结果都算，只收段内的', () => {
    const r = hanaminRanges(CSS);
    // 假转换：把「鉷」转成扩展 C 的 U+2AA58（真站上是 opencc：巘→𪩘）
    const variants = [(s) => s, (s) => s.replace('巘', String.fromCodePoint(0x2aa58))];
    assert.deepEqual(rareCodepoints('㒋一巘𠈁', r, variants), [0x348b, 0x20201, 0x2aa58]);
});

test('收字：char 各格、norm 的字、全书目录的章名与标题', () => {
    const text = chapterSourceText({
        char: { pages: [{ columns: [{ cells: [{ a: '1:1:1', c: '㒋' }, { a: '1:1:2', c: '一' }] }] }] },
        norm: { items: [{ a: '1:1:1', n: '㕘' }] },
        index: { chapters: [{ title: '卷𠈁', headings: [{ label: '𠉀' }] }, { title: '卷二' }] },
    });
    for (const ch of ['㒋', '一', '㕘', '𠈁', '𠉀', '卷二']) assert.ok(text.includes(ch), ch);
});

function fixture() {
    const item = mkdtempSync(join(tmpdir(), 'cf-'));
    const dir = join(item, 'default');
    mkdirSync(dir);
    const index = {
        book_id: 'x',
        chapters: [
            { n: 1, file: '001', title: '甲', char_file: '001.char.json' },
            { n: 2, file: '002', title: '乙' }, // 不是对读章
            { n: 3, file: '003', title: '丙', char_file: '003.char.json', font_file: '003.font.woff2', font_range: 'U+3400' },
        ],
    };
    writeFileSync(join(dir, 'index.json'), JSON.stringify(index));
    writeFileSync(join(dir, '001.char.json'), JSON.stringify({ pages: [{ columns: [{ cells: [{ a: '1:1:1', c: '㒋' }] }] }] }));
    writeFileSync(join(dir, '003.char.json'), JSON.stringify({ pages: [{ columns: [{ cells: [{ a: '1:1:1', c: '一' }] }] }] }));
    writeFileSync(join(dir, `003${FONT_SUFFIX}`), 'old');
    writeFileSync(join(dir, `009${FONT_SUFFIX}`), 'stale');
    return { item, dir };
}

test('任务只收对读章；写回 font_file／font_range，没字的章去掉旧字段、删旧子集', () => {
    const { item, dir } = fixture();
    const jobs = collectFontJobs(item, { ranges: hanaminRanges(CSS), variants: [(s) => s] });
    assert.deepEqual(jobs.map((j) => [j.file, j.cps]), [['001', [0x348b]], ['003', []]]);
    const n = applyFontResults(jobs, ['U+348B', null]);
    assert.equal(n, 1);
    const idx = JSON.parse(readFileSync(join(dir, 'index.json'), 'utf-8'));
    assert.deepEqual(idx.chapters[0], { n: 1, file: '001', title: '甲', char_file: '001.char.json', font_file: '001.font.woff2', font_range: 'U+348B' });
    assert.deepEqual(idx.chapters[2], { n: 3, file: '003', title: '丙', char_file: '003.char.json' });
    assert.equal(existsSync(join(dir, `003${FONT_SUFFIX}`)), false);
    assert.equal(existsSync(join(dir, `009${FONT_SUFFIX}`)), false);
});

test('条目输出目录不存在（整个条目 internal，没拷）：没有任务，不抛错', () => {
    assert.deepEqual(collectFontJobs(join(tmpdir(), 'cf-nonexistent-dir'), { ranges: hanaminRanges(CSS), variants: [(s) => s] }), []);
});

test('没有改动时不重写 index.json（保留源仓的排版字节）', () => {
    const { item, dir } = fixture();
    const raw = '{"chapters":[{"file":"002","title":"乙","char_file":"001.char.json"}]}';
    writeFileSync(join(dir, 'index.json'), raw);
    writeFileSync(join(dir, '001.char.json'), JSON.stringify({ pages: [] }));
    const jobs = collectFontJobs(item, { ranges: hanaminRanges(CSS), variants: [(s) => s] });
    applyFontResults(jobs, runFontJobs(jobs, { hanaminDir: '/nonexistent' })); // 没字：不调 python
    assert.equal(readFileSync(join(dir, 'index.json'), 'utf-8'), raw);
});

test('依赖不齐：缺省跳过，required 时抛错，off 直接跳过', async () => {
    assert.ok((await chapterFontContext({ HANAMIN_DIR: '/nonexistent' })).skip);
    await assert.rejects(chapterFontContext({ HANAMIN_DIR: '/nonexistent', KYG_CHAPTER_FONTS: 'required' }), /HANAMIN_DIR/);
    assert.equal((await chapterFontContext({ KYG_CHAPTER_FONTS: 'off', HANAMIN_DIR: '/x' })).skip, 'KYG_CHAPTER_FONTS=off');
});

test('真生成（要 HANAMIN_DIR 与 fonttools；缺就跳过）：两次逐字节相同，range 只含有字形的码位', async (t) => {
    const ctx = await chapterFontContext();
    if (ctx.skip) return t.skip(ctx.skip);
    const a = mkdtempSync(join(tmpdir(), 'cf-a-'));
    const b = mkdtempSync(join(tmpdir(), 'cf-b-'));
    const cps = [0x348b, 0x20201, 0x2aa58];
    const [ra, rb] = [a, b].map((d) => runFontJobs([{ out: join(d, 'x.woff2'), cps }], ctx)[0]);
    assert.equal(ra, 'U+348B,U+20201,U+2AA58');
    assert.equal(rb, ra);
    const fa = readFileSync(join(a, 'x.woff2'));
    assert.ok(fa.length > 500 && fa.length < 20000, `size ${fa.length}`);
    assert.deepEqual(fa, readFileSync(join(b, 'x.woff2')));
});
