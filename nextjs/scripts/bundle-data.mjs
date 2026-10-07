#!/usr/bin/env node
/**
 * bundle-data.mjs — 将 book-index（正式仓）的散落 JSON 文件打包成 web 可消费形态
 *
 * Phase 3 起改用扁平单文件结构（替换原 chunks/ 分桶）：
 * - L1: public/data/entry/{id}.json — 每个 Work/Book/Collection/Entity 单独一个文件
 *       ID 全局唯一（snowflake type 位区分），不需要 type 子目录
 * - L2: public/data/tiyao/juan-{start}-{end}.json — 整理本提要（按 10 卷分组）
 * - meta.json — 轻量计数（< 1 KB），HomePage 统计用
 * - search/* — MiniSearch 倒排索引，搜索 worker 用
 * - items/<id>/ — book-text 里一个条目的文本目录整体复制：manifest.json、<key>/index.json、各章（.md 改 .txt）、
 *   章的 .json；私有（visibility=internal）的不进公开产物（overview#307，规格 阅读文本.md）
 * - index/texts/{0-f}.json — 各条目 manifest 汇总出的全局清单（滤掉 internal 版本）
 *
 * 用法：
 *   node scripts/bundle-data.mjs                          # 默认 ../book-index
 *   node scripts/bundle-data.mjs /path/to/book-index
 *   BOOK_INDEX_PRODUCTION_DIR=/path node scripts/bundle-data.mjs
 *
 * schema-v2（overview#458）：设了 BOOK_INDEX_DERIVED_DIR（build/build_derived.py 的 --out 目录）就优先读其中的
 *   entry/<id>.json、index/、classific.json，缺哪样回退源仓；没设则完全按旧路径。见 lib/derived.mjs。
 *
 * overview#432 起只打包正式仓 book-index，不再读草稿仓 book-index-draft。
 * 缺正式仓或缺其根目录的站点内容文件（lib/production-dir.mjs）都直接报错退出，不静默。
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, statSync, unlinkSync, rmSync, copyFileSync } from 'fs';
import { join, resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { resolveDataDirs } from './lib/data-dirs.mjs';
import { assertProductionDir, assertSiteContentFiles, SITE_CONTENT_FILES } from './lib/production-dir.mjs';
import { execSync } from 'child_process';
import { bundleCatalog } from './build-catalog-index.mjs';
import { bundleRead } from './build-read-index.mjs';
import { bundleMetaHome } from './build-meta-home.mjs';
import { derivedDir, derivedPath, indexDirFor, readEntryDoc, taxonomyFileFor } from './lib/derived.mjs';
import { filterTextsShard, isInternal, isTextKey, newStructureReadable, publicManifest, publicVersions, readManifest } from './lib/text-layout.mjs';

// ─── 配置 ───

const __dirname = dirname(fileURLToPath(import.meta.url));

// 正式仓 book-index：所有条目与站点内容文件的来源。必需——缺了报错（见 main 里的检查）。
const PRODUCTION_DIR = resolve(
    process.argv[2]
    || process.env.BOOK_INDEX_PRODUCTION_DIR
    || join(__dirname, '..', '..', 'book-index')
);
// 文本仓（整理本 / 辑佚 / 全文 / 抓取素材）。2026-08-26 自 book-index 拆出，
// 两个元数据仓之下**再无资产目录**。条目与资产自此分属不同的仓：
// 条目走 rootDirFor()，资产一律走 TEXT_DIR，勿再由条目路径的 parent 推。
const TEXT_DIR = resolve(
    process.env.BOOK_TEXT_DIR
    || join(__dirname, '..', '..', 'book-text')
);
// 产物目录：默认 public/data，可用 KYG_DATA_ROOT／DATA_OUT_DIR 挪出 public/（见 lib/data-dirs.mjs）
const { dataDir: OUT_DIR, latestFile: LATEST_FILE } = resolveDataDirs();

const TIYAO_DIR = join(PRODUCTION_DIR, 'data', 'siku-catalog', 'volumes');
const TIYAO_GROUP_SIZE = 10;

// ─── 工具 ───

function readJson(path) {
    return JSON.parse(readFileSync(path, 'utf-8'));
}

/**
 * 写文件：若已存在且字节完全相同则跳过（mtime 不刷新）。
 * 配合 sync-to-cos.mjs 的 mtime-based hash cache 使用：
 * 未变文件 mtime 不变 → cache hit → 跳过 MD5 计算 → sync 提速 90%。
 */
