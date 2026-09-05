/**
 * 站点产物自述契约 —— 线上跑的前端到底是哪一版。
 *
 * 起因：0.6.4 那次，数据侧字段已经删掉、线上前端却还是 0.6.3 在读它，
 * 靠浏览器缓存掩盖了一阵子才被发现——当时没有任何办法从线上直接查证
 * 前端版本，只能靠推断。现在 next.config.ts 把 node_modules 实际解析到的
 * book-index-ui 版本注入 <meta name="bim-ui-version">，这里把它钉成契约。
 *
 * 这条同时是 e2e 版本门禁（fixtures/preconditions.ts 的 requireUiVersion）
 * 的安全网：那个门禁在读不到版本时会**跳过**用例，若无本条守着，注入一旦
 * 坏掉就会变成一批用例集体静默跳过、无人察觉。这里红了，才知道那些跳过
 * 是机制坏了而不是版本没到。
 */
import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { TARGET } from '../fixtures/anchors';
import { cmpVersion, fetchUiVersion } from '../fixtures/preconditions';

/** nextjs/package.json 里 book-index-ui 的版本区间下界（"^0.7.3" → "0.7.3"） */
function pinnedFloor(): string {
    const pkgPath = fileURLToPath(new URL('../../nextjs/package.json', import.meta.url));
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
    const range: string = pkg.dependencies?.['book-index-ui'] ?? '';
    const m = range.match(/(\d+\.\d+\.\d+)/);
    if (!m) throw new Error(`nextjs/package.json 里读不出 book-index-ui 版本: ${range || '(缺失)'}`);
    return m[1];
}

test.describe('站点产物自述', () => {
    test('线上暴露 book-index-ui 版本', async ({ request }) => {
        const live = await fetchUiVersion(request);
        expect(
            live,
            `${TARGET} 的 HTML 里没有 <meta name="bim-ui-version">——` +
            `next.config.ts 的注入或 layout.tsx 的渲染坏了。` +
            `e2e 的版本门禁会因此静默跳过一批用例。`,
        ).not.toBeNull();
        expect(live, `bim-ui-version 形态不对: ${live}`).toMatch(/^\d+\.\d+\.\d+/);
    });

    test('线上前端不比本 commit 要求的旧', async ({ request }) => {
        // verify job 跑在「刚刚部署完这个 commit」之后，线上理应已是本 commit
        // 装出来的那一版。比 package.json 的下界还旧 = 部署没真正生效，
        // 拿旧产物在冒充新版本（CDN 没刷干净、构建复用了旧 out/ 等）。
        const [live, floor] = [await fetchUiVersion(request), pinnedFloor()];
        test.skip(live === null, '站点未暴露 bim-ui-version，交由上一条用例报错');

        expect(
            cmpVersion(live!, floor),
            `线上 book-index-ui ${live} 低于本仓要求的 ${floor}——本次部署没有真正生效`,
        ).toBeGreaterThanOrEqual(0);
    });
});
