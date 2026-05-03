/**
 * smoke.ts — 浏览器交互验证关键场景，作为 CI 门禁。
 *
 * 退出码：
 *   0 — 通过
 *   1 — 至少一个场景：被请求 index.json / 出现 pageerror / 超出 wire bytes 上限
 *
 * 用法：
 *   tsx smoke.ts [--target=http://localhost:8765] [--strict-404]
 */
import { chromium } from 'playwright';

const target = (() => {
    const a = process.argv.find(x => x.startsWith('--target='));
    return a ? a.slice('--target='.length) : 'http://localhost:8765';
})();
const strictNotFound = process.argv.includes('--strict-404');

interface NetEvent { url: string; status: number; size: number }

/**
 * 每个场景的 wire bytes 上限（KB）— 编码后大小（gzip wire），
 * 留 1.5× 余量。EdgeOne 的 Content-Length 报的是原始大小（虚高 ~4×），
 * 这里我们容许虚高，所以阈值放宽。超出说明剥离回归或 worker 索引膨胀。
 */
const BUDGETS_KB: Record<string, number> = {
    'A1': 2_500,    // 首页 + 5 个图片
    'B1': 12_000,   // 索引页（如停留 ≥ 5s 触发预热则含 worker shard，~8.5 MB）
    'B2': 12_000,
    'B3': 12_000,
    'B4': 12_000,
    'B5': 12_000,
    'F1': 12_000,   // 搜索 = 索引页 + worker 立即触发
    'F2': 12_000,
    'D1':  2_000,   // 作品详情：chunk + worker（不预热）
    'D3':  2_000,
    'E1':  3_000,   // 整理本：chunk + items/* + worker chunks 可能并发
};

async function main() {
    const browser = await chromium.launch({ headless: true });
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await ctx.newPage();

    const errors: string[] = [];
    const events: NetEvent[] = [];
    const indexJsonHits: string[] = [];

    page.on('pageerror', err => errors.push(err.message));
    page.on('response', async res => {
        try {
            const url = res.url();
            if (url.includes('/data/index.json')) indexJsonHits.push(url);
            const len = res.headers()['content-length'];
            events.push({ url, status: res.status(), size: len ? +len : 0 });
        } catch {}
    });

    const scenarios: { id: string; name: string; path: string }[] = [
        { id: 'A1', name: '首页',                     path: '/' },
        { id: 'B1', name: '索引-recommend',          path: '/book-index?tab=recommend' },
        { id: 'B2', name: '索引-catalog',            path: '/book-index?tab=catalog' },
        { id: 'B3', name: '索引-collection',         path: '/book-index?tab=collection' },
        { id: 'B4', name: '索引-site',               path: '/book-index?tab=site' },
        { id: 'B5', name: '索引-feedback',           path: '/book-index?tab=feedback' },
        { id: 'F1', name: '搜索論語',                path: '/book-index?q=' + encodeURIComponent('論語') },
        { id: 'F2', name: '搜索论语',                path: '/book-index?q=' + encodeURIComponent('论语') },
        { id: 'D1', name: '作品详情 論語',           path: '/book-index?id=aTNoXY45BGY3' },
        { id: 'D3', name: '人物详情 孔子',           path: '/book-index?id=1j96hewiuieps' },
        { id: 'E1', name: '整理本 直齋書錄解題',     path: '/book-index?id=1ev3bb403quio' },
    ];

    console.log(`target: ${target}\n`);
    const failures: string[] = [];

    for (const s of scenarios) {
        events.length = 0;
        indexJsonHits.length = 0;
        errors.length = 0;

        const url = target + s.path;
        const t0 = Date.now();
        try {
            await page.goto(url, { waitUntil: 'networkidle', timeout: 30_000 });
        } catch {
            // networkidle 可能因 worker 拉索引超时；不致命
        }
        const dt = Date.now() - t0;
        const totalKB = events.reduce((x, e) => x + e.size, 0) / 1024;
        const reqCount = events.length;
        const budget = BUDGETS_KB[s.id];

        let mark = '✓';
        const sceneFails: string[] = [];
        if (indexJsonHits.length > 0) {
            mark = '✗';
            sceneFails.push(`下载了 index.json: ${indexJsonHits.length} 次`);
        }
        if (errors.length > 0) {
            mark = '✗';
            errors.forEach(e => sceneFails.push(`pageerror: ${e}`));
        }
        if (budget && totalKB > budget) {
            mark = '✗';
            sceneFails.push(`wire ${totalKB.toFixed(0)} KB > 预算 ${budget} KB`);
        }
        if (strictNotFound) {
            const notFound = events.filter(e => e.status === 404);
            if (notFound.length > 0) {
                mark = '✗';
                notFound.forEach(f => sceneFails.push(`404: ${f.url}`));
            }
        }

        const tag = `${s.id} ${s.name}`.padEnd(28);
        console.log(`${mark} ${tag} ${reqCount.toString().padStart(3)} reqs, ${totalKB.toFixed(0).padStart(5)} KB / ${(budget ?? '∞').toString().padStart(5)} budget, ${(dt/1000).toFixed(1)}s`);
        for (const f of sceneFails) console.log(`    !!! ${f}`);
        if (sceneFails.length) failures.push(`${s.id}: ${sceneFails.join('; ')}`);
    }

    await browser.close();

    if (failures.length === 0) {
        console.log('\n✅ 所有场景通过');
        process.exit(0);
    } else {
        console.log(`\n❌ ${failures.length} 个场景失败：`);
        failures.forEach(f => console.log(`  - ${f}`));
        process.exit(1);
    }
}

main().catch(e => { console.error(e); process.exit(1); });
