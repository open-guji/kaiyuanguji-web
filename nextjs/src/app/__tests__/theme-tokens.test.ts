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

/** 取 `:root[...] { ... }` 块里的变量赋值表 */
function block(selector: string): Record<string, string> {
    const esc = selector.replace(/[[\]().*+?^$|{}]/g, '\\$&');
    const m = css.match(new RegExp(`${esc}\\s*\\{([^}]*)\\}`));
    const out: Record<string, string> = {};
    for (const [, k, v] of (m?.[1] ?? '').matchAll(/(--[\w-]+):\s*([^;]+);/g)) out[k] = v.trim();
    return out;
}

const lum = (h: string) => {
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255)
        .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a: string, b: string) => {
    const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
    return (x + 0.05) / (y + 0.05);
};

describe('v4 墨主题与版式令牌', () => {
    const ink = block(':root[data-theme="ink"]');

    it('墨块重设了纸／墨／朱三族（不止强调色）', () => {
        for (const v of [
            '--color-paper', '--color-raise', '--color-tint', '--color-tint-2', '--color-ink', '--color-ink-2', '--color-ink-3',
            '--color-zhu', '--color-zhu-deep', '--color-zhu-tint', '--color-vermilion', '--color-nav-vermilion', '--bim-aux-fg',
        ]) expect(ink[v]).toBeTruthy();
    });

    it('墨：各层文字在纸／面／浅底上对比度 ≥ 4.5（AA）；强调色也是', () => {
        for (const fg of ['--color-ink', '--color-ink-2', '--color-ink-3', '--bim-aux-fg', '--color-zhu']) {
            for (const bg of ['--color-paper', '--color-raise', '--color-tint']) {
                if (contrast(ink[fg], ink[bg]) < 4.5) throw new Error(`${fg} on ${bg} = ${contrast(ink[fg], ink[bg]).toFixed(2)}`);
            }
        }
    });

    it('墨：强调色≈正文色，所以段落里的链接另有下划线（不只靠颜色）', () => {
        expect(contrast(ink['--color-zhu'], ink['--color-ink'])).toBeLessThan(1.5);
        expect(css).toMatch(/:root\[data-theme="ink"\] main :is\(p, td, dd\) a:not\(\[class\]\) \{[^}]*text-decoration: underline/);
    });

    it('版式令牌 --bim-fr-* 本站自己定义：默认疏朗（无框），boxed 覆盖成框线', () => {
        const base = block(':root');   // 首个 :root 块不含它们，下面取专用块
        expect(base).toBeTruthy();
        const names = ['bd', 'bg', 'hd-pad', 'hd-bd', 'bd-pad', 'gap', 'side-gap', 'shadow', 'tab-bd'].map((n) => `--bim-fr-${n}`);
        const all = [...css.matchAll(/:root \{([^}]*--bim-fr-bd[^}]*)\}/g)][0]?.[1] ?? '';
        for (const n of names) expect(all).toContain(`${n}:`);
        expect(all).toMatch(/--bim-fr-bd:\s*0 solid transparent/);
        const boxed = block(':root[data-layout="boxed"]');
        for (const n of names) expect(boxed[n]).toBeTruthy();
        expect(boxed['--bim-fr-bd']).toContain('1px solid');
        expect(boxed['--bim-fr-bg']).toContain('--bim-card-bg');
    });
});
