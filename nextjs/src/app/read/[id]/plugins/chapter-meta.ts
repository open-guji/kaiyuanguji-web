/**
 * 插件共用：从阅读器给的章上下文（ReaderChapterCtx）取「本项目自做的 original 版本」的下载／版本号信息。
 * 阅读器换章时 ctx 里就有章条目与版本，不必再另取一遍（原先 ReaderClient 的 useTextMeta 里重复取 manifest／index）。
 */
import type { ReaderChapterCtx } from 'book-index-ui';
import { textVersionsOf, type TextVersions } from '../TextVersionChip';
import type { ExportChapter } from '@/lib/export/download';
import { readerVersionName } from '@/lib/reader-route';

export interface OriginalMeta {
    versions: TextVersions;
    versionKey: string;
    versionLabel?: string;
    chapter: ExportChapter;
    license?: string;
}

/** 版本号只有本项目自做的 original 版本记（文本／标点／专名三线），别的来源不出；也只有它们出「下载本冊」 */
export function originalMetaOf(ctx: ReaderChapterCtx): OriginalMeta | null {
    const version = ctx.version as unknown as { key: string; is_original?: boolean; license?: unknown };
    if (!version.is_original) return null;
    const versions = textVersionsOf(ctx.chapter);
    if (!versions) return null;
    return {
        versions,
        versionKey: ctx.versionKey,
        versionLabel: readerVersionName(ctx.version as never),
        chapter: ctx.chapter as unknown as ExportChapter,
        license: typeof version.license === 'string' ? version.license : undefined,
    };
}
