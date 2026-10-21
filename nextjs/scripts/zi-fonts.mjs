#!/usr/bin/env node
/**
 * zi-fonts.mjs — 扩展区生僻字静态分片（GUJI-721 第 2 步；说明见 scripts/lib/zi-fonts.mjs）。
 *
 *   node scripts/zi-fonts.mjs gen    换字体版本、改切法或改数据域名后跑：现裁分片，重写 src/app/zi-fonts.css
 *                                    与 src/lib/zi-coverage.generated.ts（两个都入库）。要 JIGMO_DIR、KYG_FONT_PYTHON
 *                                    （ops/setup-chapter-fonts.sh 装的；本地也可以 npm pack fontpkg-jigmo 取 TTF）。
 *   node scripts/zi-fonts.mjs sync   部署时跑（deploy.yml）：入库 CSS 列的块 COS 上都有就什么也不做；缺了才装依赖、现裁、
 *                                    与入库 CSS 逐条对账（对不上就失败），再传缺的块（font/woff2，1 年 immutable）。
 *                                    要 COS_SECRET_ID／COS_SECRET_KEY／COS_BUCKET（COS_REGION 缺省 ap-shanghai）。
 *                                    不管 COS_PATH_PREFIX：CSS 写的是正式数据域名，测试站也从这里取，文件名是内容哈希，只增不改。
 */
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FONT_RANGES } from './lib/chapter-fonts.mjs';
import { IMMUTABLE_CACHE, cssDir, diffParts, parseCss, planSync, renderCoverageTs, renderCss } from './lib/zi-fonts.mjs';
import { createCosOps, requireCosSdk, runQueue } from './lib/h1-sync-core.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '../..');
const CSS_FILE = join(ROOT, 'nextjs/src/app/zi-fonts.css');
const COVERAGE_FILE = join(ROOT, 'nextjs/src/lib/zi-coverage.generated.ts');
const DATA_ORIGIN = JSON.parse(readFileSync(join(ROOT, 'config/hosts.json'), 'utf-8')).data;

function generate(outDir, { jigmoDir, python }) {
    const r = spawnSync(python, [join(__dirname, 'zi-fonts.py'), jigmoDir, outDir, JSON.stringify(FONT_RANGES)],
        { encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'inherit'] });
    if (r.status !== 0) throw new Error(`zi-fonts.py 失败（退出码 ${r.status}）`);
    return JSON.parse(r.stdout);
}

function fontTools() {
    if (process.env.JIGMO_DIR && process.env.KYG_FONT_PYTHON) return { jigmoDir: process.env.JIGMO_DIR, python: process.env.KYG_FONT_PYTHON };
    // CI 里没先跑 setup 时自己装（与 setup-chapter-fonts.sh 的落点一致）
    const r = spawnSync('bash', [join(ROOT, 'ops/setup-chapter-fonts.sh')], { stdio: 'inherit' });
    if (r.status !== 0) throw new Error('ops/setup-chapter-fonts.sh 失败');
    const d = join(process.env.RUNNER_TEMP || '/tmp', 'chapter-fonts');
    return { jigmoDir: join(d, 'jigmo'), python: join(d, 'venv/bin/python') };
}

async function gen() {
    const out = mkdtempSync(join(tmpdir(), 'zi-fonts-'));
    const t0 = Date.now();
    const parts = generate(out, fontTools());
    writeFileSync(CSS_FILE, renderCss(parts, DATA_ORIGIN));
    writeFileSync(COVERAGE_FILE, renderCoverageTs(parts));
    console.log(`✔ ${parts.length} 块 → ${out}（${((Date.now() - t0) / 1000).toFixed(0)}s）；已写 zi-fonts.css、zi-coverage.generated.ts`);
}

async function sync() {
    const cssParts = parseCss(readFileSync(CSS_FILE, 'utf-8'));
    if (!cssParts.length) throw new Error('zi-fonts.css 里没有 @font-face');
    for (const k of ['COS_SECRET_ID', 'COS_SECRET_KEY', 'COS_BUCKET']) if (!process.env[k]) throw new Error(`缺 ${k}`);
    const COS = requireCosSdk();
    const cos = new COS({ SecretId: process.env.COS_SECRET_ID, SecretKey: process.env.COS_SECRET_KEY, Timeout: 60 * 1000 });
    const ops = createCosOps({ cos, bucket: process.env.COS_BUCKET, region: process.env.COS_REGION || 'ap-shanghai' });
    const remote = await ops.listPrefixEtags(cssDir(cssParts, DATA_ORIGIN));
    const { dir, missing } = planSync(cssParts, new Set(remote.keys()), DATA_ORIGIN);
    console.log(`· zi-fonts：CSS ${cssParts.length} 块，COS ${dir} 已有 ${remote.size}，缺 ${missing.length}`);
    if (!missing.length) return;

    const out = mkdtempSync(join(tmpdir(), 'zi-fonts-'));
    const generated = generate(out, fontTools());
    const errs = diffParts(cssParts, generated, DATA_ORIGIN);
    if (errs.length) throw new Error(`现裁的分片与入库 zi-fonts.css 对不上（字体或工具版本变了？重跑 gen 并提交）：\n  ${errs.join('\n  ')}`);
    let failed = 0;
    await runQueue(missing, 8, async (file) => {
        const full = join(out, file);
        if (!existsSync(full)) { failed++; console.error(`::error::现裁结果里没有 ${file}`); return; }
        try {
            await ops.uploadOne({ full }, dir + file, IMMUTABLE_CACHE, 'font/woff2');
        } catch (e) {
            failed++; console.error(`::error::上传失败 ${file}：${e?.message || e}`);
        }
    }, 'zi-fonts');
    if (failed) throw new Error(`${failed} 块没传上`);
    console.log(`✔ zi-fonts：传了 ${missing.length} 块`);
}

const cmd = process.argv[2];
try {
    if (cmd === 'gen') await gen();
    else if (cmd === 'sync') await sync();
    else { console.error('用法：node scripts/zi-fonts.mjs gen|sync'); process.exit(2); }
} catch (e) {
    console.error(`❌ ${e.message}`);
    process.exit(1);
}
