/**
 * 阅读首页 /read 分区链接契约（overview#326 批次 2）：
 * - 从分区导航 `<nav class="bim-rh-secnav">` 读出全部 `#xxx` 锚点，
 *   对每个分区抽前 2 条可比名字的链接，点开后应 200，且目标页
 *   `document.title`（服务端直出）包含链接上的名字。
 * - 为什么固定简体再比 title：overview#337 起服务端 `<title>` 一律出简体（simplifyMetadata，
 *   opencc t2cn，与 book-index-ui 的 LocaleProvider 同一套字表），阅读页挂载后 document.title
 *   也跟随偏好。所以用 addInitScript 预设 `bim-locale=zh-Hans` 再打开 /read，首页抽到的简体名
 *   与目标页简体 title 同口径，可直接比较，不再断 main 文字。
 * - 为什么要抽查：分区与目标页由不同数据管线拼出来，ID 改名、参数改名、
 *   漏打包都会让首页链到 404 或错页，每个分区抽查真实链接是最直接的契约。
 *
 * 只发 GET（page.goto 打开页面），不写任何数据。
 */
import { test, expect } from '@playwright/test';
import { TARGET } from '../fixtures/anchors';
import { SITE } from '../fixtures/site-profile';
import { requireReadSections } from '../fixtures/preconditions';

interface ReadHomeLink {
    section: string;
    href: string;
    name: string;
}

test.describe('阅读首页 /read：分区链接契约', () => {
    test.skip(!SITE.fullstack, `${SITE.host} 是静态站，没有 /read`);
    test.beforeEach(async ({ request }) => { await requireReadSections(request, '阅读首页分区链接'); });

    test('每个分区抽查链接：目标页 200 且 title 包含链接名', async ({ page }) => {
        // 固定简体再打开首页：抽到的名字是简体，与服务端简体 title 同口径（overview#337）。
        await page.addInitScript(() => localStorage.setItem('bim-locale', 'zh-Hans'));
        await page.goto(`${TARGET}/read`, { waitUntil: 'load' });
        await page.waitForLoadState('networkidle');

        // 链接与名字的抽取全部在页面里执行，避免来回传 DOM。
        const { ids, picked } = await page.evaluate<{ ids: string[]; picked: ReadHomeLink[] }>(() => {
            const text = (el: Element | null): string => (el?.textContent ?? '').trim();
            // 按类名定位，不按 aria-label 文字：label 随繁简偏好变。
            const nav = document.querySelector('nav.bim-rh-secnav');
            const ids: string[] = nav
                ? Array.from(nav.querySelectorAll('a[href^="#"]'))
                    .map((a) => a.getAttribute('href') ?? '')
                    .filter((h) => h.length > 1 && h.startsWith('#'))
                : [];
            const picked: ReadHomeLink[] = [];
            for (const id of ids) {
                const section = document.getElementById(id.slice(1));
                if (!section) continue;
                const links: ReadHomeLink[] = [];
                for (const a of Array.from(section.querySelectorAll('a[href]'))) {
                    const href = a.getAttribute('href') ?? '';
                    if (!href.startsWith('/read')) continue;
                    // 先按结构化选择器取名字：卡片 h3、专题名、年代名、经部 <b>、分类首个 span。
                    let name = text(a.querySelector('h3'));
                    if (!name) name = text(a.querySelector('span.bim-rh-t'));
                    if (!name) name = text(a.querySelector('span.bim-rh-pl:not([aria-hidden="true"])'));
                    if (!name) name = text(a.querySelector('b'));
                    if (!name) {
                        const spans = Array.from(
                            a.querySelectorAll('span:not([aria-hidden="true"]):not(.bim-rh-slip)'),
                        );
                        name = text(spans.find((s) => text(s).length > 0) ?? null);
                    }
                    if (!name) {
                        // 都没取到才看去掉 aria-hidden 后的可见文字：
                        // 以 → 结尾的是导航链接（「…全部 N 类 →」「查看未分类 →」），跳过；
                        // 否则当纯文字名字（如安国寺大悲阁记）。
                        // 注意推荐卡片的「开始阅读 →」是 aria-hidden 装饰，去掉后不影响判断。
                        const clone = a.cloneNode(true) as HTMLElement;
                        clone.querySelectorAll('[aria-hidden="true"], .bim-rh-slip, small').forEach((n) => n.remove());
                        const visible = (clone.textContent ?? '').trim();
                        if (visible.endsWith('→')) continue;
                        name = visible;
                    }
                    if (!name) continue;
                    links.push({ section: id, href, name });
                    if (links.length >= 2) break;
                }
                picked.push(...links);
            }
            return { ids, picked };
        });

        expect(ids.length, '分区导航应有 #xxx 锚点').toBeGreaterThan(0);
        for (const id of ids) {
            const n = picked.filter((p) => p.section === id).length;
            expect(n, `分区 ${id} 没有可比名字的链接`).toBeGreaterThan(0);
        }

        // 失败信息里带上实际的繁简偏好，便于排查口径不一致。
        const locale = await page.evaluate(() => localStorage.getItem('bim-locale'));

        for (const id of ids) {
            const links = picked.filter((p) => p.section === id);
            await test.step(`分区 ${id}：抽查 ${links.length} 条`, async () => {
                for (const { href, name } of links) {
                    const response = await page.goto(`${TARGET}${href}`, { waitUntil: 'load' });
                    expect(response?.status(), `分区 ${id} ${href} 状态码`).toBe(200);
                    const title = await page.title();
                    expect(
                        title,
                        `分区 ${id} ${href} 目标页 title 应包含「${name}」(bim-locale=${locale})`,
                    ).toContain(name);
                    // 404 标题也随语言变（简体「找不到这个页面」／繁体「找不到這個頁面」），两种都排除。
                    expect(title, `分区 ${id} ${href} 不应是 404 页`).not.toContain('找不到这个页面');
                    expect(title, `分區 ${id} ${href} 不應是 404 頁`).not.toContain('找不到這個頁面');
                }
            });
        }
    });
});
