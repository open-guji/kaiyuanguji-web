/**
 * chapter-fonts.test.mjs — 章生僻字子集（GUJI-701／GUJI-721）：码位筛选、收字、写回 index.json、清理旧子集；
 * 依赖齐（JIGMO_DIR＋python3 uharfbuzz/fonttools/brotli）时再跑一遍真生成，确认两次逐字节相同、超 256 字切块。
 * 用法：node --test scripts/lib/chapter-fonts.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
    applyFontResults, chapterFontContext, chapterSourceText, charVariantMemo, collectFontJobs, FONT_RANGES, FONT_SUFFIX, inRanges, rareCodepoints, runFontJobs,
} from './chapter-fonts.mjs';

const r = FONT_RANGES;
const same = [(s) => s];

test('兜底码位段：扩 A、基本区末尾、兼容区、第 2／3 平面要字体；基本区前段、PUA 不要', () => {
    for (const cp of [0x3400, 0x4dbf, 0x9fa6, 0x9fff, 0xf900, 0x20000, 0x2ebf0, 0x2f800, 0x30000, 0x323b0, 0x3347f]) assert.equal(inRanges(cp, r), true, cp.toString(16));
    for (const cp of [0x4e00, 0x9fa5, 0xe000, 0xf8ff, 0x2fa20, 0x33480, 0xf0000]) assert.equal(inRanges(cp, r), false, cp.toString(16));
});

test('码位：原字与转换结果都算，只收段内的，按首次出现的先后', () => {
    // 假转换：把「巘」转成扩展 C 的 U+2AA58（真站上是 opencc：巘→𪩘）
    const variants = [(s) => s, (s) => s.replace('巘', String.fromCodePoint(0x2aa58))];
    assert.deepEqual(rareCodepoints('𠈁一巘㒋𠈁', r, variants), [0x20201, 0x348b, 0x2aa58]);
    // 扩 J（U+323B0）也收：花园明朝没有，Jigmo 2025 有
    assert.deepEqual(rareCodepoints(`甲${String.fromCodePoint(0x323b0)}`, r, same), [0x323b0]);
});

test('逐字转换备忘：原字在前、转换结果在后；同一个字只转一次', () => {
    let calls = 0;
    const conv = charVariantMemo([(s) => s, (s) => { calls++; return s.replace('巘', '𪩘'); }]);
    assert.equal(conv(['㒋', '巘']), '㒋巘㒋𪩘');
    assert.equal(conv(['巘', '甲']), '巘甲𪩘甲');
    assert.equal(calls, 2); // 第二次只转了没见过的「甲」
    assert.deepEqual(rareCodepoints(conv(['巘', '甲']), r), [0x2aa58]);
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
    writeFileSync(join(dir, '002.txt'), '乙𠈁乙');
    writeFileSync(join(dir, `003${FONT_SUFFIX}`), 'old');
    writeFileSync(join(dir, '003.font-2.woff2'), 'old part');
    writeFileSync(join(dir, `009${FONT_SUFFIX}`), 'stale');
    return { item, dir };
}

test('每章都收（正文 txt＋对读章的 char）；写回 font_file／font_range／font_parts，没字的章去掉旧字段、删旧子集', () => {
    const { item, dir } = fixture();
    const jobs = collectFontJobs(item, { ranges: r, variants: same });
    assert.deepEqual(jobs.map((j) => [j.file, j.cps]), [['001', [0x348b]], ['002', [0x20201]], ['003', []]]);
    const n = applyFontResults(jobs, [
        [{ file: '001.font.woff2', range: 'U+348B' }],
        [{ file: '002.font.woff2', range: 'U+20201' }, { file: '002.font-2.woff2', range: 'U+20202' }],
        [],
    ]);
    assert.equal(n, 2);
    const idx = JSON.parse(readFileSync(join(dir, 'index.json'), 'utf-8'));
    assert.deepEqual(idx.chapters[0], { n: 1, file: '001', title: '甲', char_file: '001.char.json', font_file: '001.font.woff2', font_range: 'U+348B' });
    assert.deepEqual(idx.chapters[1], {
        n: 2, file: '002', title: '乙', font_file: '002.font.woff2', font_range: 'U+20201', font_parts: [{ file: '002.font-2.woff2', range: 'U+20202' }],
    });
    assert.deepEqual(idx.chapters[2], { n: 3, file: '003', title: '丙', char_file: '003.char.json' });
    for (const f of [`003${FONT_SUFFIX}`, '003.font-2.woff2', `009${FONT_SUFFIX}`]) assert.equal(existsSync(join(dir, f)), false, f);
});

test('目录里的生僻字每章都收（阅读页侧栏常驻）', () => {
    const { item, dir } = fixture();
    const idx = JSON.parse(readFileSync(join(dir, 'index.json'), 'utf-8'));
    idx.chapters[1].title = '卷㐀';
    writeFileSync(join(dir, 'index.json'), JSON.stringify(idx));
    const jobs = collectFontJobs(item, { ranges: r, variants: same });
    assert.deepEqual(jobs.map((j) => j.cps), [[0x348b, 0x3400], [0x20201, 0x3400], [0x3400]]);
});

test('条目输出目录不存在（整个条目 internal，没拷）：没有任务，不抛错', () => {
    assert.deepEqual(collectFontJobs(join(tmpdir(), 'cf-nonexistent-dir'), { ranges: r, variants: same }), []);
});

test('没有改动时不重写 index.json（保留源仓的排版字节）', () => {
    const { item, dir } = fixture();
    const raw = '{"chapters":[{"file":"004","title":"丁","char_file":"001.char.json"}]}';
    writeFileSync(join(dir, 'index.json'), raw);
    writeFileSync(join(dir, '001.char.json'), JSON.stringify({ pages: [] }));
    const jobs = collectFontJobs(item, { ranges: r, variants: same });
    applyFontResults(jobs, runFontJobs(jobs, { jigmoDir: '/nonexistent' })); // 没字：不调 python
    assert.equal(readFileSync(join(dir, 'index.json'), 'utf-8'), raw);
});

test('依赖不齐：缺省跳过，required 时抛错，off 直接跳过', async () => {
    assert.ok((await chapterFontContext({ JIGMO_DIR: '/nonexistent' })).skip);
    await assert.rejects(chapterFontContext({ JIGMO_DIR: '/nonexistent', KYG_CHAPTER_FONTS: 'required' }), /JIGMO_DIR/);
    assert.equal((await chapterFontContext({ KYG_CHAPTER_FONTS: 'off', JIGMO_DIR: '/x' })).skip, 'KYG_CHAPTER_FONTS=off');
});

test('真生成（要 JIGMO_DIR 与 uharfbuzz／fonttools；缺就跳过）：两次逐字节相同，range 只含有字形的码位，三档合成一块', async (t) => {
    const ctx = await chapterFontContext();
    if (ctx.skip) return t.skip(ctx.skip);
    const a = mkdtempSync(join(tmpdir(), 'cf-a-'));
    const b = mkdtempSync(join(tmpdir(), 'cf-b-'));
    // 扩 A（Jigmo）、扩 B（Jigmo2）、扩 J（Jigmo3）各一个，外加 PUA（Jigmo 没有字形，不收）
    const cps = [0x20201, 0x348b, 0x323b0, 0xe000];
    const [ra, rb] = [a, b].map((d) => runFontJobs([{ out: join(d, `x${FONT_SUFFIX}`), cps }], { ...ctx, cacheDir: null })[0]);
    assert.deepEqual(ra, [{ file: `x${FONT_SUFFIX}`, range: 'U+348B,U+20201,U+323B0' }]);
    assert.deepEqual(rb, ra);
    const fa = readFileSync(join(a, `x${FONT_SUFFIX}`));
    assert.ok(fa.length > 500 && fa.length < 20000, `size ${fa.length}`);
    assert.deepEqual(fa, readFileSync(join(b, `x${FONT_SUFFIX}`)));
});

test('真生成：超过 256 字按先后切块，缓存命中与现裁逐字节相同', async (t) => {
    const ctx = await chapterFontContext();
    if (ctx.skip) return t.skip(ctx.skip);
    const cache = mkdtempSync(join(tmpdir(), 'cf-cache-'));
    const cps = Array.from({ length: 300 }, (_, i) => 0x20000 + 300 - i); // 倒序给：切块按给的先后，不按码位
    const out = (d) => runFontJobs([{ out: join(d, `y${FONT_SUFFIX}`), cps }], { ...ctx, cacheDir: cache })[0];
    const [d1, d2] = [mkdtempSync(join(tmpdir(), 'cf-c1-')), mkdtempSync(join(tmpdir(), 'cf-c2-'))];
    const p1 = out(d1);
    assert.deepEqual(p1.map((p) => p.file), [`y${FONT_SUFFIX}`, 'y.font-2.woff2']);
    assert.equal(p1[0].range, 'U+2002D-2012C'); // 前 256 个（0x2012C 往下数）
    assert.equal(p1[1].range, 'U+20001-2002C');
    assert.deepEqual(out(d2), p1); // 第二次全部命中缓存
    for (const f of [`y${FONT_SUFFIX}`, 'y.font-2.woff2']) assert.deepEqual(readFileSync(join(d1, f)), readFileSync(join(d2, f)));
});
