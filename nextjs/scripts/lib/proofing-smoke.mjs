/**
 * proofing-smoke.mjs — 精校页读者侧冒烟（GUJI-730 P0-2，1.0 发布标准 G3c）
 *
 * 发布之后从读者那一侧看一遍：proof/index.json 里每个有待审格的章，网站 /api/pending 都取得到（待审格由条目现拼，没有 rev），
 * 单子引用的每张图（格的 img.s、相似字的 alt[].g.s）都取得到（GET 首字节；数据域名对没进缓存的图 HEAD 回 403，GET 才回源，所以不用 HEAD）。
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

/**
 * @param base  数据域名根（config/hosts.json 的 data；staging 再加 /staging）：读 proof/index.json 与单格图
 * @param site  网站根：读 /api/pending?book=&vol=（条目现拼的待审格）
 * @param fetchFn  (url, {method, range}) → {ok, status, json()}；range=true 时只取首字节
 * @param only  可选 (entry{book,chap}) → boolean；给了就只对所指章节做完整检查（取单子＋全部图），
 *              别的章节只看单子取不取得到，有问题进 warnings，不算失败
 * @returns {{lists: number, images: number, problems: string[], warnings: string[]}}
 */
export async function runProofingSmoke({ base, site, fetchFn, concurrency = 8, only = null }) {
    const problems = [];
    const warnings = [];
    const idxRes = await fetchFn(`${base}/proof/index.json`, { method: 'GET' });
    if (!idxRes.ok) return { lists: 0, images: 0, problems: [`proof/index.json ${idxRes.status}`], warnings };
    const idx = await idxRes.json();
    const heads = [];
    let lists = 0;
    // 11-28：/api/pending 改成由条目现拼（每次查中心库）后，原来一章一章串行取，整册检查超过 15 分钟被取消（11-26 起每趟都被取消、没人告警）。
    // 先把要看的章列出来，再按 concurrency 并发取单子；结果仍按章序合并，输出与串行时一致。
    const chaps = [];
    for (const [book, cs] of Object.entries(idx.books || {})) {
        for (const [chap, meta] of Object.entries(cs)) {
            if (meta?.n) chaps.push({ book, chap });       // 空章（全审完）不用看
        }
    }
    const fetched = new Array(chaps.length);
    for (let i = 0; i < chaps.length; i += concurrency) {
        await Promise.all(chaps.slice(i, i + concurrency).map(async ({ book, chap }, j) => {
            const r = await fetchFn(`${site}/api/pending?${new URLSearchParams({ book, vol: chap })}`, { method: 'GET' }).catch(() => ({ ok: false, status: 'ERR' }));
            fetched[i + j] = { r, doc: r.ok ? await r.json() : null };
        }));
    }
    for (const [k, { book, chap }] of chaps.entries()) {
        const inScope = !only || only({ book, chap });
        const bad = inScope ? problems : warnings;         // 范围外的章节只告警
        const { r, doc } = fetched[k];
        if (!r.ok) { bad.push(`${book}/${chap} 待审格 ${r.status}`); continue; }
        lists++;
        if (!inScope) continue;                            // 范围外不查图，省掉上千次请求
        for (const n of spriteRefs(doc)) heads.push([`${book}/${chap}`, `${base}/proof/${book}/${chap}/${n}`, n]);
    }
    for (let i = 0; i < heads.length; i += concurrency) {
        const part = heads.slice(i, i + concurrency);
        const res = await Promise.all(part.map(([, url]) => fetchFn(url, { method: 'GET', range: true }).catch(() => ({ ok: false, status: 'ERR' }))));
        res.forEach((r, j) => { if (!r.ok) problems.push(`${part[j][0]}：${part[j][2]} ${r.status}`); });
    }
    return { lists, images: heads.length, problems, warnings };
}
