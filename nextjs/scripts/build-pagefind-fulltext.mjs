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
 * 用法：
 *   node scripts/build-pagefind-fulltext.mjs [draft-dir]
 */

import { readFileSync, existsSync, readdirSync, statSync, rmSync } from 'fs';
import { join, resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import * as pagefind from 'pagefind';
import { Converter } from 'opencc-js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DRAFT_DIR = resolve(process.argv[2] || join(__dirname, '..', '..', '..', 'book-index-draft'));
const OUT_DIR = resolve(__dirname, '..', 'public', 'data', 'pagefind-fulltext');

if (!existsSync(DRAFT_DIR)) {
    console.error(`❌ book-index-draft not found: ${DRAFT_DIR}`);
    process.exit(1);
}

console.log(`build-pagefind-fulltext: ${DRAFT_DIR}`);
console.log(`output:                  ${OUT_DIR}\n`);

if (existsSync(OUT_DIR)) rmSync(OUT_DIR, { recursive: true });

const t2s = Converter({ from: 't', to: 'cn' });

function readJson(path) {
    return JSON.parse(readFileSync(path, 'utf-8'));
}

// 读 Work index 拿到 id → title 映射，给 fragment meta 用
function loadWorkIndex() {
    const map = new Map();
    const indexDir = join(DRAFT_DIR, 'index', 'works');
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

// 找所有 Work/.../collated_edition/ 目录，并解析里面的 *.json 取 sections
function collectCollatedJsons() {
    const result = [];
    function walk(dir) {
        for (const name of readdirSync(dir)) {
            const full = join(dir, name);
            const st = statSync(full);
            if (!st.isDirectory()) continue;
            if (name === 'collated_edition') {
                for (const f of readdirSync(full)) {
                    if (!f.endsWith('.json')) continue;
                    if (f === 'collated_edition_index.json') continue;
                    const fullPath = join(full, f);
                    if (statSync(fullPath).isFile()) {
                        result.push({ workDir: dir, jsonPath: fullPath, jsonName: f });
                    }
                }
            } else {
                walk(full);
            }
        }
    }
    for (const top of ['Work', 'Book']) {
        const p = join(DRAFT_DIR, top);
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

for (const { workDir, jsonPath, jsonName } of collatedJsons) {
    // workDir 末段是 work id（按 book-index-draft 路径约定 Work/1/e/u/1euxxx/）
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
            url: `/book-index?id=${workId}&juan=${encodeURIComponent(jsonName)}&sec=${i}`,
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
