/** 临时诊断（不并 main）：测试站上点对读字为什么跳到条目页 */
import { test } from '../fixtures/test';
import { TARGET } from '../fixtures/anchors';
import { ensureProperNamesFull, setReaderSettings } from '../fixtures/preconditions';

for (const mode of ['default', 'old']) {
    test(`diag click ${mode}`, async ({ page }) => {
        if (mode === 'old') await page.addInitScript(() => localStorage.setItem('bim-reader-prefs', JSON.stringify({ v: 2, pageBreaks: true, bookTitleStyle: 'wavy' })));
        page.on('framenavigated', f => { if (f === page.mainFrame()) console.log(mode, 'NAV', f.url()); });
        page.on('console', m => console.log(mode, 'console', m.type(), m.text().slice(0, 300)));
        page.on('pageerror', e => console.log(mode, 'PAGEERROR', e.message));
        await page.goto(`${TARGET}/read/96mid1ogzk/002`);
        await page.locator('[data-char-id]').first().waitFor({ timeout: 60_000 });
        await setReaderSettings(page, true);
        await ensureProperNamesFull(page);
        await setReaderSettings(page, false);
        await page.waitForTimeout(3000);
        const first = page.locator('[data-char-id]').first();
        console.log(mode, 'FIRST', await first.evaluate(e => {
            const r = e.getBoundingClientRect();
            const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
            const chain = (el: Element | null) => { const out: string[] = []; while (el && out.length < 8) { out.push(`${el.tagName}.${(el.className || '').toString().slice(0, 60)}${el.getAttribute('href') ? '[href=' + el.getAttribute('href') + ']' : ''}${el.getAttribute('data-char-id') ? '#' + el.getAttribute('data-char-id') : ''}`); el = el.parentElement; } return out.join(' < '); };
            return { id: e.getAttribute('data-char-id'), rect: [r.left, r.top, r.width, r.height], self: chain(e), hit: chain(hit), scrollY };
        }));
        await page.evaluate(() => document.addEventListener('click', (e) => {
            const t = e.target as Element;
            console.log('CLICKEVT', e.detail, e.defaultPrevented, t.tagName, t.getAttribute('data-char-id'), t.closest('a')?.getAttribute('href'));
            setTimeout(() => console.log('CLICKEVT-after', e.defaultPrevented), 0);
        }, true));
        await first.click();
        await page.waitForTimeout(2000);
        console.log(mode, 'URL', page.url(), 'warp', await page.locator('[data-warp-page]').count());
    });
}
