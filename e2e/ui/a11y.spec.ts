/**
 * 自动无障碍检查（overview#280 T1）：axe-core，只查 critical 与 serious 两级，按 WCAG 2.0/2.1 A、AA 规则。
 * minor／moderate 与 best-practice 不在这里拦（噪声大，另行人工巡检）。
 *
 * 覆盖：首页、总目、搜索页、阅读首页、条目页、阅读页（整理本）。桌面与手机两个宽度各一遍。
 * v4 外观矩阵（overview#291 P0）：3 配色 × 2 版式共 6 种组合，默认组合（朱砂＋疏朗）就是上面的基础用例，
 * 其余 5 种在桌面 1440 各扫一遍，「墨＋界栏」再补手机 390。组合靠写 localStorage（kyg-theme／kyg-layout）
 * 由页面自己的防闪脚本生效——顺带验证了「存了就生效」这条路径。站点还没上外观面板时（旧部署）自动跳过矩阵。
 * 只发 GET，不点任何按钮。总目、阅读首页、阅读页只有全栈站才有，静态站自动跳过。
 *
 * 失败时消息里列出规则 id、影响级别、命中节点的选择器，方便直接定位。
 */
import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { ANCHORS, TARGET } from '../fixtures/anchors';
import { SITE } from '../fixtures/site-profile';
import { requireNewTextData } from '../fixtures/preconditions';

interface Target {
    name: string;
    path: string;
    /** 只在全栈站有 */
    fullstackOnly?: boolean;
    /** 需要新结构文本数据（overview#307）：迁移落地前跳过 */
    needsNewText?: boolean;
}

const TARGETS: Target[] = [
    { name: '首页', path: '/' },
    { name: '古籍总目', path: '/catalog', fullstackOnly: true },
    { name: '古籍元数据（搜索页）', path: '/book-index?q=%E6%98%93' },
    { name: '阅读首页', path: '/read', fullstackOnly: true },
    { name: '条目页', path: `/item/${ANCHORS.work.id}`, fullstackOnly: true },
    { name: '阅读页（整理本）', path: `/read/${ANCHORS.collated.id}`, fullstackOnly: true, needsNewText: true },
];

const VIEWPORTS = [
    { name: '桌面 1440', width: 1440, height: 900 },
    { name: '手机 390', width: 390, height: 844 },
];

async function scan(page: Page) {
    const r = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
        .analyze();
    return r.violations.filter((v) => v.impact === 'critical' || v.impact === 'serious');
}

function describeViolations(vs: Awaited<ReturnType<typeof scan>>): string {
    return vs
        .map((v) => `- [${v.impact}] ${v.id}：${v.help}（${v.nodes.length} 处）\n${v.nodes.slice(0, 5).map((n) => `    ${n.target.join(' ')}`).join('\n')}\n  ${v.helpUrl}`)
        .join('\n');
}

for (const vp of VIEWPORTS) {
    test.describe(`无障碍（axe critical／serious）· ${vp.name}`, () => {
        for (const t of TARGETS) {
            test(t.name, async ({ browser, request }) => {
                test.skip(!!t.fullstackOnly && !SITE.fullstack, `${SITE.host} 是静态站，没有 ${t.path}`);
                if (t.needsNewText) await requireNewTextData(request, ANCHORS.collated.id, t.name);
                const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, reducedMotion: 'reduce' });
                const page = await ctx.newPage();
                try {
                    const res = await page.goto(`${TARGET}${t.path}`, { waitUntil: 'load' });
                    expect(res?.status(), `${t.path} 应为 200`).toBe(200);
                    await page.waitForLoadState('networkidle').catch(() => {});
                    const violations = await scan(page);
                    expect(violations, `\n${t.path} 有 ${violations.length} 条严重／关键无障碍问题：\n${describeViolations(violations)}\n`).toEqual([]);
                } finally {
                    await ctx.close();
                }
            });
        }
    });
}

// ── v4 外观矩阵 ──

const COMBOS: { theme: 'zhusha' | 'indigo' | 'ink'; layout: 'airy' | 'boxed' }[] = [
    { theme: 'zhusha', layout: 'boxed' },
    { theme: 'indigo', layout: 'airy' },
    { theme: 'indigo', layout: 'boxed' },
    { theme: 'ink', layout: 'airy' },
    { theme: 'ink', layout: 'boxed' },
];

/** 站点是否已上「外观」面板：首页 HTML 里有它的按钮就算（SSR 直出） */
let hasAppearance: boolean | null = null;
async function siteHasAppearance(): Promise<boolean> {
    if (hasAppearance !== null) return hasAppearance;
    try {
        const r = await fetch(`${TARGET}/`);
        hasAppearance = r.ok && (await r.text()).includes('aria-label="外观设置"');
    } catch {
        hasAppearance = false;
    }
    return hasAppearance;
}

for (const combo of COMBOS) {
    const vps = combo.theme === 'ink' && combo.layout === 'boxed' ? VIEWPORTS : VIEWPORTS.slice(0, 1);
    for (const vp of vps) {
        test.describe(`无障碍外观矩阵 · ${combo.theme}＋${combo.layout} · ${vp.name}`, () => {
            for (const t of TARGETS) {
                test(t.name, async ({ browser }) => {
                    test.skip(!!t.fullstackOnly && !SITE.fullstack, `${SITE.host} 是静态站，没有 ${t.path}`);
                    test.skip(!(await siteHasAppearance()), `${SITE.host} 还没上外观面板（v4 P0），跳过矩阵`);
                    const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, reducedMotion: 'reduce' });
                    await ctx.addInitScript(([th, ly]) => {
                        try {
                            window.localStorage.setItem('kyg-theme', th);
                            window.localStorage.setItem('kyg-layout', ly);
                        } catch { /* 存储不可用则用默认，下面的属性断言会暴露 */ }
                    }, [combo.theme, combo.layout]);
                    const page = await ctx.newPage();
                    try {
                        const res = await page.goto(`${TARGET}${t.path}`, { waitUntil: 'load' });
                        expect(res?.status(), `${t.path} 应为 200`).toBe(200);
                        await page.waitForLoadState('networkidle').catch(() => {});
                        const attrs = await page.evaluate(() => ({
                            theme: document.documentElement.getAttribute('data-theme'),
                            layout: document.documentElement.getAttribute('data-layout'),
                        }));
                        expect(attrs, `存的外观没生效（防闪脚本或面板没接上）`).toEqual({ theme: combo.theme, layout: combo.layout });
                        const violations = await scan(page);
                        expect(violations, `\n[${combo.theme}＋${combo.layout}] ${t.path} 有 ${violations.length} 条严重／关键无障碍问题：\n${describeViolations(violations)}\n`).toEqual([]);
                    } finally {
                        await ctx.close();
                    }
                });
            }
        });
    }
}
