/**
 * 数据管线契约 —— 不开浏览器，纯 HTTP，几秒跑完。
 *
 * 这是部署后的第一道门禁：数据到底有没有正确打包上线。
 * 覆盖 2026-09-02～03 那一连串故障的数据侧成因。
 */
import { test, expect } from '@playwright/test';
import { ANCHORS, COUNT_RANGES, DATA_BASE } from '../fixtures/anchors';
import { fetchLatest, dataUrl } from '../fixtures/version';

test.describe('数据管线契约', () => {
    test('latest.json 可达、格式正确、不陈旧', async ({ request }) => {
        const v = await fetchLatest(request);

        // latest.json 是「发布指针」，commitId 用 12 位短哈希（前端直接拿它当 ?v=）。
        expect(v.commitId, 'commitId 必须是 12 位短哈希').toMatch(/^[0-9a-f]{12}$/);
        expect(v.fullCommitId, 'fullCommitId 缺失说明 bundle 时没拿到 draft 仓 HEAD').toMatch(/^[0-9a-f]{40}$/);
        // production 仓（book-index）——缺了会导致正式条目全 404
        expect(v.productionCommitId, 'productionCommitId 缺失 = production 仓没克隆成功').toMatch(/^[0-9a-f]{40}$/);
        // book-text 仓——deploy.yml 的定时跳过判断要读它。缺了不会漏部署
        // （比对不上必然走「有变化」分支），但定时任务每次都白跑一遍构建。
        expect(v.textCommitId, 'latest.json 缺 textCommitId：deploy.yml 的跳过判断会永远失效').toMatch(/^[0-9a-f]{40}$/);

        // 发布时间不该太陈旧：超过 7 天说明连每日定时兜底部署都挂了
        expect(v.bundleDate, 'bundleDate 缺失').toBeTruthy();
        const ageDays = (Date.now() - Date.parse(v.bundleDate!)) / 86_400_000;
        expect(ageDays, `数据已 ${ageDays.toFixed(1)} 天没更新，定时部署可能已失效`).toBeLessThan(7);
    });

    test('meta.json 全局统计在合理量级', async ({ request }) => {
        const v = await fetchLatest(request);
        const res = await request.get(dataUrl('current/meta.json', v.commitId));
        expect(res.ok()).toBeTruthy();

        const meta = await res.json();
        for (const [key, range] of Object.entries(COUNT_RANGES)) {
            const actual = meta[key];
            expect(actual, `meta.${key} 缺失`).toBeTruthy();
            expect(
                actual,
                `meta.${key}=${actual} 超出合理区间 [${range.min}, ${range.max}]——` +
                `要么数据打包出问题，要么真实增长了该调区间`,
            ).toBeGreaterThanOrEqual(range.min);
            expect(actual).toBeLessThanOrEqual(range.max);
        }
    });

    test('production 条目可取（史記）', async ({ request }) => {
        const v = await fetchLatest(request);
        const res = await request.get(dataUrl(`current/entry/${ANCHORS.work.id}.json`, v.commitId));
        expect(res.ok(), `正式条目 404 = production 仓没打包进来`).toBeTruthy();

        const entry = await res.json();
        expect(entry.title).toBe(ANCHORS.work.title);
        expect(entry.type).toBe('work');
        expect(entry.authors?.[0]?.name).toBe(ANCHORS.work.author);
        expect(entry.books?.length ?? 0).toBeGreaterThanOrEqual(ANCHORS.work.minBooks);
        expect(entry.related_works?.length ?? 0).toBeGreaterThanOrEqual(ANCHORS.work.minRelatedWorks);
    });

    test('整理本清单档用新文件名 index.json', async ({ request }) => {
        // 2026-08-26 归一把 collated_edition_index.json 改名 index.json，
        // 前端一直请求旧名导致整理本全线 404、tab 消失。
        const v = await fetchLatest(request);
        const base = `current/items/${ANCHORS.collated.id}/collated_edition`;

        const res = await request.get(dataUrl(`${base}/index.json`, v.commitId));
        expect(res.ok(), '整理本清单档 index.json 取不到').toBeTruthy();

        const idx = await res.json();
        expect(idx.work_id).toBe(ANCHORS.collated.id);

        // juan_files 是卷数的唯一可信来源，前端「共 N 卷」取它的长度。
        // 曾有 total_juan/total_categories/total_sections 三个统计字段与之
        // 并存，是整理时写入、之后没人维护的独立声明，实测 4 部整理本对不上
        // （d59f2mp38qv4 声明 1 卷、实际 43 个卷文件，页面就显示「共 1 卷」）。
        // 2026-09-03 已从数据、类型、前端一并删除——这里断言它们不再出现，
        // 防止哪天又被写回去。
        expect(Array.isArray(idx.juan_files), 'juan_files 不是数组').toBeTruthy();
        expect(idx.juan_files.length, 'juan_files 为空').toBe(ANCHORS.collated.juanFileCount);
        for (const k of ['total_juan', 'total_categories', 'total_sections']) {
            expect(idx[k], `${k} 是已废弃的不可信统计字段，不应再写入`).toBeUndefined();
        }
    });

    test('整理本卷数据结构完好且 type 用英文枚举', async ({ request }) => {
        // section.type 是英文枚举（book/category/...），前端 normSectionType
        // 必须能识别；2026-09-03 之前只认中文，导致书名标题不渲染、统计归零。
        const v = await fetchLatest(request);
        const res = await request.get(
            dataUrl(
                `current/items/${ANCHORS.collated.id}/collated_edition/${ANCHORS.collated.sampleJuanFile}`,
                v.commitId,
            ),
        );
        expect(res.ok()).toBeTruthy();

        const juan = await res.json();
        expect(juan.title).toBe(ANCHORS.collated.sampleJuanCategory);
        expect(Array.isArray(juan.sections)).toBeTruthy();

        const books = juan.sections.filter((s: any) => s.type === 'book');
        expect(
            books.length,
            `卷四书目条目数应为 ${ANCHORS.collated.sampleJuanBookCount}`,
        ).toBe(ANCHORS.collated.sampleJuanBookCount);

        // 每条书目都必须有 title——UI 靠它渲染书名，缺了就是"看不到索引"
        for (const b of books) {
            expect(b.title, `book section 缺 title: ${JSON.stringify(b).slice(0, 120)}`).toBeTruthy();
        }
        expect(books[0].title).toBe(ANCHORS.collated.sampleJuanFirstBook);

        // 所有 type 值都应在已知枚举内；出现新值说明数据 schema 又变了，
        // 前端映射表需要同步扩展（否则又会静默退化成兜底渲染）
        const KNOWN = new Set([
            'book', 'poem', 'category', 'preface', 'verification',
            'prose', 'reconstruction', 'comment', 'tally', 'page_header',
        ]);
        const unknown = [...new Set(juan.sections.map((s: any) => s.type))].filter(
            (t) => !KNOWN.has(t as string),
        );
        expect(
            unknown,
            `出现未知 section.type，前端 TYPE_EN2CN 映射需同步: ${unknown.join(', ')}`,
        ).toEqual([]);
    });

    test('current/version.json 与 latest.json 同版本且含 book-text commit', async ({ request }) => {
        // 两文件不一致 = CDN 把 current/version.json 缓存住了。
        // 前端若误读 current/version.json（它带 immutable 长缓存），会拿到过期
        // commit，items/* 全部拼错 URL——2026-09-02 的真实故障。
        const latest = await fetchLatest(request);
        const res = await request.get(`${DATA_BASE}/current/version.json?_=${Date.now()}`);
        expect(res.ok()).toBeTruthy();

        const cur = await res.json();
        // 这里的 commitId 是 40 位全长，latest 的是 12 位前缀
        expect(
            String(cur.commitId).slice(0, 12),
            'current/version.json 落后于 latest.json——CDN 缓存未刷新',
        ).toBe(latest.commitId);

        // book-text 仓（整理本/全文资产），2026-08-26 从 book-index 拆出。
        // 缺了说明 deploy 没克隆 book-text，整理本会整片空白。
        expect(
            cur.textCommitId,
            'textCommitId 缺失 = book-text 没打包，整理本/全文会全空',
        ).toMatch(/^[0-9a-f]{40}$/);
    });
});
