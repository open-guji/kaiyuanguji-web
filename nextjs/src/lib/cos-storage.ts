/**
 * COS 数据源支持
 *
 * 流程：
 *   1. 浏览器启动 fetch `${COS_BASE}/latest.json` 拿当前发布的版本键：优先 cacheKey
 *      （三仓 commit 合成键），旧数据没有该字段时回退 commitId（见 data-version.ts）
 *   2. entry/ 与 index/ 走 commit-independent 的 `${COS_BASE}/current/`，
 *      靠 `?v=${版本键}` 让 CDN 区分版本（见 withCacheBust）；
 *      search 分片仍走 `${COS_BASE}/v/${版本键}/search`，版本隔离（见 getCosSearchBaseUrl）
 *      只用 draft 的 commitId 当版本键时，只有 production／book-text 变的发布
 *      URL 不变，immutable 缓存一直吐旧版（overview#169），所以改用 cacheKey。
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
import { dataVersionKey, type LatestPointer } from './data-version';

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
 * 解析 COS 上当前发布的版本键（cacheKey，缺则回退 commitId）。
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
            .then((j: LatestPointer) => {
                const key = dataVersionKey(j);
                if (!j.commitId || !key) throw new Error('latest.json missing commitId');
                setRelease(j.commitId); // 把数据版本（draft commit）附到后续错误上报里
                return key;
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
 *   - 客户端用 BundleStorage 的 ?v=<版本键> 自动 cache-bust（版本键由本模块注入）。
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
 * 搜索分片根 URL —— 走 v/<版本键>/search/，按版本隔离。
 *
 * 路径本身带版本，但以前的版本只是 draft commit：只有 production 变时 search
 * 会重建、却覆盖写回同一路径（immutable 缓存）→ 与 ?v= 同样的旧缓存问题。
 * 现在与 ?v= 同用 cacheKey。
 *
 * search 倒排索引文件互相引用，必须跟当前 entry snapshot 一致。如果跟 entry/
 * 一起进 current/，部分 client 会在版本切换时拉到混合 snapshot（旧 ID 找不到新
 * entry / 新 ID 取到旧 entry），出现搜索结果失效。所以 search 维持 commit 隔离。
 */
export async function getCosSearchBaseUrl(): Promise<string> {
    const key = await resolveCosVersion();
    return `${COS_BASE}/v/${key}/search`;
}

// ─── h1（哈希寻址）取数路径：读指针 → 读 root → 读条目所在分片 → 取 entry ───
//
// 与现行路径的关键区别：entry URL 本身带内容哈希（immutable，可无限期强缓存）；
// 取一条条目要先解析它落在哪个 manifest 分片（内存缓存，同一会话内同分片的
// 其余条目免费复用），比现行路径多两次往返（root、分片各一次），换来的是
// 「改一条不冲全站」。见任务书 A3-部分更新-哈希寻址、S3-h1版本根清单、
// [29 卡](../../../../overview/项目进展/古籍索引网站/进度/G-工具分发与网站/29-架构原型实测.md)。
//
// S3（h1 版本根清单，2026-09-27）：manifest 分片原本固定路径、原地覆盖，
// 一次发布不是原子切换。改法：分片也按内容哈希命名，manifest-root.json 降级
// 成一个「指向哪个 root」的短缓存指针，root 文档（`roots/<key>.json`）本身
// 不可变、列出本版全部分片的文件名。取数因此变成四级：
//   指针（manifest-root.json，短缓存）
//   → root（roots/<key>.json，内容寻址，可长缓存）
//   → 分片（manifest/<后缀>.<hash8>.json，内容寻址，可长缓存）
//   → entry（entry/<id>.<hash8>.json，内容寻址，可长缓存）
// 只有第一跳（指针）需要短缓存／不缓存去感知新发布，后三跳全部不可变。

interface H1ManifestRoot {
    version: number;
    root: string; // roots/ 下的文件名，如 "<dataCommitKey>.json"
    generatedAt: string;
    dataCommit: { commitId?: string; productionCommitId?: string; textCommitId?: string };
}

interface H1RootDoc {
    version: number;
    shardKeyLength: number;
    shardSpace: number;
    shardCount: number;
    generatedAt: string;
    dataCommit: { commitId?: string; productionCommitId?: string; textCommitId?: string };
    shards: Record<string, string>; // 分片后缀 → 该分片文件的内容哈希（hash8）
}

function getH1BaseUrl(): string {
    return `${COS_BASE}/h1`;
}

