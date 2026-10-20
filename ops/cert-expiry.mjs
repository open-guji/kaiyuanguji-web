#!/usr/bin/env node
// GUJI-145：HTTPS 证书到期只读检查。对每个域名做一次 TLS 握手，取证书的颁发者、到期日，输出剩余天数；
// 任一域名剩余天数低于阈值（默认 30）或已过期，退出码非零。
//
//   node ops/cert-expiry.mjs                          # 查默认域名清单
//   node ops/cert-expiry.mjs www.openguji.com ...     # 只查指定域名
//   node ops/cert-expiry.mjs --days 30                # 改阈值
//   node ops/cert-expiry.mjs --json                   # 机读
//
// 全程只读：只做 TLS 握手，不发 HTTP 请求，不带凭证，不导出证书／私钥，不碰 DNS 与 EdgeOne 配置。
// 零依赖（Node ≥ 20）。有 HTTPS_PROXY 时自己走 CONNECT 隧道（同 ops/cutover-check.mjs）。
//
// 注意（GUJI-145 实测）：Claude 云端沙箱的出口网关会做 TLS 中转，在那里握手拿到的是网关代签的证书，
// 不是线上真证书。本脚本把颁发者原样打出来；颁发者不是公共 CA（如出现网关自签名 CA）时标「疑似中转」，
// 此时到期日不可信。要看真值请在 GitHub Actions 或能直连的机器上跑。
//
// 退出码：0 = 全部通过；1 = 有证书剩余天数低于阈值或已过期；
//         2 = 参数错误；3 = 无证书可判（没连上／握手失败），且没有 1 的情况。

import tls from 'node:tls';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { HOSTS, hostOf } from '../config/hosts.mjs';

/**
 * 默认域名清单：config/hosts.json 里的全部主机（去重；oauthIssuer 与旧 www 是同一个）。
 * 那里加了新域名（例如数据迁到 data.openguji.com），这里自动跟着查。
 */
export const DEFAULT_HOSTS = [...new Set(
    ['site', 'siteApex', 'legacySite', 'legacyApex', 'staging', 'data', 'api', 'ssrTest', ...Object.keys(HOSTS)]
        .filter((k) => k in HOSTS && !k.startsWith('$'))
        .map((k) => hostOf(HOSTS[k])),
)];

export const DEFAULT_MIN_DAYS = 30;
const TIMEOUT_MS = 15_000;
const DAY_MS = 86_400_000;

/** 常见公共 CA 的组织名片段；颁发者都不含这些，且是自签名／未知时标「疑似中转」 */
const PUBLIC_CA_HINTS = [
    "let's encrypt", 'digicert', 'globalsign', 'sectigo', 'zerossl', 'google trust', 'amazon',
    'trustasia', 'wosign', 'geotrust', 'rapidssl', 'thawte', 'comodo', 'certum', 'cloudflare',
    'baltimore', 'isrg', 'usertrust', 'entrust', 'buypass', 'ssl.com',
];

// ---------------------------------------------------------------- 纯函数（有单测）

/** 剩余整天数（向下取整；已过期为负） */
export function daysLeft(validTo, now = new Date()) {
    return Math.floor((validTo.getTime() - now.getTime()) / DAY_MS);
}

/** 颁发者展示串：O／CN 取一个可读的 */
export function issuerLabel(issuer) {
    if (!issuer) return '';
    const o = issuer.O ?? '';
    const cn = issuer.CN ?? '';
    return [o, cn].filter(Boolean).join(' / ');
}

/** 颁发者是否看着像公共 CA；空的或查不出来返回 null（不下结论） */
export function looksPublicCa(issuer) {
    const s = issuerLabel(issuer).toLowerCase();
    if (!s) return null;
    return PUBLIC_CA_HINTS.some((h) => s.includes(h));
}

/**
 * 把一次握手的结果判成一行结论。
 * cert：{ validFrom: Date, validTo: Date, issuer, subjectCN, selfSigned } 或 null；err：失败原因。
 * 返回 { status: 'ok'|'expiring'|'expired'|'error', days, ... }
 */
export function evaluate(host, cert, err, minDays, now = new Date()) {
    if (err || !cert) return { host, status: 'error', error: String(err ?? '没拿到证书') };
    const days = daysLeft(cert.validTo, now);
    const publicCa = looksPublicCa(cert.issuer);
    const intercepted = cert.selfSigned || publicCa === false;
    let status = 'ok';
    if (days < 0) status = 'expired';
    else if (days < minDays) status = 'expiring';
    return {
        host,
        status,
        days,
        notAfter: cert.validTo.toISOString().slice(0, 10),
        issuer: issuerLabel(cert.issuer),
        subjectCN: cert.subjectCN,
        suspectedIntercept: intercepted,
    };
}

/** 汇总退出码：1 优先于 3 */
export function exitCodeFor(results) {
    if (results.some((r) => r.status === 'expiring' || r.status === 'expired')) return 1;
    if (results.some((r) => r.status === 'error')) return 3;
    return 0;
}

