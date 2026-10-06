/**
 * Phase 5 全文搜索原型 v2：Pagefind 仅索引整理本正文
 *
 * 策略：
 *   - 索引侧：所有正文 → OpenCC t2s 归一化为简体后存入 Pagefind
 *   - 查询侧（在前端）：用户查询同样 t2s 归一化
 *   - 显示侧：fragment meta 里保留原始繁体文本，UI 展示原貌
 *   - 一对多歧义最小（繁→简通常是 1:1）；不影响繁体阅读
 *
 * 输出：public/data/pagefind-fulltext/
 *
 * 只认新结构（overview#307）：条目目录有 manifest.json 的，从文本仓（BOOK_TEXT_DIR，默认 ../../../book-text）取
 * kind=collated 的公开版本的章 JSON，链接指向 /read/<id>[/<key>]/<章>。internal 版本不索引。
 *
 * 用法：
 *   node scripts/build-pagefind-fulltext.mjs [book-index-dir]
 */

import { readFileSync, existsSync, readdirSync, statSync, rmSync } from 'fs';
import { join, resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { resolveDataDirs } from './lib/data-dirs.mjs';
import { collatedChapterJsons, readManifest } from './lib/text-layout.mjs';
import * as pagefind from 'pagefind';
import { Converter } from 'opencc-js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PRODUCTION_DIR = resolve(process.argv[2] || process.env.BOOK_INDEX_PRODUCTION_DIR || join(__dirname, '..', '..', '..', 'book-index'));
const OUT_DIR = join(resolveDataDirs().dataDir, 'pagefind-fulltext');

const TEXT_DIR = resolve(process.env.BOOK_TEXT_DIR || join(__dirname, '..', '..', '..', 'book-text'));

if (!existsSync(PRODUCTION_DIR)) {
    console.error(`❌ book-index（正式仓）not found: ${PRODUCTION_DIR}`);
    process.exit(1);
}

console.log(`build-pagefind-fulltext: ${PRODUCTION_DIR}`);
console.log(`output:                  ${OUT_DIR}\n`);

if (existsSync(OUT_DIR)) rmSync(OUT_DIR, { recursive: true });

const t2s = Converter({ from: 't', to: 'cn' });

function readJson(path) {
    return JSON.parse(readFileSync(path, 'utf-8'));
}

// 读 Work index 拿到 id → title 映射，给 fragment meta 用
function loadWorkIndex() {
    const map = new Map();
    const indexDir = join(PRODUCTION_DIR, 'index', 'works');
    if (!existsSync(indexDir)) return map;
    for (let i = 0; i < 16; i++) {
        const shard = join(indexDir, `${i.toString(16)}.json`);
        if (!existsSync(shard)) continue;
        const data = readJson(shard);
        for (const item of Object.values(data)) {
            map.set(item.id, {
                title: item.title || item.name || '',
                author: item.author || '',
                dynasty: item.dynasty || '',
            });
        }
    }
    return map;
}

const workMeta = loadWorkIndex();
console.log(`Loaded ${workMeta.size} works from index\n`);

// 文本仓里有 manifest.json 的条目目录，取整理本版本的章 JSON
function collectCollatedJsons() {
    const result = [];
    function walk(dir) {
        for (const name of readdirSync(dir)) {
            const full = join(dir, name);
            if (!statSync(full).isDirectory()) continue;
            if (readManifest(full)) {
                for (const c of collatedChapterJsons(full)) {
                    result.push({ workDir: full, jsonPath: c.jsonPath, jsonName: `${c.stem}.json`, key: c.key, stem: c.stem });
                }
            } else if (!/^[a-z0-9]{8,}$/.test(name)) {
                walk(full); // 分片目录（Work/G/Y/L/…）；条目目录名是 id，不往下钻
            }
        }
    }
    for (const top of ['Work', 'Book']) {
        const p = join(TEXT_DIR, top);
        if (existsSync(p)) walk(p);
    }
    return result;
}

const { index, errors } = await pagefind.createIndex({ forceLanguage: 'zh' });
if (errors?.length) console.warn('createIndex warnings:', errors);

const t0 = Date.now();
let totalSections = 0;
let totalChars = 0;
let skippedEmpty = 0;
let totalWorks = 0;

const collatedJsons = collectCollatedJsons();
console.log(`Found ${collatedJsons.length} collated JSON files\n`);

for (const { workDir, jsonPath, jsonName, key, stem } of collatedJsons) {
    // workDir 末段是 work id（按 book-index 路径约定 Work/1/e/u/1euxxx/）
    const workId = workDir.split(/[\\/]/).pop();
    const meta = workMeta.get(workId) || { title: '', author: '', dynasty: '' };
    let data;
    try { data = readJson(jsonPath); } catch { continue; }
    if (!data) continue;

    const sections = data.sections || (data.content ? [{ title: data.title, content: data.content }] : []);
    if (!Array.isArray(sections) || sections.length === 0) continue;

    let addedInThisFile = 0;
    for (let i = 0; i < sections.length; i++) {
        const sec = sections[i];
        const rawTitle = sec.title || '';
        const rawContent = sec.content || '';
        if (!rawContent.trim() && !rawTitle.trim()) { skippedEmpty++; continue; }

        // 索引侧：t2s 归一化
        const normTitle = t2s(rawTitle);
        const normContent = t2s(rawContent);
        const indexedText = `${normTitle} ${normContent}`.trim();
        if (!indexedText) { skippedEmpty++; continue; }

        const result = await index.addCustomRecord({
            url: `/read/${workId}${key === 'default' ? '' : `/${key}`}/${stem}?sec=${i}`,
            content: indexedText,
            language: 'zh',
            // meta 保存**原始繁体**（不转换）供 UI 展示
            meta: {
                title: rawTitle || meta.title,
                work_title: meta.title,
                work_author: meta.author,
                work_dynasty: meta.dynasty,
                juan: jsonName.replace(/\.json$/, ''),
            },
            filters: {
                work_id: [workId],
                dynasty: meta.dynasty ? [meta.dynasty] : [],
            },
        });
        if (result.errors?.length) {
            if (totalSections < 3) console.warn('  ⚠ add:', result.errors);
        } else {
            totalSections++;
            totalChars += indexedText.length;
            addedInThisFile++;
        }
    }
    if (addedInThisFile > 0) totalWorks++;
}

console.log(`Indexed ${totalSections} sections from ${totalWorks} works (skipped ${skippedEmpty} empty)`);
console.log(`  total normalized chars: ${(totalChars / 1024).toFixed(1)} KB`);
console.log(`  indexing took ${((Date.now() - t0) / 1000).toFixed(1)}s`);

console.log(`\nWriting to ${OUT_DIR}...`);
await index.writeFiles({ outputPath: OUT_DIR });
await pagefind.close();
console.log(`✅ Done in ${((Date.now() - t0) / 1000).toFixed(1)}s\n`);
