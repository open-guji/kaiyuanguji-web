/**
 * promotions-source.mjs — 读正式仓 book-index 的升格对照表源档（overview#458，bim#139 的分片形）。
 *
 * 源档有两种形状，打包要都认：
 *   · 整档  <book-index>/promotions.json                 { version: 1, promotions: { 草稿id: 记录 } }
 *   · 分片  <book-index>/promotions/<草稿id末2位>.json   每片形状同整档
 * 与 bim（book_index_manager/promotion.py 的 load_all_raw）同一套合流规矩：先整档、再各分片（按文件名排序），
 * 同键后者覆盖前者＝分片优先。两种形状同时存在（迁移过渡期）时取并集。
 *
 * 产物形状不变：打包写出的 current/promotions.json 一律是「key 字典序、indent 2、档尾换行」的整档
 * （与 bim 的 _write_promotions_file 同格式），所以同一份对照表无论源档是哪种形状，打出的字节相同；
 * 客户端兜底路径、h1 的 PH 分片（lib/h1-promotions.mjs）都吃这份产物，不用改。
 *
 * 源档读不了（不是合法 JSON）要让构建失败：静默跳过会让一批草稿 id 的跳转悄悄失效。
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';

export const PROMOTIONS_FILENAME = 'promotions.json';
export const PROMOTIONS_DIRNAME = 'promotions';
/** 与 bim 的 PROMOTIONS_VERSION、src/lib/promotions.ts 的 buildPromotionMap 一致 */
export const PROMOTIONS_VERSION = 1;

function isFile(p) {
    try { return statSync(p).isFile(); } catch { return false; }
}
function isDir(p) {
    try { return statSync(p).isDirectory(); } catch { return false; }
}

/** 有没有对照表源档：整档在，或 promotions/ 目录在（bim 以目录存在为分片形，目录可以暂时为空）。 */
export function hasPromotionsSource(dir) {
    return isFile(join(dir, PROMOTIONS_FILENAME)) || isDir(join(dir, PROMOTIONS_DIRNAME));
}

/** 全部源档路径：整档（若在）＋各分片（按文件名排序）。 */
export function promotionSourceFiles(dir) {
    const out = [];
    const legacy = join(dir, PROMOTIONS_FILENAME);
    if (isFile(legacy)) out.push(legacy);
    const d = join(dir, PROMOTIONS_DIRNAME);
    if (isDir(d)) {
        const names = readdirSync(d).filter((n) => n.endsWith('.json') && isFile(join(d, n))).sort();
        for (const n of names) out.push(join(d, n));
    }
    return out;
}

function readOne(path) {
    let data;
    try {
        data = JSON.parse(readFileSync(path, 'utf-8'));
    } catch (e) {
        throw new Error(`升格对照表源档读不了：${path}（${e.message}）`);
    }
    const p = data && typeof data === 'object' ? data.promotions : undefined;
    const rows = p && typeof p === 'object' && !Array.isArray(p) ? p : {};
    // 下游读者（src/lib/promotions.ts、lib/h1-promotions.mjs）只认 version 1，别的版本整表丢弃。
    // 我们合流后会把产物标成 version 1，所以遇到别的版本又带着记录要在这里拦下，不能悄悄放行（bim 读档不看版本）。
    if (Object.keys(rows).length > 0 && data.version !== PROMOTIONS_VERSION) {
        throw new Error(`升格对照表源档版本不是 ${PROMOTIONS_VERSION}（${String(data.version)}）：${path}`);
    }
    return rows;
}

/**
 * 合流读出 { version: 1, promotions: { 草稿id: 记录 } }（key 字典序）。
 * 整档、分片都没有 → 抛错（调用方一般先 assertSiteContentFiles 过了）。
 */
export function readPromotionsSource(dir) {
    const files = promotionSourceFiles(dir);
    if (files.length === 0 && !hasPromotionsSource(dir)) {
        throw new Error(`book-index 里没有升格对照表（${join(dir, PROMOTIONS_FILENAME)} 或 ${join(dir, PROMOTIONS_DIRNAME)}/）`);
    }
    const merged = {};
    for (const f of files) Object.assign(merged, readOne(f));
    const promotions = {};
    for (const k of Object.keys(merged).sort()) promotions[k] = merged[k];
    return { version: PROMOTIONS_VERSION, promotions };
}

/** 产物文本：indent 2、档尾换行（与 bim 写盘同格式）。 */
export function serializePromotions(table) {
    return JSON.stringify(table, null, 2) + '\n';
}

/** 读源档（任一形状）并给出要写进产物的整档文本。 */
export function buildPromotionsFileText(dir) {
    return serializePromotions(readPromotionsSource(dir));
}
