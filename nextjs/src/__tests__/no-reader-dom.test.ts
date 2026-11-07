/**
 * 阅读器 DOM 契约 lint（迁移计划 §2.1，M 线）：网站代码不碰阅读器内部的 DOM。
 * 阅读功能一律写成 `ReaderPlugin`（app/read/[id]/plugins/）：按格位修饰用 decorate、点字用 onCell、
 * 选字用 selectionActions、定位滚动用 api.locate／scrollTo／rectOf。
 *
 * 扫 src 下 .ts/.tsx（去注释、不含测试）里这些阅读器内部细节：`data-char-id`、`data-ft-cp`、`data-reader-lead`。
 * 没有例外清单——要用就是接口缺了一块，去给 book-index-ui 提需求，别在这里抓。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const SRC = join(process.cwd(), 'src');

function walk(dir: string, out: string[] = []): string[] {
    for (const name of readdirSync(dir)) {
        const full = join(dir, name);
        if (statSync(full).isDirectory()) {
            if (name === 'node_modules' || name === '__tests__') continue;
            walk(full, out);
        } else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(full);
    }
    return out;
}

const stripComments = (text: string) =>
    text.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' ')).replace(/(^|[^:])\/\/.*$/gm, '$1');

describe('阅读器 DOM 契约 lint：不抓阅读器的 DOM', () => {
    it('src 里没有 data-char-id／data-ft-cp／data-reader-lead', () => {
        const hits: string[] = [];
        for (const file of walk(SRC)) {
            stripComments(readFileSync(file, 'utf8')).split('\n').forEach((line, i) => {
                if (/data-char-id|data-ft-cp|data-reader-lead/.test(line)) hits.push(`${relative(SRC, file)}:${i + 1}  ${line.trim()}`);
            });
        }
        expect(hits).toEqual([]);
    });
});
