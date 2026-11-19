/**
 * book-versions.mjs — 数据地址按书版本化（current/items/<书 ID>/** 的 `?v=`）
 *
 * 为什么：`current/*?v=<cacheKey>` 的 cacheKey 是整库一个键，每次数据发布（约每天 7 次）都换，
 * EdgeOne 缓存键含全部查询串，没改的书也整体回源（COS 本月 CDN 回源约 49GB）。
 * 做法：每本书按自己 items/<id>/ 下全部文件的内容算一个 bookVer（16 位），没改的书地址在多次发布间不变。
 *
 * 版本由内容算出（路径＋md5，排序后 sha256），不手动递增：漏递增就是 CDN 吐旧内容（overview#169、#322 的教训）。
 * 回滚到旧内容，摘要回到旧值，天然回到旧地址。
 *
 * 清单按书 ID 末 2 位分片（与 promotions 同一套切法，每片几百字节）：`current/vers/<末2位>.json`
 *   { "version": 1, "books": { "<书ID>": { "v": "<16位摘要>" } } }
 * 前端读分片时带全局 cacheKey 做 `?v=`（每次发布换一次，片很小，回源可忽略），保证清单永远是新的。
 * 纯函数，不读写文件，sync-to-cos.mjs 用，jest／node --test 直接测。
 * 与前端口径的对应：src/lib/book-version.ts（切分与路径规则必须一致，有测试守着）。
 */
import { createHash } from 'node:crypto';

export const BOOK_VERSION_SHARD_KEY_LENGTH = 2;
export const BOOK_VERSION_SHARD_DIR = 'vers';
export const BOOK_VERSION_SCHEMA = 1;

const ITEMS_PATH_RE = /^items\/([\w-]+)\//;

/** `items/<id>/…` 的书 ID；不是书内文件返回 null */
export function bookIdOfPath(relative) {
    const m = ITEMS_PATH_RE.exec(relative);
    return m ? m[1] : null;
}

/** 书 ID 所在分片的键（末 N 位）；ID 太短或含非法字符返回 null（这样的书照旧用全局键） */
export function bookVersionShardKey(id) {
    if (typeof id !== 'string' || id.length < BOOK_VERSION_SHARD_KEY_LENGTH || !/^[\w-]+$/.test(id)) return null;
    return id.slice(-BOOK_VERSION_SHARD_KEY_LENGTH);
}

/**
 * 每本书的版本。files：[{ relative }]；md5Of(relative) 取该文件内容 md5。
 * 返回 Map<书ID, 16 位摘要>。只看路径与内容，不看 mtime、遍历顺序。
 */
export function computeBookVersions(files, md5Of) {
    const byBook = new Map();
    for (const f of files) {
        const id = bookIdOfPath(f.relative);
        if (!id) continue;
        let list = byBook.get(id);
        if (!list) byBook.set(id, (list = []));
        list.push(`${f.relative}\0${md5Of(f.relative)}`);
    }
    const out = new Map();
    for (const [id, list] of byBook) {
        list.sort();
        out.set(id, createHash('sha256').update(list.join('\n')).digest('hex').slice(0, 16));
    }
    return out;
}

/**
 * 分片内容：Map<分片键, JSON 文本>。键与书都排序、不含时间戳，同样的输入每次产出逐字节一致（增量同步才能跳过没变的片）。
 * 键不合法的书（ID 太短等）不进清单。
 */
export function buildBookVersionShards(versions) {
    const shards = new Map();
    for (const id of [...versions.keys()].sort()) {
        const key = bookVersionShardKey(id);
        if (!key) continue;
        let books = shards.get(key);
        if (!books) shards.set(key, (books = {}));
        books[id] = { v: versions.get(id) };
    }
    const out = new Map();
    for (const key of [...shards.keys()].sort()) {
        out.set(key, JSON.stringify({ version: BOOK_VERSION_SCHEMA, books: shards.get(key) }) + '\n');
    }
    return out;
}

/** 分片在数据目录里的相对路径（与 COS 上 current/ 下一致） */
export function bookVersionShardPath(key) {
    return `${BOOK_VERSION_SHARD_DIR}/${key}.json`;
}
