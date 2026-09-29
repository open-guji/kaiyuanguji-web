/**
 * WEB2（overview#249 Q2）：服务端取阅读页首屏数据，见 reader-seed.ts。
 *
 * 读的是与浏览器端 BundleStorage 同一批 current/ 地址；目录几份在卷号校验时已读过，
 * 走进程内缓存，这里只多取首卷正文一次。任何一步取不到就少放一项，不抛错：
 * 首屏数据只是提速，缺了阅读器会自己去取。
 */
import type { BookFullTextIndex, CollatedEditionIndex, WorkFullTextEntry } from 'book-index-ui';
import { collatedJuanFile, type ReaderQuery } from '@/lib/reader-route';
import type { GetCurrentJson } from '@/lib/server/reader-check';
import { fullTextShardOf } from '@/lib/server/reader-check';
import { collatedJuanFiles, firstChapterFile, seedCallKey, type ReaderSeed } from './reader-seed';

export type GetCurrentText = (relPath: string, maxBytes?: number) => Promise<string | null>;

/** 首卷正文超过这么大就不随页面带（不让 HTML 过大），交给浏览器自己取 */
export const SEED_TEXT_MAX = 256 * 1024;

function badSegment(s: string): boolean {
    return s.includes('..') || s.includes('\\');
}

/** .md → .txt，与 BundleStorage 取章节的地址一致 */
function txtName(file: string): string {
    return file.endsWith('.md') ? file.replace(/\.md$/, '.txt') : file;
}

async function orNull<T>(p: Promise<T | null>): Promise<T | null> {
    try {
        return await p;
    } catch {
        return null;
    }
}

async function collated(id: string, q: ReaderQuery, getJson: GetCurrentJson, getText: GetCurrentText): Promise<ReaderSeed> {
    const index = await orNull(getJson<CollatedEditionIndex>(`items/${id}/collated_edition/index.json`));
    if (!index) return {};
    const files = collatedJuanFiles(index);
    const want = q.juan ? collatedJuanFile(q.juan, files) : undefined;
    const juan = want && files.includes(want) ? want : files[0];
    const seed: ReaderSeed = { collatedIndex: index, calls: {} };
    if (!juan || badSegment(juan) || !juan.endsWith('.json')) return seed;
    const [data, text] = await Promise.all([
        orNull(getJson<unknown>(`items/${id}/collated_edition/${juan}`)),
        orNull(getText(`items/${id}/collated_edition/text/${juan.replace(/\.json$/, '.txt')}`, SEED_TEXT_MAX)),
    ]);
    // 卷数据与正文要么一起给、要么都不给：只给一半，组件会拿半份数据渲染
    if (data && text !== null) {
        seed.calls![seedCallKey('getCollatedJuan', id, juan)] = data;
        seed.calls![seedCallKey('getCollatedJuanText', id, juan)] = text;
    }
    return seed;
}

async function fullText(id: string, q: ReaderQuery, isWork: boolean, getJson: GetCurrentJson, getText: GetCurrentText): Promise<ReaderSeed> {
    const seed: ReaderSeed = { calls: {} };
    let key: string | undefined;
    if (isWork) {
        const shard = await orNull(getJson<Record<string, WorkFullTextEntry[]>>(`index/full_text/${fullTextShardOf(id)}.json`));
        if (!shard) return {};
        const list = (shard[id] ?? []).filter((v) => v && v.owner_type !== 'Book' && typeof v.key === 'string');
        seed.workTexts = list;
        seed.calls![seedCallKey('getWorkFullTextList', id)] = list;
        key = q.key && list.some((v) => v.key === q.key) ? q.key : (list.find((v) => v.primary) ?? list[0])?.key;
        if (!key || badSegment(key) || key.includes('/')) return seed;
        seed.key = key;
    }
    const dir = isWork ? `items/${id}/full_text/${key}` : `items/${id}/full_text`;
    const index = await orNull(getJson<BookFullTextIndex>(`${dir}/index.json`));
    if (!index) return seed;
    seed.fullTextIndex = index;
    const file = firstChapterFile(index, q.juan);
    if (!file || badSegment(file)) return seed;
    const text = await orNull(getText(`${dir}/${txtName(file)}`, SEED_TEXT_MAX));
    if (text !== null) {
        seed.calls![isWork ? seedCallKey('getWorkFullTextChapter', id, key!, file) : seedCallKey('getBookFullTextChapter', id, file)] = text;
    }
    return seed;
}

/** 取阅读页首屏数据。q 须已通过 parseReaderQuery；isWork：条目是 Work（否则是 Book） */
export async function preloadReader(
    id: string,
    q: ReaderQuery,
    isWork: boolean,
    getJson: GetCurrentJson,
    getText: GetCurrentText,
): Promise<ReaderSeed> {
    try {
        return q.kind === 'collated' ? await collated(id, q, getJson, getText) : await fullText(id, q, isWork, getJson, getText);
    } catch (err) {
        console.warn(`[reader-preload] ${id} 首屏数据没取到，交给浏览器：${(err as Error).message}`);
        return {};
    }
}
