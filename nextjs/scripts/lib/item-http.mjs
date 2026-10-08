/**
 * item-http.mjs — 发版后对站点发请求的小工具（W2-3：失效、预热、实测共用）。
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

export const SITE = (process.env.ITEM_SITE || 'https://staging.kaiyuanguji.com').replace(/\/$/, '');

/** 读 item-changes.mjs 的输出 */
export function readChanges(path) {
    if (!existsSync(path)) throw new Error(`没有改动集文件 ${path}（先跑 item-changes.mjs）`);
    return JSON.parse(readFileSync(path, 'utf-8'));
}

/** 并发池：items 逐个交给 fn，最多 n 个同时在跑 */
export async function pool(items, n, fn) {
    const out = new Array(items.length);
    let i = 0;
    await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
        while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); }
    }));
    return out;
}

/** GET 一个条目页，返回状态、耗时、CDN 缓存状态和页面里的 data-ssr-version */
export async function getItemPage(id, { timeoutMs = 30_000 } = {}) {
    const t0 = Date.now();
    try {
        const res = await fetch(`${SITE}/item/${id}`, { redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
        const html = res.status === 200 ? await res.text() : '';
        const m = html.match(/data-ssr-version="([^"]*)"/);
        const ra = Number(res.headers.get('retry-after'));
        return {
            id, status: res.status, ms: Date.now() - t0,
            cache: res.headers.get('eo-cache-status') || '',
            version: m ? m[1] : null,
            retryAfter: Number.isFinite(ra) && ra > 0 ? ra : null,
        };
    } catch (err) {
        return { id, status: 0, ms: Date.now() - t0, cache: '', version: null, error: err.message };
    }
}

/**
 * 预热用的「热门」条目：访问量数据（24 卡）还没有汇总前，按 26 卡的约定先用
 * 「有整理本或有影像」的作品代替。读 bundle 产物 data/entry/*.json。
 */
export function hotItemIds(dataDir, limit) {
    const dir = join(dataDir, 'entry');
    if (!existsSync(dir)) return [];
    const picked = [];
    for (const f of readdirSync(dir).sort()) {
        if (picked.length >= limit) break;
        if (!f.endsWith('.json')) continue;
        try {
            const e = JSON.parse(readFileSync(join(dir, f), 'utf-8'));
            if (e.merged_into) continue;
            if (e.type === 'work' && (e.has_text || e._has_text || e.has_image || e._has_image)) picked.push(e.id);
        } catch { /* 坏文件跳过 */ }
    }
    return picked;
}

/**
 * 缓存实测用的对照页候选：环境变量 ITEM_CONTROL_IDS（逗号分隔，数据流程的 refresh 任务用——它没有本地打包产物，
 * 候选由 package 任务在有产物的地方挑好、随工件带过来）优先；没设就读本地产物（部署流程里）。
 */
export function controlItemIds(dataDir, limit, env = process.env) {
    const given = String(env.ITEM_CONTROL_IDS || '').split(',').map((x) => x.trim()).filter(Boolean);
    return given.length ? given.slice(0, limit) : hotItemIds(dataDir, limit);
}

export function percentile(values, p) {
    if (!values.length) return 0;
    const s = [...values].sort((a, b) => a - b);
    return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
}
