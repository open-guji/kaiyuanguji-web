/**
 * 阅读首页（节点页、年代页）的书目卡守版式判准（overview#325 第 14 条）：
 * 直角、不写死 1px 边框，框线走 --bim-fr-card-bd（疏朗透明不画框，界栏 1px 实线）。
 */
import fs from 'fs';
import path from 'path';

const src = fs.readFileSync(path.join(__dirname, '..', 'ReadHome.tsx'), 'utf8');
const card = src.match(/\n    card: \{([^}]*)\}/)?.[1] ?? '';

describe('阅读首页书目卡版式', () => {
    it('边框走 --bim-fr-card-bd 令牌', () => {
        expect(card).toContain("border: 'var(--bim-fr-card-bd)'");
        expect(card).not.toMatch(/1px solid/);
    });
    it('直角：不写圆角', () => {
        expect(card).not.toMatch(/borderRadius/);
    });
});
