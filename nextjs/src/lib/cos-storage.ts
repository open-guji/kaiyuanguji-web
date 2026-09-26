/**
 * COS 数据源支持
 *
 * 流程：
 *   1. 浏览器启动 fetch `${COS_BASE}/latest.json` 拿当前发布的 commitId（12位短哈希）
 *   2. entry/ 与 index/ 走 commit-independent 的 `${COS_BASE}/current/`，
 *      靠 `?v=${commit}` 让 CDN 区分版本（见 withCacheBust）；
 *      search 分片仍走 `${COS_BASE}/v/${commit}/search`，commit 隔离（见 getCosSearchBaseUrl）
 *   3. 回滚 = 改 latest.json 一个文件，30 秒生效
 *
 * ⚠️ 排查线上数据别只用 `?v=<commit>` 做 cache-buster
 *   current/* 带 `Cache-Control: immutable, max-age=31536000`。bundle 重建后同名
 *   URL 内容会变，但边缘节点可能仍握着旧副本——`?v=` 是同一个 commit 值，穿不透。
 *   2026-09-05 实测：新写入的 Book.dating 在 `?v=<commit>` 下返回 null，换随机串
 *   立刻拿到正确数据。手工核验线上一律用随机 cache-buster，否则会把「CDN 没刷新」
 *   误判成「数据没发布」。同类坑另见 latest.json 被缓存数小时那次。
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
import { reportError, setRelease } from './error-report';

export const COS_BASE = (process.env.NEXT_PUBLIC_COS_BASE || '').replace(/\/$/, '');

/**
 * A3 第一期：条目按内容哈希寻址（h1 布局），开关默认关，走现行路径。
 * 见 nextjs/scripts/bundle-hashed.mjs + sync-h1-to-cos.mjs。
 * `NEXT_PUBLIC_DATA_LAYOUT=hashed` 才启用；任何其他值（含未设置）走现行 `current/` 路径。
 */
const DATA_LAYOUT: 'legacy' | 'hashed' =
    process.env.NEXT_PUBLIC_DATA_LAYOUT === 'hashed' ? 'hashed' : 'legacy';

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
                setRelease(j.commitId); // 把数据版本附到后续错误上报里
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

/**
 * 当前版本对应的 data 根 URL。
 *
 * 数据布局自 2026-05-17：
 *   - 数据文件（entry/, items/, promotions, recommended, meta, pagefind-fulltext 等）
 *     在 COS 上单副本 `current/*`，每次 sync 仅 PUT 变化的文件。
 *   - 客户端用 BundleStorage 的 ?v=<commit> 自动 cache-bust。
 *   - 已废弃的 v/<commit>/ 数据前缀仍由 listPrefixEtags 列文件，但新 sync 不再写。
 *
 * 搜索分片（倒排索引）独立维护：[[getCosSearchBaseUrl]]。
 */
export async function getCosDataBaseUrl(): Promise<string> {
    // resolveCosVersion 仍要解析，让 BundleStorage 拿 commit 作 cache-bust。
    // 但 basePath 现在指向 commit-independent 的 current/。
    await resolveCosVersion();
    return `${COS_BASE}/current`;
}

/**
 * 搜索分片根 URL —— 走 v/<commit>/search/，commit-isolated。
 *
 * search 倒排索引文件互相引用，必须跟当前 entry snapshot 一致。如果跟 entry/
 * 一起进 current/，部分 client 会在版本切换时拉到混合 snapshot（旧 ID 找不到新
 * entry / 新 ID 取到旧 entry），出现搜索结果失效。所以 search 维持 commit 隔离。
 */
export async function getCosSearchBaseUrl(): Promise<string> {
    const commit = await resolveCosVersion();
    return `${COS_BASE}/v/${commit}/search`;
}

// ─── h1（哈希寻址）取数路径：读 root → 读条目所在分片 → 取 entry ───
//
// 与现行路径的关键区别：entry URL 本身带内容哈希（immutable，可无限期强缓存）；
// 取一条条目要先解析它落在哪个 manifest 分片（内存缓存，同一会话内同分片的
// 其余条目免费复用），比现行路径多一次往返，换来的是「改一条不冲全站」。
// 见任务书 A3-部分更新-哈希寻址、[29 卡](../../../../overview/项目进展/古籍索引网站/进度/G-工具分发与网站/29-架构原型实测.md)。

interface H1ManifestRoot {
    shardKeyLength: number;
    shardSpace: number;
    shardCount: number;
    generatedAt: string;
    dataCommit: { commitId?: string; productionCommitId?: string; textCommitId?: string };
}

function getH1BaseUrl(): string {
    return `${COS_BASE}/h1`;
}

let _h1ManifestRootPromise: Promise<H1ManifestRoot> | null = null;