function writeIfChanged(path, data, encoding = 'utf-8') {
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data, encoding);
    if (existsSync(path)) {
        const old = readFileSync(path);
        if (old.length === buf.length && old.equals(buf)) return false;
    }
    writeFileSync(path, buf);
    return true;
}

function writeJson(path, data) {
    mkdirSync(dirname(path), { recursive: true });
    writeIfChanged(path, JSON.stringify(data));
}

function ensureDir(dir) {
    mkdirSync(dir, { recursive: true });
}

// 复制 items/{id}/ 到 public/data/items/{id}/，并把章的 *.md 重命名为 *.txt
// （EdgeOne 默认只对 text/plain 等做 wire-gzip，不对 text/markdown 压缩，
// 1MB+ 的章文本不压缩会拖慢国内移动网络的加载）。
// 源仓库 book-text 仍保留 .md 后缀，仅打包产物改名。
// skip(relPath)：可选，相对 src 的路径（'/' 分隔）返回 true 就不拷（内部版本，见 copyItemDir）。
function copyDirRecursive(src, dest, skip = null, rel = '') {
    mkdirSync(dest, { recursive: true });
    for (const name of readdirSync(src)) {
        const relPath = rel ? `${rel}/${name}` : name;
        if (skip && skip(relPath)) continue;
        const srcPath = join(src, name);
        const stat = statSync(srcPath);
        if (stat.isDirectory()) {
            copyDirRecursive(srcPath, join(dest, name), skip, relPath);
        } else {
            const destName = name.endsWith('.md') ? name.slice(0, -3) + '.txt' : name;
            const destPath = join(dest, destName);
            // 与 writeIfChanged 同效：内容相同则不动 mtime（sync 端 cache 用）
            const buf = readFileSync(srcPath);
            if (existsSync(destPath)) {
                const old = readFileSync(destPath);
                if (old.length === buf.length && old.equals(buf)) continue;
            }
            writeFileSync(destPath, buf);
        }
    }
}

/**
 * 把文本仓里一个条目的目录拷进 items/<id>/。
 * 没有 manifest.json 的目录（只有 fragments／sources／lineage_graph.json 这类非文本资产）：整个目录原样拷。
 * 有 manifest.json（overview#307）：同样整体拷，但私有的不进公开产物——
 *   manifest 顶层 visibility:internal → 整个条目目录都不拷；
 *   某个 version 标 internal → 不拷它的目录，公开版 manifest.json 里也去掉这一项（没去掉任何版本则原样拷字节）；
 *   manifest 没列的文本版本目录（顶层目录里直接有 index.json、名字像版本 key）→ 不拷；
 *   manifest.json 存在但不合法 → 抛错，构建失败。
 * 返回 { internalSkipped: 被挡在外面的版本数 }，供日志。
 */
function copyItemDir(itemDir, destDir) {
    const manifest = readManifest(itemDir); // manifest.json 存在但不合法会抛错：构建失败，不当旧结构放过
    if (!manifest) {
        copyDirRecursive(itemDir, destDir);
        return { internalSkipped: 0 };
    }
    // 顶层 internal：整个条目目录都不进公开产物
    if (isInternal(manifest)) return { internalSkipped: manifest.versions.length };
    const pub = publicManifest(manifest);
    const listed = new Set(manifest.versions.map((v) => v?.key));
    const blocked = new Set(manifest.versions
        .filter((v) => typeof v?.key === 'string' && (isInternal(v) || !pub?.versions.includes(v)))
        .map((v) => v.key));
    // manifest 没列的文本版本目录（顶层目录里直接有 index.json、名字又像版本 key）不公开：没登记就当没有，
    // 免得未声明可见性的文本混进来。fragments／sources／lineage_graph.json 等非文本资产照旧公开。
    for (const name of readdirSync(itemDir)) {
        if (!listed.has(name) && isTextKey(name) && existsSync(join(itemDir, name, 'index.json'))) blocked.add(name);
    }
    copyDirRecursive(itemDir, destDir, (rel) => rel === 'manifest.json' || blocked.has(rel.split('/')[0]));
    if (pub) {
        const dest = join(destDir, 'manifest.json');
        if (pub === manifest) writeIfChanged(dest, readFileSync(join(itemDir, 'manifest.json')));
        else writeIfChanged(dest, JSON.stringify(pub));
    }
    return { internalSkipped: blocked.size };
}

