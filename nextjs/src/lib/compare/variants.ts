/**
 * 异体字表。来源是 open-guji-cv 的 config/hanzi/core/edges.tsv，构建时抽成一张小表
 * `public/compare/glyph-variants.json`（见 scripts/build-glyph-variants.mjs），进对校模式才懒加载。
 * 格式：{ version, sources, pairs: "葢蓋\n畧略\n…" }，每行一对，各取一个码点。
 */

export interface VariantTable {
    version: string;
    sources: string[];
    pairs: string;
}

/** 由表建判定函数（双向）；两字相同视为同字，不在这里处理 */
export function buildVariantTest(table: Pick<VariantTable, 'pairs'>): (a: string, b: string) => boolean {
    const set = new Set<string>();
    for (const line of table.pairs.split('\n')) {
        const cp = Array.from(line);
        if (cp.length !== 2) continue;
        set.add(cp[0] + cp[1]);
        set.add(cp[1] + cp[0]);
    }
    return (a, b) => set.has(a + b);
}

let loading: Promise<((a: string, b: string) => boolean) | null> | null = null;

/** 取表并建判定函数；取不到返回 null（对校照常，只是异体字都归入「用字不同」）。只取一次 */
export function loadVariantTest(url = '/compare/glyph-variants.json'): Promise<((a: string, b: string) => boolean) | null> {
    if (!loading) {
        loading = Promise.resolve()
            .then(() => fetch(url))
            .then((r) => (r.ok ? (r.json() as Promise<VariantTable>) : null))
            .then((t) => (t && typeof t.pairs === 'string' ? buildVariantTest(t) : null))
            .catch(() => null);
        loading.then((f) => {
            if (!f) loading = null; // 失败不缓存，下次进对校再试
        });
    }
    return loading;
}
