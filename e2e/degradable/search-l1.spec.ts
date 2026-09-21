/**
 * 搜索 L1 (Meilisearch) 探活 —— 独立 project，**不阻断部署验收**。
 *
 * 见 playwright.config.ts 的 project 划分：这个文件跑在 `degradable` 下，
 * CI 里单独一步、失败不挡发版。L2 兜底与 UI 层仍是硬门禁。
 */
import { test, expect } from '@playwright/test';
import { MEILI_BASE, MEILI_KEY, SEARCH_QUERIES, ANCHORS, MEILI_INDEX_SETTINGS } from '../fixtures/anchors';

/**
 * L1 是**可降级依赖**：它挂了前端会自动切到 L2，用户照样能搜（已由
 * ui/search.spec.ts 独立验证）。所以这一组标记为 fixme-on-failure 语义——
 * 仍然跑、仍然报告，但不把「一次部署」判定为失败。
 *
 * 这么做的理由：L1 跑在一台 2GB 无 swap 的小机器上，OOM/卡死是常态化风险
 * （2026-09-03 一天内就出现两次：先是公网 IP 变更、后是进程卡死）。若让它
 * 阻断部署验收，每次发版都亮红灯，很快就没人认真看红灯了，真正的回归反而
 * 被淹没。L2 兜底层与 UI 层仍是硬门禁，那才是用户可见的底线。
 *
 * 判读方式：
 *   L1 红 + L2 绿 + ui/search 绿  → 搜索走降级路径，用户无感，择机修
 *   L1 红 + L2 红                → 搜索真的要挂了，紧急
 */
const L1_SOFT = '搜索 L1 不可用属可降级故障：前端会切到 L2，用户仍能搜索。'
    + '不阻断部署，但需尽快修复——L2 更慢、结果依赖上次构建。';

