/**
 * WEB2（overview#249 Q2；overview#307 E 块）：服务端取阅读页首屏数据，见 reader-seed.ts。
 *
 * 读的是与浏览器端 BundleStorage 同一批 current/ 地址。manifest 与版本目录在校验地址时已读过（checkReader），
 * 这里直接用，只多取首章正文（与章 json）一次。任何一步取不到就少放一项，不抛错：
 * 首屏数据只是提速，缺了阅读器会自己去取。
 */
import type { ReaderCheckResult } from '@/lib/server/reader-check';
import { seedCallKey, type ReaderSeed } from './reader-seed';

export type GetCurrentText = (relPath: string, maxBytes?: number) => Promise<string | null>;
export type GetCurrentJson = <T>(relPath: string) => Promise<T | null>;

/** 首章正文超过这么大就不随页面带（不让 HTML 过大），交给浏览器自己取 */
export const SEED_TEXT_MAX = 256 * 1024;

async function orNull<T>(p: Promise<T | null>): Promise<T | null> {
    try {
        return await p;
    } catch {
        return null;
    }
}

/**
 * 取阅读页首屏数据。checked 须是 status=found 的校验结果（带 manifest、版本、目录与落实的章）。
 * 章的 md 与 json 要么一起给、要么都不给：只给一半，组件会拿半份数据渲染。
 */
export async function preloadReader(id: string, checked: ReaderCheckResult, getJson: GetCurrentJson, getText: GetCurrentText): Promise<ReaderSeed> {
    if (checked.status !== 'found' || !checked.manifest || !checked.version || !checked.index || !checked.chapter) return {};
    const key = checked.version.key;
    const chapter = checked.chapter;
    const calls: Record<string, unknown> = {
        [seedCallKey('getTextManifest', id)]: checked.manifest,
        [seedCallKey('getTextIndex', id, key)]: checked.index,
    };
    try {
        const meta = checked.index.chapters.find((c) => c.file === chapter);
        const base = `items/${id}/${key}/${chapter}`;
        const [md, json] = await Promise.all([
            orNull(getText(`${base}.txt`, SEED_TEXT_MAX)),
            meta?.has_json ? orNull(getJson<unknown>(`${base}.json`)) : Promise.resolve(null),
        ]);
        if (md !== null && (!meta?.has_json || json !== null)) calls[seedCallKey('getChapter', id, key, chapter)] = { md, json };
    } catch (err) {
        console.warn(`[reader-preload] ${id} 首章没取到，交给浏览器：${(err as Error).message}`);
    }
    return { calls };
}
