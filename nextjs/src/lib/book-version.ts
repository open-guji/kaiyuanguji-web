/**
 * 数据地址按书版本化（前端口径；脚本侧是 scripts/lib/book-versions.mjs，切分与路径规则必须一致，有测试守着）。
 *
 * `current/items/<书 ID>/**` 的 `?v=` 不再用整库一个的 cacheKey，改用这本书自己的 bookVer（内容摘要）：
 * 没改的书地址在多次发布间不变，一直命中 CDN。清单按书 ID 末 2 位分片：`current/vers/<末2位>.json`
 *   { "version": 1, "books": { "<书ID>": { "v": "<16位摘要>" } } }
 * 清单取不到、书不在清单里、格式不对 ⇒ 一律回退全局 cacheKey（旧数据、新旧前端混跑都照常）。
 * 设计见 docs/数据地址按书版本化.md。本文件客户端、服务端共用，不能引服务端模块。
 */

export const BOOK_VERSION_SHARD_KEY_LENGTH = 2;
const SHARD_DIR = 'vers';
const ITEMS_PATH_RE = /^items\/([\w-]+)\//;
const BOOK_VER_RE = /^[0-9a-f]{16}$/;

/** `items/<id>/…` 的书 ID；不是书内文件返回 null */
export function bookIdOfItemsPath(relPath: string): string | null {
    const m = ITEMS_PATH_RE.exec(relPath);
    return m ? m[1] : null;
}

/** 书 ID 所在分片的键；ID 太短或含非法字符返回 null（这样的书用全局键） */
export function bookVersionShardKey(id: string): string | null {
    if (typeof id !== 'string' || id.length < BOOK_VERSION_SHARD_KEY_LENGTH || !/^[\w-]+$/.test(id)) return null;
    return id.slice(-BOOK_VERSION_SHARD_KEY_LENGTH);
}

/** 分片地址：`<数据根>/vers/<键>.json?v=<全局 cacheKey>`（base 是 current/ 根；全局键每次发布换一次，保证清单永远是新的） */
export function bookVersionShardUrl(currentBase: string, shardKey: string, globalKey: string | undefined): string {
    return `${currentBase}/${SHARD_DIR}/${shardKey}.json${globalKey ? `?v=${globalKey}` : ''}`;
}

export type BookVersionShard = Record<string, string>;

/** 解析分片，只留合格的「书 ID → 16 位摘要」；整体格式不对返回 null（调用方回退全局键） */
export function parseBookVersionShard(raw: unknown): BookVersionShard | null {
    if (!raw || typeof raw !== 'object') return null;
    const doc = raw as { version?: unknown; books?: unknown };
    if (doc.version !== 1 || !doc.books || typeof doc.books !== 'object' || Array.isArray(doc.books)) return null;
    const out: BookVersionShard = {};
    for (const [id, row] of Object.entries(doc.books as Record<string, unknown>)) {
        const v = row && typeof row === 'object' ? (row as { v?: unknown }).v : undefined;
        if (typeof v === 'string' && BOOK_VER_RE.test(v)) out[id] = v;
    }
    return out;
}

/**
 * 一份 current/ 下相对路径该用的 `?v=`：书内文件（items/<id>/…）用该书的 bookVer，其余用全局键。
 * lookup 取分片失败请自己吞掉并返回 null；这里不抛错。
 */
export async function versionForPath(
    relPath: string,
    globalKey: string | undefined,
    lookup: (id: string) => Promise<string | null>,
): Promise<string | undefined> {
    const id = bookIdOfItemsPath(relPath);
    if (!id) return globalKey;
    try {
        return (await lookup(id)) ?? globalKey;
    } catch {
        return globalKey;
    }
}
