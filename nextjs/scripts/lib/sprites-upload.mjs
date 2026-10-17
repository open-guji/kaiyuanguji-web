/**
 * sprites-upload.mjs — 真上传一册精灵图（GUJI-557）。COS 操作、HEAD、并发队列都由调用方传入，便于用假实现测。
 * 与 COS 上 md5（ETag）相同的跳过；其余 PUT（1 年 immutable、image/webp）；全部成功后对前 3 个文件 HEAD 核长度。
 * 任何失败只记 ::warning::、计数，不抛（非阻塞）。
 */
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const IMMUTABLE_CACHE = 'public, max-age=31536000, immutable';
export const HEAD_CHECKS = 3;
const md5 = (b) => createHash('md5').update(b).digest('hex');

/** @param {{id:string, files:{key:string, buf:Buffer}[], remote:Map<string,string>, cosOps:{uploadOne:Function}, headLen:(key:string)=>Promise<number>, tmpDir:string, runQueue:Function, log:(m:string)=>void}} a */
export async function uploadVolume({ id, files, remote, cosOps, headLen, tmpDir, runQueue, log }) {
    const todo = [], r = { put: 0, same: 0, failed: 0, headBad: 0 };
    for (const f of files) {
        if (remote.get(f.key) === md5(f.buf)) r.same++; else todo.push(f);
    }
    await runQueue(todo, 8, async (f) => {
        const tmp = join(tmpDir, f.key.replace(/[\\/]/g, '_'));
        try {
            writeFileSync(tmp, f.buf);
            await cosOps.uploadOne({ full: tmp }, f.key, IMMUTABLE_CACHE, 'image/webp');
            r.put++;
        } catch (e) { r.failed++; log(`::warning::sprites ${id} 上传失败 ${f.key}：${e?.message || e}`); }
    }, 'sprites');
    if (!r.failed) {
        for (const f of files.slice(0, HEAD_CHECKS)) {
            try {
                const n = await headLen(f.key);
                if (n !== f.buf.length) { r.headBad++; log(`::warning::sprites ${id} HEAD 核对不符 ${f.key}：COS ${n} B ≠ 应有 ${f.buf.length} B`); }
            } catch (e) { r.headBad++; log(`::warning::sprites ${id} HEAD 失败 ${f.key}：${e?.message || e}`); }
        }
    }
    return r;
}
