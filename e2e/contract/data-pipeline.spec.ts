/**
 * 数据管线契约 —— 不开浏览器，纯 HTTP，几秒跑完。
 *
 * 这是部署后的第一道门禁：数据到底有没有正确打包上线。
 * 覆盖 2026-09-02～03 那一连串故障的数据侧成因。
 */
import { test, expect } from '../fixtures/test';
import { ANCHORS, COUNT_RANGES, DATA_BASE } from '../fixtures/anchors';
import { fetchLatest, dataUrl, versionKey } from '../fixtures/version';

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

        // subtypeStats 是首页「書 N 部 · 文章 N 篇 · 詩詞 N 首」的数据源。
        // subtype 是可选字段，96.7% 的 Work 根本没写——它们就是普通的书。
        // 此前 subtypeStats.book 只数「显式标了 subtype=book」的 27 条，
        // 于是首页长期显示「書 27 部」，把另外 88,000+ 部全漏了。
        // 修复后各项之和必须等于 works 总数，这条断言就是钉住这个不变量。
        const st = meta.subtypeStats ?? {};
        const sum = Object.values(st).reduce((n: number, v) => n + (v as number), 0);
        expect(
            sum,
            `subtypeStats 各项之和 ${sum} != works ${meta.works}——` +
            `未标注 subtype 的 Work 没有被计入 book`,
        ).toBe(meta.works);
        // 「書」必然是大头；掉到几十说明又退回只数显式标注的老毛病
        expect(st.book, `subtypeStats.book=${st.book} 明显偏小`).toBeGreaterThan(50_000);
    });

    test('production 条目可取（史記）', async ({ request }) => {
        const v = await fetchLatest(request);
        const res = await request.get(dataUrl(`current/entry/${ANCHORS.work.id}.json`, v.commitId));
        expect(res.ok(), `正式条目 404 = production 仓没打包进来`).toBeTruthy();

        const entry = await res.json();
        expect(entry.title).toBe(ANCHORS.work.title);
        expect(entry.type).toBe('work');
        expect(entry.authors?.[0]?.name).toBe(ANCHORS.work.author);
        // schema-v2（overview#458）：新数据没有 books，版本在 _books；新旧都认
        expect((entry.books ?? entry._books)?.length ?? 0).toBeGreaterThanOrEqual(ANCHORS.work.minBooks);
        // 关联：schema-v2 源档的 related_works 只留规范方向（史記只剩 7 条），双向全集在 _related，有就以它为准（与 book-index-ui 的 adaptEntry 一致）
        expect((entry._related ?? entry.related_works)?.length ?? 0).toBeGreaterThanOrEqual(ANCHORS.work.minRelatedWorks);
    });

    test('整理本在新结构里：manifest.json（default=整理本）＋ default/index.json 章目录', async ({ request }) => {
        // overview#307：整理本迁到 items/<id>/manifest.json ＋ items/<id>/default/{index.json,NNN.json}；
        // 旧的 collated_edition/index.json 不再有（只认新结构）。
        const v = await fetchLatest(request);
        const base = `current/items/${ANCHORS.collated.id}`;

        const mres = await request.get(dataUrl(`${base}/manifest.json`, v.commitId));
        expect(mres.ok(), 'manifest.json 取不到——文本没迁移到新结构，或没打包进来').toBeTruthy();
        const manifest = await mres.json();
        expect(manifest.id).toBe(ANCHORS.collated.id);
        expect(manifest.versions?.[0]?.key, 'versions[0] 必须是 default').toBe('default');
        expect(manifest.versions[0].kind, '这部书的主版本应是整理本').toBe('collated');
        expect(manifest.versions[0].license).toBeTruthy();

        const res = await request.get(dataUrl(`${base}/default/index.json`, v.commitId));
        expect(res.ok(), '整理本章目录 default/index.json 取不到').toBeTruthy();
        const idx = await res.json();
        expect(idx.work_id).toBe(ANCHORS.collated.id);

        // chapters 是章数的唯一可信来源（旧的 juan_files／total_juan 等都不再有）
        expect(Array.isArray(idx.chapters), 'chapters 不是数组').toBeTruthy();
        expect(idx.chapters.length, 'chapters 条数不对').toBe(ANCHORS.collated.juanFileCount);
        expect(idx.chapters[0].file, '章文件名是三位编号（不带扩展名）').toBe('001');
        for (const k of ['juan_files', 'total_juan', 'total_categories', 'total_sections']) {
            expect(idx[k], `${k} 是旧结构／已废弃字段，不应出现在新结构里`).toBeUndefined();
        }
    });

    test('整理本卷数据结构完好且 type 用英文枚举', async ({ request }) => {
        // section.type 是英文枚举（book/category/...），前端 normSectionType
        // 必须能识别；2026-09-03 之前只认中文，导致书名标题不渲染、统计归零。
        const v = await fetchLatest(request);
        const res = await request.get(
            dataUrl(
                `current/items/${ANCHORS.collated.id}/default/${ANCHORS.collated.sampleJuanFile.replace(/^juan\/|\.json$/g, '')}.json`,
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

    // 派生产物（总目 catalog/、阅读首页 read/、元数据首页 meta-home/）由网站打包脚本生成：脚本改了、数据仓没动，
    // 产物变了而旧 cacheKey 不变，`?v=<cacheKey>` 的 URL 一字不变，CDN 继续吐旧产物（10-01：build-meta-home 修了 shelf，
    // 页面取到的还是 shelf: null，测试站 verify 连挂两轮）。cacheKey 现在并进了产物内容摘要；这条按**前端实际用的 URL**
    // （只带 ?v=<版本键>、不挂时间戳）取，与绕开缓存取到的源站内容比，不一致就是 CDN 在吐旧的。
    for (const rel of ['meta-home/sections.json', 'catalog/tree.json', 'read/sections.json']) {
        test(`派生产物 current/${rel}：按前端的带版本键 URL 取到的就是源站现状（CDN 没吐旧的）`, async ({ request }) => {
            const latest = await fetchLatest(request);
            const key = versionKey(latest);
            const asFrontend = await request.get(`${DATA_BASE}/current/${rel}?v=${key}`);
            test.skip(asFrontend.status() === 404, `${rel} 这个站点没有（旧版产物）`);
            expect(asFrontend.ok(), `${rel} 带 ?v=${key} 取不到`).toBeTruthy();
            const origin = await request.get(dataUrl(`current/${rel}`, key));
            expect(origin.ok()).toBeTruthy();
            expect(
                await asFrontend.json(),
                `${rel} 带 ?v=${key} 取到的与源站现状不一致——cacheKey 没随产物变，CDN 在吐旧产物（overview#322）`,
            ).toEqual(await origin.json());
        });
    }
});
