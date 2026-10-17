/** 用法：node --test scripts/sync-proof-sprites.test.mjs —— 对夹具跑整个入口脚本（演练，不连 COS） */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, appendFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const FIX = join(here, 'fixtures', 'sprites');
const run = (src, extra = {}) => spawnSync(process.execPath, [join(here, 'sync-proof-sprites.mjs')], {
    env: { PATH: process.env.PATH, SPRITES_SOURCE_DIR: src, ...extra }, encoding: 'utf8',
});
const tmp = () => mkdtempSync(join(tmpdir(), 'sprites-'));

test('① 没有指针：成功并跳过', () => {
    const d = tmp(); mkdirSync(join(d, 'book-text'));
    const r = run(d);
    assert.equal(r.status, 0); assert.match(r.stdout, /没有 sprites 指针/);
    rmSync(d, { recursive: true });
});

test('② 好夹具：计划上传 3 个文件，不报警', () => {
    const r = run(FIX, { COS_PATH_PREFIX: 'staging' });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /PUT staging\/proof\/demo\/vol01\/sprites\/p1\.webp/);
    assert.match(r.stdout, /待传 3/); assert.doesNotMatch(r.stdout, /::warning::/);
});

test('③ 改坏一个文件：该册不上传、有 warning、退出码仍为 0', () => {
    const d = tmp(); cpSync(FIX, d, { recursive: true });
    appendFileSync(join(d, 'releases', 'proof-demo-vol01-1', 'sprites', 'p2.webp'), 'x');
    const r = run(d);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /::warning::sprites demo\/vol01 校验未过/);
    assert.doesNotMatch(r.stdout, /PUT /);
    rmSync(d, { recursive: true });
});

test('④ 重跑幂等：第二次跳过已传的', () => {
    const d = tmp(); const state = join(d, 'state.json');
    assert.match(run(FIX, { SPRITES_STATE: state }).stdout, /待传 3/);
    assert.match(run(FIX, { SPRITES_STATE: state }).stdout, /待传 0，跳过 3/);
    rmSync(d, { recursive: true });
});
