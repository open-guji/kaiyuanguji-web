#!/usr/bin/env node
/**
 * measure-history.mjs — A0-架构原型件一·实测 1：拿三仓最近 20 次真实数据提交，
 * 逐次算「现行方式（视同全量）」vs「哈希方式（只传真变化 + 触及的 manifest 分片）」
 * 各自的上传文件数与字节数。
 *
 * 全程只用 git plumbing（ls-tree / diff --name-status / cat-file -s），
 * 不签出（checkout）任何历史版本，跑在已有的浅克隆上就够，不写盘、不改任何仓。
 *
 * 用法：
 *   node scripts/spike/measure-history.mjs \
 *     --repo /home/user/open-guji/book-index --dirs Work,Book,Collection,Entity --n 20 --label production
 */

import { execSync } from 'child_process';

const PREFIX_LEN = 2; // 与 bundle-hashed.mjs 的分片方案一致（用 id 后缀）

// core.quotePath=false：否则非 ASCII（中文标题）文件名会被 git 转成带引号的八进制
// 转义串，字符串按 tab 切出来的 path 直接喂给下一条 git 命令会 "fatal: path ... does
// not exist"（README §八·5 的坑，此处曾实打实踩过一次）。
function sh(cmd, cwd) {
    return execSync(`git -c core.quotePath=false ${cmd.replace(/^git /, '')}`, { cwd, encoding: 'utf-8', maxBuffer: 1024 * 1024 * 256 });
}

function idOf(path) {
    // "Work/g/c/g/d59dh4069gcg-欽定四庫全書薈要分架圖.json" → "d59dh4069gcg"
    // book-text 资产路径 "Work/.../d59f2mp12329/collated_edition/juan/007.json" → 取路径分量里
    // 紧跟 Work|Book 分片目录之后、长度 ≥10 的那一段作为 id（不依赖固定深度）。
    const base = path.split('/').pop();
    const m = base.match(/^([A-Za-z0-9]{10,14})-/);
    if (m) return m[1];
    // 资产型路径：从目录分量里找一个像 snowflake id 的段
    const parts = path.split('/');
    for (const p of parts) {
        if (/^[A-Za-z0-9]{10,14}$/.test(p)) return p;
    }
    return null;
}

function shardKeyFor(id) {
    return id.slice(-PREFIX_LEN);
}

function parseArgs() {
    const a = process.argv.slice(2);
    const out = { n: 20 };
    for (let i = 0; i < a.length; i++) {
        if (a[i] === '--repo') out.repo = a[++i];
        else if (a[i] === '--dirs') out.dirs = a[++i].split(',');
        else if (a[i] === '--n') out.n = parseInt(a[++i], 10);
        else if (a[i] === '--label') out.label = a[++i];
    }
    return out;
}

