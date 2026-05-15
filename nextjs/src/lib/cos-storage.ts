/**
 * COS 数据源支持
 *
 * 流程：
 *   1. 浏览器启动 fetch `${COS_BASE}/latest.json` 拿当前发布的 commitId（12位短哈希）
 *   2. 所有 data 请求 basePath 拼为 `${COS_BASE}/v/${commit}/`，永久不可变
 *   3. 回滚 = 改 latest.json 一个文件，30 秒生效
 *
 * 设计要点：
 *   - getTransport() 必须保持同步 → 用 Proxy 包装 BundleStorage，方法被调用时再 await 版本
 *   - 版本号在模块级 promise 共享 → CosStorage 和 search worker init 共用一次 fetch
 *   - sessionStorage 不缓存版本：每次首屏拉一次 ~150B latest.json 成本可忽略，但可保证回滚立即生效
 */

import { BundleStorage } from 'book-index-ui/storage';
import type { IndexStorage } from 'book-index-ui/storage';
import { extractType } from 'book-index-ui';
import type { IndexEntry } from 'book-index-ui';
import { buildPromotionMap } from './promotions';

export const COS_BASE = (process.env.NEXT_PUBLIC_COS_BASE || '').replace(/\/$/, '');

let _versionPromise: Promise<string> | null = null;

/**
 * 解析 COS 上当前发布的 commitId（12位短哈希）。
 * 模块级 memoization：单次页面生命周期只 fetch 一次 latest.json。
 */
export function resolveCosVersion(): Promise<string> {
    if (!COS_BASE) {
        return Promise.reject(new Error('NEXT_PUBLIC_COS_BASE not set'));
    }
    if (!_versionPromise) {
        // EdgeOne 控制台已为 /latest.json 配「节点缓存 TTL: 不缓存 + 浏览器缓存
        // 30 秒」规则（2026-05-14），客户端只需告诉浏览器别走自身缓存。
        _versionPromise = fetch(`${COS_BASE}/latest.json`, { cache: 'no-store' })
            .then(r => {
                if (!r.ok) throw new Error(`latest.json HTTP ${r.status}`);
                return r.json();
            })
            .then((j: { commitId?: string }) => {
                if (!j.commitId) throw new Error('latest.json missing commitId');
                return j.commitId;
            })
            .catch(err => {
                // 失败时清掉 promise，让下次 fetch 重试（不长期粘在错误状态）
                _versionPromise = null;
                throw err;
            });
    }
    return _versionPromise;
}

/** 当前版本对应的 data 根 URL（已包含 /v/{commit}） */
export async function getCosDataBaseUrl(): Promise<string> {
    const commit = await resolveCosVersion();
    return `${COS_BASE}/v/${commit}`;
}

/** 当前版本对应的搜索分片根 URL */
export async function getCosSearchBaseUrl(): Promise<string> {
    return `${await getCosDataBaseUrl()}/search`;
}

/**
 * 创建一个延迟解析版本号的 IndexStorage —— 同步返回，方法调用时才 await。
 *
 * 实现：先用 dummy basePath 占位创建 BundleStorage，第一次方法被调用时
 * 重新 fetch latest.json 拿真实版本，构造正式 BundleStorage 替换之。
 *
 * Phase 3：getEntry 改为单文件直拉 entry/{id}.json，跳过 BundleStorage 的
 * chunks 逻辑。其他方法（getCollatedJuan / getCounts 等）仍委托给 BundleStorage。
 */
