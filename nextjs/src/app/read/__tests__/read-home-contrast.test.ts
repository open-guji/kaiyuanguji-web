/**
 * 阅读首页小字不许用 --color-ink-3（#948a7e，对纸底 3.17、对卡底 3.33，都不到 axe 要的 4.5:1）。
 * 测试站 e2e a11y.spec「阅读首页」桌面／手机的 color-contrast 失败就是这个。改接 --bim-aux-fg（#6f6457，≥5.4）。
 */
import fs from 'fs';
import path from 'path';

const src = fs.readFileSync(path.join(__dirname, '..', 'ReadHome.tsx'), 'utf8');
const css = fs.readFileSync(path.join(__dirname, '..', '..', 'globals.css'), 'utf8');

describe('阅读首页小字对比度', () => {
    it('不用 --color-ink-3 作文字色', () => {
        expect(src).not.toMatch(/color:\s*'var\(--color-ink-3\)'/);
    });
    it('note／meta 用 --bim-aux-fg，且该令牌在 globals.css 里有定义', () => {
        expect(src.match(/var\(--bim-aux-fg\)/g)?.length).toBeGreaterThanOrEqual(2);
        expect(css).toMatch(/--bim-aux-fg:\s*#6f6457/);
    });
});
