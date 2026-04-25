/**
 * Server-side local data access for book-index
 *
 * Reads directly from local book-index-draft / book-index repositories.
 * Used by Next.js API routes in dev mode.
 *
 * Ported from book-index-ui/server/vite-plugin-api.ts
 */

import * as fs from 'fs';
import * as path from 'path';

// ── Types ──

interface IndexFileEntry {
    id: string;
    title: string;
    type: string;
    path: string;
    author: string;
    year: string;
    holder: string;
    dynasty?: string;
    role?: string;
    has_collated?: boolean;
    has_text?: boolean;
    has_image?: boolean;
    additional_titles?: string[];
    attached_texts?: string[];
    [key: string]: unknown;
}

interface IndexFile {
    books: Record<string, IndexFileEntry>;
    collections: Record<string, IndexFileEntry>;
    works: Record<string, IndexFileEntry>;
    entities: Record<string, IndexFileEntry>;
}

const TYPE_MAP: Record<string, keyof IndexFile> = {
    book: 'books',
    collection: 'collections',
    work: 'works',
    entity: 'entities',
};

const NUM_SHARDS = 16;

// ── T2S converter ──

let t2sConverter: ((text: string) => string) | null | false = null;

async function ensureT2S(): Promise<((text: string) => string) | null> {
    if (t2sConverter === false) return null;
    if (t2sConverter) return t2sConverter;
    try {
        const OpenCC = await (Function('return import("opencc-js")')() as Promise<any>);
        t2sConverter = OpenCC.Converter({ from: 'tw', to: 'cn' }) as (text: string) => string;
        return t2sConverter as (text: string) => string;
    } catch {
        t2sConverter = false;
        return null;
    }
}

// ── Workspace root ──

function getWorkspaceRoot(): string {
    return process.env.BOOK_INDEX_WORKSPACE_ROOT || path.resolve(process.cwd(), '..');
}

// ── Index loading ──

function loadIndex(repoRoot: string): IndexFile {
    const result: IndexFile = { books: {}, collections: {}, works: {}, entities: {} };

    const colPath = path.join(repoRoot, 'index', 'collections.json');
    try {
        if (fs.existsSync(colPath)) {
            result.collections = JSON.parse(fs.readFileSync(colPath, 'utf-8'));
        }
    } catch { /* ignore */ }

    for (const typeKey of ['books', 'works', 'entities'] as const) {
        for (let i = 0; i < NUM_SHARDS; i++) {
            const shardPath = path.join(repoRoot, 'index', typeKey, `${i.toString(16)}.json`);
            try {
                if (fs.existsSync(shardPath)) {
                    Object.assign(result[typeKey], JSON.parse(fs.readFileSync(shardPath, 'utf-8')));
                }
            } catch { /* ignore */ }
        }
    }

    return result;
}

export function getAllEntries(type: string): IndexFileEntry[] {
    const workspaceRoot = getWorkspaceRoot();
    const typeKey = TYPE_MAP[type];
    if (!typeKey) return [];

    const entries: IndexFileEntry[] = [];
    for (const folder of ['book-index', 'book-index-draft']) {
        const repoRoot = path.join(workspaceRoot, folder);
        if (!fs.existsSync(repoRoot)) continue;
        const index = loadIndex(repoRoot);
        const section = index[typeKey] || {};
        const isDraft = folder === 'book-index-draft';

        for (const [id, entry] of Object.entries(section)) {
            let hasCollated = entry.has_collated;
            if (hasCollated === undefined && entry.path && type === 'work') {
                const entryDir = path.join(workspaceRoot, folder, path.dirname(entry.path), id, 'collated_edition');
                hasCollated = fs.existsSync(entryDir) || undefined;
            }

            const out: IndexFileEntry = {
                ...entry,
                id,
                type,
                isDraft,
                has_collated: hasCollated || undefined,
            };
            // Entity：把 primary_name 同步到 title，便于通用搜索/排序
            if (type === 'entity' && !out.title && (entry as any).primary_name) {
                out.title = (entry as any).primary_name as string;
            }
            entries.push(out);
        }
    }
    return entries;
}

