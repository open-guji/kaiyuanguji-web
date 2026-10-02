'use client';

/**
 * 元数据首页（/book-index 无检索词，overview#322 块 D）：页首检索框＋类型签｜最近浏览，下面是 book-index-ui 的 MetaHomeView 各分区。
 * 取代原来的 HomePage 页签（推荐／目录／丛编／在线资源／反馈）和底部单独的数据版本行；数据版本并进「数据与授权」。
 *
 * 检索框是普通表单（GET /book-index?q=），关掉 JS 也能检索；提交后由 IndexBrowser 出结果。
 * 边输边出候选（overview#342），与首页同一个 SearchSuggest。
 * 分区数据在浏览器里取（正式站是静态导出），取到之前与取不到时只出检索框和最近浏览，缺数据的分区整块隐藏。
 */
import { useEffect, useState } from 'react';
import { MetaHomeView, type MetaHomeSections } from 'book-index-ui';
import type { IndexStorage } from 'book-index-ui';
import type { DataSource } from '@/lib/constants';
import { COS_BASE } from '@/lib/cos-storage';
import { entryHref } from '@/lib/item-id';
import { CATALOG_ALL_ID, catalogHref } from '@/app/catalog/catalog-route';
import { fetchMetaHome, formatDataVersion } from './meta-home-data';
import { useSiteT } from '@/i18n/use-site-t';
import SearchSuggest from '@/components/common/SearchSuggest';

/** 数据仓库（CC0）。只提 book-index，不提 draft（9-30 反馈） */
export const META_HOME_REPO_URL = 'https://github.com/open-guji/book-index';

const EMPTY: MetaHomeSections = {
    counts: { works: 0, books: 0, collections: 0, entities: 0 },
    shelf: null, related_catalogs: [], catalog_progress: [], bu: [], unclassified: 0,
    collection_groups: [], bibliographers: [], lineage: [], sites: [],
    stats: { works: 0, books: 0, collections: 0, entities: 0, has_image: 0, has_text: 0, article: 0, poem: 0, loss: { extant: 0, partially_extant: 0, lost: 0, unknown: 0 } },
};

const S = {
    sr: { position: 'absolute', width: 1, height: 1, padding: 0, margin: -1, overflow: 'hidden', clip: 'rect(0 0 0 0)', whiteSpace: 'nowrap', border: 0 } as const,
    search: { display: 'flex', alignItems: 'stretch', maxWidth: 760, margin: 0, border: '1px solid var(--bim-rule-dashed)', background: 'var(--bim-card-bg)' } as const,
    searchField: { flex: 1, minWidth: 0, display: 'flex' } as const,
    searchInput: { flex: 1, minWidth: 0, padding: '12px 14px', border: 0, background: 'none', font: 'inherit', fontSize: 15, color: 'var(--bim-ink)' } as const,
    searchBtn: { padding: '0 22px', border: 0, background: 'var(--bim-accent)', color: 'var(--bim-page-bg)', font: 'inherit', fontSize: 15, letterSpacing: '0.2em', cursor: 'pointer' } as const,
    hint: { margin: '10px 0 0', fontSize: 12.5, color: 'var(--bim-meta-fg)' } as const,
};

function SearchHead() {
    const t = useSiteT();
    const [q, setQ] = useState('');
    return (
        <>
            <form role="search" action="/book-index" method="get" style={S.search} data-meta-search>
                <label htmlFor="meta-q" style={S.sr}>{t('bookIndex.meta.searchLabel')}</label>
                <SearchSuggest
                    id="meta-q"
                    value={q}
                    onChange={setQ}
                    placeholder={t('bookIndex.meta.searchPlaceholder')}
                    style={S.searchField}
                    inputStyle={S.searchInput}
                />
                <button type="submit" style={S.searchBtn}>{t('bookIndex.meta.search')}</button>
            </form>
            <p style={S.hint}>{t('bookIndex.meta.hint')}</p>
        </>
    );
}

/** 数据版本：cos 读 latest.json（发布指针，不缓存），其他读同站 /data/version.json */
function useDataVersion(source: DataSource): string | null {
    const [v, setV] = useState<string | null>(null);
    useEffect(() => {
        let cancelled = false;
        const url = source === 'cos' ? (COS_BASE ? `${COS_BASE}/latest.json` : null) : '/data/version.json';
        if (!url) return;
        fetch(url, { cache: 'no-store' })
            .then((r) => (r.ok ? r.json() : null))
            .then((j) => { if (!cancelled) setV(formatDataVersion(j)); })
            .catch(() => {});
        return () => { cancelled = true; };
    }, [source]);
    return v;
}

export default function MetaHome({ source, transport }: { source: DataSource; transport: IndexStorage }) {
    const [sections, setSections] = useState<MetaHomeSections | null>(null);
    useEffect(() => {
        let cancelled = false;
        fetchMetaHome(source).then((s) => { if (!cancelled) setSections(s); });
        return () => { cancelled = true; };
    }, [source]);
    const version = useDataVersion(source);
    return (
        <MetaHomeView
            sections={sections ?? EMPTY}
            head={<SearchHead />}
            transport={transport}
            links={{ item: entryHref, node: (id) => catalogHref(id) }}
            catalogHref={catalogHref(CATALOG_ALL_ID)}
            version={version ?? undefined}
            repoUrl={META_HOME_REPO_URL}
        />
    );
}
