/**
 * zi-fonts.mjs — 扩展区生僻字的静态分片（GUJI-721 第 2 步）：生成 CSS、覆盖表，部署时对账与上传计划。
 *
 * 分片由 scripts/zi-fonts.py 从 Jigmo 2025.9.12 裁出（约 320 块、22MB），放在数据域名的 `font/jigmo-<版本>-<哈希>/<首字码位>.woff2`
 * （COS 桶，跨域头 `*` 与章文件同一套），1 年 immutable。哈希按全部块的内容算、放在目录名里：任何一块变了就换目录，
 * 文件名保持短（CSS 每页都下，文件名若各带哈希，gzip 后要多 5KB）。`src/app/zi-fonts.css` 每块一条 @font-face，
 * 字族 ZI_FAMILY，放在字体栈最前：unicode-range 只含扩展区，基本区与拉丁字母不受影响；扩展区字先查本站字体，
 * 系统字体（如文泉驿正黑）认领了码位却画方框的情形就没有了（需求文档扩 B 方框一条）。
 * 章的子集字体用同一字族后定义（chapter-font.ts），读者读正文时只下子集，不碰这里的分片。
 *
 * CSS 与 `src/lib/zi-coverage.generated.ts` 都由 `node scripts/zi-fonts.mjs gen` 生成并入库；部署时
 * `node scripts/zi-fonts.mjs sync` 先查 COS，缺块才现裁，现裁的结果必须与入库 CSS 逐条一致（对不上就失败），再传缺的块。
 */

import { createHash } from 'node:crypto';

export const ZI_FAMILY = 'KygZi';
export const JIGMO_VERSION = '20250912';
export const IMMUTABLE_CACHE = 'public, max-age=31536000, immutable';

const FILE_RE = /^[0-9a-f]{4,5}\.woff2$/;
const DIR_RE = /^font\/jigmo-\d{8}-[0-9a-f]{10}\/$/;

/** 分片目录（COS key 前缀）：版本＋全部块内容的哈希 */
export function fontDir(parts) {
    const h = createHash('sha1').update(parts.map((p) => `${p.file} ${p.sha1} ${p.range}`).join('\n')).digest('hex');
    return `font/jigmo-${JIGMO_VERSION}-${h.slice(0, 10)}/`;
}
const RANGE_RE = /^U\+[0-9A-F]{4,6}(?:-[0-9A-F]{4,6})?(?:,U\+[0-9A-F]{4,6}(?:-[0-9A-F]{4,6})?)*$/;

/** 一块的 @font-face（一行一条，便于 diff） */
function faceCss(base, { file, range }) {
    return `@font-face{font-family:"${ZI_FAMILY}";font-style:normal;font-weight:400;font-display:swap;src:url("${base}${file}") format("woff2");unicode-range:${range}}`;
}

/** parts：zi-fonts.py 的输出 [{file, range, sha1}]，按码位排；dataOrigin：config/hosts.json 的 data */
export function renderCss(parts, dataOrigin) {
    for (const p of parts) {
        if (!FILE_RE.test(p.file) || !RANGE_RE.test(p.range)) throw new Error(`zi-fonts：块不合规 ${JSON.stringify(p)}`);
    }
    const base = `${dataOrigin}/${fontDir(parts)}`;
    return [
        `/* 由 scripts/zi-fonts.mjs gen 生成，勿手改。扩展区生僻字兜底：Jigmo ${JIGMO_VERSION}（CC0）按码位切的 ${parts.length} 块，`,
        `   托管在本站数据域名；字族 "${ZI_FAMILY}" 放在字体栈最前（globals.css），只在页面出现某块的字时才下那一块。`,
        `   设计见 docs/扩展区与未收字显示-设计.md §2.2 第二层。 */`,
        ...parts.map((p) => faceCss(base, p)),
        '',
    ].join('\n');
}

