/**
 * 千本级作品的版本分组分页（book-index build_derived 契约 5，book-index#2262）：
 * 产物 `books/<wid>/<g>/<n>.json`（g＝叢編 id，无叢編为 `_none`；每页 200 张 Book 卡）
 * 原样拷到数据包 `book-groups/<wid>/<g>/<n>.json`，读者端由 cos-storage 的 getBookGroupPage 取。
 * 现在 Work 仍带全量 `_books`，版本表用不到这些分页；等 `_books` 去掉后才用得上。
 * 产物里没有的旧文件一并删掉；产物没有 books/ 目录时整个 book-groups/ 删掉。
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from 'fs';
import { join } from 'path';

export const BOOK_GROUPS_DIRNAME = 'book-groups';

const SAFE = /^[\w-]+$/;

function walk(dir, out = []) {
    for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walk(p, out); else out.push(p);
    }
    return out;
}

/** 同步分页文件；返回 { works, files, written, removed }。srcDir 为 null／不存在时清空目标。 */
export function syncBookGroupPages(srcDir, destDir) {
    const stats = { works: 0, files: 0, written: 0, removed: 0 };
    if (!srcDir || !existsSync(srcDir)) {
        if (existsSync(destDir)) {
            stats.removed = walk(destDir).length;
            rmSync(destDir, { recursive: true, force: true });
        }
        return stats;
    }
    const want = new Set();
    for (const wid of readdirSync(srcDir)) {
        if (!SAFE.test(wid) || !statSync(join(srcDir, wid)).isDirectory()) continue;
        stats.works++;
        for (const g of readdirSync(join(srcDir, wid))) {
            if (!SAFE.test(g) || !statSync(join(srcDir, wid, g)).isDirectory()) continue;
            for (const f of readdirSync(join(srcDir, wid, g))) {
                if (!/^[1-9]\d*\.json$/.test(f)) continue;
                const data = readFileSync(join(srcDir, wid, g, f));
                if (!Array.isArray(JSON.parse(data.toString('utf-8')))) {
                    throw new Error(`books/${wid}/${g}/${f} 不是 Book 卡数组`);
                }
                const dest = join(destDir, wid, g, f);
                want.add(dest);
                stats.files++;
                if (existsSync(dest) && readFileSync(dest).equals(data)) continue;
                mkdirSync(join(destDir, wid, g), { recursive: true });
                writeFileSync(dest, data);
                stats.written++;
            }
        }
    }
    if (existsSync(destDir)) {
        for (const p of walk(destDir)) {
            if (!want.has(p)) { unlinkSync(p); stats.removed++; }
        }
        // 删空目录（自底向上）
        const dirs = [];
        (function collect(d) { for (const n of readdirSync(d)) { const p = join(d, n); if (statSync(p).isDirectory()) { collect(p); dirs.push(p); } } })(destDir);
        for (const d of dirs) if (readdirSync(d).length === 0) rmSync(d, { recursive: true });
    }
    return stats;
}

export function bookGroupPagePath(wid, g, n) {
    return `${BOOK_GROUPS_DIRNAME}/${wid}/${g}/${n}.json`;
}
