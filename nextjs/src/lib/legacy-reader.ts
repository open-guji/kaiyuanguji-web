/**
 * 旧阅读地址 → 新路径式地址（overview#307 E 块，规格 §六）。只做换算，不取数、不依赖 React／Next，
 * 中间件（边缘运行时）、页面、测试共用。
 *
 * 旧地址有三种：
 *   /read/<id>?kind=collated|fulltext[&key=wikisource-01][&juan=011]      （上一版的阅读页）
 *   /item/<id>/read?…                                                      （再上一版，查询串同上）
 *   /book-index?id=<id>&tab=fulltext|collated[&juan=…] 与 /item/<id>?tab=…  （条目页的页签）
 * 新地址里版本 key 与章号怎么对应，文本总管的迁移对照表（texts-migration-map.tsv，约 11 万行）整张按规则可推：
 *   - 章号：旧 juan（011／juan/011.json／001.md／第001…）末尾的数字补成三位（实测对照表全部行一致，0 例外）；
 *   - 版本：整理本→ manifest 里 kind=collated 的那份；全文带 key → 去 `-01`、`-02`→`-2` 找同 key 的，找不到按来源与序号；
 *     全文不带 key（Book，或 Work 由阅读器取首选）→ 第一份 kind=transcription；
 *   - 那份版本是 default 的，地址里不写 key。
 * 所以不把对照表塞进中间件，只在请求时读一次该条目的 manifest（已在进程内缓存）按规则换算；
 * 条目没有 manifest（没有文本）返回 null，由调用方决定（跳条目页）。
 */
import { hasReaderType, isTextKey, readerPath } from './reader-route';
import { parseItemId } from './item-id';

export type LegacyKind = 'collated' | 'fulltext';

export interface LegacyReaderRef {
    id: string;
    kind: LegacyKind;
    /** 旧的全文 key（wikisource-01、kanripo-01…）；整理本没有 */
    key?: string;
    /** 旧的卷／章号：011、juan/011.json、001.md、第001… */
    juan?: string;
}

/** 只需要 manifest 里换算用的那几个字段 */
export interface ManifestLike {
    versions?: { key?: string; kind?: string; source?: string }[];
}

function isLegacyKind(v: string | null | undefined): v is LegacyKind {
    return v === 'collated' || v === 'fulltext';
}

/** 不带 kind 时按条目类型取默认：Work 看整理本，Book 看全文 */
function defaultKind(id: string): LegacyKind {
    return parseItemId(id)?.type === 'work' ? 'collated' : 'fulltext';
}

/**
 * /read/<id>?… 或 /item/<id>/read?… 的查询串里有没有旧的 kind／key／juan。没有返回 null（不是旧地址）。
 * kind 不合法当作没写（按类型取默认），不再 404。
 */
export function parseLegacyReaderParams(id: string, params: URLSearchParams): LegacyReaderRef | null {
    if (!hasReaderType(id)) return null;
    const rawKind = params.get('kind');
    const key = params.get('key') || undefined;
    const juan = params.get('juan') || undefined;
    if (rawKind === null && !key && !juan) return null;
    return { id, kind: isLegacyKind(rawKind) ? rawKind : defaultKind(id), key, juan };
}

/**
 * 条目页页签形式的旧入口（tab=fulltext／collated）：
 *   /book-index?id=<id>&tab=…[&juan=…]、/item/<id>?tab=…[&juan=…]
 * 只认 tab 为 fulltext／collated 的；redirected_from／no_redirect（草稿升格横幅的往返）在场时放过，留给详情组件处理。
 */
export function parseLegacyTab(pathname: string, params: URLSearchParams): LegacyReaderRef | null {
    const tab = params.get('tab');
    if (!isLegacyKind(tab)) return null;
    if (params.has('redirected_from') || params.has('no_redirect')) return null;
    let id: string | null = null;
    if (pathname === '/book-index') id = params.get('id');
    else if (pathname.startsWith('/item/')) id = pathname.slice('/item/'.length).replace(/\/$/, '');
    if (!id || id.includes('/') || !hasReaderType(id)) return null;
    return { id, kind: tab, juan: params.get('juan') || undefined };
}

