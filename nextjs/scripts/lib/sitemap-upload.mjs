/**
 * 条目 sitemap 上传到数据前缀（overview#470 P1，设计 §1「sitemap」；路由代理见 src/lib/server/sitemap-proxy.ts）。
 *
 * gen-sitemaps.mjs 把 sitemap 写成：
 *   <dir>/sitemap-index.xml          索引
 *   <dir>/sitemaps/<名>.xml           work／book／collection／entity 分片与 nodes-001
 * 这里把它们传到 `<前缀>/sitemaps/<名>.xml`（索引传到 `<前缀>/sitemaps/sitemap-index.xml`），站点的路由代理从这里取。
 *
 * 纯逻辑，COS 访问由调用方注入（backend），单测用内存后端。要点：
 *   · 先传分片、**索引最后传**——索引一换，读到的就是完整的一版，不会出现"索引列了还没传上去的分片"；
 *   · 传之前检查：名字必须在路由代理的白名单里（不在白名单的传上去也没人读，说明生成端出了问题）；
 *     索引里列的每个分片文件都在；所有 <loc> 都是正式站地址（数据前缀里只存一份、读的时候再换成本站）；
 *     每个文件以 </urlset> 或 </sitemapindex> 收尾（挡截断）；
 *   · 传完回读索引核对字节数；
 *   · 最后清掉前缀下已经不在这一版里的旧分片（只动名字合规的 .xml；清理失败只警告）。
 */
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

/** 数据前缀里存的 sitemap 用的站点地址；与 sitemap-proxy.ts 的 STORED_SITE 相同（单测比对） */
export const STORED_SITE = 'https://www.kaiyuanguji.com';

/** 路由代理允许的名字；与 sitemap-proxy.ts 的 NAME_RE 相同（单测比对源文件） */
export const NAME_RE = /^(?:sitemap-index|(?:work|book|collection|entity)-\d{3,}|nodes-001)$/;

export const CONTENT_TYPE = 'application/xml; charset=utf-8';
/** 数据前缀里的缓存头；站点路由再给边缘加 s-maxage（一小时） */
export const CACHE_CONTROL = 'public, max-age=300';

export function sitemapKey(prefix, name) {
    const p = String(prefix || '').replace(/^\/+|\/+$/g, '');
    return `${p ? `${p}/` : ''}sitemaps/${name}.xml`;
}

/** 看目录，返回 { shards: [{name, file}], index: {name, file}, errors: [] }，不碰网络 */
export function planSitemaps(dir) {
    const errors = [];
    const shards = [];
    const shardDir = join(dir, 'sitemaps');
    if (existsSync(shardDir)) {
        for (const f of readdirSync(shardDir).sort()) {
            if (!f.endsWith('.xml')) continue;
            const name = f.slice(0, -4);
            if (!NAME_RE.test(name) || name === 'sitemap-index') { errors.push(`分片名不在路由代理的白名单里：sitemaps/${f}`); continue; }
            shards.push({ name, file: join(shardDir, f) });
        }
    } else {
        errors.push(`没有 ${shardDir}`);
    }
    const indexFile = join(dir, 'sitemap-index.xml');
    if (!existsSync(indexFile)) errors.push(`没有 ${indexFile}`);
    if (!shards.length) errors.push('没有任何分片');
    return { shards, index: { name: 'sitemap-index', file: indexFile }, errors };
}

/** 检查内容；返回错误列表（空＝通过）。texts: { [name]: xml } 含 'sitemap-index' */
export function checkSitemaps(plan, texts, site = STORED_SITE) {
    const errors = [];
    const base = site.replace(/\/$/, '');
    for (const [name, xml] of Object.entries(texts)) {
        const want = name === 'sitemap-index' ? 'sitemapindex' : 'urlset';
        if (!xml.trimStart().startsWith('<?xml')) errors.push(`${name}：不是 XML`);
        if (!new RegExp(`</${want}>\\s*$`).test(xml)) errors.push(`${name}：没有以 </${want}> 收尾（截断或不是 sitemap）`);
        for (const m of xml.matchAll(/<loc>([^<]*)<\/loc>/g)) {
            if (!m[1].startsWith(`${base}/`)) { errors.push(`${name}：<loc> 不是正式站地址（${m[1].slice(0, 80)}）`); break; }
        }
    }
    const idx = texts['sitemap-index'];
    if (idx) {
        const have = new Set(plan.shards.map((s) => s.name));
        const listed = [...idx.matchAll(/<loc>([^<]*)<\/loc>/g)].map((m) => m[1].slice(base.length + 1));
        for (const p of listed) {
            const m = p.match(/^sitemaps\/([^/]+)\.xml$/);
            if (p === 'sitemap.xml') continue;               // 静态页那一片由站点自己出，不走代理
            if (!m) { errors.push(`sitemap-index：不认识的地址 ${p}`); continue; }
            if (!have.has(m[1])) errors.push(`sitemap-index 列了 ${p}，但目录里没有这个分片`);
        }
        const listedNames = new Set(listed.map((p) => (p.match(/^sitemaps\/([^/]+)\.xml$/) || [])[1]).filter(Boolean));
        for (const s of plan.shards) if (!listedNames.has(s.name)) errors.push(`分片 ${s.name} 不在索引里（传上去也没人引用）`);
    }
    return errors;
}

