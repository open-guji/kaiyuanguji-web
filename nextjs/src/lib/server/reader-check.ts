/**
 * N5b：阅读页服务端校验 kind／key／juan 在数据里是否真有（网站总管审查 web#99）。
 *
 * 不校验的话，乱填的卷号也回 200、还带着指向自己的 canonical，会被当作大批软 404 收录。
 * 查的是阅读器组件自己要读的同几份目录（与浏览器端 BundleStorage 同一地址）：
 *   整理本      items/<id>/collated_edition/index.json 的 juan_files
 *   Book 全文   items/<id>/full_text/index.json 的 chapters[].file
 *   Work 全文   index/full_text/<分片>.json 的清单（key 缺省取首选）→ items/<id>/full_text/<key>/index.json
 *
 * 结果：found ＝ 都查到了；missing ＝ 确定没有（页面 404）；unknown ＝ 查不了（网络错等），
 * 页面照常渲染，但 canonical 回落到不带 key／juan 的地址，不给查不准的地址背书。
 */
import { juanStem, type ReaderQuery } from '../reader-route';

export type ReaderCheck = 'found' | 'missing' | 'unknown';

/** 校验结果：status 同 ReaderCheck；chapterTitle 是全文目录里这一章的章名（查到才有），给 <title> 用 */
export interface ReaderCheckResult { status: ReaderCheck; chapterTitle?: string }

/** 取 current/ 下一个 JSON：确定没有返回 null，查不了抛错 */
export type GetCurrentJson = <T>(relPath: string) => Promise<T | null>;

interface CollatedIndex { juan_files?: unknown }
interface FullTextIndex { chapters?: { file?: unknown; title?: unknown }[] }
interface WorkFullTextEntry { key?: unknown; owner_type?: unknown; primary?: unknown }

/** 与 book-index-ui 的 shardOf 同一算法（16 片）；不为一个哈希函数把 UI 包拉进服务端 */
export function fullTextShardOf(id: string): string {
    let h = 0;
    for (let i = 0; i < id.length; i++) h = (Math.imul(h, 31) + id.charCodeAt(i)) >>> 0;
    return (h % 16).toString(16);
}

/** 全文章节 key：去掉 .md，与 BookFullText 的 normalizeChapterKey 一致（"001.md" ↔ "001"） */
function chapterKey(s: string): string {
    return s.replace(/\.md$/, '');
}

function findChapter(index: FullTextIndex, juan: string) {
    const want = chapterKey(juan);
    return Array.isArray(index.chapters) ? index.chapters.find((c) => typeof c?.file === 'string' && chapterKey(c.file) === want) : undefined;
}

function hasChapter(index: FullTextIndex, juan: string): boolean {
    return !!findChapter(index, juan);
}

/** 这一章在目录里的章名（如「第三回」）；没带卷号、查不到、章名为空都返回 undefined */
export function chapterTitleOf(index: FullTextIndex, juan: string | undefined): string | undefined {
    const t = juan ? findChapter(index, juan)?.title : undefined;
    return typeof t === 'string' && t.trim() ? t.trim() : undefined;
}

/** 全文目录有章：chapters 非空（与构建期阅读索引的 bookFirstChapter 同一判据；空目录的阅读页没有东西可读，404） */
function hasAnyChapter(index: FullTextIndex): boolean {
    return Array.isArray(index.chapters) && index.chapters.some((c) => typeof c?.file === 'string' && c.file !== '');
}

function badPathSegment(s: string): boolean {
    return s.includes('..') || s.includes('/') || s.includes('\\');
}

async function check(id: string, q: ReaderQuery, isWork: boolean, get: GetCurrentJson): Promise<{ ok: boolean; chapterTitle?: string }> {
    if (q.kind === 'collated') {
        const index = await get<CollatedIndex>(`items/${id}/collated_edition/index.json`);
        if (!index || !Array.isArray(index.juan_files) || index.juan_files.length === 0) return { ok: false };
        // 地址里是短形式（011），旧地址是卷文件名（juan/011.json），两种都认；旧的由页面 308 到短的
        const files = index.juan_files as unknown[];
        return { ok: !q.juan || files.includes(q.juan) || files.some((f) => typeof f === 'string' && juanStem(f) === q.juan) };
    }

    if (!isWork) {
        const index = await get<FullTextIndex>(`items/${id}/full_text/index.json`);
        if (!index || !hasAnyChapter(index)) return { ok: false };
        return { ok: !q.juan || hasChapter(index, q.juan), chapterTitle: chapterTitleOf(index, q.juan) };
    }

    let key = q.key;
    if (key) {
        if (badPathSegment(key)) return { ok: false };
    } else {
        const shard = await get<Record<string, WorkFullTextEntry[]>>(`index/full_text/${fullTextShardOf(id)}.json`);
        const list = (shard?.[id] ?? []).filter((v) => v.owner_type !== 'Book' && typeof v.key === 'string');
        const pick = list.find((v) => v.primary) ?? list[0];
        if (!pick) return { ok: false };
        key = pick.key as string;
        if (!q.juan) return { ok: true };
    }
    const index = await get<FullTextIndex>(`items/${id}/full_text/${key}/index.json`);
    if (!index || !hasAnyChapter(index)) return { ok: false };
    return { ok: !q.juan || hasChapter(index, q.juan), chapterTitle: chapterTitleOf(index, q.juan) };
}

/** 校验一个已通过 parseReaderQuery 的阅读页地址，并带回章名。isWork：条目是 Work（否则是 Book） */
export async function checkReader(id: string, q: ReaderQuery, isWork: boolean, get: GetCurrentJson): Promise<ReaderCheckResult> {
    try {
        const r = await check(id, q, isWork, get);
        return r.ok ? { status: 'found', chapterTitle: r.chapterTitle } : { status: 'missing' };
    } catch (err) {
        console.warn(`[reader-check] ${id} 查不了，canonical 回落：${(err as Error).message}`);
        return { status: 'unknown' };
    }
}

/** 同 checkReader，只要结论 */
export async function checkReaderQuery(id: string, q: ReaderQuery, isWork: boolean, get: GetCurrentJson): Promise<ReaderCheck> {
    return (await checkReader(id, q, isWork, get)).status;
}
