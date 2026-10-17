#!/usr/bin/env node
/**
 * sync-proof-sprites.mjs — 校对精灵图同步（GUJI-557）
 *
 * 读指针 <POINTER_ROOT>/proof/<书>/<册>/sprites.pointer.json（book-text 里，{tag, manifest_sha256, rev}），逐册校验后（见 lib/sprites-sync.mjs）
 * 计划上传到 [前缀/]proof/<书>/<册>/<文件名>（目录取自指针所在目录，清单与 Release 资产都是扁平文件名）。
 * **只做演练：不连 COS、不用密钥**；真上传另走现有 COS 同步（上线前先 staging 演练）。
 *
 * 取资源两种来源（取清单／取文件两个函数，可互换）：
 *   · SPRITES_RELEASE_REPO=owner/repo：按 tag 匿名下载 GitHub Release 资产（清单 assets.json ＋ 各 webp），公开仓，不需要令牌；
 *   · SPRITES_SOURCE_DIR=<夹具根>：其下 book-text/ 放指针、releases/<tag>/ 放清单与 webp（测试用，同时是指针根）。
 *
 * 某册校验不过：该册不传，打 ::warning:: 并写进 run 摘要；脚本仍以 0 退出（非阻塞任务，不让整次 run 变红）。
 * 没有任何指针：正常，直接成功。
 *
 * 环境变量：SPRITES_SOURCE_DIR 或（SPRITES_RELEASE_REPO ＋ SPRITES_POINTER_ROOT）、
 *   COS_PATH_PREFIX（上传前缀，可空）、SPRITES_STATE（已传状态文件，可选，{key: sha256}）
 * 用法：SPRITES_SOURCE_DIR=scripts/fixtures/sprites node scripts/sync-proof-sprites.mjs
 *       SPRITES_RELEASE_REPO=open-guji/open-guji-dataset SPRITES_POINTER_ROOT=../book-text node scripts/sync-proof-sprites.mjs
 */
import { readFileSync, readdirSync, statSync, existsSync, appendFileSync, writeFileSync } from 'node:fs';
import { join, resolve, posix } from 'node:path';
import { verifyVolume, planUpload, parsePointerPath, MANIFEST_NAME } from './lib/sprites-sync.mjs';

const SRC = process.env.SPRITES_SOURCE_DIR ? resolve(process.env.SPRITES_SOURCE_DIR) : '';
const REPO = process.env.SPRITES_RELEASE_REPO || '';
const POINTER_ROOT = SRC ? join(SRC, 'book-text') : resolve(process.env.SPRITES_POINTER_ROOT || '');
const PREFIX = (process.env.COS_PATH_PREFIX || '').replace(/^\/+|\/+$/g, '');
const STATE = process.env.SPRITES_STATE || '';

if (!SRC && !(REPO && process.env.SPRITES_POINTER_ROOT)) { console.error('❌ 需要 SPRITES_SOURCE_DIR，或 SPRITES_RELEASE_REPO＋SPRITES_POINTER_ROOT'); process.exit(1); }
if (SRC && !existsSync(SRC)) { console.error('❌ SPRITES_SOURCE_DIR 不存在'); process.exit(1); }
if (REPO && !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(REPO)) { console.error('❌ SPRITES_RELEASE_REPO 格式应为 owner/repo'); process.exit(1); }

/** 本地夹具来源 */
const localSource = {
    fetchManifest: async (tag) => readFileSync(join(SRC, 'releases', tag, MANIFEST_NAME)),
    fetchFile: async (tag, name) => readFileSync(join(SRC, 'releases', tag, name)),
};

/** GitHub Release 匿名下载（公开仓）；失败重试 2 次。tag／name 已由校验限定为安全字符 */
async function download(url) {
    let err;
    for (let i = 0; i < 3; i++) {
        try {
            const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(60_000) });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            return Buffer.from(await res.arrayBuffer());
        } catch (e) { err = e; await new Promise((r) => setTimeout(r, 1000 * (i + 1))); }
    }
    throw err;
}
const releaseSource = {
    fetchManifest: (tag) => download(`https://github.com/${REPO}/releases/download/${tag}/${MANIFEST_NAME}`),
    fetchFile: (tag, name) => download(`https://github.com/${REPO}/releases/download/${tag}/${name}`),
};
const source = SRC ? localSource : releaseSource;

function findPointers() {
    const base = POINTER_ROOT;
    const out = [];
    if (!existsSync(base)) return out;
    const walk = (dir) => {
        for (const name of readdirSync(dir)) {
            if (name === '.git') continue;
            const full = join(dir, name);
            if (statSync(full).isDirectory()) { walk(full); continue; }
            const rel = posix.join(...full.slice(base.length + 1).split(/[\\/]/));
            const id = parsePointerPath(rel);
            if (id) out.push({ ...id, full });
        }
    };
    walk(base);
    return out.sort((a, b) => (a.book + a.vol).localeCompare(b.book + b.vol));
}

const state = new Map(STATE && existsSync(STATE) ? Object.entries(JSON.parse(readFileSync(STATE, 'utf8'))) : []);
const summary = [`### sprites（演练：只算计划，不上传；来源 ${SRC ? '本地夹具' : REPO}）`];
const pointers = findPointers();
if (!pointers.length) {
    console.log('· 没有 sprites 指针，跳过（正常）');
    summary.push('没有指针，跳过。');
}
let okVols = 0, badVols = 0;
for (const p of pointers) {
    const id = `${p.book}/${p.vol}`;
    let pointer;
    try { pointer = JSON.parse(readFileSync(p.full, 'utf8')); } catch { pointer = null; }
    const r = await verifyVolume(pointer, source, { book: p.book, vol: p.vol });
    if (!r.ok) {
        badVols++;
        console.log(`::warning::sprites ${id} 校验未过，该册不上传：${r.problems.join('；')}`);
        summary.push(`- ⚠ \`${id}\` 校验未过，未上传：${r.problems.join('；')}`);
        continue;
    }
    okVols++;
    const plan = planUpload(PREFIX, p.book, p.vol, r.files, state);
    console.log(`· ${id}：${r.files.length} 个文件，待传 ${plan.upload.length}，跳过 ${plan.skip.length}（演练，不上传）`);
    for (const f of plan.upload) console.log(`  PUT ${f.key} (${f.buf.length} B)`);
    summary.push(`- ✓ \`${id}\`：${r.files.length} 个文件，待传 ${plan.upload.length}，跳过 ${plan.skip.length}`);
    if (STATE) for (const f of plan.upload) state.set(f.key, f.sha256);   // 演练也记 state，便于验证幂等；真传时改成上传成功后才记
}
if (STATE && pointers.length) writeFileSync(STATE, JSON.stringify(Object.fromEntries(state)));
summary.push(`通过 ${okVols} 册，未过 ${badVols} 册。`);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary.join('\n') + '\n');
