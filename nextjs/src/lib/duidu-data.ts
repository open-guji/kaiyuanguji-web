/**
 * 图文对读的数据文件（overview#425）：章在 `items/<id>/<版本 key>/index.json` 里的条目用 `*_file` 字段声明有哪些层，
 * 网站只按声明取，不写死书 id、不猜文件名：
 *   - `char_file`（必有）：每格的字（guji-char，文本真源）；
 *   - `cord_file`（可选）：每格的像素框（guji-cord）——**有它才有对读**（书影格线、对读版面）；没有它只加载 char（及 punct／entity），cord 为 null 往下传；
 *   - `punct_file`：标点；`entity_file`：专名实体；
 *   - `norm_file`（可选）：异体字归一表（overview#540）。未声明或取不到都当没有，不影响整章；
 *   - `fig_file`（可选，char v0.3／GUJI-737）：图表（图片格、插图块的说明与文件，guji-fig v0.1）。同样未声明或取不到都当没有——
 *     阅读器对 `fig` 格显示 `〔图：…〕` 标签，不影响整章。图片文件在版本目录的 `fig/` 下，地址用存储的 `getTextAssetUrl` 取。
 * `pages_file`、`has_warp` 随 pages.json 作废。这些文件在同一章里按格位 key（`页:列:格[子列]`）对上。
 */

export interface DuiduFiles {
    char: unknown;
    /** 没有声明 `cord_file` 时为 null：下游不画书影格线、不做对读版面 */
    cord: unknown | null;
    punct: unknown;
    entity: unknown;
    /** 没有声明 `norm_file`（或取不到）时为 null：下游照旧走全局异体字表 */
    norm: unknown;
    /** 声明了 `fig_file` 才有这个键；取不到为 null：图片格取不到图，显示标签 */
    fig?: unknown;
    /** 声明了 `cord_file` 但这次没取（窄屏不显示书影栏，GUJI-700）：cord 为 null，正文照常排，只是没有字框 */
    cordSkipped?: boolean;
}

/** 册号（IIIF 路径里的 `<册>`）：cord 的 canvas id 取不到时（窄屏没取 cord）按 char 的 book_id＋volume 推，册号两位补零 */
export function volumeFromChar(char: unknown): { bookId: string; vol: string } | null {
    const c = char as { book_id?: unknown; volume?: unknown } | null;
    const bookId = typeof c?.book_id === 'string' && /^[0-9a-z]+$/.test(c.book_id) ? c.book_id : null;
    const v = typeof c?.volume === 'number' && Number.isInteger(c.volume) && c.volume > 0 ? c.volume : null;
    return bookId && v ? { bookId, vol: String(v).padStart(2, '0') } : null;
}

/**
 * 取一份版本目录下的文本 JSON 的方法。cos 数据源（含 h1 哈希寻址）的 storage 上有，
 * 与 getChapter 走同一套取数；bundle／本地模式的 storage 上没有，退回同域 `/data/items/...`。
 */
export interface TextFileStorage {
    getTextFile?: (id: string, key: string, file: string) => Promise<unknown>;
    /** 版本目录下相对路径文件（如 `fig/005/f148-2-14.png`）的可直接用的地址；取不到（没有这份文件、不合规）返回 null */
    getTextAssetUrl?: (id: string, key: string, rel: string) => Promise<string | null>;
}

const cache = new Map<string, Promise<DuiduFiles | null>>();

