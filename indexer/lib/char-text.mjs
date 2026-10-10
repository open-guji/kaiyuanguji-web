/**
 * 自校文本（kind=self_collated）的章正文：`NNN.char.json`（guji-format v0.1 char）→ 纯字符串，给 juans 全文索引用。
 *
 * 格式见 book-text `docs/ORIGINAL.md`、guji-format spec/02：`pages[].columns[].cells[] = { a, c, lacuna?, … }`，
 * 数组顺序就是读序（夹注 a 右列先读、b 左列后读），所以不排序、不按 key 重排。
 * 版心列（`kind: 'banxin'`）、空白列（`kind: 'blank'`）和阙文格（`lacuna: true`，c 只是占位）不进索引文本。
 * 取的是**原字**（char.json 的 c），不套 `norm`（通行字）——精确检索要原字，norm 是另一层（overview#525）。
 */

export const CHAR_FILE_RE = /^[0-9A-Za-z_-]+\.char\.json$/;

/** char.json（已 parse 的对象）→ 章正文；结构不对返回 ''。 */
export function charJsonText(raw) {
    const pages = raw && typeof raw === 'object' && Array.isArray(raw.pages) ? raw.pages : [];
    const out = [];
    for (const pg of pages) {
        const cols = pg && Array.isArray(pg.columns) ? pg.columns : [];
        for (const col of cols) {
            if (!col || col.kind === 'banxin' || col.kind === 'blank') continue;
            const cells = Array.isArray(col.cells) ? col.cells : [];
            for (const cell of cells) {
                if (!cell || cell.lacuna === true) continue;
                if (typeof cell.c === 'string' && cell.c) out.push(cell.c);
            }
        }
    }
    return out.join('');
}
