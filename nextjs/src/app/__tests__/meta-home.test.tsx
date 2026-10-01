/**
 * 元数据首页（/book-index 无检索词，overview#322 块 D）：取 meta-home/sections.json 渲染 MetaHomeView；
 * 去掉「推荐」「反馈」等页签和底部单独的数据版本行；缺数据的分区整块隐藏。
 */
import { render, screen, waitFor, within } from '@testing-library/react';

let query = '';
jest.mock('next/navigation', () => ({
    useRouter: () => ({ push: jest.fn() }),
    useSearchParams: () => new URLSearchParams(query),
    usePathname: () => '/book-index',
}));
jest.mock('@/components/layout/LayoutWrapper', () => ({ children }: { children: React.ReactNode }) => <main>{children}</main>);
jest.mock('@/components/common/SourceContext', () => ({ useSource: () => ({ source: 'bundle' }) }));
jest.mock('@/lib/transport', () => ({ getTransport: () => ({ getItem: async () => null }), getSearchBaseUrl: async () => '' }));
jest.mock('@/lib/search/client', () => ({ getSearchClient: () => ({ init: async () => {} }) }));
jest.mock('@/lib/search/use-prefetch-search', () => ({ usePrefetchSearch: () => {} }));
jest.mock('@/lib/search/meili-storage', () => ({ isSearchDegraded: () => false, subscribeSearchDegraded: () => () => {} }));
jest.mock('@/components/book-index/BookDetailContent', () => () => null);
jest.mock('book-index-ui', () => {
    const actual = jest.requireActual('book-index-ui');
    return { ...actual, IndexBrowser: () => <div data-testid="browser" /> };
});

import BookIndexPage from '../book-index/BookIndexClient';
import { fetchMetaHome, formatDataVersion, metaHomeUrl, normalizeMetaHome } from '../book-index/meta-home-data';

const SECTIONS = {
    counts: { works: 95055, books: 20899, collections: 84, entities: 30994 },
    shelf: { label: '歷代史志', items: [{ id: 'd59f23o7ygw2', title: '漢書藝文志', period_of: '漢', orig: true, records: 621 }] },
    related_catalogs: [],
    catalog_progress: [{ id: 'r1', name: '漢書藝文志', total: 621, imported: 549, status: 'done', work_id: 'd59f23o7ygw2' }],
    bu: [{ id: 'c0000000001', label: '經部', count: 13065, children_total: 10, top: [{ id: 'c0000000002', label: '易類', count: 2523 }] }],
    unclassified: 41804,
    collection_groups: [],
    bibliographers: [],
    lineage: [],
    sites: [{ id: 'ctext', name: 'CText', total: 11381, imported: 5700, status: 'done' }],
    stats: { works: 95055, books: 20899, collections: 84, entities: 30994, has_image: 17415, has_text: 11517, article: 2525, poem: 320, loss: { extant: 0, partially_extant: 0, lost: 0, unknown: 0 } },
};

function mockFetch(routes: Record<string, unknown>) {
    global.fetch = jest.fn(async (u: RequestInfo | URL) => {
        const url = String(u);
        const hit = Object.keys(routes).find((k) => url.includes(k));
        if (!hit) return { ok: false, status: 404, json: async () => null } as Response;
        return { ok: true, status: 200, json: async () => routes[hit] } as Response;
    }) as typeof fetch;
}

