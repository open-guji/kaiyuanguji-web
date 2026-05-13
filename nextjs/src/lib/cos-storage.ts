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
 */
export function createCosStorage(): IndexStorage {
    let resolved: BundleStorage | null = null;
    let resolving: Promise<BundleStorage> | null = null;

    function ensureInner(): Promise<BundleStorage> {
        if (resolved) return Promise.resolve(resolved);
        if (!resolving) {
            resolving = getCosDataBaseUrl().then(baseUrl => {
                resolved = new BundleStorage({ basePath: baseUrl });
                return resolved;
            });
        }
        return resolving;
    }

    // Proxy: 任何属性访问 → 返回异步包装函数，调用时先 await ensureInner
    return new Proxy({} as IndexStorage, {
        get(_, prop) {
            return (...args: unknown[]) =>
                ensureInner().then(inner => {
                    const fn = (inner as unknown as Record<string | symbol, unknown>)[prop];
                    if (typeof fn !== 'function') {
                        throw new Error(`CosStorage: method '${String(prop)}' not on BundleStorage`);
                    }
                    return (fn as (...a: unknown[]) => unknown).apply(inner, args);
                });
        },
    });
}
