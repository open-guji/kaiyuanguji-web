/**
 * 图文对读的数据文件（overview#425）：章在 `items/<id>/<版本 key>/index.json` 里的条目用 `*_file` 字段声明有哪些层，
 * 网站只按声明取，不写死书 id、不猜文件名：
 *   - `char_file`（必有）：每格的字（guji-char，文本真源）；
 *   - `cord_file`：每格的像素框（guji-cord）——**有它才有对读**，没有就是普通阅读，不发请求；
 *   - `punct_file`：标点；`entity_file`：专名实体。
 * `pages_file`、`has_warp` 随 pages.json 作废。四个文件在同一章里按格位 key（`页:列:格[子列]`）对上。
 */

export interface DuiduFiles {
    char: unknown;
    cord: unknown;
    punct: unknown;
    entity: unknown;
}

/**
 * 取一份版本目录下的文本 JSON 的方法。cos 数据源（含 h1 哈希寻址）的 storage 上有，
 * 与 getChapter 走同一套取数；bundle／本地模式的 storage 上没有，退回同域 `/data/items/...`。
 */
export interface TextFileStorage {
    getTextFile?: (id: string, key: string, file: string) => Promise<unknown>;
}

const cache = new Map<string, Promise<DuiduFiles | null>>();

async function getJson(storage: object | undefined, id: string, key: string, file: string): Promise<unknown> {
    try {
        const getTextFile = (storage as TextFileStorage | undefined)?.getTextFile;
        if (typeof getTextFile === 'function') return (await getTextFile.call(storage, id, key, file)) ?? null;
        const res = await fetch(`/data/items/${id}/${key}/${file}`);
        return res.ok ? await res.json() : null;
    } catch {
        return null;
    }
}

const fileField = (ch: Record<string, unknown>, k: string): string | null => {
    const v = ch[k];
    // 只认章目录所在目录下的文件名，不让条目写出路径把请求带到别处
    return typeof v === 'string' && /^[\w.-]+$/.test(v) ? v : null;
};

/** 取本章的对读数据；本章没有声明 `char_file`＋`cord_file`、或这两个取不到返回 null（不缓存失败） */
export function loadDuiduFiles(
    id: string,
    ctx: { versionKey: string | null; chapter: Record<string, unknown> | null } | undefined,
    _chapterKey: string,
    /** 当前数据源的 storage（transport）；不传或没有 getTextFile 就读同域 /data */
    storage?: object,
): Promise<DuiduFiles | null> {
    const ch = ctx?.chapter;
    const key = ctx?.versionKey;
    if (!ch || !key) return Promise.resolve(null);
    const charFile = fileField(ch, 'char_file');
    const cordFile = fileField(ch, 'cord_file');
    if (!charFile || !cordFile) return Promise.resolve(null);
    const punctFile = fileField(ch, 'punct_file');
    const entityFile = fileField(ch, 'entity_file');
    const cacheKey = `${id}/${key}/${charFile}|${cordFile}|${punctFile ?? ''}|${entityFile ?? ''}`;
    let p = cache.get(cacheKey);
    if (!p) {
        p = (async () => {
            const [char, cord, punct, entity] = await Promise.all([
                getJson(storage, id, key, charFile),
                getJson(storage, id, key, cordFile),
                punctFile ? getJson(storage, id, key, punctFile) : null,
                entityFile ? getJson(storage, id, key, entityFile) : null,
            ]);
            if (!char || !cord) return null;
            return { char, cord, punct, entity };
        })();
        cache.set(cacheKey, p);
        p.then(v => { if (!v) cache.delete(cacheKey); });
    }
    return p;
}