function main() {
    const { repo, dirs, n, label } = parseArgs();
    if (!repo || !dirs) {
        console.error('用法: --repo <path> --dirs Work,Book,... [--n 20] [--label xxx]');
        process.exit(1);
    }
    const dirArgs = dirs.join(' ');

    // 最近 n 个「触及数据目录」的非 merge 提交，从旧到新
    const log = sh(`git log --no-merges --pretty=format:%H -${n} -- ${dirArgs}`, repo).trim();
    const commits = log ? log.split('\n').reverse() : [];
    if (commits.length === 0) {
        console.log(`[${label}] 无匹配提交`);
        return;
    }
    console.log(`\n=== ${label}（${repo}） ${commits.length} 个真实数据提交 ===`);
    console.log('commit    现行·文件数  现行·MB   哈希·变更数  哈希·MB   新增  修改  删除  触及分片数(后缀2)');

    const rows = [];
    for (const c of commits) {
        // 现行：视同全量 = 当前提交时点整棵数据树的大小（每次发布都要让 CDN 边缘重新当作"新"）
        let totalCount = 0, totalBytes = 0;
        try {
            const lsOut = sh(`git ls-tree -r -l ${c} -- ${dirArgs}`, repo);
            for (const line of lsOut.split('\n')) {
                if (!line.trim()) continue;
                // "100644 blob <sha>   <size>\t<path>"
                const m = line.match(/^\S+\s+blob\s+\S+\s+(\d+)\t/);
                if (m) { totalCount++; totalBytes += parseInt(m[1], 10); }
            }
        } catch { /* 首个提交等边界情况 */ }

        // 哈希：本提交相对父提交的真实变化（A/M 才要上传，D 只是清单里少一条，不占带宽）
        // 字节数用 git cat-file --batch-check 一次性批量查（每条目单独 spawn 一次 git
        // 进程在「清空 draft 倉」那种 14 万文件的批量提交上实测卡到数分钟起步，改批量后到秒级）。
        let added = 0, modified = 0, deleted = 0, hashBytes = 0;
        const touchedShards = new Set();
        try {
            const diffOut = sh(`git diff --name-status ${c}^ ${c} -- ${dirArgs}`, repo);
            const amPaths = [];
            for (const line of diffOut.split('\n')) {
                if (!line.trim()) continue;
                const [status, ...pathParts] = line.split('\t');
                const path = pathParts[pathParts.length - 1];
                if (status === 'A') added++;
                else if (status === 'M') modified++;
                else if (status === 'D') {
                    deleted++;
                    // 删除不产生新的 entry/<id>.<hash>.json，但要把 id 从所在 manifest
                    // 分片里摘掉——分片文件本身还是要重写重传，这块常被漏算。
                    const id = idOf(path);
                    if (id) touchedShards.add(shardKeyFor(id));
                    continue;
                }
                else continue; // R/C 等罕见情况本 spike 不细分
                amPaths.push(path);
                const id = idOf(path);
                if (id) touchedShards.add(shardKeyFor(id));
            }
            if (amPaths.length > 0) {
                const input = amPaths.map(p => `${c}:${p}`).join('\n') + '\n';
                const out = execSync("git -c core.quotePath=false cat-file '--batch-check=%(objectsize)'", {
                    cwd: repo, input, encoding: 'utf-8', maxBuffer: 1024 * 1024 * 512,
                });
                for (const line of out.split('\n')) {
                    if (!line.trim() || line.endsWith('missing')) continue;
                    const n = parseInt(line.trim(), 10);
                    if (!Number.isNaN(n)) hashBytes += n;
                }
            }
        } catch { /* 根提交没有父提交 */ }

        const changedCount = added + modified;
        rows.push({ c, totalCount, totalBytes, changedCount, hashBytes, added, modified, deleted, shards: touchedShards.size });
        console.log(
            `${c.slice(0, 8)}  ${String(totalCount).padStart(8)}  ${(totalBytes / 1024 / 1024).toFixed(1).padStart(7)}  ` +
            `${String(changedCount).padStart(10)}  ${(hashBytes / 1024 / 1024).toFixed(3).padStart(8)}  ` +
            `${String(added).padStart(4)}  ${String(modified).padStart(4)}  ${String(deleted).padStart(4)}  ${String(touchedShards.size).padStart(6)}`
        );
    }

    // 汇总
    const sum = (f) => rows.reduce((s, r) => s + f(r), 0);
    const avgTotalCount = sum(r => r.totalCount) / rows.length;
    const avgTotalMB = sum(r => r.totalBytes) / rows.length / 1024 / 1024;
    const avgChanged = sum(r => r.changedCount) / rows.length;
    const avgHashMB = sum(r => r.hashBytes) / rows.length / 1024 / 1024;
    const avgShards = sum(r => r.shards) / rows.length;
    console.log(`\n[${label}] 均值：现行 ${avgTotalCount.toFixed(0)} 文件 / ${avgTotalMB.toFixed(1)} MB  vs  哈希 ${avgChanged.toFixed(1)} 文件变更 / ${avgHashMB.toFixed(3)} MB + 平均触及 ${avgShards.toFixed(1)} 个 manifest 分片`);
    console.log(`[${label}] 缩减倍数：文件数 ×${(avgTotalCount / Math.max(avgChanged, 0.01)).toFixed(0)}，字节数 ×${(avgTotalMB / Math.max(avgHashMB, 0.0001)).toFixed(0)}`);
}

main();
