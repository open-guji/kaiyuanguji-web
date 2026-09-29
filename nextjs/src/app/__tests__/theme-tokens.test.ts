/**
 * 主题令牌守门：本站不引 book-index-ui 的 variables.css（组件库里 `:root[data-theme="indigo"]` 那块覆盖到不了这里），
 * 所以组件库主题会换的那几个 --bim-* 变量必须由本站自己映射到朱色令牌族，靛蓝下才会跟着变。
 * 漏一个就是「蓝字配红底」（「有影印」块、「看原書影印」按钮曾如此）。
 * 列表取自 book-index-ui `BIM_THEMES.indigo` 的变量名：accent、accent-deep、flag-bg、selection-bg、rule-accent-soft。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const css = readFileSync(join(process.cwd(), 'src/app/globals.css'), 'utf8');

/** 取某个 `:root { ... }` 声明块里对某变量的赋值 */
function assigned(varName: string): string | undefined {
    const re = new RegExp(`--${varName}:\\s*([^;]+);`);
    return css.match(re)?.[1].trim();
}

describe('随主题变的 --bim-* 由本站映射', () => {
    it.each(['accent', 'accent-deep', 'flag-bg', 'selection-bg', 'rule-accent-soft'])('--bim-%s 有本站自己的赋值', (name) => {
        expect(assigned(`bim-${name}`)).toBeTruthy();
    });

    it('朱色一族的三个变量（accent、accent-deep、flag-bg）走 --color-zhu*，靛蓝下随之变', () => {
        expect(assigned('bim-accent')).toContain('--color-zhu');
        expect(assigned('bim-accent-deep')).toContain('--color-zhu-deep');
        expect(assigned('bim-flag-bg')).toContain('--color-zhu-tint');
    });

    it('靛蓝块重设了 --color-zhu 三件套', () => {
        const block = css.match(/:root\[data-theme="indigo"\]\s*\{([^}]*)\}/)?.[1] ?? '';
        for (const v of ['--color-zhu', '--color-zhu-deep', '--color-zhu-tint']) expect(block).toContain(v);
    });
});
