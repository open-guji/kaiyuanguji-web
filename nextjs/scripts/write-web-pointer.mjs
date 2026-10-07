#!/usr/bin/env node
/**
 * write-web-pointer.mjs — 部署成功后写代码指针 web.json（overview#470 P1，见 lib/web-pointer.mjs）。
 * 读 COS_SECRET_ID／COS_SECRET_KEY／COS_BUCKET／COS_REGION／COS_PATH_PREFIX（测试站是 staging）、
 * WEB_COMMIT_ID（完整 commit）、GITHUB_RUN_ID。只写 [staging/]web.json 一个对象，不碰别的。失败 exit 1。
 */
import { createRequire } from 'node:module';
import { buildWebPointer, webPointerKey } from './lib/web-pointer.mjs';

const require = createRequire(import.meta.url);
const { COS_SECRET_ID, COS_SECRET_KEY, COS_BUCKET, WEB_COMMIT_ID, GITHUB_RUN_ID } = process.env;
const REGION = process.env.COS_REGION || 'ap-shanghai';
const PREFIX = process.env.COS_PATH_PREFIX || '';

async function main() {
    for (const [k, v] of Object.entries({ COS_SECRET_ID, COS_SECRET_KEY, COS_BUCKET })) {
        if (!v) throw new Error(`缺环境变量 ${k}`);
    }
    const ptr = buildWebPointer({ webCommitId: WEB_COMMIT_ID, runId: GITHUB_RUN_ID });
    const COS = require('cos-nodejs-sdk-v5');
    const cos = new COS({ SecretId: COS_SECRET_ID, SecretKey: COS_SECRET_KEY, Timeout: 30 * 1000 });
    const key = webPointerKey(PREFIX);
    await new Promise((ok, ng) => cos.putObject({
        Bucket: COS_BUCKET, Region: REGION, Key: key,
        Body: Buffer.from(JSON.stringify(ptr, null, 2) + '\n', 'utf-8'),
        ContentType: 'application/json; charset=utf-8',
        CacheControl: 'public, max-age=30, must-revalidate', // 与 latest.json 一致
    }, (e) => (e ? ng(e) : ok())));
    console.log(`✓ ${key} 已写：webCommitId=${ptr.webCommitId.slice(0, 12)} deployedAt=${ptr.deployedAt} runId=${ptr.runId}`);
}

main().catch((e) => {
    console.error(`❌ 写代码指针失败：${e && e.message}`);
    process.exit(1);
});
