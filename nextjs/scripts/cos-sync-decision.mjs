#!/usr/bin/env node
/**
 * cos-sync-decision.mjs — 部署里「COS 数据同步要不要做」的判定与收尾（overview#293 第 2 项）。
 * 纯逻辑在 lib/cos-sync-decision.mjs（有单测），这里只负责联网读写。
 *
 * 子命令（都读 COS_SECRET_ID／COS_SECRET_KEY／COS_BUCKET／COS_REGION／COS_PATH_PREFIX）：
 *   decide       比对这次要发的（三仓 commit＋打包脚本指纹）与线上的同步标记、latest.json，
 *                写 GITHUB_OUTPUT：skip=true|false。任何读不到／对不上都是 skip=false，本命令永远 exit 0。
 *                需要环境变量 PROD_COMMIT／TEXT_COMMIT（workflow 里用 git rev-parse HEAD 取）。
 *   latest-only  数据没变时：以线上 latest.json 为底只改 webCommitId 写回（其它字段不丢）。失败 exit 1
 *                （workflow 里失败就退回照常同步）。需要 WEB_COMMIT_ID。
 *   mark         三次同步都成功后写同步标记 _deploy/sync-marker.json。需要上面三个 commit＋WEB_COMMIT_ID。
 *
 * 只写 latest.json 与 _deploy/sync-marker.json 两个对象，不碰 current/、v/、h1/。
 */
import { createRequire } from 'node:module';
import { appendFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    computeBundleFingerprint, decideSync, buildMarker, mergeLatestForUnchangedData, markerKey, latestKey,
} from './lib/cos-sync-decision.mjs';

const require = createRequire(import.meta.url);
const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..');

const { COS_SECRET_ID, COS_SECRET_KEY, COS_BUCKET } = process.env;
const REGION = process.env.COS_REGION || 'ap-shanghai';
const PREFIX = (process.env.COS_PATH_PREFIX || '').replace(/^\/+|\/+$/g, '');
const LATEST_CACHE = 'public, max-age=30, must-revalidate'; // 与 sync-to-cos.mjs 写 latest.json 的一致

function setOutput(k, v) {
    console.log(`· output ${k}=${v}`);
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${k}=${v}\n`);
}

function currentInputs() {
    return {
        // overview#432 起 fullCommitId 即正式仓 commit（草稿仓不再参与），与 latest.json 同口径
        fullCommitId: process.env.PROD_COMMIT || '',
        productionCommitId: process.env.PROD_COMMIT || '',
        textCommitId: process.env.TEXT_COMMIT || '',
        bundleFingerprint: computeBundleFingerprint(REPO_ROOT),
    };
}

function makeCos() {
    for (const [k, v] of Object.entries({ COS_SECRET_ID, COS_SECRET_KEY, COS_BUCKET })) {
        if (!v) throw new Error(`缺环境变量 ${k}`);
    }
    const COS = require('cos-nodejs-sdk-v5');
    return new COS({ SecretId: COS_SECRET_ID, SecretKey: COS_SECRET_KEY, Timeout: 30 * 1000 });
}

/** 读一个 JSON 对象；不存在返回 null，其它错误抛出 */
async function getJson(cos, key) {
    try {
        const res = await new Promise((ok, ng) => cos.getObject({ Bucket: COS_BUCKET, Region: REGION, Key: key }, (e, d) => (e ? ng(e) : ok(d))));
        return JSON.parse(res.Body.toString('utf-8'));
    } catch (e) {
        if (e && (e.statusCode === 404 || e.code === 'NoSuchKey')) return null;
        throw e;
    }
}

async function putJson(cos, key, obj, cacheControl) {
    await new Promise((ok, ng) => cos.putObject({
        Bucket: COS_BUCKET, Region: REGION, Key: key,
        Body: Buffer.from(JSON.stringify(obj, null, 2) + '\n', 'utf-8'),
        ContentType: 'application/json; charset=utf-8',
        CacheControl: cacheControl,
    }, (e) => (e ? ng(e) : ok())));
}

async function decide() {
    let skip = false;
    let reason;
    try {
        const cur = currentInputs();
        const cos = makeCos();
        const [marker, latest] = await Promise.all([getJson(cos, markerKey(PREFIX)), getJson(cos, latestKey(PREFIX))]);
        ({ skip, reason } = decideSync({ marker, latest, current: cur }));
        console.log(`· 这次：prod=${cur.productionCommitId.slice(0, 12)} text=${cur.textCommitId.slice(0, 12)} 脚本指纹=${cur.bundleFingerprint.slice(0, 12)}`);
        if (marker) console.log(`· 上次完整同步：prod=${String(marker.productionCommitId).slice(0, 12)} text=${String(marker.textCommitId).slice(0, 12)} 脚本指纹=${String(marker.bundleFingerprint).slice(0, 12)}（${marker.syncedAt}）`);
    } catch (e) {
        skip = false;
        reason = `比对失败（${e && e.message}），按有变化处理`;
    }
    console.log(skip ? `✅ 数据没变，跳过三次 COS 数据同步：${reason}` : `· 照常同步 COS：${reason}`);
    setOutput('skip', String(skip));
}

async function latestOnly() {
    const web = process.env.WEB_COMMIT_ID || '';
    const cos = makeCos();
    const remote = await getJson(cos, latestKey(PREFIX));
    const next = mergeLatestForUnchangedData(remote, { webCommitId: web });
    await putJson(cos, latestKey(PREFIX), next, LATEST_CACHE);
    console.log(`✓ latest.json 已更新：webCommitId=${web.slice(0, 12)}（其余字段沿用线上：commitId=${next.commitId} cacheKey=${next.cacheKey}）`);
}

async function mark() {
    const cos = makeCos();
    const m = buildMarker(currentInputs(), { webCommitId: process.env.WEB_COMMIT_ID || '' });
    await putJson(cos, markerKey(PREFIX), m, 'no-store');
    console.log(`✓ 同步标记已写：${markerKey(PREFIX)}（脚本指纹 ${m.bundleFingerprint.slice(0, 12)}）`);
}

const cmd = process.argv[2];
const table = { decide, 'latest-only': latestOnly, mark };
if (!table[cmd]) {
    console.error(`用法：node scripts/cos-sync-decision.mjs <${Object.keys(table).join('|')}>`);
    process.exit(2);
}
table[cmd]().catch((e) => {
    console.error(`❌ ${cmd} 失败：${e && e.message}`);
    process.exit(1);
});
