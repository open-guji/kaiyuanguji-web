/**
 * text-layout.mjs — book-text 文本目录结构（manifest.json＋<key>/）的识别与公共判据（overview#307）
 *
 * 结构（规格见 overview 项目进展/古籍索引网站/设计/阅读文本.md）：
 *   <id>/manifest.json                  { id, visibility?, versions: [{ key, kind, label, source, …, visibility? }] }
 *   <id>/default/ 与 <id>/<key>/        index.json（{ chapters: [{ n, file: '001', title, has_json }] ）、NNN.md、NNN.json（整理本可选）
 *   全局清单 index/texts/{0-f}.json
 *
 * 条目目录下有 manifest.json 才有阅读文本；没有就是没有文本（旧的 collated_edition／full_text 结构已在 2026-09-30 迁移掉，
 * 2026-10-01 起代码里不再认，规格 §十）。
 *
 * 私有：manifest 顶层或某个 version 标 `visibility: 'internal'`（book-text-private 的識典等）的不得进公开产物——
 * 顶层标了整个条目的文本都不公开，version 标了只去掉那一份（公开版的 manifest.json 里也不列它）。
 *
 * 纯函数＋少量只读 fs，无副作用；ops/ 与 nextjs/scripts 共用。
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * 非主版本的 key 不能用的保留字（规格 §二）；default 是主版本专用。
 * extra：版本目录下的手编源／工作档（如 default/extra/source/<N>册.md），不是读者可见的文本，不能当版本 key，也不进公开产物。
 */
export const RESERVED_KEYS = new Set(['default', 'manifest', 'fragments', 'sources', 'extra']);
const KEY_RE = /^[a-z][a-z0-9-]*$/;

/** 合法的版本 key：主版本固定 default；其余 [a-z0-9-]、字母开头、非保留字 */
export function isTextKey(key) {
    if (typeof key !== 'string') return false;
    if (key === 'default') return true;
    return KEY_RE.test(key) && !RESERVED_KEYS.has(key);
}

/**
 * 条目目录内的相对路径（'/' 分隔）是不是 `extra` 工作档，不得进公开产物：
 * 顶层 `extra/**`（不是版本目录，也不是登记的版本），或 `<版本 key>/extra/**`（任何版本目录下的 extra/，含 default/extra/）。
 * versionKeys：manifest 里登记的版本 key 集合（Set 或数组）；第二段是 extra 但第一段不是版本目录的（如 fragments/extra）不归本规则管。
 */
export function isExtraPath(rel, versionKeys = []) {
    if (typeof rel !== 'string') return false;
    const parts = rel.split('/');
    if (parts[0] === 'extra') return true;
    const keys = versionKeys instanceof Set ? versionKeys : new Set(versionKeys);
    return parts.length > 1 && parts[1] === 'extra' && keys.has(parts[0]);
}

function readJsonOrNull(p) {
    try {
        return JSON.parse(readFileSync(p, 'utf-8'));
    } catch {
        return null;
    }
}

/**
 * 条目目录的 manifest.json：没有这个文件返回 null（＝没有阅读文本）；
 * 有但不是合法 JSON、或缺 versions 数组，**抛错**——不能当没有文本悄悄放过：
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

/**
 * 章文件名：新结构 index 里 file 不带扩展名（'001'，guji-format 规格；book-text 全部 11,385 份 index.json 实测 0 个带扩展名），
 * 返回源仓里的 .md 文件名。不再容忍带扩展名的写法：带了会得到 '001.md.md'，构建期核对（verifyReadProbes）会失败而不是静默放过。
 */
export function chapterMdFile(file) {
    return `${file}.md`;
}

/** 打包产物里的章文件名（md 改 txt） */
export function chapterTxtFile(file) {
    return chapterMdFile(file).replace(/\.md$/, '.txt');
}

/** `<key>/index.json` 的第一章 → { file, hasJson[, charFile] }（对读章声明 char_file）；没有章返回 null */
export function firstChapterOf(indexDoc) {
    const ch = Array.isArray(indexDoc?.chapters) ? indexDoc.chapters.find((c) => typeof c?.file === 'string' && c.file) : null;
    if (!ch) return null;
    const first = { file: ch.file, hasJson: ch.has_json === true };
    if (typeof ch.char_file === 'string' && ch.char_file) first.charFile = ch.char_file;
    return first;
}

/**
 * 新结构条目的可读性（阅读首页判据，与 #306 同一思路：站内真有正文）：
 * manifest 存在、有可公开版本，且每个公开版本的 index.json 章目录非空才算这个版本可读；一份可读版本都没有就不可读。
 * 返回 null（不可读）或 { versions: [{ key, kind, first: { file, hasJson } }], collated, defaultFirst }。
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
            const stem = c.file; // file 不带扩展名（同 chapterMdFile）
            const jsonPath = join(itemDir, v.key, `${stem}.json`);
            if (existsSync(jsonPath)) out.push({ key: v.key, stem, jsonPath });
        }
    }
    return out;
}
