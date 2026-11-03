/**
 * production-dir.mjs — 打包脚本对正式仓 book-index 的前置检查。
 *
 * 网站只打包正式仓 book-index（overview#432 起不再打包草稿仓 book-index-draft）。
 * 缺了正式仓就什么条目都没有，必须报错退出，不能静默打出一份空站。
 * 站点内容文件（资源页、首页推荐位、升格跳转表）也在 book-index 根目录，缺了同样是数据出错。
 */

import { existsSync } from 'fs';
import { join } from 'path';
import { indexDirFor } from './derived.mjs';
import { hasPromotionsSource, PROMOTIONS_DIRNAME, PROMOTIONS_FILENAME } from './promotions-source.mjs';

/**
 * book-index 根目录里网站要带上的站点内容文件。
 * 其中 promotions.json 有两种源形状（整档，或 bim#139 的 promotions/<末2位>.json 分片，见 promotions-source.mjs）：
 * 产物里仍是一份整档，但源档在不在由 hasPromotionsSource 判，不是这里的 existsSync。
 */
export const SITE_CONTENT_FILES = [
    'resource.json',
    'resource-catalog.json',
    'resource-collection.json',
    'resource-site.json',
    'recommended.json',
    'promotions.json',
];

/** 正式仓不存在、或没有检索索引 index/ 时抛错。index/ 取 build 产物的（仓内 index/ 将删，见 indexDirFor），不要求仓内有 */
export function assertProductionDir(dir) {
    if (!existsSync(dir)) {
        throw new Error(`book-index（正式仓）目录不存在：${dir}\n   请设置 BOOK_INDEX_PRODUCTION_DIR，或把仓克隆到默认位置`);
    }
    const idx = indexDirFor(dir);
    if (!existsSync(idx)) {
        throw new Error(`book-index（正式仓）没有可用的 index/（产物与仓内都没有）：${idx}`);
    }
}

/** 站点内容文件有缺就抛错，列出缺哪几个 */
export function assertSiteContentFiles(dir) {
    const missing = SITE_CONTENT_FILES.filter((f) => (f === PROMOTIONS_FILENAME ? !hasPromotionsSource(dir) : !existsSync(join(dir, f))))
        .map((f) => (f === PROMOTIONS_FILENAME ? `${f}（或 ${PROMOTIONS_DIRNAME}/ 分片目录）` : f));
    if (missing.length > 0) {
        throw new Error(`book-index（正式仓）根目录缺站点内容文件：${missing.join('、')}（${dir}）`);
    }
}
