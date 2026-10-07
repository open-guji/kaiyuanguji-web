#!/usr/bin/env node
/**
 * sync-heartbeat.mjs — COS 同步（deploy.yml 里三路并行）的心跳行：每路已完成／总数／速率／预计剩余（overview#470 P1）。
 *
 * 原来每分钟只打一行「进行中＋pid」，看不出谁在跑、跑到哪、还要多久。三路各自把日志写进文件，runQueue 每处理 200 个就写一段
 * 进度（`\r  <队列名>: 已完成/总数 (已用秒数s)`），所以这里直接读各路日志里最新的一段，换算出速率与预计剩余，不需要新的通道。
 *
 * 用法：node scripts/sync-heartbeat.mjs <日志目录> [标题:文件名 ...]，默认三路：current/:current.log h1 条目:h1-entry.log h1 文本:h1-text.log
 * 输出一行，例如：
 *   · COS 同步进行中 12:03:10 UTC | current/ shared-up 41,200/147,007（28%，190 个/秒，约 9 分钟）| h1 条目 打包中…… | h1 文本 完成（用时 312 秒）
 * 本脚本任何错误都只当没有信息，永远 exit 0（它只是日志，不能拖累同步）。
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const DEFAULT_PATHS = [['current/', 'current.log'], ['h1 条目', 'h1-entry.log'], ['h1 文本', 'h1-text.log']];
const fmt = (n) => Number(n).toLocaleString('en-US');

/** 日志里最新的一段队列进度；没有返回 null */
export function lastProgress(text) {
    // 队列名可能含中文、空格（h1 批次的 label），所以不限字符集，只要「名字: 已完成/总数 (已用秒数s)」
    const re = /(?:^|[\r\n])[ \t]*([^\s:\r\n][^:\r\n]*?): (\d+)\/(\d+) \((\d+)s\)/g;
    let m;
    let last = null;
    while ((m = re.exec(text)) !== null) last = { label: m[1], done: Number(m[2]), total: Number(m[3]), elapsed: Number(m[4]) };
    return last;
}

export function formatEta(seconds) {
    if (!Number.isFinite(seconds) || seconds < 0) return '';
    if (seconds < 90) return `约 ${Math.max(1, Math.round(seconds))} 秒`;
    return `约 ${Math.round(seconds / 60)} 分钟`;
}

/** 一路的状态文字 */
export function summarizePath(title, text) {
    if (text == null) return `${title} 未开始`;
    // 整路结束的标记由 deploy.yml 在各路子 shell 末尾写：「一路共用时 N 秒（exit R）」。带 exit 才分得出成功与失败；
    // 没有 exit 的旧格式按成功算
    const finished = text.match(/一路共用时 (\d+) 秒(?:（exit (\d+)）)?/);
    if (finished) {
        const rc = finished[2] === undefined ? 0 : Number(finished[2]);
        return rc === 0 ? `${title} 完成（用时 ${finished[1]} 秒）` : `${title} 失败（exit ${rc}，用时 ${finished[1]} 秒）`;
    }
    const p = lastProgress(text);
    if (p) {
        const pct = p.total > 0 ? Math.floor((p.done * 100) / p.total) : 100;
        // 只是这一个队列做完了，整路还没结束（后面可能还有别的队列），不说「完成」
        if (p.done >= p.total) return `${title} ${p.label} ${fmt(p.done)}/${fmt(p.total)}（本队列已做完，整路未结束）`;
        const rate = p.elapsed > 0 ? p.done / p.elapsed : 0;
        const eta = rate > 0 ? formatEta((p.total - p.done) / rate) : '';
        const parts = [`${pct}%`];
        if (rate > 0) parts.push(`${rate >= 10 ? Math.round(rate) : rate.toFixed(1)} 个/秒`);
        if (eta) parts.push(eta);
        return `${title} ${p.label} ${fmt(p.done)}/${fmt(p.total)}（${parts.join('，')}）`;
    }
    // 还没进到队列（打包、计划、LIST 远端）：显示日志最后一行有内容的，让人知道在干什么
    const lines = text.split(/[\r\n]+/).map((l) => l.trim()).filter(Boolean);
    const lastLine = lines.length ? lines[lines.length - 1].slice(0, 60) : '';
    return lastLine ? `${title} 准备中：${lastLine}` : `${title} 准备中`;
}

export function formatHeartbeat({ now = new Date(), paths }) {
    const t = now.toISOString().slice(11, 19);
    return `· COS 同步进行中 ${t} UTC | ${paths.map((p) => summarizePath(p.title, p.text)).join(' | ')}`;
}

function readLog(file) {
    try { return existsSync(file) ? readFileSync(file, 'utf-8') : null; } catch { return null; }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    try {
        const dir = process.argv[2] || '.';
        const given = process.argv.slice(3).map((a) => a.split(':'));
        const specs = given.length ? given : DEFAULT_PATHS;
        console.log(formatHeartbeat({ paths: specs.map(([title, file]) => ({ title, text: readLog(join(dir, file)) })) }));
    } catch (e) {
        console.log(`· COS 同步进行中（心跳读取失败：${e && e.message}）`);
    }
}
