/**
 * proofing-smoke.mjs — 精校页读者侧冒烟（GUJI-730 P0-2，1.0 发布标准 G3c）
 *
 * 发布之后从读者那一侧看一遍：proof/index.json 里每张在线待审单都取得到、rev 与 index 一致，
 * 单子引用的每张图（格的 img.s、相似字的 alt[].g.s）都登记在 sprites[] 里、并且取得到（GET 首字节；
 * 数据域名对没进缓存的图 HEAD 回 403，GET 才回源，所以不用 HEAD）。
 * 册 004–007 的 alt-<章>.webp 一直 404 就是这样漏掉的：单子引用了，sprites[] 没登记，proofing-sync 不传。
 *
 * 连网的部分由调用方注入（单测用假的 fetch）；只出计数和文件名，不出票的内容。
 */

/** 单子引用的全部图名 */
export function spriteRefs(doc) {
    const out = new Set();
    for (const c of doc?.cells || []) {
        if (c?.img?.s) out.add(c.img.s);
        for (const x of c?.alt || []) if (x?.g?.s) out.add(x.g.s);
    }
    return out;
}

/** 引用了却没登记进 sprites[] 的图 */
export function unregistered(doc) {
    const have = new Set((doc?.sprites || []).map((e) => e.name));
    return [...spriteRefs(doc)].filter((n) => !have.has(n)).sort();
}

/**
 * @param base  数据域名根（config/hosts.json 的 data；staging 再加 /staging）
 * @param fetchFn  (url, {method, range}) → {ok, status, json()}；range=true 时只取首字节
 * @returns {{lists: number, images: number, problems: string[]}}
 */
export async function runProofingSmoke({ base, fetchFn, concurrency = 8 }) {
    const problems = [];
    const idxRes = await fetchFn(`${base}/proof/index.json`, { method: 'GET' });
    if (!idxRes.ok) return { lists: 0, images: 0, problems: [`proof/index.json ${idxRes.status}`] };
    const idx = await idxRes.json();
    const heads = [];
    let lists = 0;
    for (const [book, chaps] of Object.entries(idx.books || {})) {
        for (const [chap, meta] of Object.entries(chaps)) {
            if (!meta?.n) continue;                        // 空单（全审完）不用看
            const r = await fetchFn(`${base}/proof/${book}/${chap}.pending.json`, { method: 'GET' });
            if (!r.ok) { problems.push(`${book}/${chap}.pending.json ${r.status}`); continue; }
            const doc = await r.json();
            lists++;
            if (doc.rev !== meta.rev) problems.push(`${book}/${chap}：单子 rev ${doc.rev} ≠ index ${meta.rev}（CDN 旧缓存？）`);
            for (const n of unregistered(doc)) problems.push(`${book}/${chap}：${n} 被引用但没登记进 sprites[]`);
            for (const n of spriteRefs(doc)) heads.push([`${book}/${chap}`, `${base}/proof/${book}/${chap}/${n}`, n]);
        }
    }
    for (let i = 0; i < heads.length; i += concurrency) {
        const part = heads.slice(i, i + concurrency);
        const res = await Promise.all(part.map(([, url]) => fetchFn(url, { method: 'GET', range: true }).catch(() => ({ ok: false, status: 'ERR' }))));
        res.forEach((r, j) => { if (!r.ok) problems.push(`${part[j][0]}：${part[j][2]} ${r.status}`); });
    }
    return { lists, images: heads.length, problems };
}