const NUM_SHARDS = 16;

// ─── 内部：合并分片索引（不再写入 index.json，仅供 L1/meta/recommended hydrate 使用）───

/**
 * 加载正式仓 book-index 的 shard 索引。
 * 每个 entry 上加 `_root` 字段（恒为 "official"），bundleL1 据此找 detail 文件。
 * （overview#432 前还合并草稿仓、`_root` 有 "draft"/"official" 两种；下游 builder 仍按 `_root` 取根目录，故保留该字段。）
 *
 * ⚠️ 必须跳过升格墓碑（`promoted_to`），否则计数翻倍：
 * 升格会给条目**分配新 ID**，旧 ID 只留一个 stub 墓碑。按 ID dedupe 挡不住
 * 这种情况——墓碑(旧 ID) 与真身(新 ID) 是两个不同的 key，两条都会留下。
 * 2026-09-04 查实：meta.json 的 works/books/collections 恰好是真实值的
 * 1.99~2.00 倍（works 181097 vs 真实 91125，差 89972 正是墓碑数），
 * 而不参与升格的 entities 比值精确为 1.000（对照组）。
 *
 * 同一个坑 L1 在 2026-08-25 修（indexer/full-reindex.mjs 的 iterAllRoots），
 * L2 随后跟上（build-search-index.mjs 的 loadShardedIndex），**唯独本文件
 * 一直没改** —— 于是首页「N 部作品」的统计数字虚高一倍。三处语义须一致：只丢墓碑。
 */
function loadShardedIndex() {
    const merged = { books: {}, collections: {}, works: {}, entities: {} };
    _mergeRoot(merged, PRODUCTION_DIR, 'official');
    return merged;
}

function _mergeRoot(merged, rootDir, rootLabel) {
    // schema-v2：有 build 产物（BOOK_INDEX_DERIVED_DIR）就读产物的 index/，否则读源仓的（lib/derived.mjs）
    const indexDir = indexDirFor(rootDir);

    // collections (single file)
    const colPath = join(indexDir, 'collections.json');
    if (existsSync(colPath)) {
        for (const [id, entry] of Object.entries(readJson(colPath))) {
            if (entry?.promoted_to) continue; // 升格墓碑：真身在 production 侧
            merged.collections[id] = { ...entry, _root: rootLabel };
        }
    }

    // books / works / entities (16 shards each)
    for (const typeKey of ['books', 'works', 'entities']) {
        for (let i = 0; i < NUM_SHARDS; i++) {
            const shardPath = join(indexDir, typeKey, `${i.toString(16)}.json`);
            if (existsSync(shardPath)) {
                for (const [id, entry] of Object.entries(readJson(shardPath))) {
                    if (entry?.promoted_to) continue; // 升格墓碑：真身在 production 侧
                    merged[typeKey][id] = { ...entry, _root: rootLabel };
                }
            }
        }
    }

    return merged;
}

/** 条目所在根目录：只有正式仓 */
function rootDirFor(_entry) {
    return PRODUCTION_DIR;
}

// ─── L1: 扁平单文件 entry/{id}.json ───
//
// 每个 Work/Book/Collection/Entity 写一个独立 JSON 文件，URL 直接拼 entry/{id}.json
// 拉，不需要 chunks 分桶 manifest 查询。ID 全局唯一（snowflake type 位区分），
// 不需要 type 子目录。
//
// 注入字段：detail 文件本身没有 has_collated/has_text/has_image/subtype/primary_name
// 这几个 index-only 标记，bundleL1 从 index 里读取后并入 entry 文件，保证 getEntry
// 一次请求拿到完整渲染所需数据，不再触发额外 ensureLoaded 拉 index.json。