export async function getJson(storage: object | undefined, id: string, key: string, file: string): Promise<unknown> {
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

/** 先取阅读器瘦身副本（打包时生成，GUJI-700），取不到再取原文件：副本是原文件的同结构子集，读法相同 */
async function getPreferred(storage: object | undefined, id: string, key: string, slim: string | null, original: string | null): Promise<unknown> {
    if (slim) {
        const v = await getJson(storage, id, key, slim);
        if (v != null) return v;
    }
    return original ? getJson(storage, id, key, original) : null;
}

/**
 * 取本章的对读数据。本章没有声明 `char_file`、或声明了 char／（已声明的）cord 取不到返回 null（不缓存失败）；
 * `cord_file` 未声明则 cord 为 null（只加载 char 及 punct／entity），不再因此整章返回 null。
 */
export function loadDuiduFiles(
    id: string,
    ctx: { versionKey: string | null; chapter: Record<string, unknown> | null } | undefined,
    _chapterKey: string,
    /** 当前数据源的 storage（transport）；不传或没有 getTextFile 就读同域 /data */
    storage?: object,
    /** `cord: false`＝不取像素框（窄屏不显示书影栏，cord 是最大的文件，GUJI-700）；缺省取 */
    opts?: { cord?: boolean },
): Promise<DuiduFiles | null> {
    const ch = ctx?.chapter;
    const key = ctx?.versionKey;
    if (!ch || !key) return Promise.resolve(null);
    const charFile = fileField(ch, 'char_file');
    const declaredCord = fileField(ch, 'cord_file');
    const cordFile = opts?.cord === false ? null : declaredCord;
    const cordSkipped = !!declaredCord && !cordFile;
    if (!charFile) return Promise.resolve(null);
    // 阅读器瘦身副本（`reader_*_file`，数据打包时生成）：有就先取它，取不到回落原文件
    const readerChar = fileField(ch, 'reader_char_file');
    const readerCord = cordFile ? fileField(ch, 'reader_cord_file') : null;
    const punctFile = fileField(ch, 'punct_file');
    const readerPunct = punctFile ? fileField(ch, 'reader_punct_file') : null;
    const entityFile = fileField(ch, 'entity_file');
    const readerEntity = entityFile ? fileField(ch, 'reader_entity_file') : null;
    const normFile = fileField(ch, 'norm_file');
    const figFile = fileField(ch, 'fig_file');
    const cacheKey = `${id}/${key}/${charFile}|${readerChar ?? ''}|${cordFile ?? ''}|${readerCord ?? ''}|${punctFile ?? ''}|${readerPunct ?? ''}|${entityFile ?? ''}|${readerEntity ?? ''}|${normFile ?? ''}|${figFile ?? ''}`;
    let p = cache.get(cacheKey);
    if (!p) {
        p = (async () => {
            const [char, cord, punct, entity, norm, fig] = await Promise.all([
                getPreferred(storage, id, key, readerChar, charFile),
                cordFile ? getPreferred(storage, id, key, readerCord, cordFile) : null,
                punctFile ? getPreferred(storage, id, key, readerPunct, punctFile) : null,
                entityFile ? getPreferred(storage, id, key, readerEntity, entityFile) : null,
                normFile ? getJson(storage, id, key, normFile) : null,
                figFile ? getJson(storage, id, key, figFile) : null,
            ]);
            // 声明了 cord_file 却取不到：整章按原行为返回 null（不缓存）；未声明则 cord 为 null
            if (!char || (cordFile && !cord)) return null;
            // norm 是可选层：取不到当没有（null），不让整章返回 null
            return { char, cord, punct, entity, norm: norm ?? null, ...(figFile ? { fig: fig ?? null } : {}), ...(cordSkipped ? { cordSkipped: true } : {}) };
        })();
        cache.set(cacheKey, p);
        // 失败不缓存；声明了 norm_file 却没取到也不缓存（可能是暂时失败，下次再取），并留一条日志
        p.then(v => {
            if (!v) cache.delete(cacheKey);
            else if (normFile && v.norm == null) {
                cache.delete(cacheKey);
                console.warn(`[duidu-data] 声明了 norm_file 但取不到：${id}/${key}/${normFile}（本次当没有规范层，下次重试）`);
            }
            else if (figFile && v.fig == null) {
                cache.delete(cacheKey);
                console.warn(`[duidu-data] 声明了 fig_file 但取不到：${id}/${key}/${figFile}（本次图片格显示标签，下次重试）`);
            }
        });
    }
    return p;
}

/**
 * 本章图表（`fig.json`，guji-fig v0.1）里每张图的文件地址：`file`（相对版本目录，如 `fig/005/f148-2-14.png`）→ 可直接放进 `<img src>` 的 URL。
 * 阅读器的 `figUrl` 是同步函数，而哈希寻址的地址要先查哈希表（异步），所以在取数时一次解析好。
 * 存储没有 `getTextAssetUrl`（bundle／本地模式）时按同域 `/data/items/<id>/<key>/<file>`；取不到地址的图不进表（阅读器显示 `〔图：说明〕` 标签）。
 */
export async function loadFigUrls(id: string, key: string | null | undefined, fig: unknown, storage?: object): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    const list = fig && typeof fig === 'object' ? (fig as { figures?: unknown }).figures : undefined;
    if (!key || !Array.isArray(list)) return out;
    const getUrl = (storage as TextFileStorage | undefined)?.getTextAssetUrl;
    await Promise.all(list.map(async (f) => {
        const file = (f as { file?: unknown } | null)?.file;
        if (typeof file !== 'string' || !/^fig\/[\w-]+\/[\w-]+\.(?:png|webp|svg)$/.test(file) || out.has(file)) return;
        try {
            const url = typeof getUrl === 'function' ? await getUrl.call(storage, id, key, file) : `/data/items/${id}/${key}/${file}`;
            if (url) out.set(file, url);
        } catch { /* 这张图取不到地址：显示标签 */ }
    }));
    return out;
}
