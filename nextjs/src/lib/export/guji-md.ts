/**
 * 阅读页「下载本冊」：一册的 char／punct／entity（book-text original 三层）→ guji-markdown 文本（A33 下载方案，sheldon 11-02 定）。
 *
 * 规则照 guji-format spec/03 §三（lines.md）、§四（rich.md），实现逐行照 book-text
 * `scripts/book-text/original_char.py` 的 `render_lines`／`render_rich`，测试里与它的输出逐字节比对
 * （`__tests__/guji-md.test.ts` 用真书几页；`__tests__/cases/` 是手编小样本，逐项覆盖各种版式、标点、专名情况，
 * 答案由 `scripts/export-golden.py` 用 Python 出）。改规则须两边一起改，并重出答案。
 *
 * 纯函数，不碰 DOM、不取数；取数和下载在 `download.ts`。
 */
import { extractType } from 'book-index-ui';

export const SOLO_ATTR = '{type=单行}';
const LACUNA = '[[]]';
const BOX = '□';
const FIG_DEFAULT_ALT = '图形符号';

export class GujiFormatError extends Error {}

/* ── 输入（只列用到的字段，都是 guji-format 02／04／05 的子集） ─────────────── */

export interface CharCell { a: string; c: string; lane?: string; lacuna?: boolean; zi?: string; guess?: boolean; fig?: string; pending_reason?: string }
export interface CharColumn { cells?: CharCell[]; kind?: string; fig?: string; raised?: number; lead_blank?: number }
export interface CharPage { page: number; columns?: CharColumn[] }
export interface CharDoc { pages?: CharPage[] }

export interface PunctItem { mark: string; kind: string; pos: 'before' | 'after'; anchor?: string; pre_char?: string }
export interface PunctDoc { punctuations?: PunctItem[] }

export interface EntityItem {
    id?: string;
    type: string;
    text?: string;
    anchor?: { start?: string; end?: string };
    target?: { status?: string; entity_id?: string; href?: string };
}
export interface EntityDoc { entities?: EntityItem[] }

const TYPE_SEG: Record<string, string> = { work: 'Work', book: 'Book', collection: 'Collection', entity: 'Entity' };

/**
 * 专名的站内链接 `book-index://<类>/<id>`。book-text 第 11 组起专名层不再写 `target.href`，
 * 类段由 id 的类型位解出；旧数据只有 href 时照用 href。
 */
export function entityHref(e: EntityItem): string | undefined {
    const id = e.target?.entity_id;
    if (id) {
        try {
            const seg = TYPE_SEG[extractType(id)];
            if (seg) return `book-index://${seg}/${id}`;
        } catch { /* 解不出类型就退回 href */ }
    }
    return e.target?.href || undefined;
}

export interface FigDoc { figures?: { id: string; alt?: string }[] }

/* ── 读 char ─────────────────────────────────────────────────────────────── */

export function cellLane(cell: CharCell): string {
    if (cell.lane) return cell.lane;
    if (cell.a.endsWith('a')) return 'jz_r';
    if (cell.a.endsWith('b')) return 'jz_l';
    return 'main';
}

/** char → [格位, 字]，按 cells 读序 */
export function charSlots(char: CharDoc): [string, string][] {
    const out: [string, string][] = [];
    for (const p of char.pages ?? []) for (const col of p.columns ?? []) for (const c of col.cells ?? []) out.push([c.a, c.c]);
    return out;
}

type RunKind = 'main' | 'solo' | 'jz';

/** 一列的格 → [kind, 格…]；jz 一段 = 连续的 a 再连续的 b，b 之后又来 a 另起一段 */
function runs(cells: CharCell[]): [RunKind, CharCell[]][] {
    const out: [RunKind, CharCell[]][] = [];
    for (const cell of cells) {
        const lane = cellLane(cell);
        const kind = (lane === 'jz_r' || lane === 'jz_l' ? 'jz' : lane) as RunKind;
        if (kind !== 'main' && kind !== 'solo' && kind !== 'jz') throw new GujiFormatError(`${cell.a}: 不认识的 lane ${lane}`);
        const last = out[out.length - 1];
        if (last && last[0] === kind) {
            if (kind === 'jz' && lane === 'jz_r' && cellLane(last[1][last[1].length - 1]) === 'jz_l') out.push([kind, [cell]]);
            else last[1].push(cell);
        } else {
            out.push([kind, [cell]]);
        }
    }
    return out;
}

type Alts = Map<string, string | undefined> | null;