function bundleL1() {
    const index = loadShardedIndex();
    let totalEntries = 0;
    let totalBytes = 0;
    let itemFileCount = 0;
    let internalSkipped = 0; // 新结构里标 internal、没进公开产物的版本数
    const entryDir = join(OUT_DIR, 'entry');
    const itemsDir = join(OUT_DIR, 'items');
    const legacyChunksDir = join(OUT_DIR, 'chunks');

    // 清理旧数据（包括 Phase 3 之前的 chunks/ 目录）
    if (existsSync(entryDir)) rmSync(entryDir, { recursive: true });
    if (existsSync(itemsDir)) rmSync(itemsDir, { recursive: true });
    if (existsSync(legacyChunksDir)) rmSync(legacyChunksDir, { recursive: true });
    ensureDir(entryDir);

    for (const [typeName] of [['works'], ['collections'], ['books'], ['entities']]) {
        const items = index[typeName];
        if (!items) continue;

        for (const item of Object.values(items)) {
            const id = item.id;
            const path = item.path; // e.g. "Work/G/Y/L/GYL5215Antw-尚書正義.json"
            const baseDir = rootDirFor(item);

            // 详情：build 产物 entry/<id>.json（源＋_ 派生字段）优先，缺则读源档
            const detailPath = join(baseDir, path);
            try {
                // 读不了／JSON 坏了只跳过这一条（readEntryDoc 抛错在 try 内，与改前读源档同口径）
                const read = readEntryDoc({ id, srcPath: detailPath });
                const detail = read?.doc;
                if (detail) {
                    if (item.has_collated) detail.has_collated = true;
                    if (item.has_text) detail.has_text = true;
                    if (item.has_image) detail.has_image = true;
                    // has_text 只表示「有外部文本资源」，不代表站内有正文。站内有几份可读文本看 text_count／text_kinds
                    // （有 manifest.json，overview#307，规格 §四）：只认可公开且章目录非空的版本；没有文本的条目不加这两个字段
                    const newText = newStructureReadable(join(TEXT_DIR, dirname(path), id));
                    if (newText) {
                        detail.text_count = newText.versions.length;
                        detail.text_kinds = [...new Set(newText.versions.map((v) => v.kind))].sort();
                    }
                    if (item.subtype) detail.subtype = item.subtype;
                    if (item.primary_name) detail.primary_name = item.primary_name;
                    // 注入仓库归属，供前端拼右上角 GitHub 源文件链接：
                    //   _path     —— item.path（如 "Book/9/6/k/96kzkdm8e8-紅樓夢.json"）
                    //   _isDraft  —— item._root === 'draft'（production 条目应链到 book-index）
                    detail._path = item.path;
                    detail._isDraft = item._root !== 'official';
                    const json = JSON.stringify(detail);
                    writeIfChanged(join(entryDir, `${id}.json`), json);
                    totalEntries++;
                    totalBytes += Buffer.byteLength(json);
                }
            } catch (e) {
                console.warn(`  ⚠ Failed to read ${path}: ${e.message}`);
            }

            // 关联文件（文本 manifest.json＋<key>/、fragments、sources）
            // → 直接复制到 items/{id}/ 下。**根是 TEXT_DIR，不是 baseDir**：
            // 拆分之后资产不在元数据仓里，用 baseDir 则一个也找不着，且
            // existsSync 为假就静默跳过——不报错，只是 items/ 空了。
            const itemDir = join(TEXT_DIR, dirname(path), id);
            if (existsSync(itemDir) && statSync(itemDir).isDirectory()) {
                internalSkipped += copyItemDir(itemDir, join(itemsDir, id)).internalSkipped;
                itemFileCount++;
            }
        }
    }

    console.log(`L1  ${totalEntries} entry/*.json files (${(totalBytes / 1024 / 1024).toFixed(1)} MB)`);
    if (itemFileCount > 0) {
        console.log(`    items: ${itemFileCount} directories copied to items/`);
    }
    if (internalSkipped > 0) {
        console.log(`    items: ${internalSkipped} 份 visibility=internal 的文本版本未进公开产物`);
    }
}

// ─── L2: 提要按卷组打包 ───

