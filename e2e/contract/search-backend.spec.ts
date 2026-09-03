/**
 * 搜索 L2（worker 分片索引）契约 —— **硬门禁**。
 *
 * 站内搜索是两层架构。L1 (Meilisearch) 挂了前端自动切到 L2，用户照样能搜；
 * 但 L2 再挂就真没得兜了，所以这一层必须阻断发版。
 *
 * L1 的探活在 degradable/search-l1.spec.ts —— 那是可降级依赖，单独一个
 * project，失败不挡部署。
 */
import { test, expect } from '@playwright/test';
import { DATA_BASE } from '../fixtures/anchors';
import { fetchLatest } from '../fixtures/version';

test.describe('搜索 L2 — worker 分片索引（L1 挂时的兜底）', () => {
    test('分片清单可取且四类索引齐全', async ({ request }) => {
        const v = await fetchLatest(request);
        // 分片走 v/<commit>/search/，与 entry 的 current/ 不同：
        // 倒排索引文件互相引用，必须 commit 隔离，否则版本切换时会拿到混合快照
        const res = await request.get(`${DATA_BASE}/v/${v.commitId}/search/meta.json?_=${Date.now()}`);
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

    test('索引覆盖率与全站条目数相当（不能只索引到一个仓）', async ({ request }) => {
        // 2026-09-03 实测：线上 L2 的 works docCount=89974，恰好等于 draft 仓
        // works 总数，而其中 89972 条是升格墓碑（stub 化到只剩标题）——
        // 也就是说兜底搜索索引里几乎全是废数据，production 的 9 万条完整条目
        // 一条都没进去。根因：build-search-index.mjs 只读 BOOK_INDEX_DRAFT_DIR。
        // entities 更直白：29336 对 58669，正好差一个仓。
        //
        // L1 已于 2026-08-25 修成「两仓都收 + 跳过墓碑」，L2 一直没跟上。
        // 这里用 meta.json 的全站统计做基准，覆盖率过低即报警。
        const v = await fetchLatest(request);
        const [metaRes, searchRes] = await Promise.all([
            request.get(`${DATA_BASE}/current/meta.json?v=${v.commitId}`),
            request.get(`${DATA_BASE}/v/${v.commitId}/search/meta.json?_=${Date.now()}`),
        ]);
        expect(metaRes.ok() && searchRes.ok()).toBeTruthy();

        const meta = await metaRes.json();
        const search = await searchRes.json();
        const byType = new Map<string, any>(search.indices.map((i: any) => [i.type, i]));

        // meta.json 的计数含墓碑，L2 跳过墓碑，所以不会 1:1 相等。
        // 但 entities 侧没有墓碑，应当高度吻合；差一半就是漏了一个仓。
        const entityDocs = byType.get('entity').docCount;
        expect(
            entityDocs / meta.entities,
            `L2 entity 覆盖率仅 ${((entityDocs / meta.entities) * 100).toFixed(0)}%` +
            `（${entityDocs}/${meta.entities}）——多半只索引了 draft 一个仓`,
        ).toBeGreaterThan(0.9);

        // works 会因跳过墓碑而低于 meta 计数，但不该低到只剩一半
        const workDocs = byType.get('work').docCount;
        expect(
            workDocs,
            `L2 work docCount=${workDocs} 偏低（全站 ${meta.works}）——检查是否漏了 production 仓`,
        ).toBeGreaterThan(70_000);
    });

    test('首个 work 分片可下载', async ({ request }) => {
        const v = await fetchLatest(request);
        const metaRes = await request.get(`${DATA_BASE}/v/${v.commitId}/search/meta.json?_=${Date.now()}`);
        const meta = await metaRes.json();
        const workIdx = meta.indices.find((i: any) => i.type === 'work');
        const first = workIdx.shards?.[0] ?? workIdx.file;
        expect(first, 'work 索引既无 shards 也无 file').toBeTruthy();

        const res = await request.get(`${DATA_BASE}/v/${v.commitId}/search/${first}`);
        expect(res.ok(), `分片 ${first} 下载失败`).toBeTruthy();
    });
});
