/**
 * h1-hash-common.mjs — bundle-hashed*.mjs 共用的小工具（内容哈希、按需写、建目录）
 *
 * 从 bundle-hashed.mjs（A3 第一期）抽出，供它与 bundle-hashed-text.mjs（A3b）共用。
 * 全部是无副作用的纯工具函数，不认识 "entry" 或 "text" 这两个词。
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, statSync, unlinkSync } from 'fs';
import { join } from 'path';
import { createHash } from 'crypto';

export function ensureDir(d) {
    mkdirSync(d, { recursive: true });
}

/** 递归收集一个目录下所有文件（跳过点开头的私有状态文件），带 size/mtimeMs。 */
export function walk(dir, base = dir) {
    const out = [];
    for (const name of readdirSync(dir)) {
        if (name.startsWith('.')) continue;
        const full = join(dir, name);
        const stat = statSync(full);
        if (stat.isDirectory()) {
            for (const f of walk(full, base)) out.push(f);
        } else {
            const relative = full.slice(base.length + 1).split(/[\\/]/).join('/');
            out.push({ full, relative, size: stat.size, mtimeMs: Math.floor(stat.mtimeMs) });
        }
    }
    return out;
}

export function readJson(p) {
    return JSON.parse(readFileSync(p, 'utf-8'));
}

export function hash8(buf) {
    return createHash('sha256').update(buf).digest('hex').slice(0, 8);
}

/** 写文件：若已存在且字节完全相同则跳过（mtime 不刷新），返回是否真的写了。 */
export function writeIfChanged(path, buf) {
    if (existsSync(path)) {
        const old = readFileSync(path);
        if (old.length === buf.length && old.equals(buf)) return false;
    }
    writeFileSync(path, buf);
    return true;
}

/**
 * S3（h1 版本根清单）：一次发布的版本 key，供 roots/<key>.json 与
 * text-roots/<key>.json 共用命名。
 *
 * 不能只用 draft 仓的 commitId：整理本／全文的内容由 book-text 的
 * textCommitId 决定，draft 不变、book-text 单独更新是常态（deploy.yml 本来就
 * 靠三仓比对各自触发部署）。若只拿 commitId 当 key，同一个 key 在两次发布之间
 * 内容会变，破坏 roots 文件"内容寻址、可长期不可变缓存"的前提。改用三个
 * commit 字段整体哈希，任一仓变了 key 就变，entry 与 text 两条 root 各自
 * 独立调用本函数，但输入同一份 dataCommit 时天然算出同一个 key，方便协调者
 * 按 key 对齐同一次发布的两条 root。
 */
export function dataCommitKey(dataCommit) {
    return createHash('sha256').update(JSON.stringify(dataCommit)).digest('hex').slice(0, 16);
}

/**
 * 把一组"key → 任意可 JSON 化对象"按内容哈希命名写盘（manifest/text-manifest
 * 分片同一套逻辑）：<key>.<hash8>.json，内容不变则不重写（mtime 不刷新）。
 *
 * 本地目录只是发布前的暂存区，不代表跨版本要保留的历史——一个 key 换了哈希后，
 * 旧哈希文件在本地没有继续存在的理由（真正决定"COS 上这个旧哈希文件还能不能删"
 * 的，是 h1-roots.mjs 的在用 root 集合，而不是本地这份暂存区还留没留着它）。
 * 所以这里直接按"本轮预期文件集合"做 diff 清理，跟 h1-orphans 的 7 天保留期
 * 是两回事，互不冲突。
 */
export function writeHashedShards(dir, shardsByKey) {
    ensureDir(dir);
    const shardHashes = {};
    const expectedFiles = new Set();
    let changedShards = 0;
    let totalBytes = 0;

    for (const [key, obj] of Object.entries(shardsByKey)) {
        const json = Buffer.from(JSON.stringify(obj));
        const h = hash8(json);
        shardHashes[key] = h;
        const fname = `${key}.${h}.json`;
        expectedFiles.add(fname);
        totalBytes += json.length;
        if (writeIfChanged(join(dir, fname), json)) changedShards++;
    }

    let removedShards = 0;
    if (existsSync(dir)) {
        for (const fname of readdirSync(dir)) {
            if (!expectedFiles.has(fname)) {
                unlinkSync(join(dir, fname));
                removedShards++;
            }
        }
    }

    return {
        shardHashes,               // key → hash8，供构造本轮 roots 文档的 shards 字段
        shardCount: Object.keys(shardsByKey).length,
        changedShards,
        removedShards,
        totalBytes,
    };
}
