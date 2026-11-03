/**
 * 遍历数据仓 index shards（从 full-reindex.mjs 抽出，overview#561）。
 * 纯文件读取，roots 由参数给：[{ dir, isDraft }]，draft 在前、production 在后。
 */
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';

/** p（绝对路径）是否在 rootDir 之内（防分片里的 ../ 越界读）。 */
export function insideRoot(rootDir, p) {
    const r = resolve(rootDir);
    return p === r || p.startsWith(r + sep);
}

/**
 * 检索分片目录：build 产物（BOOK_INDEX_DERIVED_DIR）里有 index/ 就用产物的，否则用源仓的。
 * book-index 要从仓里删掉 index/（schema 审查⑦），以后只有 build_derived 写的 <out>/index/（格式同仓内）。
 * 与 nextjs/scripts/lib/derived.mjs 的 indexDirFor 同一取法。
 */
export function indexDirFor(rootDir, derivedDir = '') {
    const d = (derivedDir || '').trim();
    if (d && existsSync(join(d, 'index'))) return join(d, 'index');
    return join(rootDir, 'index');
}

/** indexDir 缺省＝rootDir/index（旧口径）；条目的 path 仍相对 rootDir 解析，不受 indexDir 影响。 */
export function* iterIndexShards(rootDir, typeDir, indexDir = join(rootDir, 'index')) {
    const shardDir = join(indexDir, typeDir);
    if (existsSync(shardDir) && statSync(shardDir).isDirectory()) {
        const files = readdirSync(shardDir).filter(f => f.endsWith('.json')).sort();
        for (const f of files) {
            try {
                const data = JSON.parse(readFileSync(join(shardDir, f), 'utf-8'));
                for (const entry of Object.values(data)) yield entry;
            } catch (e) {
                console.error(`  ERROR reading ${f}: ${e.message}`);
            }
        }
    } else {
        const f = join(indexDir, `${typeDir}.json`);
        if (existsSync(f)) {
            const data = JSON.parse(readFileSync(f, 'utf-8'));
            for (const entry of Object.values(data)) yield entry;
        } else {
            // 不静默：一条都读不到时下游的条数闸会挡住换上线，但要让日志看得出是分片源没了
            console.warn(`⚠️  [${typeDir}] 在 ${indexDir} 下既没有 ${typeDir}/ 也没有 ${typeDir}.json，读到 0 条`);
        }
    }
}

/**
 * 跨 draft + production 遍历，产出 { entry, rootDir, isDraft }；跳过升格墓碑（draft 侧 promoted_to）。
 * roots：[{ dir, isDraft, indexDir? }]，indexDir 缺省＝dir/index。
 */
export function* iterAllRoots(roots, typeDir) {
    let tombstones = 0;
    for (const { dir, isDraft, indexDir } of roots) {
        for (const entry of iterIndexShards(dir, typeDir, indexDir || join(dir, 'index'))) {
            if (!entry || !entry.id) continue;
            if (entry.promoted_to) { tombstones++; continue; }
            yield { entry, rootDir: dir, isDraft };
        }
    }
    if (tombstones) console.log(`  [${typeDir}] 跳过 ${tombstones} 个升格墓碑`);
}
