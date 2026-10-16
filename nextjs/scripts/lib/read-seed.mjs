/**
 * read-seed.mjs — 阅读页首屏种子 current/items/<id>/read-seed.json 的生成（overview#345 方案 B，数据侧）。
 *
 * 形状与读侧（src/lib/server/read-seed.ts parseReadSeed）一致：
 *   { "v": 1, "manifest": {…公开 manifest…}, "primary": { "key": "<主版本 key>", "index": {…该版本 index.json…} } }
 *
 * 主版本的选法与阅读器相同：先按 readerManifest 隐藏整理本（有全文版时 kind=collated 不列），再取 key 为 default 的，没有就 versions[0]。
 *
 * 不生成（返回 skip，不抛错，调用方照旧只打包原文件）的情形：
 *   - 条目没有 manifest.json（没有阅读文本）、或没有可公开版本；
 *   - 主版本的 index.json 不存在、不是合法 JSON、章目录为空、有章没有字符串 file；
 *   - index.json 超过 SEED_MAX_BYTES（64KB）：按 Ella 的答复，这些条目走老的四请求读法，不生成 seed。
 * manifest.json 本身不合法（readManifest 抛错）不吞掉：构建失败，与 bundle-data 的 fail-closed 一致。
 *
 * 纯函数（只读文件，不联网）。
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { publicManifest, readManifest } from './text-layout.mjs';

export const READ_SEED_VERSION = 1;
export const SEED_MAX_BYTES = 64 * 1024;

/** 与 readerManifest（src/lib/reader-manifest.ts）同一规则：有全文版时隐藏 kind=collated */
function readerVersions(manifest) {
    const versions = manifest.versions;
    const hasFullText = versions.some((v) => v?.kind === 'transcription');
    return versions.filter((v) => !(hasFullText && v?.kind === 'collated'));
}

/** 主版本：阅读器的 default ?? versions[0] */
export function primaryVersionOf(manifest) {
    const vs = readerVersions(manifest);
    return vs.find((v) => v.key === 'default') ?? vs[0] ?? null;
}

function readJsonFile(p) {
    try {
        return JSON.parse(readFileSync(p, 'utf-8'));
    } catch {
        return null;
    }
}

/**
 * 为一个条目目录生成 seed。
 * 返回 { status: 'ok', key, text }（text 为写入 read-seed.json 的字符串，已是确定性的 JSON）或 { status: 'skip', reason }。
 */
export function buildReadSeed(itemDir) {
    const manifest = readManifest(itemDir); // 不合法会抛错
    if (!manifest) return { status: 'skip', reason: 'no-manifest' };
    const pub = publicManifest(manifest);
    if (!pub) return { status: 'skip', reason: 'not-public' };
    const primary = primaryVersionOf(pub);
    if (!primary) return { status: 'skip', reason: 'no-primary' };

    const indexPath = join(itemDir, primary.key, 'index.json');
    if (!existsSync(indexPath)) return { status: 'skip', reason: 'no-index' };
    if (statSync(indexPath).size > SEED_MAX_BYTES) return { status: 'skip', reason: 'index-too-large' };
    const index = readJsonFile(indexPath);
    if (!index || typeof index !== 'object' || !Array.isArray(index.chapters) || index.chapters.length === 0) {
        return { status: 'skip', reason: 'bad-index' };
    }
    if (!index.chapters.every((c) => !!c && typeof c === 'object' && typeof c.file === 'string')) {
        return { status: 'skip', reason: 'bad-index' };
    }

    const seed = { v: READ_SEED_VERSION, manifest: pub, primary: { key: primary.key, index } };
    return { status: 'ok', key: primary.key, text: JSON.stringify(seed) };
}
