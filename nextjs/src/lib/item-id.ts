/**
 * 条目 id 解析（与 book-index-ui 的 id 编码同一套，这里只取 status 与 type 两段）。
 *
 * 单独写一份而不 import book-index-ui：中间件跑在边缘运行时，每个请求都执行，
 * 不能为两个位段拉进整个 UI 包。编码：base36 → 64 位整数，
 *   第 62 位 status（0 正式、1 草稿），第 59–61 位 type（0 book、2 collection、3 work、4 entity）。
 */
export type ItemStatus = 'official' | 'draft';
export type ItemType = 'book' | 'collection' | 'work' | 'entity';

const TYPES: Record<number, ItemType> = { 0: 'book', 2: 'collection', 3: 'work', 4: 'entity' };

/** 条目 id 形态：base36 小写字母数字。挡掉路径穿越与明显无效的请求 */
export function isValidItemId(id: string): boolean {
    return /^[0-9a-z]{6,20}$/.test(id);
}

// tsconfig 目标低于 ES2020，不能写 BigInt 字面量（123n），一律用 BigInt(...)
const B36 = BigInt(36);
const LIMIT = BigInt(2) ** BigInt(63);
const SHIFT_STATUS = BigInt(62);
const SHIFT_TYPE = BigInt(59);
const ONE = BigInt(1);
const SEVEN = BigInt(7);

export function parseItemId(id: string): { status: ItemStatus; type: ItemType } | null {
    if (!isValidItemId(id)) return null;
    let v = BigInt(0);
    for (const c of id) v = v * B36 + BigInt(parseInt(c, 36));
    if (v >= LIMIT) return null;
    const type = TYPES[Number((v >> SHIFT_TYPE) & SEVEN)];
    if (!type) return null;
    return { status: ((v >> SHIFT_STATUS) & ONE) === ONE ? 'draft' : 'official', type };
}
