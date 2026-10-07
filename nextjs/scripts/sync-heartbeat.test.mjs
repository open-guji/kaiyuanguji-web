/**
 * sync-heartbeat.test.mjs — COS 同步心跳行的解析与换算。
 * 用法：node --test scripts/sync-heartbeat.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { lastProgress, formatEta, summarizePath, formatHeartbeat } from './sync-heartbeat.mjs';

test('lastProgress：取最新的一段（日志里是回车分隔的覆盖式输出）', () => {
    const log = 'plan...\n\r  shared-up: 200/147007 (3s)   \r  shared-up: 41200/147007 (217s)   ';
    assert.deepEqual(lastProgress(log), { label: 'shared-up', done: 41200, total: 147007, elapsed: 217 });
    assert.equal(lastProgress('没有进度的日志\n· 打包用时 12 秒'), null);
    assert.equal(lastProgress(''), null);
});

test('lastProgress：多个队列取最后出现的；带连字符和点的队列名', () => {
    const log = '  shared-up: 10/10 (1s)\n  delete-entry-orphan: 5/9 (2s)';
    assert.equal(lastProgress(log).label, 'delete-entry-orphan');
});

test('formatEta：90 秒以内按秒，之后按分钟；非法值为空', () => {
    assert.equal(formatEta(30), '约 30 秒');
    assert.equal(formatEta(0.2), '约 1 秒');
    assert.equal(formatEta(89), '约 89 秒');
    assert.equal(formatEta(540), '约 9 分钟');
    assert.equal(formatEta(NaN), '');
    assert.equal(formatEta(-1), '');
});

test('summarizePath：进行中显示 已完成/总数（百分比，速率，预计剩余）', () => {
    const s = summarizePath('current/', '\r  shared-up: 41200/147007 (217s)   ');
    assert.equal(s, 'current/ shared-up 41,200/147,007（28%，190 个/秒，约 9 分钟）');
});

test('summarizePath：速率不足 10 保留一位小数；刚开始（用时 0 秒）没有速率和预计', () => {
    assert.equal(summarizePath('h1 文本', '  upload: 50/1000 (10s)'), 'h1 文本 upload 50/1,000（5%，5.0 个/秒，约 3 分钟）');
    assert.equal(summarizePath('h1 文本', '  upload: 0/1000 (0s)'), 'h1 文本 upload 0/1,000（0%）');
});

test('summarizePath：队列做完、整路完成、未开始、准备中', () => {
    assert.equal(summarizePath('current/', '  shared-up: 9/9 (3s)'), 'current/ shared-up 9/9（完成）');
    assert.equal(summarizePath('h1 条目', '  upload: 3/9 (1s)\n· h1 条目一路共用时 41 秒'), 'h1 条目 完成（用时 41 秒）');
    assert.equal(summarizePath('h1 文本', null), 'h1 文本 未开始');
    assert.equal(summarizePath('h1 文本', '· 打包 1/3\n  LIST 远端 h1/ 中……\n'), 'h1 文本 准备中：LIST 远端 h1/ 中……');
    assert.equal(summarizePath('h1 文本', ''), 'h1 文本 准备中');
});

test('formatHeartbeat：一行，带时间和三路', () => {
    const line = formatHeartbeat({
        now: new Date('2026-10-07T12:03:10Z'),
        paths: [{ title: 'current/', text: '  shared-up: 100/200 (10s)' }, { title: 'h1 文本', text: null }],
    });
    assert.equal(line, '· COS 同步进行中 12:03:10 UTC | current/ shared-up 100/200（50%，10 个/秒，约 10 秒） | h1 文本 未开始');
});

test('命令行：读日志目录里的三个默认文件；目录不存在也不报错', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hb-'));
    try {
        writeFileSync(join(dir, 'current.log'), '\r  shared-up: 41200/147007 (217s)   ');
        writeFileSync(join(dir, 'h1-text.log'), '· h1 文本一路共用时 12 秒\n');
        const script = fileURLToPath(new URL('./sync-heartbeat.mjs', import.meta.url));
        const r = spawnSync('node', [script, dir], { encoding: 'utf-8' });
        assert.equal(r.status, 0);
        assert.match(r.stdout, /current\/ shared-up 41,200\/147,007（28%，190 个\/秒，约 9 分钟）/);
        assert.match(r.stdout, /h1 条目 未开始/);
        assert.match(r.stdout, /h1 文本 完成（用时 12 秒）/);
        const r2 = spawnSync('node', [script, join(dir, 'nope')], { encoding: 'utf-8' });
        assert.equal(r2.status, 0);
        assert.match(r2.stdout, /未开始/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
});
