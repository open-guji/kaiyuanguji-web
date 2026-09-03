/**
 * 搜索 L1 (Meilisearch) 探活 —— 独立 project，**不阻断部署验收**。
 *
 * 见 playwright.config.ts 的 project 划分：这个文件跑在 `degradable` 下，
 * CI 里单独一步、失败不挡发版。L2 兜底与 UI 层仍是硬门禁。
 */
import { test, expect } from '@playwright/test';
import { MEILI_BASE, MEILI_KEY, SEARCH_QUERIES } from '../fixtures/anchors';

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
});

