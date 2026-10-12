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

export function* iterIndexShards(rootDir, typeDir) {
    const shardDir = join(rootDir, 'index', typeDir);
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
        const f = join(rootDir, 'index', `${typeDir}.json`);
        if (existsSync(f)) {
            const data = JSON.parse(readFileSync(f, 'utf-8'));
            for (const entry of Object.values(data)) yield entry;
        }
    }
}

/** 跨 draft + production 遍历，产出 { entry, rootDir, isDraft }；跳过升格墓碑（draft 侧 promoted_to）。 */
export function* iterAllRoots(roots, typeDir) {
    let tombstones = 0;
    for (const { dir, isDraft } of roots) {
        for (const entry of iterIndexShards(dir, typeDir)) {
            if (!entry || !entry.id) continue;
            if (entry.promoted_to) { tombstones++; continue; }
            yield { entry, rootDir: dir, isDraft };
        }
    }
    if (tombstones) console.log(`  [${typeDir}] 跳过 ${tombstones} 个升格墓碑`);
}
