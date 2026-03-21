/**
 * 共享 GithubStorage 实例
 *
 * 替代原 @/services/bookIndex，统一通过 book-index-ui 的 storage 获取数据。
 */

import { GithubStorage } from 'book-index-ui/storage';
import type { IndexType } from 'book-index-ui/storage';
import {
    DataSource,
    GITHUB_ORG,
    JSDELIVR_FASTLY,
    JSDELIVR_CDN,
} from './constants';

/** 按数据源缓存 storage 实例 */
const storageCache = new Map<DataSource, GithubStorage>();

/** 获取指定数据源的 storage（单例） */
export function getTransport(source: DataSource = 'github'): GithubStorage {
    let s = storageCache.get(source);
    if (s) return s;

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
    });

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