/** 从 CSS 读回各块 [{url, file, range}]（部署对账、单测用） */
export function parseCss(css) {
    const out = [];
    for (const m of css.matchAll(/src:url\("([^"]+)"\) format\("woff2"\);unicode-range:([^}]+)\}/g)) {
        out.push({ url: m[1], file: m[1].slice(m[1].lastIndexOf('/') + 1), range: m[2] });
    }
    return out;
}

/** unicode-range 串 → 码位段 [[lo, hi], …] */
export function parseRange(range) {
    return range.split(',').map((s) => {
        const [a, b] = s.trim().replace(/^U\+/i, '').split('-');
        return [parseInt(a, 16), parseInt(b ?? a, 16)];
    });
}

/** 合并相邻、重叠的段，按起点排 */
export function mergeRanges(ranges) {
    const sorted = ranges.map((r) => [...r]).sort((x, y) => x[0] - y[0]);
    const merged = [];
    for (const r of sorted) {
        const last = merged[merged.length - 1];
        if (last && r[0] <= last[1] + 1) last[1] = Math.max(last[1], r[1]);
        else merged.push(r);
    }
    return merged;
}

const hex = (n) => `0x${n.toString(16)}`;

/** zi-coverage.generated.ts：分片覆盖的码位段（zi-display.ts 的能否显示判据用） */
export function renderCoverageTs(parts) {
    const merged = mergeRanges(parts.flatMap((p) => parseRange(p.range)));
    return [
        '// 由 scripts/zi-fonts.mjs gen 生成，勿手改：src/app/zi-fonts.css 各块 unicode-range 的并集（Jigmo ' + JIGMO_VERSION + ' 非基本区实有字形的码位）。',
        'export const ZI_FONT_RANGES: ReadonlyArray<readonly [number, number]> = [',
        ...merged.map(([a, b]) => `    [${hex(a)}, ${hex(b)}],`),
        '];',
        '',
    ].join('\n');
}

/**
 * 部署对账：入库 CSS 的块 vs COS 上该目录已有的文件名（listPrefix 的结果，去掉了目录前缀）。
 * 返回 { dir: COS key 前缀, missing: 要传的文件名 }；CSS 指向别的域名、各块不在同一目录时抛错。
 */
export function cssDir(cssParts, dataOrigin) {
    const dirs = new Set(cssParts.map((p) => p.url.startsWith(`${dataOrigin}/`) ? p.url.slice(dataOrigin.length + 1, p.url.length - p.file.length) : ''));
    const [dir] = dirs;
    if (dirs.size !== 1 || !DIR_RE.test(dir) || cssParts.some((p) => !FILE_RE.test(p.file))) {
        throw new Error(`zi-fonts.css 的地址不全在 ${dataOrigin}/font/jigmo-…/ 同一目录下：改了域名请重跑 node scripts/zi-fonts.mjs gen`);
    }
    return dir;
}

export function planSync(cssParts, remoteNames, dataOrigin) {
    const dir = cssDir(cssParts, dataOrigin);
    return { dir, missing: cssParts.map((p) => p.file).filter((f) => !remoteNames.has(f)) };
}

/** 现裁结果与入库 CSS 逐条比对：地址（目录含全部内容的哈希）与 range 都要一致；返回不一致的说明（空数组＝一致） */
export function diffParts(cssParts, generated, dataOrigin) {
    const gen = parseCss(renderCss(generated, dataOrigin));
    const errs = [];
    if (cssParts.length !== gen.length) errs.push(`块数不同：CSS ${cssParts.length}，现裁 ${gen.length}`);
    const n = Math.min(cssParts.length, gen.length);
    for (let i = 0; i < n && errs.length < 5; i++) {
        const a = cssParts[i], b = gen[i];
        if (a.url !== b.url || a.range !== b.range) errs.push(`第 ${i + 1} 块：CSS ${a.url} ${a.range.slice(0, 40)}，现裁 ${b.url} ${b.range.slice(0, 40)}`);
    }
    return errs;
}