export function createCosStorage(): IndexStorage {
    let resolved: { inner: BundleStorage; baseUrl: string } | null = null;
    let resolving: Promise<{ inner: BundleStorage; baseUrl: string }> | null = null;

    function ensureInner(): Promise<{ inner: BundleStorage; baseUrl: string }> {
        if (resolved) return Promise.resolve(resolved);
        if (!resolving) {
            resolving = getCosDataBaseUrl().then(baseUrl => {
                resolved = { inner: new BundleStorage({ basePath: baseUrl }), baseUrl };
                return resolved;
            });
        }
        return resolving;
    }

    // entry/{id}.json 内存缓存：同 ID 反复 getEntry 不重复 fetch
    const entryCache = new Map<string, Promise<unknown>>();

    // promotions.json 一次性加载、模块生命周期共享。Map 为空 → 没有任何已升级。
    let promotionsPromise: Promise<Map<string, string>> | null = null;
    function ensurePromotions(): Promise<Map<string, string>> {
        if (promotionsPromise) return promotionsPromise;
        promotionsPromise = (async () => {
            try {
                const { baseUrl } = await ensureInner();
                const res = await fetch(`${baseUrl}/promotions.json`, { cache: 'force-cache' });
                if (!res.ok) return new Map();
                return buildPromotionMap(await res.json());
            } catch {
                return new Map();
            }
        })();
        return promotionsPromise;
    }

    // 取原始 detail JSON（getItem 返回原貌，getEntry 在此基础上转 IndexEntry shape）
    async function fetchRawDetail(canonicalId: string): Promise<Record<string, unknown> | null> {
        let cached = entryCache.get(canonicalId);
        if (!cached) {
            cached = (async () => {
                const { baseUrl } = await ensureInner();
                const res = await fetch(`${baseUrl}/entry/${encodeURIComponent(canonicalId)}.json`, {
                    cache: 'force-cache',
                });
                if (res.status === 404) return null;
                if (!res.ok) throw new Error(`entry ${canonicalId}: HTTP ${res.status}`);
                return res.json();
            })();
            entryCache.set(canonicalId, cached);
        }
        return cached as Promise<Record<string, unknown> | null>;
    }

    /** 走 promotions 重定向 + 拉原始 detail；getItem 直接返回，getEntry 转 IndexEntry */
    async function resolveDetail(id: string): Promise<{
        canonicalId: string;
        redirectedFrom: string | undefined;
        detail: Record<string, unknown> | null;
    }> {
        const promotions = await ensurePromotions();
        const canonicalId = promotions.get(id) ?? id;
        const redirectedFrom = canonicalId !== id ? id : undefined;
        const detail = await fetchRawDetail(canonicalId);
        return { canonicalId, redirectedFrom, detail };
    }

    // getItem：返回原始 detail（含全部字段，BookDetailLayout 用）
    async function getItemFromCos(id: string): Promise<Record<string, unknown> | null> {
        const { canonicalId, redirectedFrom, detail } = await resolveDetail(id);
        if (!detail) return null;
        // Entity 同步 primary_name → title
        if (detail.type === 'entity' && !detail.title && detail.primary_name) {
            detail.title = detail.primary_name;
        }
        if (redirectedFrom) detail.redirected_from = redirectedFrom;
        return detail;
    }

    // getEntry：原始 detail → IndexEntry shape（用于卡片 / 列表 / 搜索结果）
    // 跟 BundleStorage.getEntry 的字段映射保持一致
    async function getEntryFromCos(id: string): Promise<IndexEntry | null> {
        const { canonicalId, redirectedFrom, detail } = await resolveDetail(id);
        if (!detail) return null;
        const type = extractType(canonicalId);
        const d = detail as Record<string, unknown>;
        const displayTitle = type === 'entity'
            ? ((d.primary_name as string) || (d.title as string) || (d.name as string) || canonicalId)
            : ((d.title as string) || (d.name as string) || canonicalId);
        // additional_titles / attached_texts：原始 detail 里可能是 string[] 或
        // { book_title }[]，统一打平成 string[]
        const flatten = (arr: unknown): string[] | undefined => {
            if (!Array.isArray(arr)) return undefined;
            return arr.map(t => typeof t === 'string' ? t : ((t as { book_title?: string })?.book_title))
                      .filter(Boolean) as string[];
        };
        return {
            id: canonicalId,
            title: displayTitle,
            type,
            isDraft: true,
            author: d.author as string,
            dynasty: d.dynasty as string,
            role: d.role as string,
            additional_titles: flatten(d.additional_titles),
            attached_texts: flatten(d.attached_texts),
            edition: d.edition as string,
            juan_count: d.juan_count as number,
            has_text: d.has_text as boolean,
            has_image: d.has_image as boolean,
            has_collated: d.has_collated as boolean,
            subtype: d.subtype as string,
            primary_name: d.primary_name as string,
            birth_year: d.birth_year as number,
            death_year: d.death_year as number,
            cbdb_id: d.cbdb_id as number,
            ...(redirectedFrom ? { redirected_from: redirectedFrom } : {}),
        };
    }

    // Proxy: 任何属性访问 → 返回异步包装函数，调用时先 await ensureInner
    return new Proxy({} as IndexStorage, {
        get(_, prop) {
            // getEntry / getItem：单文件 entry/{id}.json 路径，绕开 BundleStorage 的 chunks 逻辑
            if (prop === 'getEntry') return (id: string) => getEntryFromCos(id);
            if (prop === 'getItem') return (id: string) => getItemFromCos(id);
            return (...args: unknown[]) =>
                ensureInner().then(({ inner }) => {
                    const fn = (inner as unknown as Record<string | symbol, unknown>)[prop];
                    if (typeof fn !== 'function') {
                        throw new Error(`CosStorage: method '${String(prop)}' not on BundleStorage`);
                    }
                    return (fn as (...a: unknown[]) => unknown).apply(inner, args);
                });
        },
    });
}
