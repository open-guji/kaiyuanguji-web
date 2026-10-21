import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FONT_RANGES } from './chapter-fonts.mjs';
import { cssDir, diffParts, fontDir, mergeRanges, parseCss, parseRange, planSync, renderCoverageTs, renderCss } from './zi-fonts.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '../../..');
const ORIGIN = 'https://data.test';
const PARTS = [
    { file: '3400.woff2', range: 'U+3400-34FF', sha1: 'a'.repeat(40) },
    { file: '2b721.woff2', range: 'U+2B721-2B81D,U+2B820-2B822', sha1: 'b'.repeat(40) },
];

test('renderCss → parseCss 往返；同一目录、带内容哈希', () => {
    const css = renderCss(PARTS, ORIGIN);
    const got = parseCss(css);
    assert.equal(got.length, 2);
    assert.deepEqual(got.map((p) => [p.file, p.range]), PARTS.map((p) => [p.file, p.range]));
    assert.equal(got[0].url, `${ORIGIN}/${fontDir(PARTS)}3400.woff2`);
    assert.match(css, /font-family:"KygZi"/);
    assert.equal(cssDir(got, ORIGIN), fontDir(PARTS));
});

test('任何一块内容变了，目录哈希就变', () => {
    const changed = [PARTS[0], { ...PARTS[1], sha1: 'c'.repeat(40) }];
    assert.notEqual(fontDir(changed), fontDir(PARTS));
});

test('块不合规就不生成', () => {
    assert.throws(() => renderCss([{ file: '../x.woff2', range: 'U+3400', sha1: '' }], ORIGIN));
    assert.throws(() => renderCss([{ file: '3400.woff2', range: 'U+3400;}', sha1: '' }], ORIGIN));
});

test('planSync：只列 COS 上没有的；域名对不上就报错', () => {
    const css = parseCss(renderCss(PARTS, ORIGIN));
    assert.deepEqual(planSync(css, new Set(['3400.woff2']), ORIGIN).missing, ['2b721.woff2']);
    assert.deepEqual(planSync(css, new Set(['3400.woff2', '2b721.woff2']), ORIGIN).missing, []);
    assert.throws(() => planSync(css, new Set(), 'https://data.other'), /重跑/);
});

test('diffParts：现裁与入库一致时为空，内容变了就报', () => {
    const css = parseCss(renderCss(PARTS, ORIGIN));
    assert.deepEqual(diffParts(css, PARTS, ORIGIN), []);
    assert.ok(diffParts(css, [PARTS[0], { ...PARTS[1], sha1: 'c'.repeat(40) }], ORIGIN).length > 0);
    assert.ok(diffParts(css, [PARTS[0]], ORIGIN).length > 0);
});

test('覆盖表：合并相邻段', () => {
    assert.deepEqual(mergeRanges([[5, 6], [1, 2], [3, 4], [8, 9]]), [[1, 6], [8, 9]]);
    assert.deepEqual(parseRange('U+3400-34FF,U+3500'), [[0x3400, 0x34ff], [0x3500, 0x3500]]);
    assert.match(renderCoverageTs(PARTS), /\[0x2b721, 0x2b81d\],\n {4}\[0x2b820, 0x2b822\],/);
});

test('入库的 zi-fonts.css 与覆盖表、数据域名一致，块全在要兜底的码位段里、不碰基本区 U+4E00–9FA5', () => {
    const css = parseCss(readFileSync(join(ROOT, 'nextjs/src/app/zi-fonts.css'), 'utf-8'));
    const origin = JSON.parse(readFileSync(join(ROOT, 'config/hosts.json'), 'utf-8')).data;
    assert.ok(css.length > 300);
    cssDir(css, origin);
    const ts = readFileSync(join(ROOT, 'nextjs/src/lib/zi-coverage.generated.ts'), 'utf-8');
    assert.equal(ts, renderCoverageTs(css));
    for (const p of css) {
        for (const [lo, hi] of parseRange(p.range)) {
            assert.ok(FONT_RANGES.some(([a, b]) => lo >= a && hi <= b), `${p.file} ${p.range}`);
        }
    }
});