test.describe('搜索 L1 — Meilisearch（可降级，不阻断部署）', () => {
    test('健康检查', async ({ request }) => {
        const res = await request.get(`${MEILI_BASE}/health`, { timeout: 15_000 });
        expect(
            res.status(),
            `Meili 源站不健康。522=EdgeOne 回源失败——先查源站 IP 是否变了` +
            `（2026-09-03 就是公网 IP 变更、EdgeOne 源站组仍指旧 IP，被误判成整机宕机），` +
            `再考虑进程挂/OOM。前端会降级到 L2，用户仍能搜索但更慢、结果陈旧。`,
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

    /**
     * 前端真实查询形态探活 —— 2026-09-21 事故的守门用例。
     *
     * 上面那些用例都是「裸查询」：不带 filter。而前端实际发出的每一条
     * 搜索请求都带 `filter=is_draft = false`（meili-storage.ts）。
     * 两者的区别正是 works 索引空转 13 天没人发现的原因：
     * 裸查询 200 且有结果，带 filter 的查询 400。
     *
     * 所以这一组必须**照抄前端的请求形态**，不能图省事省掉 filter。
     */
    for (const uid of ['works', 'books', 'collections', 'entities'] as const) {
        test(`索引 ${uid} 支持前端实际使用的 is_draft 过滤`, async ({ request }) => {
            const res = await request.get(`${MEILI_BASE}/indexes/${uid}/search`, {
                headers: { Authorization: `Bearer ${MEILI_KEY}` },
                params: { q: '', limit: '1', filter: 'is_draft = false' },
                timeout: 15_000,
            });

            const body = await res.json().catch(() => ({}));
            expect(
                res.status(),
                `索引 ${uid} 不支持 is_draft 过滤（${body?.code ?? res.status()}）：` +
                `${body?.message ?? ''}\n` +
                `前端每条搜索都带这个 filter，该索引因此对用户恒为空结果。` +
                `多半是索引被重建后 settings 没重推——上机 PATCH /indexes/${uid}/settings，` +
                `设置见 indexer/full-reindex.mjs 的 SETTINGS。`,
            ).toBe(200);
        });
    }

    /**
     * settings 契约。上一组查的是症状（查询挂没挂），这一组查的是直接原因
     * （settings 在不在），红灯时能少走一步排查。
     */
    for (const [uid, want] of Object.entries(MEILI_INDEX_SETTINGS)) {
        test(`索引 ${uid} 的 settings 完整（filterable / searchable）`, async ({ request }) => {
            const res = await request.get(`${MEILI_BASE}/indexes/${uid}/settings`, {
                headers: { Authorization: `Bearer ${MEILI_KEY}` },
                timeout: 15_000,
            });
            // 只读 search key 没有读 settings 的权限时是 403 —— 那是 key 权限
            // 正确的表现，不是故障（同本文件上面那条 403 的注释）。此时跳过，
            // 症状层（上一组带 filter 的查询）仍然覆盖着这个故障。
            test.skip(res.status() === 403, 'search key 无 settings 读权限，改由带 filter 的查询用例兜底');
            expect(res.status(), `读 ${uid} settings 返回 ${res.status()}`).toBe(200);

            const s = await res.json();
            const filterable: string[] = s.filterableAttributes ?? [];
            const searchable: string[] = s.searchableAttributes ?? [];

            expect(
                filterable,
                `索引 ${uid} 的 filterableAttributes 为 ${JSON.stringify(filterable)}` +
                `——空数组 = 索引被重建后 settings 没重推（2026-09-07 works 就是这么丢的）。`,
            ).not.toHaveLength(0);

            for (const attr of want.filterable) {
                expect(filterable, `索引 ${uid} 缺 filterable 属性「${attr}」`).toContain(attr);
            }

            // searchable 为 ['*'] 是 Meili 默认值，等于 settings 从没推过：
            // 此时搜索会去匹配 id / completeness 这类字段，排序与召回都不对。
            expect(
                searchable,
                `索引 ${uid} 的 searchableAttributes 是默认值 ['*']，settings 未生效`,
            ).not.toEqual(['*']);
            for (const attr of want.searchable) {
                expect(searchable, `索引 ${uid} 缺 searchable 属性「${attr}」`).toContain(attr);
            }
        });
    }

    /**
     * 排序契约：rankingRules 丢失时，搜书名不会报错，只是把正主排到后面去——
     * 比报错更难发现。用史記锚：搜「史記」，司馬遷那部必须在首屏。
     * 同名《史記》条目有六部（徐堅、王元感、陳伯宣…），能把司馬遷排第一，
     * 靠的正是 completeness:desc 那条规则。
     */
    for (const { q, label } of [
        { q: ANCHORS.work.title, label: '繁体' },
        { q: ANCHORS.work.titleSimplified, label: '简体' },
    ]) {
        test(`${label}搜「${q}」时 ${ANCHORS.work.author} 本排在首屏`, async ({ request }) => {
            const res = await request.get(`${MEILI_BASE}/indexes/works/search`, {
                headers: { Authorization: `Bearer ${MEILI_KEY}` },
                params: { q, limit: '5', filter: 'is_draft = false' },
                timeout: 15_000,
            });
            expect(res.status(), `搜索返回 ${res.status()}`).toBe(200);

            const { hits = [] } = await res.json();
            expect(hits.length, `「${q}」召回 0 条`).toBeGreaterThan(0);
            expect(
                hits.some((h: any) => h.id === ANCHORS.work.id),
                `「${q}」前 5 条里没有 ${ANCHORS.work.author}《${ANCHORS.work.title}》` +
                `（${ANCHORS.work.id}），实得：` +
                `${hits.map((h: any) => `${h.title}/${h.author || '?'}`).join('、')}\n` +
                `多半是 works 的 rankingRules 丢了（settings 未重推），` +
                `completeness:desc 不生效时同名条目会盖过正主。`,
            ).toBeTruthy();
        });
    }
});

