/**
 * 简体模式下全站不残留繁体字（overview#337）。
 *
 * 用户 10-01：「繁简转换在很多地方没有起效，所有网站上的文本要经过 i18n 包装」。
 * 在简体模式（localStorage bim-locale=zh-Hans）下打开各页，取正文、aria-label／title／placeholder／alt
 * 与 <title>，用常用繁体字表检测；专名白名单另列。命中就说明有界面文字没走字典，或数据文字没过 convert。
 * 另一组反过来：切到繁体后，顶栏与页脚的界面文字要跟着变成繁体（以前它们写死简体，切了不变）。
 *
 * 字表与检测函数取自 fixtures/traditional-check.ts（book-index-ui 导出的副本：线上验收只装 e2e 依赖，引不到组件库）。
 * 只发 GET。
 */
import { test, expect, type Page } from '../fixtures/test';
import { ANCHORS, TARGET } from '../fixtures/anchors';
import { SITE } from '../fixtures/site-profile';
import { findTraditionalChars, TRADITIONAL_ALLOWLIST } from '../fixtures/traditional-check';
import { requireUiVersion } from '../fixtures/preconditions';

/** 版本、丛编各取一个首页上推荐的经典条目（ANCHORS 里还没有这两类） */
const BOOK_ID = '96kzkdm8e8';        // 新鐫全部繡像紅樓夢（程甲本）
const COLLECTION_ID = '8rlb6yi1ecqo'; // 欽定四庫全書·文淵閣本

/**
 * 专名白名单：站上原样展示的外文或专名，不是漏转。
 * 默认表已含保护表、「切換為繁體」按钮与 Kanripo 的日文名「漢籍リポジトリ」；网站另有专名时加在这里。
 */
const ALLOW: readonly string[] = [...TRADITIONAL_ALLOWLIST];

interface Target { name: string; path: string; fullstackOnly?: boolean }

const TARGETS: Target[] = [
    { name: '首页', path: '/' },
    { name: '古籍总目', path: '/catalog', fullstackOnly: true },
    { name: '古籍总目·节点', path: '/catalog?node=cc897679fd3', fullstackOnly: true },
    { name: '元数据首页', path: '/book-index' },
    { name: '搜索', path: '/book-index?q=%E5%8F%B2%E8%A8%98' },
    { name: '条目页·作品', path: `/item/${ANCHORS.work.id}`, fullstackOnly: true },
    { name: '条目页·版本', path: `/item/${BOOK_ID}`, fullstackOnly: true },
    { name: '条目页·丛编', path: `/item/${COLLECTION_ID}`, fullstackOnly: true },
    { name: '条目页·人物', path: `/item/${ANCHORS.entity.id}`, fullstackOnly: true },
    { name: '阅读首页', path: '/read', fullstackOnly: true },
    { name: '阅读页', path: `/read/${BOOK_ID}`, fullstackOnly: true },
    { name: '关于', path: '/about' },
    { name: '反馈', path: '/feedback' },
];

async function setLocale(page: Page, locale: 'zh-Hans' | 'zh-Hant') {
    await page.addInitScript((l) => { try { localStorage.setItem('bim-locale', l); } catch { /* ignore */ } }, locale);
}

/** 用户看得到、读屏读得到的文字（含 <title>） */
async function visibleText(page: Page): Promise<string> {
    return page.evaluate(() => {
        const parts = [document.title, document.body.innerText];
        document.querySelectorAll('[aria-label],[title],[placeholder],[alt]').forEach((el) => {
            for (const a of ['aria-label', 'title', 'placeholder', 'alt']) {
                const v = el.getAttribute(a);
                if (v) parts.push(v);
            }
        });
        return parts.join('\n');
    });
}

test.describe('简体模式：页面不残留常见繁体字', () => {
    for (const t of TARGETS) {
        test(t.name, async ({ page }) => {
            test.skip(!!t.fullstackOnly && !SITE.fullstack, `${SITE.host} 是静态站，没有 ${t.path}`);
            await setLocale(page, 'zh-Hans');
            const res = await page.goto(`${TARGET}${t.path}`, { waitUntil: 'load' });
            expect(res?.status(), t.path).toBeLessThan(400);
            // 组件库的数据区块是挂载后取数的；搜索页可能有长连接，networkidle 等不到就按时限往下走
            await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => {});
            await page.waitForTimeout(800);
            const hits = findTraditionalChars(await visibleText(page), ALLOW);
            const lines = [...new Set(hits.map((h) => `${h.char}  …${h.context.replace(/\s+/g, ' ')}…`))];
            expect(lines, `${t.name}（${t.path}）简体模式残留繁体字`).toEqual([]);
        });
    }
});

test.describe('简体模式：异体字归一（overview#350）', () => {
    // 脂评凡例：用户 10-02 报「㫖」「縂」「寳」（風月寳鑑）选简体后不转；繁体模式原样保留
    const PATH = '/read/96kzii6z28/001';
    const VARIANTS = /[㫖縂寳]/;

    test('脂评凡例：简体下没有 㫖縂寳', async ({ page, request }) => {
        test.skip(!SITE.fullstack, `${SITE.host} 是静态站，没有 ${PATH}`);
        await requireUiVersion(request, '0.37.0', '异体字归一');
        await setLocale(page, 'zh-Hans');
        const res = await page.goto(`${TARGET}${PATH}`, { waitUntil: 'load' });
        expect(res?.status(), PATH).toBeLessThan(400);
        await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => {});
        const main = page.getByRole('main');
        await expect(main).toContainText(/宝鉴|旨|总/, { timeout: 30_000 });
        expect((await main.innerText()).match(new RegExp(VARIANTS, 'g')) ?? [], '简体模式残留异体字').toEqual([]);
    });

    test('脂评凡例：繁体下照原文显示异体字（归一只在简体模式做）', async ({ page, request }) => {
        test.skip(!SITE.fullstack, `${SITE.host} 是静态站，没有 ${PATH}`);
        await requireUiVersion(request, '0.37.0', '异体字归一');
        await setLocale(page, 'zh-Hant');
        await page.goto(`${TARGET}${PATH}`, { waitUntil: 'load' });
        await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => {});
        await expect(page.getByRole('main')).toContainText(VARIANTS, { timeout: 30_000 });
    });
});

test.describe('繁体模式：顶栏与页脚跟着切', () => {
    test('首页：导航与页脚出繁体', async ({ page }) => {
        await setLocale(page, 'zh-Hant');
        await page.goto(`${TARGET}/`, { waitUntil: 'load' });
        await page.waitForLoadState('networkidle');
        const nav = await page.locator('header.og-nav').innerText();
        const footer = await page.locator('footer').first().innerText();
        // 「閱讀」「關於」是顶栏／页脚固定有的词；简体模式下是「阅读」「关于」
        expect(nav).toContain('閱讀');
        expect(footer).toMatch(/關於/);
    });
});