function bundleL2() {
    if (!existsSync(TIYAO_DIR)) {
        console.log('L2  skipped (no tiyao data)');
        return;
    }

    const files = readdirSync(TIYAO_DIR)
        .filter(f => f.match(/^juan\d+\.json$/))
        .sort();

    if (files.length === 0) {
        console.log('L2  skipped (no juan files)');
        return;
    }

    const tiyaoDir = join(OUT_DIR, 'tiyao');
    ensureDir(tiyaoDir);

    // 按组打包
    let groupCount = 0;
    const maxJuan = files.length;
    const totalGroups = Math.ceil(maxJuan / TIYAO_GROUP_SIZE);

    for (let g = 0; g < totalGroups; g++) {
        const start = g * TIYAO_GROUP_SIZE + 1;
        const end = Math.min((g + 1) * TIYAO_GROUP_SIZE, maxJuan);
        const group = {};

        for (let j = start; j <= end; j++) {
            const fname = `juan${String(j).padStart(2, '0')}.json`;
            const fpath = join(TIYAO_DIR, fname);
            if (existsSync(fpath)) {
                try {
                    group[fname] = readJson(fpath);
                } catch (e) {
                    console.warn(`  ⚠ Failed to read ${fname}: ${e.message}`);
                }
            }
        }

        if (Object.keys(group).length > 0) {
            const pad = n => String(n).padStart(3, '0');
            writeJson(join(tiyaoDir, `juan-${pad(start)}-${pad(end)}.json`), group);
            groupCount++;
        }
    }

    console.log(`L2  ${files.length} juan files → ${groupCount} tiyao chunks`);
}

// ─── 轻量元数据（meta.json）：让 /book-index 首屏不再下 4 MB index ───
//
// HomePage / IndexBrowser 之前为了显示「N 部作品 / N 部书 / 资源覆盖 / subtype 直方图」
// 等几个数字会调用 getAllEntries / loadEntries 等触发 index.json 全量下载。
// 把这些数字预算到 meta.json (< 1 KB)，BundleStorage.getCounts() 优先读它。

function bundleMeta() {
    const index = loadShardedIndex();
    const counts = {
        works: Object.keys(index.works ?? {}).length,
        books: Object.keys(index.books ?? {}).length,
        collections: Object.keys(index.collections ?? {}).length,
        entities: Object.keys(index.entities ?? {}).length,
    };
    let hasText = 0, hasImage = 0;
    const subtypeStats = {};
    for (const item of Object.values(index.works ?? {})) {
        if (item.has_text) hasText++;
        if (item.has_image) hasImage++;
        if (item.subtype) subtypeStats[item.subtype] = (subtypeStats[item.subtype] ?? 0) + 1;
    }
    // subtype 是可选字段，96.7% 的 Work 根本没写——它们就是普通的「书」，
    // 只有文章/诗词/篇章这类才需要显式标注。
    //
    // 此前 subtypeStats.book 只数「显式标了 subtype=book」的条目，
    // 于是首页长期显示「書 27 部」，把另外 88,000+ 部书全漏了。
    // 这里把「未标注」并入 book，让这个数字回到它该有的语义：
    // 总作品数减去明确属于其他类型的部分。
    const typed = Object.entries(subtypeStats)
        .filter(([k]) => k !== 'book')
        .reduce((n, [, v]) => n + v, 0);
    subtypeStats.book = counts.works - typed;
    const meta = {
        ...counts,
        resourceCounts: { hasText, hasImage },
        subtypeStats,
    };
    writeJson(join(OUT_DIR, 'meta.json'), meta);
    const size = Buffer.byteLength(JSON.stringify(meta));
    console.log(
        `META meta.json (${counts.works}w/${counts.books}b/${counts.collections}c/${counts.entities}e, ${size} B)`
    );
}

/**
 * 新结构的全局清单 index/texts/{0-f}.json（由各条目 manifest 汇总生成，overview#307）：
 * 有就拷到产物 index/texts/（条目里有 internal 版本的过滤掉，没有需要过滤的原样拷字节）；没有这个目录就跳过。
 */
