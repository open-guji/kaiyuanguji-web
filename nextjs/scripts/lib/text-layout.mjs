/**
 * text-layout.mjs — book-text 文本目录的「新旧两种结构」识别与公共判据（overview#307 D 块）
 *
 * 旧结构（现状）：<id>/collated_edition/{index.json, juan/NNN.json, text/…}、<id>/full_text/…（Book 直放，Work 按 <key>/）；
 *               全局清单 index/full_text/{0-f}.json（Work 全文）。
 * 新结构（规格见 overview 项目进展/古籍索引网站/设计/阅读文本.md）：
 *   <id>/manifest.json                  { id, visibility?, versions: [{ key, kind, label, source, …, visibility? }] }
 *   <id>/default/ 与 <id>/<key>/        index.json（{ chapters: [{ n, file: '001', title, has_json }] ）、NNN.md、NNN.json（整理本可选）
 *   全局清单 index/texts/{0-f}.json
 *
 * 判别：条目目录下有 manifest.json 就是新结构；没有就按旧结构，旧结构的一切逻辑与产物保持不变。
 * 过渡期同一个仓里两种结构可以并存（逐条目迁移）。
 *
 * 私有：manifest 顶层或某个 version 标 `visibility: 'internal'`（book-text-private 的識典等）的不得进公开产物——
 * 顶层标了整个条目的文本都不公开，version 标了只去掉那一份（公开版的 manifest.json 里也不列它）。
 *
 * 纯函数＋少量只读 fs，无副作用；ops/ 与 nextjs/scripts 共用。
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** 非主版本的 key 不能用的保留字（规格 §二）；default 是主版本专用 */
export const RESERVED_KEYS = new Set(['default', 'manifest', 'fragments', 'sources']);
const KEY_RE = /^[a-z][a-z0-9-]*$/;

/** 合法的版本 key：主版本固定 default；其余 [a-z0-9-]、字母开头、非保留字 */
export function isTextKey(key) {
    if (typeof key !== 'string') return false;
    if (key === 'default') return true;
    return KEY_RE.test(key) && !RESERVED_KEYS.has(key);
}

function readJsonOrNull(p) {
    try {
        return JSON.parse(readFileSync(p, 'utf-8'));
    } catch {
        return null;
    }
}

/**
 * 条目目录的 manifest.json：没有这个文件返回 null（＝旧结构）；
 * 有但不是合法 JSON、或缺 versions 数组，**抛错**——不能当旧结构悄悄放过：
 * 那样版本目录不会被打包，私有标记也不会被看到（fail closed，构建／检查直接失败并指出是哪个文件）。
 */
export function readManifest(itemDir) {
    const p = join(itemDir, 'manifest.json');
    if (!existsSync(p)) return null;
    const m = readJsonOrNull(p);
    if (!m || typeof m !== 'object' || !Array.isArray(m.versions)) {
        throw new Error(`${p} 存在但不是合法的 manifest（要求是带 versions 数组的 JSON）`);
    }
    return m;
}

export const isInternal = (o) => o?.visibility === 'internal';

/**
 * manifest 里可公开的版本（保持 manifest 顺序，versions[0] 仍是 default）：
 * 顶层 internal → 空；单个 version internal 或 key 不合法的去掉。
 */
export function publicVersions(manifest) {
    if (!manifest || isInternal(manifest)) return [];
    return manifest.versions.filter((v) => v && isTextKey(v.key) && !isInternal(v));
}

/**
 * 公开版 manifest：没去掉任何版本时原样返回同一个对象（调用方据此原样拷贝字节）；
 * 去掉了就返回只含公开版本的副本；一份都不能公开返回 null（manifest.json 也不公开）。
 */
export function publicManifest(manifest) {
    if (!manifest) return null;
    const pub = publicVersions(manifest);
    if (pub.length === 0) return null;
    return pub.length === manifest.versions.length && !isInternal(manifest) ? manifest : { ...manifest, versions: pub };
}

/** 章文件名：新结构 index 里 file 不带扩展名（'001'），容忍带 .md／.txt 的；返回 .md 形式 */
export function chapterMdFile(file) {
    return /\.(md|txt)$/.test(file) ? file.replace(/\.txt$/, '.md') : `${file}.md`;
}

