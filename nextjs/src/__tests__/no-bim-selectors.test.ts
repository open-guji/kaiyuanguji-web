/**
 * 样式契约 lint（迁移计划 §4.6）：本站不写 `.bim-*` 结构选择器去改组件库内部。
 * 要调的东西应该是 book-index-ui/tokens.css 里的变量（--bim-*）；没有变量就给包提需求加变量，别按 DOM 层级压。
 *
 * 扫 src 下的 .css（去注释）和 .ts/.tsx（去注释）里的 `.bim-xxx` 类选择器、`[class*="bim-` 属性选择器。
 * 例外清单（ALLOW）只准减、不准增。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const SRC = join(process.cwd(), 'src');

/** 暂时还在用、等对应迁移线（P 插件、M 网站插件迁移）清零的文件；清掉一个就从这里删一个 */
const ALLOW: string[] = [];

function walk(dir: string, out: string[] = []): string[] {
    for (const name of readdirSync(dir)) {
        const full = join(dir, name);
        if (statSync(full).isDirectory()) {
            if (name === 'node_modules' || name === '__tests__') continue;
            walk(full, out);
        } else if (/\.(css|tsx?)$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(full);
    }
    return out;
}

const stripComments = (text: string, isCss: boolean) => {
    const noBlock = text.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
    return isCss ? noBlock : noBlock.replace(/(^|[^:])\/\/.*$/gm, '$1');
};

describe('样式契约 lint：不写 .bim-* 结构选择器', () => {
    const hits: string[] = [];
    for (const file of walk(SRC)) {
        const rel = relative(SRC, file);
        const isCss = file.endsWith('.css');
        const text = stripComments(readFileSync(file, 'utf8'), isCss);
        text.split('\n').forEach((line, i) => {
            const re = isCss ? /\.bim-[a-z][\w-]*|\[class[*^~$|]?=["']?bim-/ : /['"`][^'"`\n]*(\.bim-[a-z][\w-]*|\[class[*^~$|]?=["']?bim-)/;
            if (re.test(line)) hits.push(`${rel}:${i + 1}  ${line.trim()}`);
        });
    }

    it('没有 .bim-* 类选择器（例外清单之外）', () => {
        const bad = hits.filter((h) => !ALLOW.some((a) => h.startsWith(a)));
        expect(bad).toEqual([]);
    });

    it('例外清单里的文件确实还有命中（清零了就该从清单删掉）', () => {
        for (const a of ALLOW) expect(hits.some((h) => h.startsWith(a))).toBe(true);
    });
});
