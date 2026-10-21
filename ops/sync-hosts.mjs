#!/usr/bin/env node
/**
 * 把 config/hosts.json（域名的唯一来源）同步到拿不到它的地方：
 *   - nextjs/src/lib/hosts.ts          网站代码（浏览器端要构建期内联）
 *   - edge-functions/api/hosts.js      边缘函数（部署时只拷 edge-functions/，读不到仓库根）
 *   - .github/workflows/*.yml          顶层 env 里的 HOST_* 一段（GitHub 表达式读不了文件）
 *
 * 跑法（仓库根目录）：
 *   node ops/sync-hosts.mjs            写入
 *   node ops/sync-hosts.mjs --check    只检查，不一致就退出码 1（ops/tests/hosts.test.mjs 用）
 *
 * 工作流：凡正文用到 HOST_ 变量的，顶层 env 里放一段生成的 HOST_*；没用到的不加。
 */
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const HOSTS = JSON.parse(readFileSync(join(ROOT, 'config/hosts.json'), 'utf-8'));

/** hosts.json 的键 → 代码里的常量名、工作流里的变量名 */
export const KEYS = [
    ['data', 'DATA_ORIGIN', 'HOST_DATA'],
    ['legacyData', 'LEGACY_DATA_ORIGIN', 'HOST_LEGACY_DATA'],
    ['api', 'API_ORIGIN', 'HOST_API'],
    ['legacyApi', 'LEGACY_API_ORIGIN', 'HOST_LEGACY_API'],
    ['site', 'SITE_ORIGIN', 'HOST_SITE'],
    ['siteApex', 'SITE_APEX_ORIGIN', 'HOST_SITE_APEX'],
    ['staging', 'STAGING_ORIGIN', 'HOST_STAGING'],
    ['legacySite', 'LEGACY_SITE_ORIGIN', 'HOST_LEGACY_SITE'],
    ['legacyApex', 'LEGACY_APEX_ORIGIN', 'HOST_LEGACY_APEX'],
    ['oauthIssuer', 'OAUTH_ISSUER', 'HOST_OAUTH_ISSUER'],
];

for (const [k] of KEYS) {
    if (!/^https:\/\/[a-z0-9.-]+$/.test(HOSTS[k] ?? '')) throw new Error(`config/hosts.json 的 ${k} 必须是 https://主机（无结尾斜杠）：${HOSTS[k]}`);
}

const HEADER = '由 ops/sync-hosts.mjs 从 config/hosts.json 生成，勿手改；改域名请改 config/hosts.json 后重跑';

function renderTs() {
    const lines = [`// ${HEADER}`, ''];
    for (const [k, name] of KEYS) lines.push(`export const ${name} = '${HOSTS[k]}';`);
    // 不导出「测试站数据前缀」：正式站产物闸（ops/check-edgeone-artifact.sh）靠 chunk 里没有 <数据域名>/staging 判断没混进测试站构建
    lines.push('', "/** 'https://data.example.com' → 'data.example.com' */", 'export const hostOf = (origin: string): string => new URL(origin).host;', '');
    return lines.join('\n');
}

function renderEdgeJs() {
    // 边缘函数目录下每个文件都会被当作路由编译；本文件没有 onRequest，只导出常量（同 feedback-classify.js）
    const lines = [`// ${HEADER}`, ''];
    for (const [k, name] of KEYS) lines.push(`export const ${name} = '${HOSTS[k]}';`);
    lines.push('', 'export const DATA_STAGING_ORIGIN = `${DATA_ORIGIN}/staging`;', '');
    lines.push('/** 本站页面的所有来源（新旧域名的 www 与裸域）；CORS 白名单用，第一个是不匹配时的回落值 */');
    lines.push('export const SITE_ORIGINS = [LEGACY_SITE_ORIGIN, LEGACY_APEX_ORIGIN, SITE_ORIGIN, SITE_APEX_ORIGIN];', '');
    return lines.join('\n');
}

const BEGIN = '  # >>> hosts：' + HEADER;
const END = '  # <<< hosts';

function renderBlock() {
    return [BEGIN, ...KEYS.map(([k, , v]) => `  ${v}: ${HOSTS[k]}`), END].join('\n');
}

/** 工作流文本 → 同步后的文本 */
export function syncWorkflow(src) {
    const block = renderBlock();
    const re = /^ {2}# >>> hosts[^\n]*\n[\s\S]*?^ {2}# <<< hosts$/m;
    const body = src.replace(re, '');
    if (!/\bHOST_[A-Z_]+\b/.test(body)) {
        if (!re.test(src)) return src;
        // 不再用到：删掉这一段；顶层 env 因此空了就连 env: 一起删
        return src.replace(new RegExp(re.source + '\\n', 'm'), '').replace(/^env:\n(?=\n|jobs:)/m, '');
    }
    if (re.test(src)) return src.replace(re, block);
    if (/^env:\s*$/m.test(src)) return src.replace(/^env:\s*$/m, `env:\n${block}`);
    if (!/^jobs:\s*$/m.test(src)) throw new Error('工作流没有顶层 jobs:');
    return src.replace(/^jobs:\s*$/m, `env:\n${block}\n\njobs:`);
}

export function plan() {
    const out = [
        ['nextjs/src/lib/hosts.ts', renderTs()],
        ['edge-functions/api/hosts.js', renderEdgeJs()],
    ];
    const wf = join(ROOT, '.github/workflows');
    for (const f of readdirSync(wf).filter((n) => n.endsWith('.yml')).sort()) {
        const p = `.github/workflows/${f}`;
        out.push([p, syncWorkflow(readFileSync(join(ROOT, p), 'utf-8'))]);
    }
    return out;
}

function read(p) {
    try { return readFileSync(join(ROOT, p), 'utf-8'); } catch { return null; }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    const check = process.argv.includes('--check');
    const stale = [];
    for (const [p, want] of plan()) {
        if (read(p) === want) continue;
        stale.push(p);
        if (!check) writeFileSync(join(ROOT, p), want);
    }
    if (check && stale.length) {
        console.error(`❌ 以下文件与 config/hosts.json 不同步，请跑 node ops/sync-hosts.mjs：\n  ${stale.join('\n  ')}`);
        process.exit(1);
    }
    console.log(stale.length ? `${check ? '不同步' : '已更新'}：${stale.join('，')}` : '✓ 已同步');
}
