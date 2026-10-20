/**
 * 域名只许写在 config/hosts.json（唯一来源），其余地方引用常量。
 *   ① 生成物（nextjs/src/lib/hosts.ts、edge-functions/api/hosts.js、工作流顶部的 HOST_*）与 hosts.json 同步；
 *   ② 代码、脚本、工作流里没有写死的本站域名（注释、文档、测试、静态页不算，见 EXEMPT）。
 *
 * 跑法（仓库根目录）：node --test ops/tests/hosts.test.mjs
 * 报 ② 时：把那一行改成引用常量——网站 '@/lib/hosts'，边缘函数 './hosts.js'，Node 脚本 config/hosts.mjs，
 * Python ops/hosts.py，工作流 $HOST_*／env.HOST_*（任务级 env 里用不了 env 上下文，改在第一步写 GITHUB_ENV）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const HOSTS = JSON.parse(readFileSync(join(ROOT, 'config/hosts.json'), 'utf-8'));

test('生成物与 config/hosts.json 同步（不同步就跑 node ops/sync-hosts.mjs）', () => {
    execFileSync(process.execPath, [join(ROOT, 'ops/sync-hosts.mjs'), '--check'], { stdio: 'pipe' });
});

/** 本站的注册域名（各子域名都算） */
const APEXES = [...new Set(Object.entries(HOSTS)
    .filter(([k]) => !k.startsWith('$'))
    .map(([, v]) => new URL(v).hostname.split('.').slice(-2).join('.')))];
const HOST_RE = new RegExp(`(^|[^\\w.-])([a-z0-9-]+\\.)*(${APEXES.map((a) => a.replace(/\./g, '\\.')).join('|')})(?![\\w-])`, 'i');

/** 不查的文件：唯一来源与生成物、文档、测试与夹具、静态页、单独部署到机器上的 indexer（靠 .env 配） */
const EXEMPT = [
    /^config\//,
    /^nextjs\/src\/lib\/hosts\.ts$/,
    /^edge-functions\/api\/hosts\.js$/,
    /\.md$/, /^docs\//, /\/docs\//,
    /__tests__\//, /^ops\/tests\//, /\.test\.[cm]?[jt]sx?$/, /\.spec\.[jt]s$/, /(^|\/)fixtures\/(?!anchors\.ts|site-profile\.ts)/,
    /^e2e\/(contract|ui|degradable|selftest)\//,
    /^nextjs\/public\//,
    /^indexer\//,
    /^perf\/thresholds\.json$/, /^perf\/gate\.test\.ts$/,
    /\.env\.example$/,
    /package(-lock)?\.json$/,
];

/** 注释行（各语言）不查：说明里提到域名无妨，改域名时顺手改文字即可 */
const COMMENT = /^\s*(\/\/|\/\*|\*|#|<!--|""")/;

/**
 * 工作流里 GitHub 不允许引用变量的位置：workflow_dispatch 输入的 default／options／description。
 * 这些只出现站点主机（供人在下拉框里选），不出现数据、接口域名。
 */
function workflowInputLine(file, line) {
    return file.startsWith('.github/workflows/')
        && /^\s*(default|description|options):|^\s*- https?:\/\//.test(line)
        && !line.includes(new URL(HOSTS.data).hostname)
        && !line.includes(new URL(HOSTS.api).hostname);
}

test('代码、脚本、工作流里没有写死的本站域名', () => {
    const files = execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf-8' }).split('\n').filter(Boolean);
    const hits = [];
    for (const f of files) {
        if (EXEMPT.some((re) => re.test(f))) continue;
        if (!/\.(m?[jt]sx?|cjs|mts|py|sh|ya?ml|json|html)$/.test(f)) continue;
        let src;
        try { src = readFileSync(join(ROOT, f), 'utf-8'); } catch { continue; }
        let generated = false; // 工作流顶部 ops/sync-hosts.mjs 生成的 HOST_* 一段
        src.split('\n').forEach((line, i) => {
            if (/^ {2}# >>> hosts/.test(line)) generated = true;
            if (/^ {2}# <<< hosts/.test(line)) generated = false;
            if (generated || COMMENT.test(line) || !HOST_RE.test(line) || workflowInputLine(f, line)) return;
            hits.push(`${f}:${i + 1}: ${line.trim().slice(0, 120)}`);
        });
    }
    assert.deepEqual(hits, [], `以下位置写死了域名，请改为引用常量（见本文件开头）：\n${hits.join('\n')}`);
});
