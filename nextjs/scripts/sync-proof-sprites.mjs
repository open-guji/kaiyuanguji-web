#!/usr/bin/env node
/**
 * sync-proof-sprites.mjs — 校对精灵图同步（GUJI-557，夹具版）
 *
 * 读 SPRITES_SOURCE_DIR 下的指针 book-text/proof/<书>/<册>/sprites.pointer.json，逐册校验后（见 lib/sprites-sync.mjs）
 * 计划上传到 [前缀/]proof/<书>/<册>/<文件名>（目录取自指针所在目录，清单 path 是扁平文件名）。**本版只做演练：不连 COS、不用密钥**；
 * 真实源（open-guji-dataset Release proof-<书>-<册>-<n>）接入时只需换下面的 localSource（取 manifest／取文件两个函数）与上传一步。
 *
 * 某册校验不过：该册不传，打 ::warning:: 并写进 run 摘要；脚本仍以 0 退出（这是非阻塞任务，不让整次 run 变红）。
 * 没有任何指针：正常，直接成功。
 *
 * 环境变量：SPRITES_SOURCE_DIR（必填，夹具根；其下 book-text/ 放指针、releases/<tag>/ 放 manifest 与 webp）、
 *   COS_PATH_PREFIX（上传前缀，可空）、SPRITES_STATE（已传状态文件，可选，{key: sha256}）
 * 用法：SPRITES_SOURCE_DIR=scripts/fixtures/sprites node scripts/sync-proof-sprites.mjs
 */
import { readFileSync, readdirSync, statSync, existsSync, appendFileSync, writeFileSync } from 'node:fs';
import { join, resolve, posix } from 'node:path';
import { verifyVolume, planUpload, parsePointerPath } from './lib/sprites-sync.mjs';

const SRC = process.env.SPRITES_SOURCE_DIR ? resolve(process.env.SPRITES_SOURCE_DIR) : '';
const PREFIX = (process.env.COS_PATH_PREFIX || '').replace(/^\/+|\/+$/g, '');
const STATE = process.env.SPRITES_STATE || '';

if (!SRC || !existsSync(SRC)) { console.error('❌ SPRITES_SOURCE_DIR 未设或不存在'); process.exit(1); }

/** 可替换的"取资源"：本地夹具版。换成 Release 下载时只改这里 */
const localSource = {
    fetchManifest: async (tag) => readFileSync(join(SRC, 'releases', tag, 'sprites.manifest.json')),
    fetchFile: async (tag, path) => readFileSync(join(SRC, 'releases', tag, path)),
};

function findPointers() {
    const base = join(SRC, 'book-text');
    const out = [];
    if (!existsSync(base)) return out;
    const walk = (dir) => {
        for (const name of readdirSync(dir)) {
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
const summary = ['### sprites（演练：只算计划，不上传）'];
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
    const r = await verifyVolume(pointer, localSource);
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
