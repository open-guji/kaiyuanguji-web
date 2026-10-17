/**
 * sprites-sync.mjs — 校对精灵图同步的纯逻辑（GUJI-557，夹具版）：不联网、不读盘，取资源由调用方注入。
 *
 * 流程：指针（book-text proof/<书>/<册>/sprites.pointer.json）→ 取 manifest 并核对 sha256 → 取全部 webp，
 * 逐个核对字节数与 sha256、文件数＝total → 通过才允许上传。任何一项不符：整册不传，只返回 problems。
 */
import { createHash } from 'node:crypto';

export const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

const POINTER_PATH_RE = /^proof\/([^/]+)\/([^/]+)\/sprites\.pointer\.json$/;
const FLAT_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*\.webp$/;   // 资产名是扁平文件名（Eliot 定）：不含目录，COS 目录取自指针所在目录

/** 从指针文件的相对路径取 {book, vol}；不是指针路径返回 null */
export function parsePointerPath(rel) {
    const m = POINTER_PATH_RE.exec(rel);
    return m ? { book: m[1], vol: m[2] } : null;
}

/** 指针内容是否合规 → 错误列表（空＝合规） */
export function checkPointer(p) {
    const errs = [];
    if (!p || typeof p !== 'object') return ['指针不是对象'];
    if (typeof p.tag !== 'string' || !/^[A-Za-z0-9._-]+$/.test(p.tag)) errs.push('tag 缺失或含非法字符');
    if (typeof p.manifest_sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(p.manifest_sha256)) errs.push('manifest_sha256 不是 64 位小写十六进制');
    return errs;
}

/**
 * 校验一册。
 * @param {{tag:string, manifest_sha256:string}} pointer
 * @param {{ fetchManifest:(tag:string)=>Promise<Buffer>, fetchFile:(tag:string, path:string)=>Promise<Buffer> }} src  可替换的取资源函数
 * @returns {Promise<{ok:boolean, files:{path:string, buf:Buffer, sha256:string}[], problems:string[]}>}
 */
export async function verifyVolume(pointer, src) {
    const problems = [];
    const bad = () => ({ ok: false, files: [], problems });
    const pe = checkPointer(pointer);
    if (pe.length) { problems.push(...pe); return bad(); }

    let mbuf;
    try { mbuf = await src.fetchManifest(pointer.tag); } catch (e) { problems.push(`取 manifest 失败：${e?.message || e}`); return bad(); }
    if (sha256(mbuf) !== pointer.manifest_sha256) { problems.push('manifest sha256 与指针不符'); return bad(); }
    let m;
    try { m = JSON.parse(mbuf.toString('utf8')); } catch { problems.push('manifest 不是合法 JSON'); return bad(); }
    if (!Array.isArray(m.files)) { problems.push('manifest.files 不是数组'); return bad(); }
    if (m.total !== m.files.length) problems.push(`文件数 ${m.files.length} ≠ total ${m.total}`);

    const files = [];
    const seen = new Set();
    for (const f of m.files) {
        if (typeof f?.path !== 'string' || !FLAT_NAME_RE.test(f.path)) { problems.push(`路径不合约定：${f?.path}`); continue; }
        if (seen.has(f.path)) { problems.push(`重复路径：${f.path}`); continue; }
        seen.add(f.path);
        let buf;
        try { buf = await src.fetchFile(pointer.tag, f.path); } catch (e) { problems.push(`取文件失败 ${f.path}：${e?.message || e}`); continue; }
        if (buf.length !== f.bytes) { problems.push(`${f.path} 字节数 ${buf.length} ≠ manifest ${f.bytes}`); continue; }
        const h = sha256(buf);
        if (h !== f.sha256) { problems.push(`${f.path} sha256 不符`); continue; }
        files.push({ path: f.path, buf, sha256: h });
    }
    return problems.length ? bad() : { ok: true, files, problems };
}

/** 上传计划：已在 state 里且 sha256 相同的跳过。state: Map<cosKey, sha256> */
export function planUpload(prefix, book, vol, files, state) {
    const base = [prefix, 'proof', book, vol].filter(Boolean).join('/') + '/';
    const upload = [], skip = [];
    for (const f of files) {
        const key = base + f.path;
        (state.get(key) === f.sha256 ? skip : upload).push({ key, ...f });
    }
    return { upload, skip };
}