export function figAlts(fig: FigDoc | null | undefined): Alts {
    if (fig == null) return null;
    return new Map((fig.figures ?? []).map((f) => [f.id, f.alt]));
}

function tu(fid: string, alts: Map<string, string | undefined>, block = false): string {
    const alt = alts.get(fid) || FIG_DEFAULT_ALT;
    if (/[[\]{}\n]/.test(alt)) throw new GujiFormatError(`图 ${fid} 的说明里有方括号、花括号或换行，写不进 :tu[…]`);
    return `${block ? '::' : ':'}tu[${alt}]{id=${fid}}`;
}

function glyph(cell: CharCell, inSolo = false, alts: Alts = null): string {
    if (cell.fig != null) return alts === null ? cell.c : tu(cell.fig, alts);
    // char v0.4：机器没给字的待审格（pending_reason 且 c 为 □）与阙文同写 [[]]（guji-format 02 §4.8、03 §三）
    if (cell.lacuna || (cell.pending_reason != null && cell.c === BOX)) return inSolo ? BOX : LACUNA;
    if (cell.zi != null) return `:zi[${cell.zi}]`;
    if (cell.guess) return `□{guess=${cell.c}}`;
    return cell.c;
}

function columnBody(column: CharColumn, alts: Alts): string {
    const out: string[] = [];
    for (const [kind, cells] of runs(column.cells ?? [])) {
        if (kind === 'main') out.push(...cells.map((c) => glyph(c, false, alts)));
        else if (kind === 'solo') out.push(':jz[' + cells.map((c) => glyph(c, true, alts)).join('') + ']' + SOLO_ATTR);
        else {
            const a = cells.filter((c) => cellLane(c) === 'jz_r').map((c) => glyph(c, false, alts)).join('');
            const b = cells.filter((c) => cellLane(c) === 'jz_l').map((c) => glyph(c, false, alts)).join('');
            out.push(a && b ? `<${a}|${b}>` : `<${a}${b}>`);
        }
    }
    return out.join('');
}

const isBlankColumn = (column: CharColumn) => !column.cells || column.cells.length === 0;

/* ── 分行本：lines.md（spec/03 §三） ─────────────────────────────────────── */

/** char → 分行稿全文（末尾带换行）。给了 fig：图片格写 `:tu[…]`、图列出一行 `::tu[…]`；不给：图片格写字、图列不出 */
export function renderLines(char: CharDoc, fig?: FigDoc | null): string {
    const alts = figAlts(fig);
    const out: string[] = [];
    for (const page of char.pages ?? []) {
        out.push(`<!-- p${page.page} -->`);
        for (const column of page.columns ?? []) {
            if (column.kind === 'figure') {
                if (alts !== null && column.fig) out.push(tu(column.fig, alts, true));
                continue;
            }
            if (isBlankColumn(column)) continue;
            out.push('^'.repeat(column.raised ?? 0) + '.'.repeat(column.lead_blank ?? 0) + columnBody(column, alts));
        }
    }
    return out.join('\n') + '\n';
}

/* ── 标点本／专名本：rich.md（spec/03 §四） ─────────────────────────────── */

/**
 * 专名怎么出：
 *   - `works`：只出书名号（work 实体写《》，不带链接，其余专名不出）＝标点本；
 *   - `plain`：全部专名，不带链接（`/人名/`、`《書名》`）；
 *   - `linked`：全部专名，matched 且有 href 的带链接（`[/人名/](book-index://…)`）＝ rich.md。
 */
export type EntityMode = 'works' | 'plain' | 'linked';

type Tok = [string, string];

function renderTokens(char: CharDoc, breakAfter: Set<number>, alts: Alts): Tok[] {
    const toks: Tok[] = [];
    let idx = 0;
    for (const page of char.pages ?? []) {
        let first = true;
        for (const column of page.columns ?? []) {
            if (column.kind === 'figure') {
                if (alts !== null && column.fig) {
                    if (first) {
                        toks.push([`<!-- p${page.page} -->`, '']);
                        first = false;
                    }
                    toks.push([tu(column.fig, alts, true), '']);
                }
                continue;
            }
            if (isBlankColumn(column)) continue;
            if (first) {
                toks.push([`<!-- p${page.page} -->`, '']);
                first = false;
            }
            for (const [kind, cells] of runs(column.cells ?? [])) {
                let ordered = cells;
                if (kind === 'jz') {
                    const last = toks[toks.length - 1];
                    if (last && last[0] === '>' && last[1] === '' && !breakAfter.has(idx - 1)) toks.pop(); // 与上一条夹注合并
                    else toks.push(['<', '']);
                    ordered = [...cells.filter((c) => cellLane(c) === 'jz_r'), ...cells.filter((c) => cellLane(c) === 'jz_l')];
                } else if (kind === 'solo') {
                    toks.push([':jz[', '']);
                }
                for (const c of ordered) {
                    toks.push([glyph(c, kind === 'solo', alts), c.c]);
                    idx += 1;
                }
                if (kind === 'jz') toks.push(['>', '']);
                else if (kind === 'solo') toks.push([']' + SOLO_ATTR, '']);
            }
        }
    }
    return toks;
}

