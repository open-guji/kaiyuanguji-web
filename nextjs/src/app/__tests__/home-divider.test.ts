import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// 9-30 反馈（overview#322）：疏朗下「文本开放」「代码开源」之间加竖分割线，上下不顶边；界栏不画（两栏各自有框）；手机不画
const css = readFileSync(join(__dirname, '..', 'globals.css'), 'utf-8');
const SEL = ':root:not([data-layout="boxed"]) .home-open-col + .home-open-col::before';

describe('首页开放区竖分割线', () => {
    it('只在疏朗下画，1px，上下各缩进', () => {
        const i = css.indexOf(`${SEL} {\n    content`);
        expect(i).toBeGreaterThan(-1);
        const rule = css.slice(i, css.indexOf('}', i));
        expect(rule).toMatch(/width: 1px/);
        expect(rule).toMatch(/top: 12px/);
        expect(rule).toMatch(/bottom: 12px/);
    });

    it('手机（单栏）不画', () => {
        expect(css).toMatch(new RegExp(`${SEL.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\{\\s*display: none;`));
    });
});
