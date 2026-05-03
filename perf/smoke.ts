/**
 * smoke.ts — 浏览器交互验证 index.json 剥离后的关键场景。
 *
 * 用法：tsx smoke.ts [--target=http://localhost:8765]
 */
import { chromium } from 'playwright';

const target = (() => {
    const a = process.argv.find(x => x.startsWith('--target='));
    return a ? a.slice('--target='.length) : 'http://localhost:8765';
})();

interface NetEvent { url: string; status: number; size: number }

async function main() {
    const browser = await chromium.launch({ headless: true });
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await ctx.newPage();

    const errors: string[] = [];
    const consoleErrors: string[] = [];
    const events: NetEvent[] = [];
    const indexJsonHits: string[] = [];

    page.on('console', msg => {
        if (msg.type() === 'error') consoleErrors.push(msg.text());
    });
    page.on('pageerror', err => errors.push(err.message));
    page.on('response', async res => {
        try {
            const url = res.url();
            if (url.includes('/data/index.json')) indexJsonHits.push(url);
            const len = res.headers()['content-length'];
            events.push({ url, status: res.status(), size: len ? +len : 0 });
        } catch {}
    });

    const scenarios = [
        { name: 'A1 首页',                     path: '/' },
        { name: 'B1 索引-recommend',          path: '/book-index?tab=recommend' },
        { name: 'B2 索引-catalog',            path: '/book-index?tab=catalog' },
        { name: 'B3 索引-collection',         path: '/book-index?tab=collection' },
        { name: 'B4 索引-site',               path: '/book-index?tab=site' },
        { name: 'B5 索引-feedback',           path: '/book-index?tab=feedback' },
        { name: 'F1 搜索論語',                path: '/book-index?q=' + encodeURIComponent('論語') },
        { name: 'F2 搜索论语',                path: '/book-index?q=' + encodeURIComponent('论语') },
        { name: 'D1 作品详情 論語',           path: '/book-index?id=aTNoXY45BGY3' },
        { name: 'D3 人物详情 孔子',           path: '/book-index?id=1j96hewiuieps' },
        { name: 'E1 整理本 直齋書錄解題',     path: '/book-index?id=1ev3bb403quio' },
    ];

    console.log(`target: ${target}\n`);
    let allOk = true;
    for (const s of scenarios) {
        events.length = 0;
        indexJsonHits.length = 0;
        consoleErrors.length = 0;
        errors.length = 0;

        const url = target + s.path;
        const t0 = Date.now();
        try {
            await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
        } catch (e: any) {
            // networkidle 可能因 worker 拉索引超时；不致命
            console.log(`  ${s.name.padEnd(28)} (networkidle timeout, 继续)`);
        }
        const dt = Date.now() - t0;
        const totalKB = events.reduce((x, e) => x + e.size, 0) / 1024;
        const reqCount = events.length;

        const status = indexJsonHits.length === 0 ? '✓' : '✗';
        const errSuffix = (consoleErrors.length || errors.length)
            ? ` ⚠console:${consoleErrors.length} pageerr:${errors.length}` : '';
        console.log(`${status} ${s.name.padEnd(28)} ${reqCount.toString().padStart(3)} reqs, ${totalKB.toFixed(0).padStart(5)} KB, ${(dt/1000).toFixed(1)}s${errSuffix}`);

        if (indexJsonHits.length) {
            allOk = false;
            console.log(`    !!! 仍下载了 index.json: ${indexJsonHits.join(', ')}`);
        }
        if (errors.length) {
            allOk = false;
            for (const e of errors) console.log(`    pageerror: ${e}`);
        }
        // 输出所有 4xx/5xx 请求
        const fails = events.filter(e => e.status >= 400);
        for (const f of fails) {
            console.log(`    [${f.status}] ${f.url}`);
        }
    }

    await browser.close();
    console.log(allOk ? '\n✅ 所有场景通过' : '\n❌ 发现问题');
    process.exit(allOk ? 0 : 1);
}

main().catch(e => { console.error(e); process.exit(1); });