/** manifest-root.json 是短缓存（60–300s），不做 sessionStorage 之类的额外缓存，靠 HTTP 缓存本身。 */
function resolveH1ManifestRoot(): Promise<H1ManifestRoot> {
    if (!_h1ManifestRootPromise) {
        _h1ManifestRootPromise = fetch(`${getH1BaseUrl()}/manifest-root.json`, { cache: 'no-store' })
            .then(r => {
                if (!r.ok) throw new Error(`manifest-root.json HTTP ${r.status}`);
                return r.json() as Promise<H1ManifestRoot>;
            })
            .catch(err => {
                _h1ManifestRootPromise = null;
                throw err;
            });
    }
    return _h1ManifestRootPromise;
}

// 分片按 id → hash8 表，同一分片内的 id 只需拉一次，页面生命周期内内存缓存。
const _h1ShardCache = new Map<string, Promise<Record<string, string>>>();

function h1ShardKeyFor(id: string, shardKeyLength: number): string {
    return id.slice(-shardKeyLength);
}

/** 解析一个 id 当前的内容哈希；manifest 里没有这个 id 视同 404（条目不存在或已被移除）。 */
async function resolveH1EntryHash(id: string): Promise<string | null> {
    const root = await resolveH1ManifestRoot();
    const shardKey = h1ShardKeyFor(id, root.shardKeyLength);
    let shardPromise = _h1ShardCache.get(shardKey);
    if (!shardPromise) {
        shardPromise = fetch(`${getH1BaseUrl()}/manifest/${shardKey}.json`, { cache: 'no-store' })
            .then(r => {
                if (!r.ok) throw new Error(`manifest/${shardKey}.json HTTP ${r.status}`);
                return r.json() as Promise<Record<string, string>>;
            });
        _h1ShardCache.set(shardKey, shardPromise);
    }
    const shard = await shardPromise;
    return shard[id] ?? null;
}

/**
 * 丢掉一个 id 所在分片的内存缓存，下次 resolveH1EntryHash 会重新 fetch。
 *
 * 用于 entry 404 时的加固（见 fetchRawDetailH1）：分片有短缓存（60–300s）＋
 * 页面内存缓存两层，都可能比 COS 上的最新状态慢半拍——尤其 sync 端「旧 entry
 * 保留 7 天」意味着旧哈希文件仍在，但分片一旦更新到新哈希，旧 URL 就会 404。
 */
async function invalidateH1Shard(id: string): Promise<void> {
    const root = await resolveH1ManifestRoot();
    _h1ShardCache.delete(h1ShardKeyFor(id, root.shardKeyLength));
}

// entry/<id>.<hash8>.json 本身按内容哈希寻址，可以放心用 force-cache（浏览器永久缓存，
// 内容变了 URL 也会变，不存在「缓存了旧内容」这回事）。
const _h1EntryCache = new Map<string, Promise<Record<string, unknown> | null>>();

// promotions.json（draft→production 重定向表）不在 h1 范围内——A3 第一期只做
// entry 本身，promotions 仍从现行 current/ 读（见 createCosStorage 里的
// ensurePromotions，两条路径共用同一份）。这不是遗漏：那份表很小、改动频率低，
// 不是 R4「改一条目冲全站缓存」这个痛点要解的对象，留给条目全部按哈希寻址后
// 视情况再一并处理。
/** 单次尝试：拿 hash 直接拼 URL 去取，不重试、不上报，调用方决定怎么处理结果。 */
function fetchH1EntryOnce(canonicalId: string, hash: string): Promise<Response> {
    const url = `${getH1BaseUrl()}/entry/${encodeURIComponent(canonicalId)}.${hash}.json`;
    return fetch(url, { cache: 'force-cache' });
}

/**
 * entry 404 时的加固：分片缓存（内存 + HTTP 短缓存）可能比 COS 落后一步，
 * 指向一个已经不存在的旧哈希——sync 端「新 entry 上线」与「分片更新」隔着
 * 两个上传批次，加上前端自己的缓存分层，短暂的不一致是设计内允许的，不能让它
 * 直接变成读者看到的 404。策略：清掉分片缓存重取一次，hash 变了就再试一次
 * entry；两次都不行（或分片仍指向同一个 hash）才真的判 404。
 */
