/**
 * 共享 GithubTransport 实例
 *
 * 替代原 @/services/bookIndex，统一通过 book-index-ui 的 transport 获取数据。
 */

import { GithubTransport } from 'book-index-ui/transport';
import type { IndexType } from 'book-index-ui/transport';
import {
    DataSource,
    GITHUB_ORG,
    JSDELIVR_FASTLY,
    JSDELIVR_CDN,
} from './constants';

/** 按数据源缓存 transport 实例 */
const transportCache = new Map<DataSource, GithubTransport>();

/** 获取指定数据源的 transport（单例） */
export function getTransport(source: DataSource = 'github'): GithubTransport {
    let t = transportCache.get(source);
    if (t) return t;

    const baseUrl = source === 'github'
        ? 'https://raw.githubusercontent.com'
        : undefined;

    t = new GithubTransport({
        org: GITHUB_ORG,
        repos: {
            draft: 'book-index-draft',
            official: 'book-index',
        },
        baseUrl,
        cdnUrls: [JSDELIVR_FASTLY, JSDELIVR_CDN],
    });

    transportCache.set(source, t);
    return t;
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
