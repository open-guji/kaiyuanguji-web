/**
 * 图文对读的数据文件：`items/<id>/<版本 key>/` 下与章同名的 `NNN.pages.json`（guji-pages/0.1，逐字坐标）、
 * `NNN.punct.json`、`NNN.entity.json`（overview#389）。
 *
 * 判断「这章有没有对读」：章在 `index.json` 里的条目带 `pages`（页范围）与 `lines_file`，或直接写了 `pages_file`；
 * 都没有就不发请求（普通阅读的章不会多出三个 404）。待文本总管把声明字段定进规范后，只改这里。
 */

export interface DuiduFiles {
    pages: unknown;
    punct: unknown;
    entity: unknown;
}

const cache = new Map<string, Promise<DuiduFiles | null>>();

async function getJson(url: string): Promise<unknown> {
    try {
        const res = await fetch(url);
        return res.ok ? await res.json() : null;
    } catch {
        return null;
    }
}

/** 取本章的对读数据；本章不是对读章、或 pages.json 取不到返回 null（不缓存失败） */
export function loadDuiduFiles(
    id: string,
    ctx: { versionKey: string | null; chapter: Record<string, unknown> | null } | undefined,
    chapterKey: string,
): Promise<DuiduFiles | null> {
    const ch = ctx?.chapter;
    const key = ctx?.versionKey;
    if (!ch || !key || !/^\d{3}$/.test(chapterKey)) return Promise.resolve(null);
    const pagesFile = typeof ch.pages_file === 'string'
        ? ch.pages_file
        : ch.pages && ch.lines_file ? `${chapterKey}.pages.json` : null;
    if (!pagesFile) return Promise.resolve(null);
    const base = `/data/items/${id}/${key}`;
    const cacheKey = `${base}/${pagesFile}`;
    let p = cache.get(cacheKey);
    if (!p) {
        p = (async () => {
            const pages = await getJson(`${base}/${pagesFile}`);
            if (!pages) return null;
            const punctFile = typeof ch.punct_file === 'string' ? ch.punct_file : `${chapterKey}.punct.json`;
            const entityFile = typeof ch.entity_file === 'string' ? ch.entity_file : `${chapterKey}.entity.json`;
            const [punct, entity] = await Promise.all([getJson(`${base}/${punctFile}`), getJson(`${base}/${entityFile}`)]);
            return { pages, punct, entity };
        })();
        cache.set(cacheKey, p);
        p.then(v => { if (!v) cache.delete(cacheKey); });
    }
    return p;
}