let _h1ManifestRootPromise: Promise<H1ManifestRoot> | null = null;
let _h1RootDocPromise: Promise<H1RootDoc> | null = null;

/** 指针本身短缓存（60–300s），不做 sessionStorage 之类的额外缓存，靠 HTTP 缓存本身。 */
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

/** root 文档不可变（同一 `root` 文件名内容恒定），可以放心 force-cache。 */
function resolveH1RootDoc(): Promise<H1RootDoc> {
    if (!_h1RootDocPromise) {
        _h1RootDocPromise = resolveH1ManifestRoot()
            .then(pointer => fetch(`${getH1BaseUrl()}/roots/${pointer.root}`, { cache: 'force-cache' }))
            .then(r => {
                if (!r.ok) throw new Error(`roots/<root> HTTP ${r.status}`);
                return r.json() as Promise<H1RootDoc>;
            })
            .catch(err => {
                _h1RootDocPromise = null;
                throw err;
            });
    }
    return _h1RootDocPromise;
}

/** 丢掉指针与 root 文档的内存缓存，下次会重新走一遍指针→root。见 fetchRawDetailH1 的 404 加固。 */
function invalidateH1Root(): void {
    _h1ManifestRootPromise = null;
    _h1RootDocPromise = null;
}

// 分片按 "后缀.分片哈希" 做 key，同一分片内的 id 只需拉一次；分片本身内容
// 寻址、可长缓存——不同哈希天然是不同 key，无需显式失效单个分片。
const _h1ShardCache = new Map<string, Promise<Record<string, string>>>();

function h1ShardKeyFor(id: string, shardKeyLength: number): string {
    return id.slice(-shardKeyLength);
}

