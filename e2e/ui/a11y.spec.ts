/**
 * 自动无障碍检查（overview#280 T1）：axe-core，只查 critical 与 serious 两级，按 WCAG 2.0/2.1 A、AA 规则。
 * minor／moderate 与 best-practice 不在这里拦（噪声大，另行人工巡检）。
 *
 * 覆盖：首页、总目、阅读首页、条目页、阅读页（整理本）。桌面与手机两个宽度各一遍。
 * 只发 GET，不点任何按钮。总目、阅读首页、阅读页只有全栈站才有，静态站自动跳过。
 *
 * 失败时消息里列出规则 id、影响级别、命中节点的选择器，方便直接定位。
 */
import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { ANCHORS, TARGET } from '../fixtures/anchors';
import { SITE } from '../fixtures/site-profile';

interface Target {
    name: string;
    path: string;
    /** 只在全栈站有 */
    fullstackOnly?: boolean;
}

const TARGETS: Target[] = [
    { name: '首页', path: '/' },
    { name: '古籍总目', path: '/catalog', fullstackOnly: true },
    { name: '阅读首页', path: '/read', fullstackOnly: true },
    { name: '条目页', path: `/item/${ANCHORS.work.id}`, fullstackOnly: true },
    { name: '阅读页（整理本）', path: `/read/${ANCHORS.collated.id}?kind=collated`, fullstackOnly: true },
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
            test(t.name, async ({ browser }) => {
                test.skip(!!t.fullstackOnly && !SITE.fullstack, `${SITE.host} 是静态站，没有 ${t.path}`);
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
