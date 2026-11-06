import type { ReaderPlugin } from 'book-index-ui';
import { ensureChapterFont } from '@/lib/chapter-font';

/**
 * 站内换章：补这一章的生僻字子集字体（GUJI-701）。字体子集地址是本站 CDN，所以留在网站；
 * 时机由阅读器的 onChapter 钩子给（首章也会来，同一地址已有则不重复加）。
 */
export const fontPlugin: ReaderPlugin = {
    id: 'kyg:chapter-font',
    onChapter: (ctx) => {
        if (ctx.versionKey) void ensureChapterFont(ctx.transport, ctx.entryId, ctx.versionKey, ctx.chapter as unknown as Record<string, unknown>);
    },
};
