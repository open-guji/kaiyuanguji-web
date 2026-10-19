#!/usr/bin/env node
/**
 * 写全文搜索的全局开关文件（COS 上的公开 JSON），并从公开地址读回核对。
 * 读它的是边缘函数 edge-functions/api/fulltext.js（isolate 缓存约 30 秒）；开关语义见那个文件头。
 * 一般经 .github/workflows/fulltext-switch.yml 手动触发，不在本地跑。
 *
 * 用法：node switch_cos.mjs --state on|off [--reason "..."] [--by 谁] [--key fulltext/switch.json]
 *                          [--public-url https://…/fulltext/switch.json] [--dry-run]
 * 环境变量：COS_SECRET_ID、COS_SECRET_KEY、COS_BUCKET、COS_REGION（默认 ap-shanghai）。凭据只从环境读，不打印。
 *
 * 写入 <key>：{ "enabled": true|false, "reason": "...", "updatedAt": "<ISO，洛杉矶时间带偏移>", "by": "<谁>" }
 *   对象头 Cache-Control: no-cache、Content-Type: application/json。
 * 写完从 --public-url（默认边缘函数读的同一个地址）读回，enabled 与 updatedAt 都对上才算成功（读回最多试 READBACK_TRIES 次）。
 * 退出码：0 成功；2 参数错；6 写入或读回失败。
 */
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { Fail, wrapClient } from './upload_cos.mjs';

export const DEFAULT_KEY = 'fulltext/switch.json';
export const DEFAULT_PUBLIC_URL = 'https://book-index-data-1394555822.cos.ap-shanghai.myqcloud.com/fulltext/switch.json';
export const REASON_MAX = 200;
const READBACK_TRIES = 5;

export function parseArgs(argv) {
    const a = { key: DEFAULT_KEY, publicUrl: DEFAULT_PUBLIC_URL, reason: '', by: '', dryRun: false };
    for (let i = 0; i < argv.length; i++) {
        const k = argv[i];
        const val = () => {
            if (i + 1 >= argv.length) throw new Fail(2, `${k} 缺值`);
            return argv[++i];
        };
        if (k === '--state') a.state = val();
        else if (k === '--reason') a.reason = val();
        else if (k === '--by') a.by = val();
        else if (k === '--key') a.key = val();
        else if (k === '--public-url') a.publicUrl = val();
        else if (k === '--dry-run') a.dryRun = true;
        else throw new Fail(2, `未知参数 ${k}`);
    }
    if (a.state !== 'on' && a.state !== 'off') throw new Fail(2, '--state 只能是 on 或 off');
    a.key = String(a.key).replace(/^\/+/, '');
    if (!/^[\w.\-/]+\.json$/.test(a.key) || a.key.split('/').includes('..')) throw new Fail(2, '--key 不合法');
    if (!/^https:\/\/[^\s]+$/.test(a.publicUrl)) throw new Fail(2, '--public-url 必须是 https 地址');
    return a;
}

/** 洛杉矶本地时间的 ISO 串（带偏移，如 2026-10-19T10:05:00-07:00） */
export function laIso(date = new Date()) {
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/Los_Angeles', hourCycle: 'h23',
        year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
    }).formatToParts(date).map(p => [p.type, p.value]));
    const local = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
    const offMin = Math.round((local - Math.floor(date.getTime() / 1000) * 1000) / 60000);
    const sign = offMin <= 0 ? '-' : '+';
    const abs = Math.abs(offMin);
    const off = `${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`;
    return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}${off}`;
}

const clean = (s, max) => String(s ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);

export function buildSwitch({ state, reason, by }, now = new Date()) {
    return { enabled: state === 'on', reason: clean(reason, REASON_MAX), updatedAt: laIso(now), by: clean(by, 100) };
}

/** 读回核对；fetchImpl 注入便于单测 */
export async function readBack(url, expected, { fetchImpl = fetch, tries = READBACK_TRIES, sleep = ms => new Promise(r => setTimeout(r, ms)) } = {}) {
    let last = '';
    for (let i = 1; i <= tries; i++) {
        try {
            const sep = url.includes('?') ? '&' : '?';
            const res = await fetchImpl(`${url}${sep}t=${Date.now()}`, { headers: { 'Cache-Control': 'no-cache' } });
            if (res.ok) {
                const got = await res.json();
                if (got && got.enabled === expected.enabled && got.updatedAt === expected.updatedAt) return got;
                last = `内容不符：${JSON.stringify(got)}`;
            } else {
                last = `HTTP ${res.status}`;
            }
        } catch (e) {
            last = e?.message || String(e);
        }
        if (i < tries) await sleep(2000 * i);
    }
    throw new Fail(6, `读回核对失败（${url}）：${last}`);
}

export async function run(a, client, { fetchImpl = fetch, log = console.log, now = new Date(), sleep } = {}) {
    const body = buildSwitch(a, now);
    if (a.dryRun) {
        log(`[dry-run] 会写 ${a.key}：${JSON.stringify(body)}`);
        return { body, readBack: null };
    }
    try {
        await client.putJson(a.key, body, 'no-cache');
    } catch (e) {
        throw new Fail(6, `写 ${a.key} 失败：${e?.message || e?.code || e}`);
    }
    log(`已写 ${a.key}：${JSON.stringify(body)}`);
    const got = await readBack(a.publicUrl, body, { fetchImpl, ...(sleep ? { sleep } : {}) });
    log(`读回核对通过：${JSON.stringify(got)}`);
    return { body, readBack: got };
}

async function main() {
    try {
        const a = parseArgs(process.argv.slice(2));
        let client = null;
        if (!a.dryRun) {
            const need = ['COS_SECRET_ID', 'COS_SECRET_KEY', 'COS_BUCKET'].filter(k => !process.env[k]);
            if (need.length) throw new Fail(2, `缺环境变量 ${need.join('、')}`);
            const COS = createRequire(import.meta.url)('cos-nodejs-sdk-v5');
            const cos = new COS({ SecretId: process.env.COS_SECRET_ID, SecretKey: process.env.COS_SECRET_KEY, Timeout: 60 * 1000 });
            client = wrapClient(cos, { bucket: process.env.COS_BUCKET, region: process.env.COS_REGION || 'ap-shanghai' });
        }
        const r = await run(a, client);
        console.log(JSON.stringify(r.readBack ?? r.body));
    } catch (e) {
        console.error(`ERROR[${e.code ?? 6}] ${e.message}`);
        process.exit(Number.isInteger(e.code) ? e.code : 6);
    }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) main();
