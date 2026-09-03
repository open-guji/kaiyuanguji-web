/**
 * 搜索后端探活 —— L1 (Meilisearch) 与 L2 (worker 分片) 分层检查。
 *
 * 站内搜索是两层架构：L1 挂了前端会自动降级到 L2，用户仍能搜但更慢、
 * 结果可能陈旧。正因为有兜底，L1 故障在页面上几乎看不出来——2026-09-03
 * 实测 L1 源站已 522，只有 EdgeOne 边缘缓存在撑，而老 smoke 毫无察觉。
 * 所以必须分层显式探活。
 */
import { test, expect } from '@playwright/test';
import { MEILI_BASE, MEILI_KEY, SEARCH_QUERIES, DATA_BASE } from '../fixtures/anchors';
import { fetchLatest, dataUrl } from '../fixtures/version';

test.describe('搜索 L1 — Meilisearch', () => {
    test('健康检查', async ({ request }) => {
        const res = await request.get(`${MEILI_BASE}/health`, { timeout: 15_000 });
        expect(
            res.status(),
            `Meili 源站不健康（522=上海服务器不可达，可能 OOM 或进程挂了）。` +
            `前端会降级到 L2，用户仍能搜索但更慢、结果陈旧。`,
        ).toBe(200);
    });

    for (const { q, label } of SEARCH_QUERIES) {
        test(`${label}查询「${q}」能召回结果`, async ({ request }) => {
            // 加随机后缀绕开边缘缓存拿不到真实源站状态的问题：
            // 直接查原词可能命中 CDN 缓存，源站挂了也返回 200。
            const res = await request.post(`${MEILI_BASE}/indexes/works/search`, {
                headers: {
                    Authorization: `Bearer ${MEILI_KEY}`,
                    'Content-Type': 'application/json',
                },
                data: { q, limit: 5 },
                timeout: 15_000,
            });

            expect(res.status(), `搜索 API 返回 ${res.status()}；401=key 失效，5xx=源站故障`).toBe(200);
            const body = await res.json();
            expect(body.hits?.length ?? 0, `「${q}」召回 0 条`).toBeGreaterThan(0);
        });
    }

    // 逐个索引探而不是 GET /indexes 列表：MEILI_KEY 是只读 search key，
    // 按最小权限原则**不该**有列索引的管理权限——2026-09-03 这条用例曾因此
    // 挂在 403，误报成"索引没了"，实际四个索引都好好的。
    // 403 是 key 权限正确的证据，不是故障。用 search 探活既够用又不需要提权。
    for (const uid of ['works', 'books', 'collections', 'entities']) {
        test(`索引 ${uid} 存在且可检索`, async ({ request }) => {
            const res = await request.post(`${MEILI_BASE}/indexes/${uid}/search`, {
                headers: {
                    Authorization: `Bearer ${MEILI_KEY}`,
                    'Content-Type': 'application/json',
                },
                data: { q: '', limit: 1 },
                timeout: 15_000,
            });

            expect(
                res.status(),
                `索引 ${uid} 返回 ${res.status()}；404=索引不存在，403=key 无该索引权限，5xx=源站故障`,
            ).toBe(200);
        });
    }
});

test.describe('搜索 L2 — worker 分片索引（L1 挂时的兜底）', () => {
    test('分片清单可取且四类索引齐全', async ({ request }) => {
        const v = await fetchLatest(request);
        // 分片走 v/<commit>/search/，与 entry 的 current/ 不同：
        // 倒排索引文件互相引用，必须 commit 隔离，否则版本切换时会拿到混合快照
        const res = await request.get(`${DATA_BASE}/v/${v.commitId}/search/meta.json`);
        expect(
            res.ok(),
            'L2 分片清单取不到——L1 一旦故障搜索就彻底不可用',
        ).toBeTruthy();

        const meta = await res.json();
        expect(Array.isArray(meta.indices), 'meta.indices 不是数组').toBeTruthy();

        const byType = new Map<string, any>(meta.indices.map((i: any) => [i.type, i]));
        for (const t of ['work', 'book', 'collection', 'entity']) {
            expect(byType.has(t), `L2 缺 ${t} 索引`).toBeTruthy();
            expect(byType.get(t).docCount, `${t} 索引文档数为 0`).toBeGreaterThan(0);
        }
        // works 是大头，塌方式下跌说明 reindex 出问题
        expect(byType.get('work').docCount).toBeGreaterThan(50_000);
    });

    test('首个 work 分片可下载', async ({ request }) => {
        const v = await fetchLatest(request);
        const metaRes = await request.get(`${DATA_BASE}/v/${v.commitId}/search/meta.json`);
        const meta = await metaRes.json();
        const workIdx = meta.indices.find((i: any) => i.type === 'work');
        const first = workIdx.shards?.[0] ?? workIdx.file;
        expect(first, 'work 索引既无 shards 也无 file').toBeTruthy();

        const res = await request.get(`${DATA_BASE}/v/${v.commitId}/search/${first}`);
        expect(res.ok(), `分片 ${first} 下载失败`).toBeTruthy();
    });
});
