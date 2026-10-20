/**
 * reader-files.mjs — 对读章的阅读器瘦身副本（GUJI-700 P1-2）。
 *
 * 阅读页直接读 CV 产出的真源文件，其中大量字段阅读器用不到。样本章 96mid1ogzk/002：
 *   cord 3.25MB（br 573KB）→ 1.28MB（br 202KB）；punct 1.44MB（br 55KB）→ 0.59MB（br 34KB）。
 * 打包时按章另写一份「同结构、只留阅读器读的字段」的副本，放在版本目录，产物 index.json 章条目记
 * `reader_cord_file`／`reader_punct_file`。原文件与原字段（cord_file／punct_file）一律不动——校对页等照旧读原文件；
 * 阅读页优先读副本，取不到再回落原文件（lib/duidu-data.ts）。副本仍是原 schema 的合法子集，读法不用改。
 *
 * 留哪些字段，以 book-index-ui 的读法为准（改那边的读法时同步这里，测试里有往返一致性检查）：
 *   cord：adaptCharCord 读 pages[].page、canvas{seq,width,height}、image{width,height}（canvas 缺尺寸时兜底）、
 *         cells[].a＋box；iiifVolumeOf 读 canvas.id。producers／regions／columns／marks、cell.id、image.sha256 不要。
 *   punct：adaptPunctJson 读 anchor、mark、kind、pos、pre_char、label、toc、id；source、char_offset、顶层 metadata／stats 不要。
 * entity 不做：ui 的 span 偏移量在用，能删的只剩 source 等，br 后省不到 20KB，不值得多一份文件。
 */
import { existsSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const READER_CORD_SUFFIX = '.cord.reader.json';
export const READER_PUNCT_SUFFIX = '.punct.reader.json';
const SAFE_FILE = /^[\w.-]+$/;

function pick(obj, keys) {
    const out = {};
    for (const k of keys) if (obj && obj[k] !== undefined) out[k] = obj[k];
    return out;
}

/** cord → 阅读器副本 */
export function slimCord(cord) {
    const top = {};
    for (const [k, v] of Object.entries(cord ?? {})) if (k !== 'pages' && (v === null || typeof v !== 'object')) top[k] = v;
    const pages = (Array.isArray(cord?.pages) ? cord.pages : []).map((p) => {
        const out = pick(p, ['page']);
        if (p?.canvas && typeof p.canvas === 'object') out.canvas = pick(p.canvas, ['id', 'seq', 'width', 'height']);
        if (p?.image && typeof p.image === 'object') {
            const image = pick(p.image, ['width', 'height']);
            if (Object.keys(image).length > 0) out.image = image;
        }
        out.cells = (Array.isArray(p?.cells) ? p.cells : [])
            .filter((c) => typeof c?.a === 'string' && Array.isArray(c.box))
            .map((c) => ({ a: c.a, box: c.box }));
        return out;
    });
    return { ...top, pages };
}

/** punct → 阅读器副本 */
export function slimPunct(punct) {
    const out = {};
    for (const [k, v] of Object.entries(punct ?? {})) {
        if (k === 'metadata' || k === 'stats') continue;
        if (k === 'punctuations' && Array.isArray(v)) {
            out.punctuations = v.map((p) => {
                if (!p || typeof p !== 'object') return p;
                const { source: _s, char_offset: _o, ...rest } = p;
                return rest;
            });
        } else {
            out[k] = v;
        }
    }
    return out;
}

function readJsonOrNull(p) {
    try { return JSON.parse(readFileSync(p, 'utf-8')); } catch { return null; }
}

function writeIfChanged(path, text) {
    if (existsSync(path) && readFileSync(path, 'utf-8') === text) return;
    writeFileSync(path, text);
}

/**
 * 一个条目输出目录：给各版本里的对读章写副本、回写 index.json；删掉不再对应任何章的旧副本。
 * 返回写了副本的文件数。
 */
export function buildItemReaderFiles(itemOutDir) {
    let written = 0;
    if (!existsSync(itemOutDir)) return 0; // 整个条目 internal：copyItemDir 不建输出目录
    for (const name of readdirSync(itemOutDir)) {
        const dir = join(itemOutDir, name);
        const indexPath = join(dir, 'index.json');
        if (!statSync(dir).isDirectory() || !existsSync(indexPath)) continue;
        const raw = readFileSync(indexPath, 'utf-8');
        let index;
        try { index = JSON.parse(raw); } catch { continue; }
        if (!Array.isArray(index?.chapters)) continue;
        const keep = new Set();
        let changed = false;
        for (const ch of index.chapters) {
            if (!ch || typeof ch !== 'object' || typeof ch.char_file !== 'string' || typeof ch.file !== 'string' || !SAFE_FILE.test(ch.file)) continue;
            for (const [srcKey, dstKey, suffix, slim] of [
                ['cord_file', 'reader_cord_file', READER_CORD_SUFFIX, slimCord],
                ['punct_file', 'reader_punct_file', READER_PUNCT_SUFFIX, slimPunct],
            ]) {
                const src = ch[srcKey];
                const data = typeof src === 'string' && SAFE_FILE.test(src) ? readJsonOrNull(join(dir, src)) : null;
                const file = data ? `${ch.file}${suffix}` : undefined;
                if (data) {
                    writeIfChanged(join(dir, file), JSON.stringify(slim(data)));
                    keep.add(file);
                    written++;
                }
                if (ch[dstKey] !== file) {
                    changed = true;
                    if (file) ch[dstKey] = file;
                    else delete ch[dstKey];
                }
            }
        }
        if (changed) writeFileSync(indexPath, `${JSON.stringify(index, null, 2)}\n`);
        for (const f of readdirSync(dir)) {
            if ((f.endsWith(READER_CORD_SUFFIX) || f.endsWith(READER_PUNCT_SUFFIX)) && !keep.has(f)) unlinkSync(join(dir, f));
        }
    }
    return written;
}