function bundleTextsIndex(index) {
    const srcDir = join(TEXT_DIR, 'index', 'texts');
    if (!existsSync(srcDir)) return;
    const destDir = join(OUT_DIR, 'index', 'texts');
    ensureDir(destDir);
    let shardCount = 0;
    let filtered = 0;
    // 用条目自己的 manifest 判可见性（顶层 internal、版本 internal 都算），不只信清单里的标记
    const pathById = new Map([...Object.values(index.works ?? {}), ...Object.values(index.books ?? {})].map((it) => [it.id, it.path]));
    const publicKeysOf = (id) => {
        const rel = pathById.get(id);
        if (!rel) return null;
        const manifest = readManifest(join(TEXT_DIR, dirname(rel), id));
        return manifest ? new Set(publicVersions(manifest).map((v) => v.key)) : null;
    };
    for (let i = 0; i < NUM_SHARDS; i++) {
        const fname = `${i.toString(16)}.json`;
        const srcPath = join(srcDir, fname);
        if (!existsSync(srcPath)) continue;
        const buf = readFileSync(srcPath);
        let out = buf;
        let doc;
        try {
            doc = JSON.parse(buf.toString('utf-8'));
        } catch (e) {
            // 读不了就没法过滤私有版本，不能原样放出去：构建失败
            throw new Error(`index/texts/${fname} 不是合法 JSON：${e.message}`);
        }
        const f = filterTextsShard(doc, publicKeysOf);
        if (f) { out = Buffer.from(JSON.stringify(f)); filtered++; }
        writeIfChanged(join(destDir, fname), out);
        shardCount++;
    }
    console.log(`TXT  ${shardCount} index/texts 分片${filtered ? `（${filtered} 片去掉了 internal 版本）` : ''}`);
}

// ─── 复制独立数据文件（resource*.json, recommended.json, promotions.json） ───
// 都在 book-index 根目录；缺了是数据出错，main 开头已 assertSiteContentFiles，这里不再静默跳过。

function bundleExtraFiles() {
    // resource* 直接复制；promotions.json 一并复制（由 book-index promote 维护，
    // 客户端 BundleStorage 用它做 draft→production redirect）
    for (const fname of SITE_CONTENT_FILES.filter((f) => f !== 'recommended.json')) {
        const src = join(PRODUCTION_DIR, fname);
        const data = readFileSync(src, 'utf-8');
        writeIfChanged(join(OUT_DIR, fname), data);
        const size = (Buffer.byteLength(data) / 1024).toFixed(0);
        console.log(`EX  ${fname} copied (${size} KB)`);
    }

    // recommended.json: hydrate items 加上 IndexEntry 元数据，让 HomePage
    // 直接渲染，不再为每个 ID 触发一次 transport.getEntry / chunk fetch。
    const recSrc = join(PRODUCTION_DIR, 'recommended.json');
    {
        const rec = readJson(recSrc);
        const index = loadShardedIndex();
        const lookup = new Map();
        for (const typeName of ['works', 'books', 'collections', 'entities']) {
            for (const item of Object.values(index[typeName] ?? {})) {
                lookup.set(item.id, { ...item, type: typeName.slice(0, -1) });
            }
        }
        let hydrated = 0, missed = 0;
        for (const group of rec.groups ?? []) {
            for (const item of group.items ?? []) {
                const idx = lookup.get(item.id);
                if (idx) {
                    if (!item.title) item.title = idx.title || idx.name || idx.primary_name;
                    item.type = idx.type;
                    if (idx.author) item.author = idx.author;
                    if (idx.dynasty) item.dynasty = idx.dynasty;
                    if (idx.role) item.role = idx.role;
                    if (idx.edition) item.edition = idx.edition;
                    if (idx.has_text) item.has_text = true;
                    if (idx.has_image) item.has_image = true;
                    if (idx.has_collated) item.has_collated = true;
                    if (idx.subtype) item.subtype = idx.subtype;
                    if (idx.primary_name) item.primary_name = idx.primary_name;
                    hydrated++;
                } else {
                    missed++;
                }
            }
        }
        const data = JSON.stringify(rec);
        writeIfChanged(join(OUT_DIR, 'recommended.json'), data);
        const size = (Buffer.byteLength(data) / 1024).toFixed(1);
        console.log(`EX  recommended.json hydrated (${hydrated} items + ${missed} missed, ${size} KB)`);
    }
}

// ─── 版本信息（commitId 记正式仓 book-index 的 commit） ───