export function findItemFile(id: string): string | null {
    const workspaceRoot = getWorkspaceRoot();
    const prefix = id.padEnd(3, '_').substring(0, 3);
    const [c1, c2, c3] = [prefix[0], prefix[1], prefix[2]];

    for (const folder of ['book-index', 'book-index-draft']) {
        for (const typeDir of ['Book', 'Collection', 'Work', 'Entity']) {
            const searchDir = path.join(workspaceRoot, folder, typeDir, c1, c2, c3);
            try {
                if (!fs.existsSync(searchDir)) continue;
                const files = fs.readdirSync(searchDir);
                const match = files.find(f => f.startsWith(`${id}-`) && f.endsWith('.json'));
                if (match) return path.join(searchDir, match);
            } catch { /* ignore */ }
        }
    }
    return null;
}

// ── Entry lookup (from index shards) ──

export function getEntry(id: string): IndexFileEntry | null {
    const workspaceRoot = getWorkspaceRoot();
    for (const folder of ['book-index', 'book-index-draft']) {
        const repoRoot = path.join(workspaceRoot, folder);
        if (!fs.existsSync(repoRoot)) continue;
        const index = loadIndex(repoRoot);
        const isDraft = folder === 'book-index-draft';

        for (const [typeKey, section] of Object.entries(index)) {
            const entry = (section as Record<string, IndexFileEntry>)[id];
            if (entry) {
                const type = typeKey === 'books' ? 'book'
                    : typeKey === 'works' ? 'work'
                    : typeKey === 'entities' ? 'entity'
                    : 'collection';
                // Entity 索引条目把 primary_name 同步到 title 方便上层显示
                const out = { ...entry, id, type, isDraft } as IndexFileEntry;
                if (type === 'entity' && !out.title && (out as any).primary_name) {
                    out.title = (out as any).primary_name as string;
                }
                return out;
            }
        }
    }
    return null;
}

// ── Item loading ──

export function getItem(id: string): Record<string, unknown> | null {
    const workspaceRoot = getWorkspaceRoot();
    const filePath = findItemFile(id);
    if (!filePath) return null;

    try {
        const content = fs.readFileSync(filePath, 'utf-8');
        const data = JSON.parse(content);

        if (data.type === 'Work' || data.type === 'work') {
            const collatedDir = path.join(path.dirname(filePath), id, 'collated_edition');
            if (fs.existsSync(collatedDir)) {
                data.has_collated = true;
            }
        }

        if (data.type === 'Book') {
            enrichResourcesFromCatalog(workspaceRoot, id, data);
        }

        // Entity：同步 primary_name 到 title 方便上层 IndexView/title 渲染
        if ((data.type === 'entity' || data.type === 'Entity') && !data.title && data.primary_name) {
            data.title = data.primary_name;
        }

        return data;
    } catch {
        return null;
    }
}

// ── Search ──

function matchesQuery(
    text: string | undefined,
    query: string,
    queryS: string | undefined,
    t2s: ((t: string) => string) | null,
): boolean {
    if (!text) return false;
    const lower = text.toLowerCase();
    if (lower.includes(query)) return true;
    if (queryS && t2s) {
        const textS = t2s(text).toLowerCase();
        if (textS.includes(queryS)) return true;
    }
    return false;
}

function scoreResult(
    entry: { title?: string; author?: string; additional_titles?: string[]; attached_texts?: string[]; [key: string]: unknown },
    query: string,
    queryS: string | undefined,
    t2s: ((t: string) => string) | null,
): number {
    const q = query;

    const scoreText = (text: string | undefined, exactW: number, prefixW: number, containsW: number): number => {
        if (!text) return 0;
        const t = text.toLowerCase();
        if (t === q) return exactW;
        if (t.startsWith(q)) return prefixW;
        if (t.includes(q)) return containsW;
        if (queryS && t2s) {
            const tS = t2s(text).toLowerCase();
            if (tS === queryS) return exactW;
            if (tS.startsWith(queryS)) return prefixW;
            if (tS.includes(queryS)) return containsW;
        }
        return 0;
    };

    let nameScore = scoreText(entry.title as string, 200, 150, 100);
    const allAliases = [...(entry.additional_titles || []), ...(entry.attached_texts || [])];
    for (const alias of allAliases) {
        nameScore = Math.max(nameScore, scoreText(alias, 120, 90, 60));
    }

    let score = nameScore;
    if (score === 0) {
        score = scoreText(entry.author as string, 80, 50, 50);
    }

    if (score === 0) return 0;

    if (entry.title) {
        score += Math.max(0, 20 - (entry.title as string).length);
    }

    return score;
}