/** 同一字上的先后：标题符最先，before 在 after 前、分段符最后；before 里《排在「后，after 里》排在最前 */
function punctKey(p: PunctItem, off: number): [number, boolean, boolean, boolean, boolean] {
    const inner = p.pos === 'before' ? p.mark === '《' : p.mark !== '》';
    return [off, p.kind !== 'heading', p.pos !== 'before', p.kind === 'break', inner];
}

function cmpKey(a: [number, boolean, boolean, boolean, boolean], b: [number, boolean, boolean, boolean, boolean]): number {
    if (a[0] !== b[0]) return a[0] - b[0];
    for (let i = 1; i < 5; i++) if (a[i] !== b[i]) return a[i] ? 1 : -1;
    return 0;
}

function resolveOffsets<T>(pos: Map<string, number>, items: T[], key: (it: T) => string | undefined): number[] {
    return items.map((it, i) => {
        const a = key(it);
        const off = a === undefined ? undefined : pos.get(a);
        if (off === undefined) throw new GujiFormatError(`第 ${i} 条的格位 ${String(a)} 不在 char 里`);
        return off;
    });
}

export function renderRich(char: CharDoc, punct: PunctDoc | null | undefined, entity: EntityDoc | null | undefined, opts: { entities?: EntityMode; fig?: FigDoc | null } = {}): string {
    const mode = opts.entities ?? 'linked';
    const slots = charSlots(char);
    const pos = new Map<string, number>();
    slots.forEach(([a], i) => pos.set(a, i));

    const puncts = [...(punct?.punctuations ?? [])];
    const pOff = resolveOffsets(pos, puncts, (p) => p.anchor);
    puncts.forEach((p, k) => {
        if (p.pre_char !== undefined && slots[pOff[k]][1] !== p.pre_char) {
            throw new GujiFormatError(`标点 ${p.anchor} 校验字应为 ${p.pre_char}，char 为 ${slots[pOff[k]][1]}`);
        }
    });
    const order = puncts.map((_, k) => k).sort((x, y) => cmpKey(punctKey(puncts[x], pOff[x]), punctKey(puncts[y], pOff[y])));

    let ents = [...(entity?.entities ?? [])];
    // 校验全部实体（与 Python 同：对不上整章不出），再按模式筛
    const allS = resolveOffsets(pos, ents, (e) => e.anchor?.start);
    const allE = resolveOffsets(pos, ents, (e) => e.anchor?.end);
    ents.forEach((e, i) => {
        const got = slots.slice(allS[i], allE[i] + 1).map(([, c]) => c).join('');
        if (e.text !== undefined && got !== e.text) throw new GujiFormatError(`实体 ${e.id ?? i} 校验字应为 ${e.text}，char 为 ${got}`);
    });
    let eS = allS;
    let eE = allE;
    if (mode === 'works') {
        const keep = ents.map((e) => e.type === 'work');
        ents = ents.filter((_, i) => keep[i]);
        eS = allS.filter((_, i) => keep[i]);
        eE = allE.filter((_, i) => keep[i]);
    }

    const breakAfter = new Set(order.filter((k) => puncts[k].kind === 'break').map((k) => pOff[k]));
    const tokens = renderTokens(char, breakAfter, figAlts(opts.fig));

    const punctMap = new Map<number, PunctItem[]>();
    for (const k of order) {
        const list = punctMap.get(pOff[k]);
        if (list) list.push(puncts[k]);
        else punctMap.set(pOff[k], [puncts[k]]);
    }
    const entStarts = new Map<number, EntityItem>();
    const entEnds = new Map<number, EntityItem>();
    ents.forEach((e, i) => {
        entStarts.set(eS[i], e);
        entEnds.set(eE[i], e);
    });
    // 书名两层都记：与 work 实体同位的《》由实体包装出，这里跳过免得重出
    const workOpen = new Set(ents.flatMap((e, i) => (e.type === 'work' ? [eS[i]] : [])));
    const workClose = new Set(ents.flatMap((e, i) => (e.type === 'work' ? [eE[i]] : [])));
    for (const [k, ps] of punctMap) {
        punctMap.set(k, ps.filter((p) => !(p.mark === '《' && p.pos === 'before' && workOpen.has(k)) && !(p.mark === '》' && p.pos === 'after' && workClose.has(k))));
    }

    const linked = (e: EntityItem) => mode === 'linked' && e.target?.status === 'matched' && !!entityHref(e);
    const punctBetween = (k: number) => (punctMap.get(k) ?? []).some((p) => p.pos === 'after') || (punctMap.get(k + 1) ?? []).some((p) => p.pos === 'before');

    // 相邻专名（spec/03 §四第 6 条）：两个以上非 work 专名紧挨、中间无字无标点，这一串里每个都写 `:zm[甲]`
    const adjacent = new Set<EntityItem>();
    for (const [t, e] of entEnds) {
        const n = entStarts.get(t + 1);
        if (n !== undefined && e.type !== 'work' && n.type !== 'work' && !punctBetween(t)) {
            adjacent.add(e);
            adjacent.add(n);
        }
    }

    const out: string[] = [];
    const pendingMarks: string[] = [];
    const pendingBreaks: string[] = [];
    const endsWithNl = () => out.length > 0 && out[out.length - 1].endsWith('\n');

    // 版面记号的次序：先收小注（`>`、`]{…}`），再分段，再标题（须在行首），再页码标记／开小注
    const flushMarks = (heading: string | null) => {
        let k = 0;
        while (k < pendingMarks.length && (pendingMarks[k].startsWith('>') || pendingMarks[k].startsWith(']'))) k++;
        out.push(...pendingMarks.slice(0, k));
        out.push(...pendingBreaks);
        if (heading) {
            if (out.length > 0 && !endsWithNl()) out.push('\n\n'); // 标题前没有分段符：仍保证另起一行
            out.push(heading);
        }
        for (const mk of pendingMarks.slice(k)) {
            if (mk.startsWith('::tu[')) {
                if (out.length > 0 && !endsWithNl()) out.push('\n\n');
                out.push(mk + '\n\n');
            } else {
                out.push(mk);
            }
        }
        pendingMarks.length = 0;
        pendingBreaks.length = 0;
    };

    let pi = 0;
    for (const [orig, ch] of tokens) {
        if (ch === '') {
            pendingMarks.push(orig);
            continue;
        }
        const here = punctMap.get(pi) ?? [];
        const head = here.find((p) => p.kind === 'heading');
        flushMarks(head ? head.mark + ' ' : null);
        for (const p of here) if (p.pos === 'before' && p.kind !== 'heading') out.push(p.mark);
        const s = entStarts.get(pi);
        if (s) {
            if (s.type === 'work') out.push('《' + (linked(s) ? '[' : ''));
            else if (adjacent.has(s)) out.push(linked(s) ? '[:zm[' : ':zm[');
            else out.push(linked(s) ? '[/' : '/');
        }
        out.push(orig);
        const e = entEnds.get(pi);
        if (e) {
            if (e.type === 'work') out.push((linked(e) ? `](${entityHref(e)})` : '') + '》');
            else if (adjacent.has(e)) out.push(linked(e) ? `]](${entityHref(e)})` : ']');
            else out.push(linked(e) ? `/](${entityHref(e)})` : '/');
        }
        for (const p of here) if (p.pos === 'after') (p.kind === 'break' ? pendingBreaks : out).push(p.mark);
        pi += 1;
    }
    flushMarks(null);
    return out.join('') + '\n';
}

/* ── 文件开头的元数据（YAML front matter，guji-format v0.4，spec/03 §2.6） ─── */

/** 值一律写成 YAML 双引号串（转义 `\` 与 `"`），不让书名里的冒号、井号之类打断 YAML */
function yamlString(v: string): string {
    return '"' + v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n') + '"';
}

/** 键按给的次序出；值为 undefined／空串的不出 */
export function frontMatter(fields: [string, string | number | undefined | null][]): string {
    const lines = ['---'];
    for (const [k, v] of fields) {
        if (v === undefined || v === null || v === '') continue;
        lines.push(`${k}: ${typeof v === 'number' ? String(v) : yamlString(v)}`);
    }
    lines.push('---');
    return lines.join('\n') + '\n';
}