describe('meta-home-data', () => {
    it('取数地址：bundle 走同站 /data；github／local 没有构建期产物', async () => {
        expect(await metaHomeUrl('bundle')).toBe('/data/meta-home/sections.json');
        expect(await metaHomeUrl('github')).toBeNull();
        expect(await metaHomeUrl('local')).toBeNull();
    });
    it('normalizeMetaHome：缺字段补空，不是对象返回 null', () => {
        expect(normalizeMetaHome(null)).toBeNull();
        const s = normalizeMetaHome({ counts: { works: 3 } })!;
        expect(s.counts).toEqual({ works: 3, books: 0, collections: 0, entities: 0 });
        expect(s.shelf).toBeNull();
        expect(s.bu).toEqual([]);
        expect(s.stats.loss).toEqual({ extant: 0, partially_extant: 0, lost: 0, unknown: 0 });
        expect(s.stats.works).toBe(3);
    });
    it('fetchMetaHome：404 与网络错都返回 null', async () => {
        mockFetch({});
        expect(await fetchMetaHome('bundle')).toBeNull();
        global.fetch = jest.fn(async () => { throw new Error('offline'); }) as typeof fetch;
        expect(await fetchMetaHome('bundle')).toBeNull();
    });
    it('formatDataVersion：短 commit · 日期', () => {
        expect(formatDataVersion({ commitId: '501935e0123', commitDate: '2026-09-27T08:00:00Z' })).toBe('501935e · 2026-09-27');
        expect(formatDataVersion({ commitId: 'unknown' })).toBeNull();
        expect(formatDataVersion(null)).toBeNull();
    });
});

describe('/book-index 首页态', () => {
    beforeEach(() => { query = ''; localStorage.clear(); });

    it('无检索词：检索框是 GET /book-index 表单，出元数据首页各分区，不出 IndexBrowser 与旧页签', async () => {
        mockFetch({ 'meta-home/sections.json': SECTIONS, 'version.json': { commitId: '501935e0123', commitDate: '2026-09-27T08:00:00Z' } });
        render(<BookIndexPage />);
        const form = screen.getByRole('search');
        expect(form.getAttribute('action')).toBe('/book-index');
        expect(within(form).getByRole('searchbox').getAttribute('name')).toBe('q');
        expect(screen.queryByTestId('browser')).toBeNull();
        await screen.findByRole('heading', { level: 2, name: '历代史志' });
        expect(screen.getByRole('heading', { level: 2, name: '四部' })).toBeInTheDocument();
        expect(screen.getByRole('heading', { level: 2, name: '在线资源' })).toBeInTheDocument();
        // 策展文件没到：丛编、人物、版本谱系整块隐藏
        expect(screen.queryByRole('heading', { level: 2, name: '丛编' })).toBeNull();
        expect(screen.queryByRole('heading', { level: 2, name: '人物' })).toBeNull();
        expect(screen.queryByRole('heading', { level: 2, name: '版本谱系' })).toBeNull();
        // 旧页签与反馈不再出现
        expect(screen.queryByRole('tab')).toBeNull();
        expect(screen.queryByText('推荐')).toBeNull();
        // 数据版本并进「数据与授权」
        await screen.findByText('501935e · 2026-09-27');
        expect(screen.queryByText(/数据版本:/)).toBeNull();
        // 书脊、四部链接
        expect(screen.getByRole('link', { name: /^汉书艺文志，正史原志/ }).getAttribute('href')).toBe('/item/d59f23o7ygw2');
        expect(screen.getByRole('link', { name: /^经部\s*13,065/ }).getAttribute('href')).toBe('/catalog?node=c0000000001');
        expect(screen.getByRole('link', { name: '进入目录 →' }).getAttribute('href')).toBe('/catalog?node=all');
    });

    it('取不到分区数据：只出检索框、最近浏览与授权说明', async () => {
        mockFetch({});
        render(<BookIndexPage />);
        expect(screen.getByRole('search')).toBeInTheDocument();
        await screen.findByText('还没有浏览记录。打开任一条目后会出现在这里。');
        expect(screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent)).toEqual(['最近浏览', '数据与授权']);
    });

    it('有检索词：照旧是 IndexBrowser 结果页', () => {
        query = 'q=史記';
        mockFetch({});
        render(<BookIndexPage />);
        expect(screen.getByTestId('browser')).toBeInTheDocument();
        expect(screen.queryByRole('heading', { level: 2, name: '数据与授权' })).toBeNull();
    });
});