export async function searchAll(query: string, limit: number = 5) {
    const q = query.toLowerCase();
    const t2s = await ensureT2S();
    const queryS = t2s ? t2s(q).toLowerCase() : undefined;

    const result: Record<string, unknown> = {};
    for (const [type, key] of [['work', 'works'], ['book', 'books'], ['collection', 'collections'], ['entity', 'entities']] as const) {
        let entries = getAllEntries(type);
        if (q) {
            entries = entries.filter((e) =>
                matchesQuery(e.title, q, queryS, t2s) ||
                matchesQuery(e.id, q, queryS, t2s) ||
                matchesQuery(e.author, q, queryS, t2s) ||
                (e.additional_titles || []).some((at: string) => matchesQuery(at, q, queryS, t2s)) ||
                (e.attached_texts || []).some((at: string) => matchesQuery(at, q, queryS, t2s))
            );
        }
        entries.sort((a, b) => {
            const sa = scoreResult(a, q, queryS, t2s);
            const sb = scoreResult(b, q, queryS, t2s);
            if (sb !== sa) return sb - sa;
            return (a.title || '').length - (b.title || '').length;
        });
        result[key] = entries.slice(0, limit);
        result[`total${key.charAt(0).toUpperCase() + key.slice(1)}`] = entries.length;
    }

    return result;
}

export async function searchEntries(query: string, type: string, page: number, pageSize: number) {
    const q = query.toLowerCase();
    const t2s = await ensureT2S();
    const queryS = t2s ? t2s(q).toLowerCase() : undefined;

    let entries = getAllEntries(type);
    if (q) {
        entries = entries.filter((e) =>
            matchesQuery(e.title, q, queryS, t2s) ||
            matchesQuery(e.id, q, queryS, t2s) ||
            matchesQuery(e.author, q, queryS, t2s)
        );
    }

    const total = entries.length;
    const start = (page - 1) * pageSize;
    return { entries: entries.slice(start, start + pageSize), total, page, pageSize };
}

// ── Collated edition ──

export function getCollatedEditionIndex(id: string) {
    const itemFile = findItemFile(id);
    if (!itemFile) return null;

    const dir = path.dirname(itemFile);
    const assetDir = path.join(dir, id, 'collated_edition');

    if (!fs.existsSync(assetDir)) return null;

    try {
        const indexFile = path.join(assetDir, 'collated_edition_index.json');
        if (fs.existsSync(indexFile)) {
            return JSON.parse(fs.readFileSync(indexFile, 'utf-8'));
        }

        const files = fs.readdirSync(assetDir)
            .filter((f: string) => f.endsWith('.json') && f !== 'juan_groups.json' && f !== 'collated_edition_index.json')
            .sort((a: string, b: string) => {
                const order = (name: string) => {
                    if (name.startsWith('juanshou')) return 0;
                    if (name.startsWith('juan')) return 1;
                    return 2;
                };
                const oa = order(a), ob = order(b);
                if (oa !== ob) return oa - ob;
                return a.localeCompare(b);
            });
        const result: Record<string, unknown> = {
            work_id: id,
            total_juan: files.length,
            juan_files: files,
        };
        const groupsFile = path.join(assetDir, 'juan_groups.json');
        if (fs.existsSync(groupsFile)) {
            try {
                result.juan_groups = JSON.parse(fs.readFileSync(groupsFile, 'utf-8'));
            } catch { /* ignore */ }
        }
        return result;
    } catch {
        return null;
    }
}

export function getCollatedJuan(id: string, juanFile: string) {
    if (juanFile.includes('..') || !juanFile.endsWith('.json')) return null;

    const itemFile = findItemFile(id);
    if (!itemFile) return null;

    const filePath = path.join(path.dirname(itemFile), id, 'collated_edition', juanFile);
    if (!fs.existsSync(filePath)) return null;

    try {
        return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    } catch {
        return null;
    }
}

// ── Collection catalog ──

