import { useConvert, type ReaderPlugin } from 'book-index-ui';
import DownloadChip from '../DownloadChip';
import DownloadPanel from '../DownloadPanel';
import { availableFormats } from '@/lib/export/download';
import { originalMetaOf } from './chapter-meta';

/** 设置抽屉里这一组的标题（按读者繁简偏好转） */
function DownloadTitle() {
    const { convert } = useConvert();
    return <>{convert('下載')}</>;
}

export interface DownloadPluginOpts {
    bookId: string;
    bookTitle: string;
    edition?: string;
    /** 数据版本键（给导出文件头记） */
    dataVersion?: string;
}

/**
 * 「下载本冊」（A33）：宽屏是书名栏里的小浮层（DownloadChip），窄屏是设置抽屉「下載」组里的面板（DownloadPanel）。
 * 宽窄由阅读器给的 ctx.viewport 定，不再自己量；只有 original 版本（有版本号、有可导出格式）才出。
 */
export function downloadPlugin(o: DownloadPluginOpts): ReaderPlugin {
    const targetOf = (api: Parameters<NonNullable<ReaderPlugin['overlay']>>[0]) => {
        const m = originalMetaOf(api.ctx);
        if (!m) return null;
        return {
            m,
            target: {
                id: o.bookId,
                versionKey: m.versionKey,
                chapter: m.chapter,
                bookTitle: o.bookTitle,
                versionLabel: m.versionLabel,
                edition: o.edition,
                license: m.license,
                dataVersion: o.dataVersion,
            },
        };
    };
    return {
        id: 'kyg:download',
        toolbar: {
            slot: 'subtitle',
            order: 10,
            render: (api) => {
                if (api.ctx.viewport !== 'wide') return null;
                const x = targetOf(api);
                // 书名栏放不下时副标题从尾部截成「…」，「下载本冊」放最前（排在版本号芯片前面）
                return x ? <><DownloadChip storage={api.ctx.transport} target={x.target} />{' '}</> : null;
            },
        },
        settings: {
            group: 'download',
            title: <DownloadTitle />,
            order: 10,
            render: (api) => {
                if (api.ctx.viewport !== 'narrow') return null;
                const x = targetOf(api);
                if (!x || availableFormats(x.m.chapter).length === 0) return null;
                return <DownloadPanel storage={api.ctx.transport} target={x.target} />;
            },
        },
    };
}
