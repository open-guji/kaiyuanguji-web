/**
 * @jest-environment node
 */
/**
 * overview#127：测试站宋史卷215 露出 52 处 `:zi[…]`（DP1 回归）。
 *
 * 当时的根因：book-text 8b4409ca2 只改了 book-text（给 Work 全文
 * `full_text/wikisource-01/index.json` 顶层加 `"guji_markdown": "0.2.0"`，并改
 * 215.md），draft／production 都没动。管线本身把两份文件都原样发到了
 * current/（源站 index.json 带着 guji_markdown，Last-Modified 09-27 22:29Z），
 * 但 FX2（#88）之前前端的 `?v=` 只取 draft commitId——这次发布 `?v=` 一字不变，
 * 而 index.json 在旧内容时已经以这个 `?v=` 被 CDN 以 immutable 缓存过，于是继续吐
 * 不带 guji_markdown 的旧版；215.txt 在这个 `?v=` 下从没被取过，拿到的是新版。
 * 新章文件 + 旧 index.json → 组字标记不生效 → 52 处原样露出（都在表格单元格里）。
 *
 * 这里把这条链路整体钉住：
 *   1. bundle-data.mjs：Work 全文 index.json 逐字节原样带出（顶层 guji_markdown／
 *      table_notation 等字段一个不丢）
 *   2. 只有 book-text 改 index.json 时：产物字节变（sync-to-cos 按 md5 比对 → 会
 *      重新 PUT），且 latest.json 的 cacheKey 变（→ `?v=` 变，CDN 旧缓存穿透）；
 *      draft commitId 不变——正是 FX2 之前的旧 `?v=` 不变的原因
 *   3. 渲染侧（book-index-ui，本道不改）：标记生效时表格单元格里的 `:zi[…]` 会渲染
 *      成 span.bim-zi；不生效时原样露出——与卡里的现象一一对应
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { renderFullTextBody } from 'book-index-ui';
import { withCacheKey } from '../../../scripts/lib/latest-cache-key.mjs';

const NEXTJS_DIR = join(__dirname, '..', '..', '..');
const WORK_ID = 'd59f2gonq7sy';
const WORK_REL = `Work/7/s/y/${WORK_ID}-宋史.json`;
const KEY = 'wikisource-01';

// 卷215 的缩影：guji-table 表格，单元格里有组字
const CHAPTER = [
    '## 卷二百一十五',
    '',
    ':::table',
    '!帝系 | 名 | 封',
    '太祖 | :zi[句員] | 某王',
    ':::',
    '',
].join('\n');

const INDEX_BEFORE = {
    work_id: WORK_ID,
    version_label: '宋史',
    table_notation: 'guji-table-v1',
    total_chapters: 1,
    chapters: [{ file: '215.md', title: '卷二百一十五' }],
};
// book-text 8b4409ca2 之后：顶层多一个 guji_markdown（键序也照源文件，放最前）
const INDEX_AFTER = { guji_markdown: '0.2.0', ...INDEX_BEFORE };

function git(cwd: string, ...args: string[]) {
    execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...args], { cwd, stdio: 'ignore' });
}

function md5(buf: Buffer) {
    return createHash('md5').update(buf).digest('hex');
}

describe('overview#127：Work 全文 index.json 发布链路', () => {
    let tmp: string;
    let draft: string;
    let text: string;
    let ftSrcDir: string;

    const bundle = (outRoot: string) => {
        const env: NodeJS.ProcessEnv = {
            ...process.env,
            KYG_DATA_ROOT: outRoot,
            BOOK_INDEX_DRAFT_DIR: draft,
            BOOK_INDEX_PRODUCTION_DIR: join(tmp, 'no-production'),
            BOOK_TEXT_DIR: text,
        };
        for (const k of ['DATA_OUT_DIR', 'DATA_LATEST_FILE', 'H1_OUT_DIR', 'H1_TEXT_OUT_DIR']) delete env[k];
        execFileSync('node', [join(NEXTJS_DIR, 'scripts', 'bundle-data.mjs')], { cwd: NEXTJS_DIR, env, stdio: 'pipe' });
        const ftOut = join(outRoot, 'data', 'items', WORK_ID, 'full_text', KEY);
        return {
            index: readFileSync(join(ftOut, 'index.json')),
            chapter: readFileSync(join(ftOut, '215.txt')),
            latest: withCacheKey(JSON.parse(readFileSync(join(outRoot, 'latest.json'), 'utf-8'))),
        };
    };

    beforeAll(() => {
        tmp = mkdtempSync(join(tmpdir(), 'dp1-127-'));
        draft = join(tmp, 'draft');
        text = join(tmp, 'text');

        mkdirSync(join(draft, 'index', 'works'), { recursive: true });
        mkdirSync(join(draft, dirname(WORK_REL)), { recursive: true });
        writeFileSync(join(draft, 'index', 'works', '0.json'),
            JSON.stringify({ [WORK_ID]: { id: WORK_ID, name: '宋史', type: 'work', path: WORK_REL } }));
        writeFileSync(join(draft, WORK_REL), JSON.stringify({ id: WORK_ID, title: '宋史', type: 'work' }));
        git(draft, 'init', '-q');
        git(draft, 'add', '-A');
        git(draft, 'commit', '-q', '-m', 'draft');

        ftSrcDir = join(text, dirname(WORK_REL), WORK_ID, 'full_text', KEY);
        mkdirSync(ftSrcDir, { recursive: true });
        writeFileSync(join(ftSrcDir, 'index.json'), JSON.stringify(INDEX_BEFORE, null, 2) + '\n');
        writeFileSync(join(ftSrcDir, '215.md'), CHAPTER);
        git(text, 'init', '-q');
        git(text, 'add', '-A');
        git(text, 'commit', '-q', '-m', 'text v1');
    }, 60_000);

    afterAll(() => {
        rmSync(tmp, { recursive: true, force: true });
    });

    it('只改 book-text 的 index.json：产物逐字节跟上、md5 变、cacheKey 变，draft commit 不变', () => {
        const before = bundle(join(tmp, 'out-1'));
        expect(before.index.equals(readFileSync(join(ftSrcDir, 'index.json')))).toBe(true);
        expect(JSON.parse(before.index.toString('utf-8')).guji_markdown).toBeUndefined();

        // book-text 8b4409ca2 的形状：只动文本仓，只给 index.json 顶层加字段
        writeFileSync(join(ftSrcDir, 'index.json'), JSON.stringify(INDEX_AFTER, null, 2) + '\n');
        git(text, 'add', '-A');
        git(text, 'commit', '-q', '-m', 'text v2: guji_markdown 0.2.0');

        const after = bundle(join(tmp, 'out-2'));

        // 1. 顶层字段原样带出：与源文件逐字节一致
        const src = readFileSync(join(ftSrcDir, 'index.json'));
        expect(after.index.equals(src)).toBe(true);
        expect(JSON.parse(after.index.toString('utf-8'))).toEqual(INDEX_AFTER);

        // 2. sync-to-cos 按 md5 判增量：index.json 的 md5 变了 → 会重新 PUT；章文件没变 → skip
        expect(md5(after.index)).not.toBe(md5(before.index));
        expect(md5(after.chapter)).toBe(md5(before.chapter));

        // 3. `?v=`：draft commit 没变（FX2 之前的 ?v= 因此不变，CDN 吐旧版），cacheKey 必须变
        expect(after.latest.commitId).toBe(before.latest.commitId);
        expect(after.latest.textCommitId).not.toBe(before.latest.textCommitId);
        expect(after.latest.cacheKey).not.toBe(before.latest.cacheKey);
    }, 60_000);
});

describe('overview#127：表格单元格里的 :zi[…]（book-index-ui 渲染，只核对不改）', () => {
    const body = CHAPTER.replace(/^##\s+[^\n]+\n+/, '');
    const render = (gujiMarkdown: boolean) =>
        renderToStaticMarkup(createElement('div', null, renderFullTextBody(body, true, gujiMarkdown)));

    it('index.json 带 guji_markdown 0.2.0 → 单元格里渲染成 span.bim-zi，不露原文', () => {
        const html = render(true);
        expect(html).toMatch(/<td[^>]*><span class="bim-zi[^"]*"[^>]*>句員<\/span><\/td>/);
        expect(html).not.toContain(':zi[');
    });

    it('index.json 缺 guji_markdown（卡里的现象）→ 表格照样出，组字原样露出', () => {
        const html = render(false);
        expect(html).toContain('<table');
        expect(html).toContain(':zi[句員]');
        expect(html).not.toContain('bim-zi');
    });
});