/** 打包产物里的章文件名（md 改 txt） */
export function chapterTxtFile(file) {
    return chapterMdFile(file).replace(/\.md$/, '.txt');
}

/** `<key>/index.json` 的第一章 → { file, hasJson }；没有章返回 null */
export function firstChapterOf(indexDoc) {
    const ch = Array.isArray(indexDoc?.chapters) ? indexDoc.chapters.find((c) => typeof c?.file === 'string' && c.file) : null;
    return ch ? { file: ch.file, hasJson: ch.has_json === true } : null;
}

/**
 * 新结构条目的可读性（阅读首页判据，与 #306 同一思路：站内真有正文）：
 * manifest 存在、有可公开版本，且每个公开版本的 index.json 章目录非空才算这个版本可读；一份可读版本都没有就不可读。
 * 返回 null（不可读／旧结构）或 { versions: [{ key, kind, first: { file, hasJson } }], collated, defaultFirst }。
 * collated：有 kind=collated 的版本（阅读首页「整理本」标记）；defaultFirst：主版本首章（可能为 null，主版本不可读时）。
 */
export function newStructureReadable(itemDir) {
    const manifest = readManifest(itemDir);
    if (!manifest) return null;
    const versions = [];
    for (const v of publicVersions(manifest)) {
        const first = firstChapterOf(readJsonOrNull(join(itemDir, v.key, 'index.json')));
        if (first) versions.push({ key: v.key, kind: v.kind, first });
    }
    if (versions.length === 0) return null;
    return {
        versions,
        collated: versions.some((v) => v.kind === 'collated'),
        defaultFirst: versions.find((v) => v.key === 'default')?.first ?? null,
    };
}

/** 新结构条目的公开版本 key 清单（不看章目录，供打包时圈定要扫的子目录） */
export function publicKeys(itemDir) {
    return publicVersions(readManifest(itemDir)).map((v) => v.key);
}

/**
 * 全局清单 index/texts/{0-f}.json（{ id: [{ key, kind, label, chapters_total, visibility? }] }）去掉不公开的版本：
 * 清单里自己标了 internal 的版本；以及条目 manifest 说不公开的（publicKeysOf(id) 返回公开 key 的 Set，
 * 顶层 internal 或版本 internal 时不在集合里；返回 null 表示没有这个条目的 manifest，按清单自己的标记判）。
 * 滤完一份都没有的条目整条去掉。无需过滤时返回 null（调用方原样拷字节，保证字节一致）。
 */
export function filterTextsShard(shard, publicKeysOf = () => null) {
    if (!shard || typeof shard !== 'object') return null;
    let changed = false;
    const out = {};
    for (const [id, list] of Object.entries(shard)) {
        const arr = Array.isArray(list) ? list : [];
        const allowed = publicKeysOf(id);
        const pub = arr.filter((v) => !isInternal(v) && (!allowed || allowed.has(v?.key)));
        if (pub.length !== arr.length) changed = true;
        if (pub.length) out[id] = pub;
        else if (arr.length) changed = true;
        else out[id] = arr;
    }
    return changed ? out : null;
}

/**
 * 新结构条目里整理本（kind=collated、可公开）版本的章 JSON（正文搜索索引用）：
 * [{ key, stem, jsonPath }]，只取 index.json 里 has_json 为 true 且文件存在的章。
 */
export function collatedChapterJsons(itemDir) {
    const manifest = readManifest(itemDir);
    const out = [];
    for (const v of publicVersions(manifest)) {
        if (v.kind !== 'collated') continue;
        const idx = readJsonOrNull(join(itemDir, v.key, 'index.json'));
        for (const c of Array.isArray(idx?.chapters) ? idx.chapters : []) {
            if (typeof c?.file !== 'string' || !c.file || c.has_json !== true) continue;
            const stem = c.file.replace(/\.(md|txt|json)$/, '');
            const jsonPath = join(itemDir, v.key, `${stem}.json`);
            if (existsSync(jsonPath)) out.push({ key: v.key, stem, jsonPath });
        }
    }
    return out;
}
