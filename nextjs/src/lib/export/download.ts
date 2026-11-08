/**
 * 阅读页「下载本冊」：取本册的 char／punct／entity（＋fig），在浏览器里生成 guji-markdown，存成 .md。
 * 不预生成、不缓存生成物：读的就是阅读页正在用的同一批文件，下载的和页面上的是同一版本（A33 下载方案，sheldon 11-02 定）。
 *
 * 三种格式：分行本（lines.md 规则）、标点本（rich.md，只留书名号）、专名本（rich.md，带或不带 book-index:// 链接）。
 * 三种字形：原书（不转）、通行繁体（异体字归一）、简体（异体字归一＋opencc t2cn，全站同一口径 lib/to-simplified-core.mjs）。
 * 文件开头写 YAML front matter（guji-format v0.4）：书名、册、格式、字形、各层版本号等。
 */
import { getJson } from '@/lib/text-file';
import { buildExport as buildExportWith, type ExportRequest, type ExportResult } from 'book-text-util';

export { availableFormats, FORMAT_LABEL, GLYPH_LABEL } from 'book-text-util';
export type { ExportChapter, ExportFormat, ExportGlyph, ExportRequest, ExportResult } from 'book-text-util';
export { saveText } from 'book-text-util/browser';

/**
 * 生成本册文件（不触发下载，便于测试）。生成规则在 npm 包 book-text-util；
 * 这里只接站内取数（getJson：cos 的 getTextFile，退回同域 /data/items）和字形转换（全站唯一入口 lib/server/simplify.ts，读者选了才动态加载，不进阅读页首屏包）。
 */
export async function buildExport(req: ExportRequest, storage: object): Promise<ExportResult> {
    const converters = req.glyph === 'original' ? undefined : await import('@/lib/server/simplify');
    return buildExportWith(req, { getTextFile: (id, key, file) => getJson(storage, id, key, file) }, converters);
}
