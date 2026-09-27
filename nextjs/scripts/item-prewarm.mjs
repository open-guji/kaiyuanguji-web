#!/usr/bin/env node
/**
 * item-prewarm.mjs — 发版后预热条目页（W2-3，26 卡步骤 4、31 卡 §A.6 第 4 条）。
 *
 * 先预热本轮改动过的页（刚失效，第一个读者会撞上函数渲染），再用「热门」页补足到
 * ITEM_PREWARM_MAX（默认 2000）。热门表在访问量汇总（24 卡）出来前用「有整理本或
 * 有影像」的作品代替。注意：CDN 按节点缓存，从 CI 跑的预热只热到 CI 出口附近的节点。
 *
 * 限流：09-27 首跑（run 311）并发 16 时 2000 页里 423 页被 EdgeOne 回 429。
 * 现在默认并发 4，遇到 429／503 按 Retry-After（没有就 2、4、8 秒）退避，最多重试 3 次。
 *
 * 环境变量：ITEM_SITE、ITEM_PREWARM_MAX、ITEM_PREWARM_CONCURRENCY（默认 4）、ITEM_CHANGES_OUT
 */
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { resolveDataDirs } from './lib/data-dirs.mjs';
import { SITE, readChanges, pool, getItemPage, hotItemIds, percentile } from './lib/item-http.mjs';

const MAX = Number(process.env.ITEM_PREWARM_MAX || 2000);
const CONC = Number(process.env.ITEM_PREWARM_CONCURRENCY || 4);
const RETRIES = 3;
const { root, dataDir } = resolveDataDirs();
const changesFile = process.env.ITEM_CHANGES_OUT || join(root, 'item-changes.json');
const changed = existsSync(changesFile) ? (({ added, changed }) => [...added, ...changed])(readChanges(changesFile)) : [];

const ids = [...new Set([...changed.slice(0, MAX), ...hotItemIds(dataDir, MAX)])].slice(0, MAX);
const t0 = Date.now();
/** 取一页；被限流（429）或暂时不可用（503）就退避重试 */
async function warm(id) {
    let r;
    let attempt = 0;
    for (;;) {
        r = await getItemPage(id);
        if ((r.status !== 429 && r.status !== 503) || attempt >= RETRIES) break;
        const wait = Math.min(10, r.retryAfter || 2 ** (attempt + 1));
        await new Promise((ok) => setTimeout(ok, wait * 1000));
        attempt++;
    }
    return { ...r, retries: attempt };
}

const results = await pool(ids, CONC, warm);
const byStatus = {};
for (const r of results) byStatus[r.status] = (byStatus[r.status] || 0) + 1;
const ok = results.filter((r) => r.status === 200).map((r) => r.ms);
const retried = results.filter((r) => r.retries).length;
console.log(`预热 ${SITE}：${ids.length} 页（改动 ${Math.min(changed.length, MAX)}＋热门补足），${((Date.now() - t0) / 1000).toFixed(0)} s；`
    + `状态 ${JSON.stringify(byStatus)}；200 的耗时 p50 ${percentile(ok, 50)} ms、p90 ${percentile(ok, 90)} ms；因 429／503 重试过的 ${retried} 页`);
const limited = byStatus[429] || 0;
if (limited) console.log(`⚠️ 重试后仍有 ${limited} 页被限流（429），请再调低 ITEM_PREWARM_CONCURRENCY`);
const bad = results.filter((r) => r.status >= 500 || r.status === 0);
if (bad.length) console.log(`⚠️ ${bad.length} 页失败，前 5 个：${bad.slice(0, 5).map((r) => `${r.id}(${r.status}${r.error ? ' ' + r.error : ''})`).join('、')}`);
if (ids.length && ok.length === 0) process.exit(1);
