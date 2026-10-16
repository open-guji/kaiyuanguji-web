/**
 * asset-sync-plan.mjs — 印影图同步的纯计算（GUJI-544）：不联网、不读盘。
 *
 * 图仓 book-index-asset 约定「图只增不改名，换图用新序号」，所以同一路径内容变了是异常（误覆盖），
 * 这里照传（以仓为准）但单列为 changed 让工作流 WARN，并提示用 edgeone-purge-urls 刷。
 */

const FILE_RE = /^entity\/[0-9a-z]\/[0-9a-z]\/[0-9a-z]\/[0-9a-z]+\/[1-8]\.webp$/;
export const MAX_BYTES = 300 * 1024;

/** 图仓里的相对路径是否合规（只收 entity/{c1}/{c2}/{c3}/{id}/{1-8}.webp） */
export function isAssetPath(rel) {
    return FILE_RE.test(rel);
}

/**
 * @param {Map<string,{md5:string,size:number}>} local   相对路径 → 本地文件摘要
 * @param {Map<string,string>} remote                    相对路径（asset/ 之下）→ COS ETag（分块对象是 "mp:<字节数>"）
 * @returns {{ add:string[], changed:string[], same:string[], orphans:string[], rejected:{rel:string,why:string}[] }}
 */
export function planAssetSync(local, remote) {
    const out = { add: [], changed: [], same: [], orphans: [], rejected: [] };
    for (const [rel, f] of [...local].sort((a, b) => a[0].localeCompare(b[0]))) {
        if (!isAssetPath(rel)) { out.rejected.push({ rel, why: '路径不合约定' }); continue; }
        if (f.size > MAX_BYTES) { out.rejected.push({ rel, why: `超过 ${MAX_BYTES / 1024}KB（${f.size}）` }); continue; }
        const r = remote.get(rel);
        if (r === undefined) out.add.push(rel);
        else if (r.startsWith('mp:') || r === f.md5) out.same.push(rel);
        else out.changed.push(rel);
    }
    for (const rel of remote.keys()) if (!local.has(rel)) out.orphans.push(rel);
    out.orphans.sort();
    return out;
}
