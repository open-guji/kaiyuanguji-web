/**
 * WEB2（overview#249 Q2）：阅读页首屏数据，服务端取好随页面交给 ReaderClient。
 *
 * 旧做法正文前是一条串行请求链：latest.json → 201 KB 的全站 index/full_text/<分片>.json
 * → 本书 index.json → 001.txt，LCP 全压在上面。服务端校验卷号时已经读过同几份目录
 * （lib/server/reader-check.ts，进程内缓存），顺手把首卷正文也取了，一起交给浏览器：
 *   - 目录直接作 index 传给阅读器组件，服务端 HTML 里就有目录与卷标题；
 *   - 其余几次调用（清单、首卷正文）由 seedTransport 就地返回，不再发请求。
 *
 * 只管首屏那一卷／那一份：翻卷、换版本照常走 transport。取不到的项就不放，阅读器自己去取。
 * 本文件客户端、服务端共用，不能引服务端模块。
 */
import type { BookFullTextIndex, CollatedEditionIndex, WorkFullTextEntry } from 'book-index-ui';
import type { IndexStorage } from 'book-index-ui/storage';

export interface ReaderSeed {
    /** Work 全文清单（已滤掉 Book 自己的全文），与 useWorkFullTexts 取到的一样 */
    workTexts?: WorkFullTextEntry[];
    /** Work 全文：下面 fullTextIndex 属于哪一份 */
    key?: string;
    /** 全文目录（Book，或 Work 的 key 那一份） */
    fullTextIndex?: BookFullTextIndex;
    /** 整理本卷目录 */
    collatedIndex?: CollatedEditionIndex;
    /** transport 调用 → 结果，键见 seedCallKey */
    calls?: Record<string, unknown>;
}

/** transport 方法名＋参数 → 种子键 */
export function seedCallKey(method: string, ...args: string[]): string {
    return [method, ...args].join('\u0000');
}

/**
 * 包一层 transport：调用命中种子就直接返回，否则照原样转给底层。
 * 种子里没有值（null／undefined）的不拦，免得把「服务端没取到」当成「没有」。
 */
export function seedTransport<T extends IndexStorage>(transport: T, calls: Record<string, unknown> | undefined): T {
    if (!calls || Object.keys(calls).length === 0) return transport;
    return new Proxy(transport, {
        get(target, prop, receiver) {
            const orig = Reflect.get(target, prop, receiver);
            if (typeof prop !== 'string' || typeof orig !== 'function') return orig;
            return (...args: unknown[]) => {
                if (args.every((a) => typeof a === 'string')) {
                    const hit = calls[seedCallKey(prop, ...(args as string[]))];
                    if (hit !== undefined && hit !== null) return Promise.resolve(hit);
                }
                return (orig as (...a: unknown[]) => unknown).apply(target, args);
            };
        },
    });
}

/** 全文章节 key：去掉 .md，与 BookFullText 一致（"001.md" ↔ "001"） */
export function chapterKey(s: string): string {
    return s.replace(/\.md$/, '');
}

/** 阅读器首屏打开哪一章：地址里的卷号对得上就用它，否则第一章（与 BookFullText 同一规则） */
export function firstChapterFile(index: BookFullTextIndex, juan: string | undefined): string | null {
    const chapters = Array.isArray(index?.chapters) ? index.chapters : [];
    if (chapters.length === 0) return null;
    if (juan) {
        const want = chapterKey(juan);
        const hit = chapters.find((c) => typeof c?.file === 'string' && chapterKey(c.file) === want);
        if (hit) return hit.file;
    }
    return typeof chapters[0]?.file === 'string' ? chapters[0].file : null;
}

/** 整理本卷文件列表（与 CollatedEdition 同一规则：juan_files 优先，退回 files[].filename） */
export function collatedJuanFiles(index: CollatedEditionIndex): string[] {
    const i = index as { juan_files?: unknown; files?: { filename?: unknown }[] };
    if (Array.isArray(i.juan_files) && i.juan_files.length > 0) return i.juan_files.filter((f): f is string => typeof f === 'string');
    if (Array.isArray(i.files)) return i.files.map((f) => f?.filename).filter((f): f is string => typeof f === 'string');
    return [];
}