function bundleVersion() {
    let commitId = 'unknown';
    let commitDate = '';
    let productionCommitId = 'unknown';
    // 文本仓之 commit（2026-08-26 拆分后立）。deploy.yml 的跳过判断要用它——
    // 不记则 book-text 单独有改动时，三仓比对里没有它这一项，部署被判为
    // 「无变化」而跳过，整理本的更新永远上不了线。
    let textCommitId = 'unknown';

    try {
        commitId = execSync('git rev-parse HEAD', { cwd: PRODUCTION_DIR, encoding: 'utf-8' }).trim();
        commitDate = execSync('git log -1 --format=%cI', { cwd: PRODUCTION_DIR, encoding: 'utf-8' }).trim();
        productionCommitId = commitId;
    } catch {
        // CI 中 --depth 1 clone 也能拿到 HEAD，如果失败则留默认值
        console.warn('  ⚠ Could not read git info from book-index (production)');
    }
    if (existsSync(TEXT_DIR)) {
        try {
            textCommitId = execSync('git rev-parse HEAD', { cwd: TEXT_DIR, encoding: 'utf-8' }).trim();
        } catch {
            console.warn('  ⚠ Could not read git info from book-text');
        }
    }

    const version = {
        commitId,
        commitDate,
        productionCommitId,
        textCommitId,
        bundleDate: new Date().toISOString(),
    };

    writeJson(join(OUT_DIR, 'version.json'), version);

    // latest.json — COS 上传时单独覆盖到桶根，作为版本软指针。
    // sync-to-cos.mjs 会在所有 v/{commit}/ 文件传完后才覆盖此文件。
    // shortCommit 是路径前缀，前端启动时拉 latest.json 拿到它再拼 basePath。
    const shortCommit = commitId === 'unknown' ? 'unknown' : commitId.slice(0, 12);
    const latest = {
        commitId: shortCommit,
        fullCommitId: commitId,
        commitDate,
        // 定时部署的新旧比对用（deploy.yml check job）：某个仓单独变更时
        // 靠这些字段判断是否需要重新部署。
        // overview#432 起 commitId／fullCommitId 即正式仓 commit（草稿仓不再参与），
        // 与 productionCommitId 相同；字段名保留，线上旧前端、cacheKey、同步标记都还读 fullCommitId。
        // 两个仓都要给全——deploy.yml 的跳过判断会读 textCommitId，
        // 漏写则该比对恒为空字符串、永远走「有变化」分支：不会漏部署，但定时任务每次都白跑一遍构建。
        productionCommitId,
        textCommitId,
        bundleDate: version.bundleDate,
    };
    writeJson(LATEST_FILE, latest);

    console.log(`VER version.json + latest.json (commit: ${commitId.slice(0, 8)}, date: ${commitDate})`);
}

// ─── Index 完整性检查 ───
//
// 扫描 Work/Book/Collection 目录下所有条目文件（文件名格式 {11位ID}-*.json），
// 验证每个 ID 都已存在于 index 分片中。
// 发现缺失时输出错误并 exit(1)，阻止生成错误的打包产物。

function checkIndex() {
    console.log('IDX checking index consistency...');

    // 加载所有已 index 的 ID
    const indexed = new Set();
    const indexDir = indexDirFor(PRODUCTION_DIR);

    const colPath = join(indexDir, 'collections.json');
    if (existsSync(colPath)) {
        for (const id of Object.keys(readJson(colPath))) indexed.add(id);
    }
    for (const typeKey of ['books', 'works', 'entities']) {
        for (let i = 0; i < NUM_SHARDS; i++) {
            const shardPath = join(indexDir, typeKey, `${i.toString(16)}.json`);
            if (existsSync(shardPath)) {
                for (const id of Object.keys(readJson(shardPath))) indexed.add(id);
            }
        }
    }

    // 扫描条目文件：文件名必须匹配 {ID}-*.json (ID为11-13位字母数字)
    const ITEM_FILE_RE = /^[A-Za-z0-9]{11,13}-.+\.json$/;
    const missing = [];

    const walkDir = (dir) => {
        for (const entry of readdirSync(dir)) {
            const full = join(dir, entry);
            if (statSync(full).isDirectory()) {
                walkDir(full);
            } else if (ITEM_FILE_RE.test(entry)) {
                const id = entry.split('-')[0];
                if (!indexed.has(id)) {
                    missing.push({ id, path: full.replace(PRODUCTION_DIR, '').replace(/\\/g, '/') });
                }
            }
        }
    };

    for (const typeDir of ['Work', 'Book', 'Collection', 'Entity']) {
        const dir = join(PRODUCTION_DIR, typeDir);
        if (existsSync(dir)) walkDir(dir);
    }

    if (missing.length > 0) {
        console.error(`\n❌ Index check failed: ${missing.length} item(s) exist as files but are missing from the index:`);
        for (const { id, path } of missing) {
            console.error(`   ${id}  ${path}`);
        }
        console.error('\n   Run: book-index reindex  to fix.\n');
        process.exit(1);
    }

    console.log(`IDX index consistent (${indexed.size} entries indexed)\n`);
}