async function fetchRawDetailH1(canonicalId: string): Promise<Record<string, unknown> | null> {
    let cached = _h1EntryCache.get(canonicalId);
    if (!cached) {
        cached = (async () => {
            const hash = await resolveH1EntryHash(canonicalId);
            if (!hash) {
                reportError({ kind: 'fetch', message: `entry 不存在 (404，h1 manifest 未命中)`, resource: canonicalId, status: 404 });
                return null;
            }

            let res = await fetchH1EntryOnce(canonicalId, hash);
            if (res.status === 404) {
                await invalidateH1Shard(canonicalId);
                const freshHash = await resolveH1EntryHash(canonicalId);
                if (freshHash && freshHash !== hash) {
                    res = await fetchH1EntryOnce(canonicalId, freshHash);
                }
                // freshHash 为空或跟 hash 相同：分片本来就是最新的，entry 就是真 404，
                // 不必再试第三次——上面这一次 res 仍是 404，走到下面统一报错分支。
            }

            if (res.status === 404) {
                reportError({ kind: 'fetch', message: `entry 不存在 (404)`, resource: canonicalId, status: 404 });
                return null;
            }
            if (!res.ok) {
                reportError({ kind: 'fetch', message: `entry 拉取失败: HTTP ${res.status}`, resource: canonicalId, status: res.status });
                throw new Error(`entry ${canonicalId}: HTTP ${res.status}`);
            }
            return res.json();
        })();
        _h1EntryCache.set(canonicalId, cached);
    }
    return cached as Promise<Record<string, unknown> | null>;
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
            // 版本号必须从 resolveCosVersion()（读不缓存的 latest.json）拿，注入给
            // BundleStorage —— 不能让它自己 fetch basePath/version.json：那是
            // current/version.json，被 CDN 打了 immutable 长缓存，实测滞后 9+ 天。
            resolving = Promise.all([getCosDataBaseUrl(), resolveCosVersion()]).then(
                ([baseUrl, commit]) => {
                    resolved = { inner: new BundleStorage({ basePath: baseUrl, version: commit }), baseUrl };
                    return resolved;
                }
            );
        }
        return resolving;
    }

    // entry/{id}.json 内存缓存：同 ID 反复 getEntry 不重复 fetch
    const entryCache = new Map<string, Promise<unknown>>();

    // current/ 是 commit-independent 单副本，必须靠 ?v=<commit> 让 CDN 把不同版本
    // 分离缓存；否则浏览器/CDN 会把上次的内容当成"还新"。
    async function withCacheBust(path: string): Promise<string> {
        const { baseUrl } = await ensureInner();
        const commit = await resolveCosVersion();
        return `${baseUrl}/${path}?v=${commit}`;
    }

    // promotions.json 一次性加载、模块生命周期共享。Map 为空 → 没有任何已升级。
    let promotionsPromise: Promise<Map<string, string>> | null = null;
    function ensurePromotions(): Promise<Map<string, string>> {
        if (promotionsPromise) return promotionsPromise;
        promotionsPromise = (async () => {
            // 取不到就退回空 Map —— 但**必须上报**。空 Map 与「一条升格都没有」
            // 长得一模一样，而它的后果是所有 draft→production 重定向静默失效，
            // 每个旧链接都变成「找不到」。2026-09-14 从错误日志里查到过一条实证：
            // 1evr5e3mct1mt 明明在 promotions.json 里，却报了 entry 404，
            // 只可能是那一次这张表没加载上。（这个文件有 18.9 MB，不是小概率事件。）
            try {
                const url = await withCacheBust('promotions.json');
                const res = await fetch(url, { cache: 'force-cache' });
                if (!res.ok) {
                    reportError({
                        kind: 'fetch',
                        message: `promotions 拉取失败: HTTP ${res.status}（草稿 ID 重定向已失效）`,
                        resource: 'promotions.json',
                        status: res.status,
                    });
                    return new Map();
                }
                return buildPromotionMap(await res.json());
            } catch (err) {
                reportError({
                    kind: 'fetch',
                    message: `promotions 加载异常: ${String((err as Error)?.message ?? err)}（草稿 ID 重定向已失效）`,
                    resource: 'promotions.json',
                });
                return new Map();
            }
        })();
        return promotionsPromise;
    }

    // 取原始 detail JSON（getItem 返回原貌，getEntry 在此基础上转 IndexEntry shape）
    async function fetchRawDetail(canonicalId: string): Promise<Record<string, unknown> | null> {
        // 开关打开时整条走 h1 路径；默认（未设置或非 'hashed'）以下现行逻辑原样不动。
        if (DATA_LAYOUT === 'hashed') return fetchRawDetailH1(canonicalId);

        let cached = entryCache.get(canonicalId);
        if (!cached) {
            cached = (async () => {
                const url = await withCacheBust(`entry/${encodeURIComponent(canonicalId)}.json`);
                const res = await fetch(url, { cache: 'force-cache' });
                if (res.status === 404) {
                    // 多为坏链 / 引用了不存在的 ID；查看页可按 status=404 过滤掉看真错误
                    reportError({ kind: 'fetch', message: `entry 不存在 (404)`, resource: canonicalId, status: 404 });
                    return null;
                }
                if (!res.ok) {
                    reportError({ kind: 'fetch', message: `entry 拉取失败: HTTP ${res.status}`, resource: canonicalId, status: res.status });
                    throw new Error(`entry ${canonicalId}: HTTP ${res.status}`);
                }
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
            // _path / _isDraft 由 bundle-data.mjs 在 entry/{id}.json 里注入。
            // 老 bundle 没这两字段时回退：path 留空（右上角链接会少一段目录），
            // isDraft 默认 true（保持改造前行为）。
            path: (d._path as string) || '',
            isDraft: typeof d._isDraft === 'boolean' ? (d._isDraft as boolean) : true,
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
