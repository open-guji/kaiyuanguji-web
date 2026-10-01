/**
 * 元数据首页（/book-index 无检索词，overview#322 块 D）的取数：构建期产物 meta-home/sections.json（scripts/build-meta-home.mjs）。
 *
 * /book-index 在正式站是静态导出页，取不到服务端数据，只能在浏览器里取：
 * - cos：`${COS_BASE}/current/meta-home/sections.json?v=<版本键>`（版本键 cache-bust，与 BundleStorage 同口径）
 * - bundle：同站 `/data/meta-home/sections.json`
 * - github／local：没有构建期产物，返回 null（页面只出检索框与最近浏览）
 * 取不到（404、网络错、格式不对）一律 null：没数据的板块整块隐藏，不报错。
 */
import type { MetaHomeSections } from 'book-index-ui';
import type { DataSource } from '@/lib/constants';
import { COS_BASE, resolveCosVersion } from '@/lib/cos-storage';

export const META_HOME_PATH = 'meta-home/sections.json';

export async function metaHomeUrl(source: DataSource): Promise<string | null> {
    if (source === 'cos') {
        if (!COS_BASE) return null;
        const v = await resolveCosVersion();
        return `${COS_BASE}/current/${META_HOME_PATH}?v=${encodeURIComponent(v)}`;
    }
    if (source === 'bundle') return `/data/${META_HOME_PATH}`;
    return null;
}

const arr = <T,>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/** 补齐缺字段：旧版产物或字段漏了也能渲染（缺的板块为空，整块不出） */
export function normalizeMetaHome(raw: unknown): MetaHomeSections | null {
    if (!raw || typeof raw !== 'object') return null;
    const r = raw as Record<string, any>;
    const counts = {
        works: num(r.counts?.works), books: num(r.counts?.books),
        collections: num(r.counts?.collections), entities: num(r.counts?.entities),
    };
    const st = r.stats ?? {};
    return {
        counts,
        shelf: r.shelf && Array.isArray(r.shelf.items) && r.shelf.items.length ? { label: String(r.shelf.label ?? ''), items: r.shelf.items } : null,
        related_catalogs: arr(r.related_catalogs),
        catalog_progress: arr(r.catalog_progress),
        bu: arr(r.bu),
        unclassified: num(r.unclassified),
        collection_groups: arr(r.collection_groups),
        bibliographers: arr(r.bibliographers),
        lineage: arr(r.lineage),
        sites: arr(r.sites),
        stats: {
            ...counts,
            ...Object.fromEntries(['works', 'books', 'collections', 'entities'].filter((k) => k in st).map((k) => [k, num(st[k])])),
            has_image: num(st.has_image), has_text: num(st.has_text), article: num(st.article), poem: num(st.poem),
            loss: {
                extant: num(st.loss?.extant), partially_extant: num(st.loss?.partially_extant),
                lost: num(st.loss?.lost), unknown: num(st.loss?.unknown),
            },
        },
    };
}

export async function fetchMetaHome(source: DataSource, fetchImpl: typeof fetch = fetch): Promise<MetaHomeSections | null> {
    try {
        const url = await metaHomeUrl(source);
        if (!url) return null;
        const res = await fetchImpl(url);
        if (!res.ok) return null;
        return normalizeMetaHome(await res.json());
    } catch {
        return null;
    }
}

/** 数据版本行：「501935e · 2026-09-27」；取不到为 null */
export function formatDataVersion(v: { commitId?: string; commitDate?: string } | null | undefined): string | null {
    if (!v?.commitId || v.commitId === 'unknown') return null;
    const short = v.commitId.slice(0, 7);
    const d = v.commitDate ? new Date(v.commitDate) : null;
    const date = d && !Number.isNaN(d.getTime()) ? d.toISOString().slice(0, 10) : '';
    return date ? `${short} · ${date}` : short;
}