interface CatalogVolumeInfo {
    resource_name: string;
    resource_id: string;
    expected_volumes?: number;
    missing_vols?: number[];
    volumes: Array<{ volume: number; status?: string; url?: string; label?: string }>;
}

let catalogVolumeCache: Map<string, CatalogVolumeInfo[]> | null = null;

function buildCatalogVolumeCache(workspaceRoot: string): Map<string, CatalogVolumeInfo[]> {
    const cache = new Map<string, CatalogVolumeInfo[]>();

    for (const folder of ['book-index', 'book-index-draft']) {
        const collectionBase = path.join(workspaceRoot, folder, 'Collection');
        if (!fs.existsSync(collectionBase)) continue;
        walkCatalogs(collectionBase, (catalogData, resourceId) => {
            const books = catalogData.books as Array<Record<string, unknown>> | undefined;
            if (!books) return;
            const resName = (catalogData.resource_name || '') as string;

            for (const book of books) {
                const bookId = book.book_id as string;
                if (!bookId) continue;
                const rawVolumes = book.volumes as unknown[];
                if (!rawVolumes || rawVolumes.length === 0) continue;
                if (typeof rawVolumes[0] !== 'object') continue;

                const volumes: CatalogVolumeInfo['volumes'] = [];
                for (const v of rawVolumes as Array<Record<string, unknown>>) {
                    let url: string | undefined;
                    if (resourceId === 'ntul' && v.tw_url) {
                        url = v.tw_url as string;
                    } else {
                        url = (v.url || v.wiki_url || v.tw_url) as string | undefined;
                    }
                    volumes.push({
                        volume: v.volume as number,
                        status: (v.status as string) || 'found',
                        url,
                        label: v.file as string | undefined,
                    });
                }

                const info: CatalogVolumeInfo = {
                    resource_name: resName,
                    resource_id: resourceId,
                    expected_volumes: book.expected_volumes as number | undefined,
                    missing_vols: book.missing_vols as number[] | undefined,
                    volumes,
                };

                if (!cache.has(bookId)) cache.set(bookId, []);
                cache.get(bookId)!.push(info);
            }
        });
    }

    return cache;
}

function walkCatalogs(
    base: string,
    callback: (data: Record<string, unknown>, resourceId: string) => void,
): void {
    for (const c1 of safeReaddir(base)) {
        const c1p = path.join(base, c1);
        if (!safeStat(c1p)?.isDirectory()) continue;
        for (const c2 of safeReaddir(c1p)) {
            const c2p = path.join(c1p, c2);
            if (!safeStat(c2p)?.isDirectory()) continue;
            for (const c3 of safeReaddir(c2p)) {
                const c3p = path.join(c2p, c3);
                if (!safeStat(c3p)?.isDirectory()) continue;
                for (const idDir of safeReaddir(c3p)) {
                    const idp = path.join(c3p, idDir);
                    if (!safeStat(idp)?.isDirectory()) continue;
                    for (const resDir of safeReaddir(idp)) {
                        const f = path.join(idp, resDir, 'volume_book_mapping.json');
                        if (fs.existsSync(f)) {
                            try { callback(JSON.parse(fs.readFileSync(f, 'utf-8')), resDir); }
                            catch { /* ignore */ }
                        }
                    }
                }
            }
        }
    }
}

function safeReaddir(dir: string): string[] {
    try { return fs.readdirSync(dir); } catch { return []; }
}

function safeStat(p: string) {
    try { return fs.statSync(p); } catch { return null; }
}

function enrichResourcesFromCatalog(
    workspaceRoot: string,
    bookId: string,
    data: Record<string, unknown>,
): void {
    const resources = data.resources as Array<Record<string, unknown>> | undefined;
    if (!resources || resources.length === 0) return;

    if (!catalogVolumeCache) {
        catalogVolumeCache = buildCatalogVolumeCache(workspaceRoot);
    }

    const infos = catalogVolumeCache.get(bookId);
    if (!infos) return;

    for (const info of infos) {
        let target = resources.find(r =>
            r.short_name === info.resource_name || r.name === info.resource_name
        );
        if (!target && info.resource_name) {
            target = resources.find(r =>
                typeof r.name === 'string' && r.name.includes(info.resource_name.slice(0, 4))
            );
        }
        if (!target) continue;

        const allVolumes = [...info.volumes];
        if (info.missing_vols) {
            for (const mv of info.missing_vols) {
                if (!allVolumes.find(v => v.volume === mv)) {
                    allVolumes.push({ volume: mv, status: 'missing' });
                }
            }
            allVolumes.sort((a, b) => a.volume - b.volume);
        }

        target.volumes = allVolumes;
        target.expected_volumes = info.expected_volumes || allVolumes.length;
    }
}