// ---------------------------------------------------------------- 网络层（只做握手）

function proxyUrl(host) {
    const p = process.env.HTTPS_PROXY || process.env.https_proxy;
    if (!p) return null;
    const no = (process.env.NO_PROXY || process.env.no_proxy || '').split(',').map((s) => s.trim()).filter(Boolean);
    if (no.some((n) => n === '*' || host === n.replace(/^\./, '') || host.endsWith(n.startsWith('.') ? n : `.${n}`))) return null;
    return new URL(p);
}

function connectSocket(host, port, timeoutMs) {
    const proxy = proxyUrl(host);
    if (!proxy) return Promise.resolve(null);
    return new Promise((resolve, reject) => {
        const req = http.request({
            host: proxy.hostname,
            port: proxy.port || 80,
            method: 'CONNECT',
            path: `${host}:${port}`,
            headers: { host: `${host}:${port}` },
            timeout: timeoutMs,
        });
        req.on('connect', (res, socket) => {
            if (res.statusCode === 200) resolve(socket);
            else {
                socket.destroy();
                reject(new Error(`代理 CONNECT ${host}:${port} 返回 ${res.statusCode}`));
            }
        });
        req.on('timeout', () => req.destroy(new Error('代理连接超时')));
        req.on('error', reject);
        req.end();
    });
}

/**
 * 握手取证书。不校验链（rejectUnauthorized:false）：目的是读到期日，链错误另行报告在 authError 里，
 * 不因链问题读不到日期。握手完立刻关连接，不发任何应用层数据。
 */
export async function fetchCert(host, { port = 443, timeoutMs = TIMEOUT_MS } = {}) {
    const raw = await connectSocket(host, port, timeoutMs);
    return new Promise((resolve, reject) => {
        const s = tls.connect({
            ...(raw ? { socket: raw } : { host, port }),
            servername: host,
            rejectUnauthorized: false,
        });
        s.setTimeout(timeoutMs, () => s.destroy(new Error('TLS 握手超时')));
        s.once('error', reject);
        s.once('secureConnect', () => {
            const c = s.getPeerCertificate();
            const authError = s.authorized ? null : String(s.authorizationError ?? '未通过校验');
            s.end();
            if (!c || !c.valid_to) return reject(new Error('握手成功但没拿到证书'));
            resolve({
                validFrom: new Date(c.valid_from),
                validTo: new Date(c.valid_to),
                issuer: c.issuer ?? null,
                subjectCN: c.subject?.CN ?? '',
                selfSigned: JSON.stringify(c.issuer ?? {}) === JSON.stringify(c.subject ?? {}),
                authError,
            });
        });
    });
}

// ---------------------------------------------------------------- 入口

export function parseArgs(argv) {
    const out = { hosts: [], days: DEFAULT_MIN_DAYS, json: false };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--json') out.json = true;
        else if (a === '--days') {
            const n = Number(argv[++i]);
            if (!Number.isFinite(n) || n < 0) return { error: '--days 要一个非负数' };
            out.days = n;
        } else if (a.startsWith('--')) return { error: `不认识的参数 ${a}` };
        else out.hosts.push(a);
    }
    if (out.hosts.length === 0) out.hosts = DEFAULT_HOSTS;
    return out;
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    if (args.error) {
        console.error(args.error);
        process.exit(2);
    }
    const now = new Date();
    const results = [];
    for (const host of args.hosts) {
        let cert = null;
        let err = null;
        // 偶发的连接重置（实测首轮 www.openguji.com 出现过一次 ECONNRESET，重试即好）：失败重试一次
        for (let attempt = 0; attempt < 2 && !cert; attempt++) {
            try { cert = await fetchCert(host); err = null; } catch (e) { err = e.message || e; }
        }
        const r = evaluate(host, cert, err, args.days, now);
        if (cert?.authError) r.authError = cert.authError;
        results.push(r);
    }
    if (args.json) {
        console.log(JSON.stringify({ checkedAt: now.toISOString(), minDays: args.days, results }, null, 2));
    } else {
        console.log(`证书到期检查（阈值 ${args.days} 天，${now.toISOString()}）`);
        for (const r of results) {
            if (r.status === 'error') { console.log(`❓ ${r.host}  没取到证书：${r.error}`); continue; }
            const icon = r.status === 'ok' ? '✅' : '❌';
            const note = [r.suspectedIntercept ? '⚠️疑似出口网关中转，到期日不可信' : '', r.authError ? `链校验：${r.authError}` : '']
                .filter(Boolean).join('；');
            console.log(`${icon} ${r.host}  到 ${r.notAfter}，剩 ${r.days} 天  颁发者：${r.issuer || '未知'}${note ? `  [${note}]` : ''}`);
        }
    }
    process.exit(exitCodeFor(results));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
