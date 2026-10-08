/**
 * cos-put.test.mjs — 大对象走 FilePath 分块、小对象单 PUT；假 SDK 严格按真 SDK 的约束（uploadFile 没有 FilePath 就抛错）。
 * 用法：node --test scripts/lib/cos-put.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makePut } from './cos-put.mjs';

function fakeCos() {
    const seen = { puts: [], uploads: [] };
    const cos = {
        putObject(args, cb) { seen.puts.push(args); cb(null, {}); },
        uploadFile(args, cb) {
            // 真 SDK：只认 FilePath，Body 会被忽略；FilePath 缺失时内部 fs 调用抛 "path ... undefined"
            if (typeof args.FilePath !== 'string') return cb(new TypeError('The "path" argument must be of type string or an instance of Buffer or URL. Received undefined'));
            seen.uploads.push({ ...args, content: readFileSync(args.FilePath), existedDuring: existsSync(args.FilePath) });
            cb(null, {});
        },
    };
    const call = (fn, args) => new Promise((ok, ng) => fn.call(cos, { Bucket: 'b', Region: 'r', ...args }, (e, d) => (e ? ng(e) : ok(d))));
    return { cos, call, seen };
}

const opts = { contentType: 'application/xml', cacheControl: 'public, max-age=300' };

test('小对象：单 PUT，不碰文件系统', async () => {
    const { cos, call, seen } = fakeCos();
    await makePut(cos, call, { threshold: 100 })('k', Buffer.alloc(100, 1), opts);
    assert.equal(seen.puts.length, 1);
    assert.equal(seen.uploads.length, 0);
    assert.equal(seen.puts[0].Key, 'k');
});

test('大对象：写临时文件、用 FilePath 分块上传、内容一致、传完删临时目录', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'cp-test-'));
    const { cos, call, seen } = fakeCos();
    const body = Buffer.alloc(101, 7);
    await makePut(cos, call, { threshold: 100, tmp })('big', body, opts);
    assert.equal(seen.puts.length, 0);
    assert.equal(seen.uploads.length, 1);
    const u = seen.uploads[0];
    assert.equal(u.Key, 'big');
    assert.equal('Body' in u, false);
    assert.ok(u.existedDuring);
    assert.deepEqual(u.content, body);
    assert.equal(u.SliceSize, 100);
    assert.equal(u.ContentType, 'application/xml');
    assert.equal(u.CacheControl, 'public, max-age=300');
    assert.deepEqual(readdirSync(tmp), [], '临时目录应已清掉');
});

test('分块上传失败：错误照抛，临时目录也清掉', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'cp-test-'));
    const cos = { uploadFile(_a, cb) { cb(new Error('boom')); }, putObject() {} };
    const call = (fn, args) => new Promise((ok, ng) => fn.call(cos, args, (e, d) => (e ? ng(e) : ok(d))));
    await assert.rejects(makePut(cos, call, { threshold: 10, tmp })('k', Buffer.alloc(11), opts), /boom/);
    assert.deepEqual(readdirSync(tmp), []);
});