// ─── Main ───

console.log(`\nbundle-data: ${PRODUCTION_DIR}`);
console.log(`  text: ${TEXT_DIR}${existsSync(TEXT_DIR) ? '' : '  ⚠ 不存在——items/ 将为空'}`);
console.log(`output:      ${OUT_DIR}\n`);

// 正式仓与其根目录的站点内容文件都是必需的：缺了直接报错，不静默打出缺条目／缺站点内容的站
try {
    assertProductionDir(PRODUCTION_DIR);
    assertSiteContentFiles(PRODUCTION_DIR);
} catch (e) {
    console.error(`❌ ${e.message}`);
    process.exit(1);
}

if (derivedDir()) {
    // schema-v2：条目详情读 build 产物 entry/<id>.json（缺则回退源档），检索索引读产物 index/
    console.log(`DER  BOOK_INDEX_DERIVED_DIR=${derivedDir()}（entry ${derivedPath('entry') ? '✓' : '✗ 缺'}，index ${derivedPath('index') ? '✓' : '✗ 缺'}）`);
}
checkIndex();
bundleMeta();
bundleL1();
// 古籍总目分类索引 catalog/（N4b，见 build-catalog-index.mjs）
bundleCatalog({ index: loadShardedIndex(), rootDirFor, dataDir: OUT_DIR, taxonomyFile: taxonomyFileFor(PRODUCTION_DIR) });
// 阅读首页可读条目索引 read/（overview#267 第 16 项，见 build-read-index.mjs）：与总目同一套分类树
bundleRead({ index: loadShardedIndex(), rootDirFor, textDirFor: () => TEXT_DIR, dataDir: OUT_DIR, taxonomyFile: taxonomyFileFor(PRODUCTION_DIR), curationFile: join(PRODUCTION_DIR, 'curation', 'read-home.json'), verifyItems: true });
// 元数据首页分区 meta-home/（overview#322，见 build-meta-home.mjs）：要用上面写好的 meta.json 与 catalog/tree.json
bundleMetaHome({ index: loadShardedIndex(), rootDirFor, textDirFor: () => TEXT_DIR, dataDir: OUT_DIR, siteDir: PRODUCTION_DIR, curationDir: join(PRODUCTION_DIR, 'curation') });
bundleL2();
bundleTextsIndex(loadShardedIndex());
bundleExtraFiles();
bundleVersion();

// 清理旧的 L0 / search_s / chunks 产物（避免上线后部署目录残留导致客户端误下载）
for (const stale of ['index.json', 'search_s.json']) {
    const p = join(OUT_DIR, stale);
    if (existsSync(p)) {
        unlinkSync(p);
        console.log(`CLR removed legacy ${stale}`);
    }
}
// Phase 3：chunks/ 已被 entry/ 替换
const legacyChunksDir = join(OUT_DIR, 'chunks');
if (existsSync(legacyChunksDir)) {
    rmSync(legacyChunksDir, { recursive: true });
    console.log(`CLR removed legacy chunks/ directory`);
}

// ─── 搜索索引（MiniSearch，自给自足从 shard 重建） ───
try {
    execSync('node scripts/build-search-index.mjs', {
        cwd: resolve(__dirname, '..'),
        stdio: 'inherit',
    });
} catch (err) {
    console.error('❌ build-search-index.mjs failed');
    process.exit(1);
}

console.log('\n✅ bundle-data complete\n');
