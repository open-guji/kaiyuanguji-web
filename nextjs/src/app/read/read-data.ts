/**
 * 阅读首页的服务端取数：构建期「可读条目」索引 current/read/…（scripts/build-read-index.mjs），
 * 与古籍总目同一套读取（catalog-data.ts 的 createCatalogFetcher：latest.json 进程内缓存 60 秒，
 * 带 ?v=<版本键>；404/403 ＝ 确定没有，返回 null；网络错与 5xx 抛错，不缓存成空页）。
 * 不读 Meili：没有单次 1000 条的上限，搜索机挂了阅读首页照样能开。
 */
import { createCatalogFetcher } from '../catalog/catalog-data';
import { defaultItemDataBase } from '@/lib/server/item-data';
import type { CatalogNode, ReadCard, ReadSections } from './read-route';

export function createReadFetcher(opts: Parameters<typeof createCatalogFetcher>[0]) {
    const { getCurrent } = createCatalogFetcher(opts);
    return {
        getSections: () => getCurrent<ReadSections>('read/sections.json'),
        getTree: () => getCurrent<CatalogNode[]>('read/tree.json'),
        getPage: (nodeId: string, page: number) => getCurrent<ReadCard[]>(`read/${nodeId}/${page}.json`),
        getPeriodPage: (key: string, page: number) => getCurrent<ReadCard[]>(`read/period/${key}/${page}.json`),
    };
}

let _default: ReturnType<typeof createReadFetcher> | null = null;

function defaultFetcher() {
    if (!_default) _default = createReadFetcher({ base: defaultItemDataBase() });
    return _default;
}

export const getReadSectionsServer = () => defaultFetcher().getSections();
export const getReadTreeServer = () => defaultFetcher().getTree();
export const getReadPageServer = (nodeId: string, page: number) => defaultFetcher().getPage(nodeId, page);
export const getReadPeriodPageServer = (key: string, page: number) => defaultFetcher().getPeriodPage(key, page);
