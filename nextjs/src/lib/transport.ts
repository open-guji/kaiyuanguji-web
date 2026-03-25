/**
 * 共享 Storage 实例工厂
 *
 * 根据 DataSource 返回对应的 IndexStorage 实现：
 * - 'github' / 'gitee' → GithubStorage
 * - 'bundle' → BundleStorage（只读，从同域 /data/ 加载预打包 chunk）
 */

import { GithubStorage, BundleStorage } from 'book-index-ui/storage';
import type { IndexStorage, IndexType } from 'book-index-ui/storage';
import {
    DataSource,
    GITHUB_ORG,
    JSDELIVR_FASTLY,
    JSDELIVR_CDN,
} from './constants';

/**
 * 只读 Storage 类型：GithubStorage 和 BundleStorage 共有的方法集合。
 * 将站点实际使用的可选方法标记为必选，避免调用方做 undefined 检查。
 */
type ReadonlyStorage = IndexStorage & Required<Pick<IndexStorage,
    'searchAll' | 'getEntry' | 'getAllEntries' |
    'getCollectionCatalogs' | 'getCollectionCatalog' |
    'getCollatedEditionIndex' | 'getCollatedJuan'
>>;

/** 按数据源缓存 storage 实例 */
const storageCache = new Map<DataSource, ReadonlyStorage>();

/** 获取指定数据源的 storage（单例） */
export function getTransport(source: DataSource = 'github'): ReadonlyStorage {
    const cached = storageCache.get(source);
    if (cached) return cached;

    let s: ReadonlyStorage;

    if (source === 'bundle') {
        s = new BundleStorage({ basePath: '/data' }) as ReadonlyStorage;
    } else {
        const baseUrl = source === 'github'
            ? 'https://raw.githubusercontent.com'
            : undefined;

        s = new GithubStorage({
            org: GITHUB_ORG,
            repos: {
                draft: 'book-index-draft',
                official: 'book-index',
            },
            baseUrl,
            cdnUrls: [JSDELIVR_FASTLY, JSDELIVR_CDN],
        }) as ReadonlyStorage;
    }

    storageCache.set(source, s);
    return s;
}

/** 类型标签 */
const TYPE_LABELS: Record<IndexType, string> = {
    work: '作品',
    collection: '丛编',
    book: '书',
};

export function getTypeLabel(type: IndexType): string {
    return TYPE_LABELS[type] || '';
}

/** 状态标签 */
export function getStatusLabel(isDraft?: boolean): string {
    return isDraft ? '草稿' : '正式';
}