/** 旧卷／章号 → 三位章号：取末段、去扩展名，末尾的数字补零（011→011，1→001，juan/011.json→011，第001→001）；没有数字返回 undefined */
export function legacyChapter(juan: string | undefined): string | undefined {
    if (!juan) return undefined;
    const stem = (juan.split('/').pop() ?? juan).replace(/\.(json|md|txt)$/, '');
    const n = stem.match(/(\d+)$/)?.[1];
    return n ? String(Number(n)).padStart(3, '0') : undefined;
}

/** 来源短名：key 去掉序号后缀（wikisource-01／wikisource-2→wikisource） */
function sourceOfKey(key: string): string {
    return key.replace(/-0*\d+$/, '');
}

/** 旧 key → 新 key：去 -01、-02→-2；没有序号的（open-guji）原样 */
function newKeyFromOld(oldKey: string): string | undefined {
    const m = /^([a-z][a-z0-9]*(?:-[a-z][a-z0-9]*)*)-0*(\d+)$/.exec(oldKey);
    if (m) {
        const n = Number(m[2]);
        return n <= 1 ? m[1] : `${m[1]}-${n}`;
    }
    return isTextKey(oldKey) ? oldKey : undefined;
}

/** 旧引用对应 manifest 里的哪份版本；manifest 里没有任何版本返回 null */
export function legacyVersionKey(manifest: ManifestLike | null | undefined, ref: Pick<LegacyReaderRef, 'kind' | 'key'>): string | null {
    const versions = (manifest?.versions ?? []).filter((v): v is { key: string; kind?: string; source?: string } => !!v && typeof v.key === 'string');
    if (versions.length === 0) return null;
    if (ref.kind === 'collated') return (versions.find((v) => v.kind === 'collated') ?? versions[0]).key;
    if (ref.key) {
        const want = newKeyFromOld(ref.key);
        const exact = want ? versions.find((v) => v.key === want) : undefined;
        if (exact) return exact.key;
        // 同来源：只有一份就是它（旧的 wikisource-02 迁移后常是唯一的一份）；多份按旧序号取第 N 份
        const source = sourceOfKey(ref.key);
        const same = versions.filter((v) => (v.source ?? sourceOfKey(v.key)) === source);
        if (same.length === 1) return same[0].key;
        if (same.length > 1) {
            const n = Number(ref.key.match(/-0*(\d+)$/)?.[1] ?? 1);
            return same[Math.min(Math.max(n, 1), same.length) - 1].key;
        }
    }
    return (versions.find((v) => v.kind === 'transcription') ?? versions[0]).key;
}

/**
 * 规则推不出来的个案（按 2026-09-30 迁移对照表逐行比对，全表只有这一处）：
 * 同一来源有两份时，迁移把章数多的那份（旧 wikisource-02）升成 default，少的那份（旧 wikisource-01）取 key `wikisource`，
 * 与「旧序号 N → 第 N 份」的规则相反。条目 d59ezkx8dt6o（81 行）。
 */
const LEGACY_KEY_EXCEPTIONS: Record<string, Record<string, string>> = {
    d59ezkx8dt6o: { 'wikisource-02': 'default' },
};

/**
 * 旧引用 → 新路径。manifest 为 null（条目没有文本）返回 null，由调用方决定（通常跳条目页 /item/<id>）。
 * 那份版本是 default 的，路径里不写 key；章号按 legacyChapter 补成三位，没有就是该版本第一章的短地址。
 */
export function legacyReaderTarget(ref: LegacyReaderRef, manifest: ManifestLike | null | undefined): string | null {
    const fixed = ref.key ? LEGACY_KEY_EXCEPTIONS[ref.id]?.[ref.key] : undefined;
    if (fixed && manifest?.versions?.some((v) => v?.key === fixed)) return readerPath(ref.id, { key: fixed, chapter: legacyChapter(ref.juan) });
    const key = legacyVersionKey(manifest, ref);
    if (key === null) return null;
    return readerPath(ref.id, { key, chapter: legacyChapter(ref.juan) });
}
