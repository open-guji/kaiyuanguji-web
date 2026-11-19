#!/usr/bin/env node
/**
 * 精校页读者侧冒烟（GUJI-730 P0-2）：proofing-sync 发布之后跑，也可单独跑。
 *   PROOF_STAGING=1  看 staging 前缀（演练）；数据域名取 config/hosts.json
 *   ONLY=书/章,…     只严查所指章节（图也查）；别章只看单子 rev，有问题只告警不失败
 * 有问题退出码 1；只出计数和文件名（公开仓）。
 */
import { appendFileSync } from 'node:fs';
import { DATA_ORIGIN } from '../../config/hosts.mjs';
import { runProofingSmoke } from './lib/proofing-smoke.mjs';
import { onlyFilter } from './lib/proofing-sync-run.mjs';

const base = DATA_ORIGIN.replace(/\/$/, '') + (process.env.PROOF_STAGING === '1' ? '/staging' : '');
const fetchFn = async (url, { method, range }) => {
    const r = await fetch(url, { method, headers: { 'User-Agent': 'kaiyuanguji-web/proofing-smoke', ...(range ? { Range: 'bytes=0-0' } : {}) } });
    if (range) await r.arrayBuffer().catch(() => null);   // 读完放掉连接
    return r;
};
const only = onlyFilter(process.env.ONLY);
const { lists, images, problems, warnings } = await runProofingSmoke({ base, fetchFn, only });
const lines = [`精校页冒烟（${base}）：在线待审单 ${lists} 张，引用图 ${images} 张，问题 ${problems.length} 个`,
    ...problems.slice(0, 50).map((p) => `- ${p}`), ...(problems.length > 50 ? [`- …另 ${problems.length - 50} 个`] : []),
    ...(warnings.length ? [`范围外章节告警 ${warnings.length} 个（不算失败）：`, ...warnings.slice(0, 20).map((p) => `- ${p}`)] : [])];
for (const w of warnings) console.log(`::warning::${w}`);
console.log(lines.join('\n'));
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, lines.join('\n') + '\n');
process.exit(problems.length ? 1 : 0);