/** 解析一个 id 当前的内容哈希；root 里没有它所在的分片、或分片里没有它，都视同 404。 */
async function resolveH1EntryHash(id: string): Promise<string | null> {
    const root = await resolveH1RootDoc();
    const shardKey = h1ShardKeyFor(id, root.shardKeyLength);
    const shardHash = root.shards[shardKey];
    if (!shardHash) return null;
    const cacheKey = `${shardKey}.${shardHash}`;
    let shardPromise = _h1ShardCache.get(cacheKey);
    if (!shardPromise) {
        shardPromise = fetch(`${getH1BaseUrl()}/manifest/${shardKey}.${shardHash}.json`, { cache: 'force-cache' })
            .then(r => {
                if (!r.ok) throw new Error(`manifest/${shardKey}.${shardHash}.json HTTP ${r.status}`);
                return r.json() as Promise<Record<string, string>>;
            });
        _h1ShardCache.set(cacheKey, shardPromise);
    }
    const shard = await shardPromise;
    return shard[id] ?? null;
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
 * entry 404 时的加固：指针/root/分片缓存都可能比 COS 落后一步，指向一个
 * 已经不存在的旧哈希——sync 端「新 entry 上线」与「指针翻转」隔着几个上传批次，
 * 加上前端自己的缓存分层，短暂的不一致是设计内允许的，不能让它直接变成读者
 * 看到的 404。策略：清掉指针＋root 缓存重新走一遍解析，hash 变了就再试一次
 * entry；两次都不行（或重新解析后 hash 仍相同）才真的判 404。
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
                invalidateH1Root();
                const freshHash = await resolveH1EntryHash(canonicalId);
                if (freshHash && freshHash !== hash) {
                    res = await fetchH1EntryOnce(canonicalId, freshHash);
                }
                // freshHash 为空或跟 hash 相同：指针/root 本来就是最新的，entry 就是
                // 真 404，不必再试第三次——上面这一次 res 仍是 404，走到下面统一报错分支。
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

// ─── h1（哈希寻址）取整理本／全文：读 text-manifest-root → 读 owner 所在分片 → 取文件 ───
//
// A3b 第二期。与上面 entry 的哈希寻址是并列的两套 manifest 空间——entry 的 key
// 是「条目 id」，这里的 key 是「owner_id + 相对路径」二元组——各自独立缓存、
// 各自的 manifest-root，互不干扰，但取数思路一致：先查 manifest 拿到内容哈希，
// 再拼 immutable URL 去取真正的文件。
//
// 五个方法与 book-index-ui 的 BundleStorage（bim/ui，本道不改）逐条对齐：
// getCollatedEditionIndex / getCollatedJuan / getCollatedJuanText /
// getBookFullTextIndex / getBookFullTextChapter——URL 拼法、参数校验
// （拒绝 `..`、拒绝非 `.json`/`.md` 后缀）、404 语义（返回 null）全部照抄，
// 保证两条路径对同一份字节的读取结果一致。见 bundle-hashed-text.mjs 的
// 文件头注释：relPath 与 items/<owner_id>/ 下的现行路径逐段对应。

interface H1TextManifestRoot {
    version: number;
    root: string; // text-roots/ 下的文件名
    generatedAt: string;
    dataCommit: { commitId?: string; productionCommitId?: string; textCommitId?: string };
}

interface H1TextRootDoc {
    version: number;
    shardKeyLength: number;
    shardSpace: number;
    shardCount: number;
    ownerCount: number;
    fileCount: number;
    generatedAt: string;
    dataCommit: { commitId?: string; productionCommitId?: string; textCommitId?: string };
    shards: Record<string, string>; // owner 后缀 → 该分片文件的内容哈希（hash8）
}

let _h1TextManifestRootPromise: Promise<H1TextManifestRoot> | null = null;
let _h1TextRootDocPromise: Promise<H1TextRootDoc> | null = null;

function resolveH1TextManifestRoot(): Promise<H1TextManifestRoot> {
    if (!_h1TextManifestRootPromise) {
        _h1TextManifestRootPromise = fetch(`${getH1BaseUrl()}/text-manifest-root.json`, { cache: 'no-store' })
            .then(r => {
                if (!r.ok) throw new Error(`text-manifest-root.json HTTP ${r.status}`);
                return r.json() as Promise<H1TextManifestRoot>;
            })
            .catch(err => {
                _h1TextManifestRootPromise = null;
                throw err;
            });
    }
    return _h1TextManifestRootPromise;
}

/** root 文档不可变，可以放心 force-cache。 */
function resolveH1TextRootDoc(): Promise<H1TextRootDoc> {
    if (!_h1TextRootDocPromise) {
        _h1TextRootDocPromise = resolveH1TextManifestRoot()
            .then(pointer => fetch(`${getH1BaseUrl()}/text-roots/${pointer.root}`, { cache: 'force-cache' }))
            .then(r => {
                if (!r.ok) throw new Error(`text-roots/<root> HTTP ${r.status}`);
                return r.json() as Promise<H1TextRootDoc>;
            })
            .catch(err => {
                _h1TextRootDocPromise = null;
                throw err;
            });
    }
    return _h1TextRootDocPromise;
}

function invalidateH1TextRoot(): void {
    _h1TextManifestRootPromise = null;
    _h1TextRootDocPromise = null;
}

// 分片按 "后缀.分片哈希" 做 key：owner_id → { 相对路径 → hash8 } 表；同一分片内
// 其余 owner 的其余文件免费复用，分片本身内容寻址、可长缓存。
const _h1TextShardCache = new Map<string, Promise<Record<string, Record<string, string>>>>();

function h1TextShardKeyFor(ownerId: string, shardKeyLength: number): string {
    return ownerId.slice(-shardKeyLength);
}

async function resolveH1TextShard(ownerId: string, root: H1TextRootDoc): Promise<Record<string, Record<string, string>>> {
    const shardKey = h1TextShardKeyFor(ownerId, root.shardKeyLength);
    const shardHash = root.shards[shardKey];
    if (!shardHash) return {};
    const cacheKey = `${shardKey}.${shardHash}`;
    let shardPromise = _h1TextShardCache.get(cacheKey);
    if (!shardPromise) {
        shardPromise = fetch(`${getH1BaseUrl()}/text-manifest/${shardKey}.${shardHash}.json`, { cache: 'force-cache' })
            .then(r => {
                if (!r.ok) throw new Error(`text-manifest/${shardKey}.${shardHash}.json HTTP ${r.status}`);
                return r.json() as Promise<Record<string, Record<string, string>>>;
            });
        _h1TextShardCache.set(cacheKey, shardPromise);
    }
    return shardPromise;
}

async function resolveH1TextHash(ownerId: string, relPath: string): Promise<string | null> {
    const root = await resolveH1TextRootDoc();
    const shard = await resolveH1TextShard(ownerId, root);
    return shard[ownerId]?.[relPath] ?? null;
}

/** relPath 最后一段插入哈希：与 bundle-hashed-text.mjs 的 insertHash() 是同一套算法。 */
function insertH1TextHash(relPath: string, hash: string): string {
    const slash = relPath.lastIndexOf('/');
    const dir = slash === -1 ? '' : relPath.slice(0, slash + 1);
    const base = slash === -1 ? relPath : relPath.slice(slash + 1);
    const dot = base.lastIndexOf('.');
    if (dot === -1) return `${dir}${base}.${hash}`;
    return `${dir}${base.slice(0, dot)}.${hash}${base.slice(dot)}`;
}

/**
 * 取一份哈希寻址的文本文件，原样返回字符串；查不到 manifest 条目或 HTTP
 * 非 2xx（含分片滞后于最新哈希导致的 404，清缓存重取一次分片）一律返回 null，
 * 不抛错——与 BundleStorage 的 getCollatedJuanText/getBookFullTextChapter
 * 404→null 语义保持一致。
 */
async function fetchH1TextRaw(ownerId: string, relPath: string): Promise<string | null> {
    try {
        let hash = await resolveH1TextHash(ownerId, relPath);
        if (!hash) return null;

        let res = await fetch(`${getH1BaseUrl()}/text/${encodeURIComponent(ownerId)}/${insertH1TextHash(relPath, hash)}`, { cache: 'force-cache' });
        if (res.status === 404) {
            invalidateH1TextRoot();
            const freshHash = await resolveH1TextHash(ownerId, relPath);
            if (freshHash && freshHash !== hash) {
                hash = freshHash;
                res = await fetch(`${getH1BaseUrl()}/text/${encodeURIComponent(ownerId)}/${insertH1TextHash(relPath, hash)}`, { cache: 'force-cache' });
            }
        }
        return res.ok ? await res.text() : null;
    } catch {
        return null;
    }
}

async function fetchH1TextJson(ownerId: string, relPath: string): Promise<Record<string, unknown> | null> {
    const raw = await fetchH1TextRaw(ownerId, relPath);
    if (raw === null) return null;
    try {
        return JSON.parse(raw);
    } catch {
        return null;
    }
}

// ─── 整理本 ───

async function getCollatedEditionIndexH1(workId: string): Promise<Record<string, unknown> | null> {
    const primary = await fetchH1TextJson(workId, 'collated_edition/index.json');
    if (primary !== null) return primary;
    // 旧命名兜底（同目录下的 collated_edition_index.json），与 BundleStorage 一致。
    return fetchH1TextJson(workId, 'collated_edition/collated_edition_index.json');
}

async function getCollatedJuanH1(workId: string, juanFile: string): Promise<Record<string, unknown> | null> {
    if (juanFile.includes('..') || !juanFile.endsWith('.json')) return null;
    return fetchH1TextJson(workId, `collated_edition/${juanFile}`);
}

async function getCollatedJuanTextH1(workId: string, juanFile: string): Promise<string | null> {
    if (juanFile.includes('..') || !juanFile.endsWith('.json')) return null;
    const txtName = juanFile.replace(/\.json$/, '.txt');
    return fetchH1TextRaw(workId, `collated_edition/text/${txtName}`);
}

// ─── Book 全文 ───

async function getBookFullTextIndexH1(bookId: string): Promise<Record<string, unknown> | null> {
    return fetchH1TextJson(bookId, 'full_text/index.json');
}

async function getBookFullTextChapterH1(bookId: string, file: string): Promise<string | null> {
    if (file.includes('..')) return null;
    const txtName = file.endsWith('.md') ? file.replace(/\.md$/, '.txt') : file;
    return fetchH1TextRaw(bookId, `full_text/${txtName}`);
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

    // current/ 是 commit-independent 单副本，必须靠 ?v=<版本键> 让 CDN 把不同版本
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
            // 整理本／全文：开关打开时整条走 h1 路径（见上方 H1 系列函数）；
            // 默认（未设置或非 'hashed'）不特殊处理这五个方法名，走下面的
            // 通用分支委托给 inner（book-index-ui 的 BundleStorage），
            // 与开这个开关之前的行为完全一致——bim/ui 本道不改。
            if (DATA_LAYOUT === 'hashed') {
                if (prop === 'getCollatedEditionIndex') return (workId: string) => getCollatedEditionIndexH1(workId);
                if (prop === 'getCollatedJuan') return (workId: string, juanFile: string) => getCollatedJuanH1(workId, juanFile);
                if (prop === 'getCollatedJuanText') return (workId: string, juanFile: string) => getCollatedJuanTextH1(workId, juanFile);
                if (prop === 'getBookFullTextIndex') return (bookId: string) => getBookFullTextIndexH1(bookId);
                if (prop === 'getBookFullTextChapter') return (bookId: string, file: string) => getBookFullTextChapterH1(bookId, file);
            }
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
