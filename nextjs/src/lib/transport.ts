/**
 * 共享 Storage 实例工厂
 *
 * 根据 DataSource 返回对应的 IndexStorage 实现：
 * - 'github' / 'gitee' → GithubStorage
 * - 'bundle' → BundleStorage（只读，从同域 /data/ 加载预打包 chunk）
 */

import { GithubStorage, BundleStorage } from 'book-index-ui/storage';
import type { IndexStorage, IndexType } from 'book-index-ui/storage';
import { LocalApiStorage } from './local-api-storage';
import { isV2SearchEnabled, wrapWithV2Search } from './search/v2-storage';
import { wrapWithMeiliSearch } from './search/meili-storage';
import { createCosStorage, getCosSearchBaseUrl } from './cos-storage';
import {
    DataSource,
    GITHUB_ORG,
    JSDELIVR_FASTLY,
    JSDELIVR_CDN,
} from './constants';

/**
 * Meilisearch L1 配置（编译时注入）。
 *
 * - NEXT_PUBLIC_MEILI_URL：API base，例如 https://api.kaiyuanguji.com
 *   或开发期 IP 直连 http://81.69.15.227:7700
 * - NEXT_PUBLIC_MEILI_KEY：tenant token / 公开搜索 key（绝不放 master key）
 *
 * 不设这两个变量时，搜索完全走 L2（worker），与未上线 Meili 等价。
 */
const MEILI_URL = process.env.NEXT_PUBLIC_MEILI_URL || '';
const MEILI_KEY = process.env.NEXT_PUBLIC_MEILI_KEY || '';

/**
 * 只读 Storage 类型：GithubStorage 和 BundleStorage 共有的方法集合。
 * 将站点实际使用的可选方法标记为必选，避免调用方做 undefined 检查。
 */
type ReadonlyStorage = IndexStorage & Required<Pick<IndexStorage,
    'searchAll' | 'getEntry' | 'getAllEntries' |
    'getCollectionCatalogs' | 'getCollectionCatalog' |
    'getCollatedEditionIndex' | 'getCollatedJuan'
>> & Partial<Pick<IndexStorage, 'getLineageGraph'>>;

/** 按数据源缓存 storage 实例 */
const storageCache = new Map<DataSource, ReadonlyStorage>();

/** 获取指定数据源的 storage（单例） */
export function getTransport(source: DataSource = 'github'): ReadonlyStorage {
    const cached = storageCache.get(source);
    if (cached) return cached;

    let s: ReadonlyStorage;

    if (source === 'local') {
        s = new LocalApiStorage('/api/book-index') as ReadonlyStorage;
    } else if (source === 'bundle') {
        s = new BundleStorage({ basePath: '/data' }) as ReadonlyStorage;
    } else if (source === 'cos') {
        // COS 模式：所有数据请求走 https://data.kaiyuanguji.com/v/{commit}/...
        // 版本号在浏览器首次请求时从 /latest.json 拉一次，模块级 promise 缓存。
        s = createCosStorage() as ReadonlyStorage;
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

    if (isV2SearchEnabled()) {
        s = wrapWithV2Search(s) as ReadonlyStorage;
    }

    // L1: Meilisearch（如果配了 URL）。失败时透传到 L2（v2-storage worker）。
    if (MEILI_URL) {
        s = wrapWithMeiliSearch(s, {
            baseUrl: MEILI_URL,
            apiKey: MEILI_KEY || undefined,
            timeoutMs: 2000,
            failuresBeforeBreak: 3,
            breakerCooldownMs: 5 * 60_000,
            debug: process.env.NODE_ENV !== 'production',
        }) as ReadonlyStorage;
    }

    storageCache.set(source, s);
    return s;
}

/**
 * 取当前数据源对应的搜索分片根 URL —— 供 SearchClient.init(baseUrl) 使用。
 * - cos:    Promise<`${COS_BASE}/v/${commit}/search`>，会等 latest.json
 * - 其他:   '/data/search'（同站静态）
 */
export function getSearchBaseUrl(source: DataSource): string | Promise<string> {
    return source === 'cos' ? getCosSearchBaseUrl() : '/data/search';
}

/** 类型标签 */
const TYPE_LABELS: Record<IndexType, string> = {
    work: '作品',
    collection: '丛编',
    book: '书',
    entity: '人物',
};

export function getTypeLabel(type: IndexType): string {
    return TYPE_LABELS[type] || '';
}

/** 状态标签 */
export function getStatusLabel(isDraft?: boolean): string {
    return isDraft ? '草稿' : '正式';
}
