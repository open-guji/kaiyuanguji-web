/**
 * cos-put.mjs — 往 COS 写一个内存里的对象：小的单 PUT，大的写临时文件后走 SDK 的分块上传。
 *
 * cos-nodejs-sdk-v5 的 `uploadFile` 只认本地文件路径 `FilePath`，不接受 `Body`（给 Body 会在内部读文件时
 * 报 `The "path" argument must be of type string ... Received undefined`——2026-10-08 staging 第 2 次演练的失败原因）。
 * 所以大对象先落到临时文件再传，传完（无论成败）删掉临时文件。
 */
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const MULTIPART_THRESHOLD = 1024 * 1024;

/**
 * @param cos   COS SDK 实例（要有 putObject、uploadFile）
 * @param call  (fn, args) => Promise，负责带上 Bucket／Region 并把回调转成 Promise
 */
export function makePut(cos, call, { threshold = MULTIPART_THRESHOLD, tmp = tmpdir() } = {}) {
    return async function put(Key, Body, { contentType, cacheControl }) {
        if (Body.length <= threshold) {
            return call(cos.putObject, { Key, Body, ContentType: contentType, CacheControl: cacheControl });
        }
        const dir = mkdtempSync(join(tmp, 'cos-put-'));
        try {
            const FilePath = join(dir, 'body');
            writeFileSync(FilePath, Body);
            return await call(cos.uploadFile, {
                Key, FilePath, ContentType: contentType, CacheControl: cacheControl,
                SliceSize: threshold, ChunkSize: threshold, ChunkRetryTimes: 4, onProgress: () => {},
            });
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    };
}