/**
 * 传。backend: { put(key, body, { contentType, cacheControl }), get(key) → Buffer|null, list(prefix) → string[], del(keys) }
 * 返回 { uploaded, bytes, pruned, warnings }；检查不过或传失败抛错。dryRun 只检查、不动 backend。
 */
export async function publishSitemaps({ dir, prefix = '', backend, site = STORED_SITE, dryRun = false, log = () => {}, concurrency = 4, retryDelayMs = 2000 }) {
    const plan = planSitemaps(dir);
    const texts = {};
    if (!plan.errors.length) {
        for (const s of plan.shards) texts[s.name] = readFileSync(s.file, 'utf-8');
        texts[plan.index.name] = readFileSync(plan.index.file, 'utf-8');
    }
    const errors = [...plan.errors, ...(plan.errors.length ? [] : checkSitemaps(plan, texts, site))];
    if (errors.length) throw new Error(`sitemap 检查没过：\n  - ${errors.join('\n  - ')}`);
    const total = plan.shards.length + 1;
    const bytes = Object.values(texts).reduce((n, t) => n + Buffer.byteLength(t), 0);
    log(`sitemap：${plan.shards.length} 个分片＋索引，共 ${(bytes / 1048576).toFixed(1)} MB，目标前缀 ${prefix || '（根）'}${dryRun ? '（dry-run，不上传）' : ''}`);
    if (dryRun) return { uploaded: 0, bytes, pruned: 0, warnings: [], planned: total };

    const meta = { contentType: CONTENT_TYPE, cacheControl: CACHE_CONTROL };
    // 分片并发传，全部成功后才传索引
    const queue = [...plan.shards];
    const workers = Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
        for (let s = queue.shift(); s; s = queue.shift()) {
            await withRetry(() => backend.put(sitemapKey(prefix, s.name), Buffer.from(texts[s.name], 'utf-8'), meta), `传 ${s.name}`, log, retryDelayMs);
        }
    });
    await Promise.all(workers);
    const idxKey = sitemapKey(prefix, 'sitemap-index');
    await withRetry(() => backend.put(idxKey, Buffer.from(texts['sitemap-index'], 'utf-8'), meta), '传 sitemap-index', log, retryDelayMs);

    // 回读索引核对
    const back = await backend.get(idxKey);
    const want = Buffer.byteLength(texts['sitemap-index']);
    if (!back || back.length !== want) throw new Error(`回读 ${idxKey} 不一致：期望 ${want} 字节，读到 ${back ? back.length : '（空）'}`);

    // 清旧分片（只动合规的名字；失败只警告）
    const warnings = [];
    let pruned = 0;
    try {
        const keep = new Set([...plan.shards.map((s) => sitemapKey(prefix, s.name)), idxKey]);
        const dirPrefix = sitemapKey(prefix, 'x').slice(0, -'x.xml'.length);
        const stale = (await backend.list(dirPrefix)).filter((k) => !keep.has(k) && NAME_RE.test(k.slice(dirPrefix.length).replace(/\.xml$/, '')) && k.endsWith('.xml'));
        if (stale.length) { await backend.del(stale); pruned = stale.length; log(`清理旧分片 ${stale.length} 个：${stale.slice(0, 5).join(', ')}${stale.length > 5 ? ' …' : ''}`); }
    } catch (e) {
        warnings.push(`清理旧分片失败（下次再试）：${e && e.message}`);
        log(`::warning::${warnings[warnings.length - 1]}`);
    }
    return { uploaded: total, bytes, pruned, warnings };
}

async function withRetry(fn, what, log, delayMs, tries = 3) {
    for (let i = 1; ; i++) {
        try { return await fn(); } catch (e) {
            if (i >= tries) throw new Error(`${what}失败（重试 ${tries} 次）：${e && e.message}`);
            log(`· ${what}失败（${e && e.message}），${(i * delayMs) / 1000} 秒后重试`);
            await new Promise((r) => setTimeout(r, i * delayMs));
        }
    }
}
