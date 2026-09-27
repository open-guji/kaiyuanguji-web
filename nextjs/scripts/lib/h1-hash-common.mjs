/**
 * h1-hash-common.mjs — bundle-hashed*.mjs 共用的小工具（内容哈希、按需写、建目录）
 *
 * 从 bundle-hashed.mjs（A3 第一期）抽出，供它与 bundle-hashed-text.mjs（A3b）共用。
 * 全部是无副作用的纯工具函数，不认识 "entry" 或 "text" 这两个词。
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, statSync } from 'fs';
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
