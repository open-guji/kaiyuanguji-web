#!/usr/bin/env node
/**
 * 精校页读者侧冒烟（GUJI-730 P0-2）：proofing-sync 发布之后跑，也可单独跑。
 *   PROOF_STAGING=1  看 staging 前缀（演练）；数据域名取 config/hosts.json
 * 有问题退出码 1；只出计数和文件名（公开仓）。
 */
import { appendFileSync } from 'node:fs';
import { DATA_ORIGIN } from '../../config/hosts.mjs';
import { runProofingSmoke } from './lib/proofing-smoke.mjs';

const base = DATA_ORIGIN.replace(/\/$/, '') + (process.env.PROOF_STAGING === '1' ? '/staging' : '');
const fetchFn = async (url, { method, range }) => {
    const r = await fetch(url, { method, headers: { 'User-Agent': 'kaiyuanguji-web/proofing-smoke', ...(range ? { Range: 'bytes=0-0' } : {}) } });
    if (range) await r.arrayBuffer().catch(() => null);   // 读完放掉连接
    return r;
};
const { lists, images, problems } = await runProofingSmoke({ base, fetchFn });
const lines = [`精校页冒烟（${base}）：在线待审单 ${lists} 张，引用图 ${images} 张，问题 ${problems.length} 个`,
    ...problems.slice(0, 50).map((p) => `- ${p}`), ...(problems.length > 50 ? [`- …另 ${problems.length - 50} 个`] : [])];
console.log(lines.join('\n'));
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, lines.join('\n') + '\n');
process.exit(problems.length ? 1 : 0);
