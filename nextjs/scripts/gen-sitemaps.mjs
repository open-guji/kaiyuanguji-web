#!/usr/bin/env node
/**
 * gen-sitemaps.mjs — 条目页 sitemap 分片（W2-3，31 卡 §A.7；原型见 D2 样本 gen-sitemaps.mjs）。
 *
 * 读 bundle-data.mjs 的产物 data/entry/*.json，写：
 *   <OUT>/sitemap-index.xml              索引：静态页 /sitemap.xml ＋ 各条目分片
 *   <OUT>/sitemaps/<类型>-NNN.xml         work／book／collection／entity 各自切片
 *   <OUT>/sitemaps/nodes-001.xml        总目 /catalog?node= 与阅读首页 /read?node= 的分类节点页（overview#280 S3；
 *                                       读 catalog/tree.json、read/tree.json，缺哪份就不列哪份）
 * 每片 ≤ 50,000 条（取 Google 50 MB 与百度 10 MB 的较严者，实测最大片约 4.9 MB）；
 * lastmod 取 updated_at／revised_at；被并条目（merged_into，SSR 端 308）不收。
 * 按类型分片，便于在站长平台按类型看收录；百度不认 sitemap 索引，要逐片提交（§A.7）。
 *
 * 只在全栈构建（测试站，将来 W2b 的正式站）之前跑，写进 nextjs/public/ 随产物发布；
 * 正式站静态导出那一支不跑，产物不变。测试站 robots.txt 全禁、也不列 sitemap。
 *
 * 闸：条目数低于 SITEMAP_MIN_URLS（默认 100000）就失败——宁可构建红，不许静默发一个空 sitemap。
 * 另核「收入条数 + 跳过的被并条目 = entry 文件数」，对不上也失败。
 *
 * 环境变量：SITEMAP_SITE（默认 NEXT_PUBLIC_SITE_URL）、SITEMAP_OUT_DIR（默认 nextjs/public）、
 *           SITEMAP_PER_SHARD、SITEMAP_MIN_URLS、KYG_DATA_ROOT（同 bundle-data）
 */
import { readdirSync, readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveDataDirs } from './lib/data-dirs.mjs';
import { nodePagePaths } from './lib/sitemap-nodes.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SITE = (process.env.SITEMAP_SITE || process.env.NEXT_PUBLIC_SITE_URL || 'https://www.kaiyuanguji.com').replace(/\/$/, '');
const OUT = process.env.SITEMAP_OUT_DIR || join(__dirname, '..', 'public');
const PER = Number(process.env.SITEMAP_PER_SHARD || 50000);
const MIN = Number(process.env.SITEMAP_MIN_URLS || 100000);
const TYPES = ['work', 'book', 'collection', 'entity'];

const { dataDir } = resolveDataDirs();
const entryDir = join(dataDir, 'entry');
const t0 = Date.now();

const byType = Object.fromEntries(TYPES.map((t) => [t, []]));
const skipped = { merged: 0, bad: 0, otherType: 0 };
let files = 0;
for (const f of readdirSync(entryDir)) {
    if (!f.endsWith('.json')) continue;
    files++;
    let e;
    try { e = JSON.parse(readFileSync(join(entryDir, f), 'utf-8')); } catch { skipped.bad++; continue; }
    if (e.merged_into) { skipped.merged++; continue; }
    if (!byType[e.type] || !/^[0-9a-z]{6,20}$/.test(e.id || '')) { skipped.otherType++; continue; }
    byType[e.type].push([e.id, String(e.updated_at || e.revised_at || '').slice(0, 10)]);
}

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
const shardDir = join(OUT, 'sitemaps');
if (existsSync(shardDir)) rmSync(shardDir, { recursive: true });
mkdirSync(shardDir, { recursive: true });

const shards = [];
let nodeShard = null;
for (const type of TYPES) {
    const list = byType[type].sort((a, b) => (a[0] < b[0] ? -1 : 1));
    for (let i = 0; i < list.length; i += PER) {
        const name = `sitemaps/${type}-${String(i / PER + 1).padStart(3, '0')}.xml`;
        const body = list.slice(i, i + PER)
            .map(([id, lm]) => `<url><loc>${esc(`${SITE}/item/${id}`)}</loc>${/^\d{4}-\d{2}-\d{2}$/.test(lm) ? `<lastmod>${lm}</lastmod>` : ''}</url>`)
            .join('\n');
        const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${body}\n</urlset>\n`;
        writeFileSync(join(OUT, name), xml);
        shards.push({ name, urls: Math.min(PER, list.length - i), bytes: Buffer.byteLength(xml) });
    }
}

// 总目与阅读首页的分类节点页（S3）。不进下面「收入＋被并＝entry 文件数」的核对，也不算 MIN 闸
const readTree = (name) => {
    const p = join(dataDir, name, 'tree.json');
    if (!existsSync(p)) return null;
    try { return JSON.parse(readFileSync(p, 'utf-8')); } catch { return null; }
};
const nodePaths = nodePagePaths({ catalog: readTree('catalog'), read: readTree('read') });
if (nodePaths.length) {
    const name = 'sitemaps/nodes-001.xml';
    const body = nodePaths.map((p) => `<url><loc>${esc(`${SITE}${p}`)}</loc></url>`).join('\n');
    const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${body}\n</urlset>\n`;
    writeFileSync(join(OUT, name), xml);
    nodeShard = { name, urls: nodePaths.length, bytes: Buffer.byteLength(xml) };
}

const today = new Date().toISOString().slice(0, 10);
const index = ['sitemap.xml', ...shards.map((s) => s.name), ...(nodeShard ? [nodeShard.name] : [])]
    .map((n) => `<sitemap><loc>${SITE}/${n}</loc><lastmod>${today}</lastmod></sitemap>`).join('\n');
writeFileSync(join(OUT, 'sitemap-index.xml'),
    `<?xml version="1.0" encoding="UTF-8"?>\n<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${index}\n</sitemapindex>\n`);

const total = shards.reduce((n, s) => n + s.urls, 0);
const report = {
    site: SITE, entryFiles: files, urls: total, skipped,
    byType: Object.fromEntries(TYPES.map((t) => [t, byType[t].length])),
    nodePages: nodeShard ? nodeShard.urls : 0,
    shards: shards.length, maxShardBytes: Math.max(0, ...shards.map((s) => s.bytes)), ms: Date.now() - t0,
};
console.log(`sitemap：${JSON.stringify(report)}`);
if (total + skipped.merged !== files) {
    console.error(`❌ 收入 ${total} ＋ 被并 ${skipped.merged} ≠ entry 文件 ${files}（坏文件 ${skipped.bad}、类型不认识 ${skipped.otherType}）`);
    process.exit(1);
}
if (total < MIN) {
    console.error(`❌ sitemap 只有 ${total} 条，低于阈值 ${MIN}——数据没打包进来？`);
    process.exit(1);
}
