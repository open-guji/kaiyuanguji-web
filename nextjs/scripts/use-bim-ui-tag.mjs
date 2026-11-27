#!/usr/bin/env node
/**
 * 构建时按 npm dist-tag 取 book-index-ui（CI 在 `npm ci` 之后调用）：
 *   node scripts/use-bim-ui-tag.mjs <latest|stable|next|版本号>
 *
 *  - 测试站构建用 latest，正式站（含 prod-artifact）用 stable：UI 发新版后网站不用改依赖、不用发网站版。
 *  - 用 --no-save 安装：不改 package.json／package-lock.json，只换 node_modules 里的那份。
 *  - 标签不存在（比如 stable 还没人设）时退回锁文件里的版本并告警，不让流水线断。
 *  - 实际版本由 next.config.ts 从 node_modules 读出，写进 /api/version 的 bimUi 与 promote-manifest，可追溯。
 *  - 未传参数或 BIM_UI_TAG=lock：什么也不做（用锁文件）。
 */
import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';

const tag = (process.argv[2] ?? process.env.BIM_UI_TAG ?? '').trim();
const pkg = JSON.parse(readFileSync('package.json', 'utf-8'));
const lockSpec = pkg.dependencies?.['book-index-ui'] ?? '';
const out = (s) => { console.log(s); if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, s + '\n'); };

if (!tag || tag === 'lock') { out(`book-index-ui：用锁文件版本（${lockSpec}）`); process.exit(0); }
if (!/^[A-Za-z0-9._-]+$/.test(tag)) { console.error(`非法标签/版本：${tag}`); process.exit(1); }

const npm = (args) => execFileSync('npm', args, { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'inherit'] }).trim();

let version = '';
try { version = npm(['view', `book-index-ui@${tag}`, 'version', '--prefer-online']).split('\n').pop().trim(); } catch { /* 标签不存在 */ }
if (!version) {
  out(`⚠ book-index-ui 的 dist-tag「${tag}」不存在，退回锁文件版本（${lockSpec}）。设好标签后下次构建才会生效。`);
  process.exit(0);
}
npm(['install', `book-index-ui@${version}`, '--no-save', '--no-audit', '--no-fund', '--ignore-scripts']);
out(`book-index-ui：标签 ${tag} → ${version}（锁文件为 ${lockSpec}）`);
