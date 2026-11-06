/**
 * 字符级最短编辑（Myers O(ND)），与对校示意页一致。输入是「字」数组（按码点拆，生僻字不会拆坏）。
 * 相邻的删、增合并成一处 hunk；差异总量超过 maxD 时放弃（返回 null），调用方提示「差异过大」。
 */

/** 一处差异：底本 [i1,i2) 被对照本 [j1,j2) 取代；i1===i2 为对照本多出，j1===j2 为底本有而对照本没有 */
export interface Hunk {
    i1: number;
    i2: number;
    j1: number;
    j2: number;
}

type Edit = ['e' | 'i' | 'd', number, number];

/** 兜底上限：D 太大时 trace 占 O(D²) 内存，也说明两份文本根本对不上 */
export const MAX_EDIT_DISTANCE = 4000;

function myers(a: readonly string[], b: readonly string[], maxD: number): Edit[] | null {
    const n = a.length;
    const m = b.length;
    const max = Math.min(n + m, maxD);
    const off = max + 1;
    const v = new Int32Array(2 * max + 3);
    const trace: Int32Array[] = [];
    let D = -1;
    for (let d = 0; d <= max && D < 0; d++) {
        trace.push(v.slice(off - d - 1, off + d + 2));
        for (let k = -d; k <= d; k += 2) {
            let x = k === -d || (k !== d && v[off + k - 1] < v[off + k + 1]) ? v[off + k + 1] : v[off + k - 1] + 1;
            let y = x - k;
            while (x < n && y < m && a[x] === b[y]) {
                x++;
                y++;
            }
            v[off + k] = x;
            if (x >= n && y >= m) {
                D = d;
                break;
            }
        }
    }
    if (D < 0) return null;
    const ed: Edit[] = [];
    let x = n;
    let y = m;
    for (let d = D; d > 0; d--) {
        const vv = trace[d];
        const g = (kk: number) => vv[kk + d + 1];
        const k = x - y;
        const pk = k === -d || (k !== d && g(k - 1) < g(k + 1)) ? k + 1 : k - 1;
        const px = g(pk);
        const py = px - pk;
        while (x > px && y > py) {
            ed.push(['e', x - 1, y - 1]);
            x--;
            y--;
        }
        if (x === px) ed.push(['i', x, y - 1]);
        else ed.push(['d', x - 1, y]);
        x = px;
        y = py;
    }
    while (x > 0 && y > 0) {
        ed.push(['e', x - 1, y - 1]);
        x--;
        y--;
    }
    return ed.reverse();
}

/** 比对两串字，返回合并后的差异；差异太大返回 null */
export function diffChars(a: readonly string[], b: readonly string[], maxD = MAX_EDIT_DISTANCE): Hunk[] | null {
    // 先削掉公共前后缀：大部分篇幅相同，能大幅减小 D 与 trace
    let lo = 0;
    while (lo < a.length && lo < b.length && a[lo] === b[lo]) lo++;
    let ea = a.length;
    let eb = b.length;
    while (ea > lo && eb > lo && a[ea - 1] === b[eb - 1]) {
        ea--;
        eb--;
    }
    const sa = a.slice(lo, ea);
    const sb = b.slice(lo, eb);
    if (sa.length === 0 && sb.length === 0) return [];
    const ed = myers(sa, sb, maxD);
    if (!ed) return null;
    const ops: Hunk[] = [];
    let cur: Hunk | null = null;
    let ai = 0;
    let bi = 0;
    const flush = () => {
        if (cur) ops.push(cur);
        cur = null;
    };
    for (const [t, x, y] of ed) {
        if (t === 'e') {
            flush();
            ai = x + 1;
            bi = y + 1;
            continue;
        }
        if (!cur) cur = { i1: ai, i2: ai, j1: bi, j2: bi };
        if (t === 'd') {
            cur.i2 = x + 1;
            ai = x + 1;
        } else {
            cur.j2 = y + 1;
            bi = y + 1;
        }
    }
    flush();
    return ops.map((o) => ({ i1: o.i1 + lo, i2: o.i2 + lo, j1: o.j1 + lo, j2: o.j2 + lo }));
}