// ── Collection catalog API ──

export function getCollectionCatalogs(id: string) {
    const workspaceRoot = getWorkspaceRoot();
    const itemFile = findItemFile(id);
    if (!itemFile) return null;

    const dir = path.dirname(itemFile);
    const idDir = path.join(dir, id);

    let resources: Array<{ id: string; short_name?: string }> = [];
    try {
        const itemContent = fs.readFileSync(itemFile, 'utf-8');
        const itemData = JSON.parse(itemContent);
        resources = (itemData.resources || []).map((r: any) => ({
            id: r.id,
            short_name: r.short_name,
        }));
    } catch { /* ignore */ }

    const catalogs: Array<{ resource_id: string; short_name?: string; data: any }> = [];

    if (fs.existsSync(idDir)) {
        try {
            const subdirs = fs.readdirSync(idDir).filter((f: string) => {
                return fs.statSync(path.join(idDir, f)).isDirectory();
            });
            for (const subdir of subdirs) {
                const mappingFile = path.join(idDir, subdir, 'volume_book_mapping.json');
                if (fs.existsSync(mappingFile)) {
                    const content = fs.readFileSync(mappingFile, 'utf-8');
                    const resource = resources.find(r => r.id === subdir);
                    catalogs.push({
                        resource_id: subdir,
                        short_name: resource?.short_name,
                        data: JSON.parse(content),
                    });
                }
            }
        } catch { /* ignore */ }
    }

    return catalogs.length > 0 ? catalogs : null;
}

// ── Work catalog ──

export function getWorkCatalog(id: string) {
    const itemFile = findItemFile(id);
    if (!itemFile) return null;

    const itemDir = path.join(path.dirname(itemFile), id);
    const results: Array<{ source: string; data: unknown }> = [];

    if (fs.existsSync(itemDir)) {
        try {
            for (const sub of fs.readdirSync(itemDir)) {
                const subDir = path.join(itemDir, sub);
                if (!fs.statSync(subDir).isDirectory()) continue;
                for (const file of fs.readdirSync(subDir)) {
                    if (file.endsWith('_catalog.json')) {
                        const content = fs.readFileSync(path.join(subDir, file), 'utf-8');
                        results.push({ source: sub, data: JSON.parse(content) });
                    }
                }
            }
        } catch { /* ignore */ }
    }

    return results.length > 0 ? results : null;
}

// ── Resource progress ──

export function getResourceProgress() {
    const workspaceRoot = getWorkspaceRoot();
    const resourceFile = path.join(workspaceRoot, 'book-index-draft', 'resource.json');
    if (!fs.existsSync(resourceFile)) return null;
    try {
        return JSON.parse(fs.readFileSync(resourceFile, 'utf-8'));
    } catch {
        return null;
    }
}

export function getSiteProgress() {
    const workspaceRoot = getWorkspaceRoot();
    const resourceFile = path.join(workspaceRoot, 'book-index-draft', 'resource-site.json');
    if (!fs.existsSync(resourceFile)) return null;
    try {
        return JSON.parse(fs.readFileSync(resourceFile, 'utf-8'));
    } catch {
        return null;
    }
}

export function getResourceCounts() {
    const entries = getAllEntries('work');
    let hasText = 0, hasImage = 0;
    for (const e of entries) {
        if (e.has_text) hasText++;
        if (e.has_image) hasImage++;
    }
    return { hasText, hasImage };
}

// ── Recommended ──

export function getRecommended() {
    const workspaceRoot = getWorkspaceRoot();
    const file = path.join(workspaceRoot, 'book-index-draft', 'recommended.json');
    if (!fs.existsSync(file)) return null;
    try {
        return JSON.parse(fs.readFileSync(file, 'utf-8'));
    } catch {
        return null;
    }
}
