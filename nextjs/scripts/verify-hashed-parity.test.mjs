/**
 * verify-hashed-parity.test.mjs — h1 与 current/ 的逐字节比对脚本（verify-hashed-parity.mjs／verify-hashed-text-parity.mjs）：
 * 用真实的 bundle-hashed.mjs／bundle-hashed-text.mjs 在小数据包上打出 h1，再跑比对：一致通过、被改坏的能抓到、
 * SAMPLE_SEED 让抽样每次不同（不设则固定）。overview#470 P0：这两个脚本接进 deploy.yml（只报告）。
 * 用法：node --test scripts/verify-hashed-parity.test.mjs   （需要 nextjs 依赖已装：脚本用到 book-index-ui 的 extractType）
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const B36 = '0123456789abcdefghijklmnopqrstuvwxyz';
// 四种类型的真实 id 前缀（类型位在 id 高位，改最后三位不改类型）
const BASES = { work: 'd59f20aow', book: '0phe8c4', collection: '8rlcsybg2', entity: 'hixhd2h9b' };

function makePackage() {
    const root = mkdtempSync(join(tmpdir(), 'parity-'));
    const entryDir = join(root, 'data', 'entry');
    mkdirSync(entryDir, { recursive: true });
    for (const [type, base] of Object.entries(BASES)) {
        for (let i = 0; i < 40; i++) {
            const id = (base + B36[Math.floor(i / 36) % 36] + B36[i % 36] + B36[(i * 7) % 36]).slice(0, 12);
            writeFileSync(join(entryDir, `${id}.json`), JSON.stringify({ id, type, title: `t${id}` }));
        }
    }
    for (let i = 0; i < 30; i++) {
        const owner = `d59f2${B36[Math.floor(i / 36)]}${B36[i % 36]}0000`.slice(0, 12);
        const d = join(root, 'data', 'items', owner);
        mkdirSync(join(d, 'default'), { recursive: true });
        writeFileSync(join(d, 'manifest.json'), JSON.stringify({ id: owner, versions: [{ key: 'default', kind: 'transcription', label: 'x', chapters_total: 2 }] }));
        writeFileSync(join(d, 'default', 'index.json'), JSON.stringify({ chapters: [{ n: '001' }, { n: '002' }] }));
        writeFileSync(join(d, 'default', '001.txt'), `第一章${owner}`);
        writeFileSync(join(d, 'default', '002.txt'), `第二章${owner}`);
    }
    writeFileSync(join(root, 'latest.json'), JSON.stringify({ commitId: 'a'.repeat(12), fullCommitId: 'a'.repeat(40), productionCommitId: 'b'.repeat(40), textCommitId: 'c'.repeat(40), bundleDate: '2026-10-07T00:00:00Z' }));
    const run = (script, env = {}) => spawnSync(process.execPath, [join(HERE, script)], { encoding: 'utf-8', env: { ...process.env, KYG_DATA_ROOT: root, ...env } });
    for (const s of ['bundle-hashed.mjs', 'bundle-hashed-text.mjs']) {
        const r = run(s);
        assert.equal(r.status, 0, `${s}: ${r.stderr || r.stdout}`);
    }
    return { root, run, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

const sampled = (out) => out.split('\n').filter((l) => /^\s+[✓✗]\s/.test(l)).map((l) => l.trim());

test('entry：h1 与 current/ 一致时通过；不设种子时抽样固定；设种子时抽样随种子变、同种子可复现', () => {
    const pkg = makePackage();
    try {
        const a = pkg.run('verify-hashed-parity.mjs', { SAMPLE_SIZE: '20' });
        assert.equal(a.status, 0, a.stderr);
        assert.match(a.stdout, /逐字一致 20\/20/);
        const b = pkg.run('verify-hashed-parity.mjs', { SAMPLE_SIZE: '20' });
        assert.deepEqual(sampled(a.stdout), sampled(b.stdout), '不设种子时每次一样（原行为）');
        const s1 = pkg.run('verify-hashed-parity.mjs', { SAMPLE_SIZE: '20', SAMPLE_SEED: '1' });
        const s1again = pkg.run('verify-hashed-parity.mjs', { SAMPLE_SIZE: '20', SAMPLE_SEED: '1' });
        const s2 = pkg.run('verify-hashed-parity.mjs', { SAMPLE_SIZE: '20', SAMPLE_SEED: '37588367536' });
        for (const r of [s1, s1again, s2]) assert.equal(r.status, 0, r.stderr);
        assert.deepEqual(sampled(s1.stdout), sampled(s1again.stdout), '同种子可复现');
        assert.notDeepEqual(sampled(s1.stdout), sampled(s2.stdout), '不同种子抽到不同的条目');
        assert.notDeepEqual(sampled(s1.stdout), sampled(a.stdout), '设种子后不再是固定的前 N 个');
        assert.equal(sampled(s1.stdout).length, 20);
        for (const t of ['work', 'book', 'collection', 'entity']) assert.equal(sampled(s1.stdout).filter((l) => l.includes(t)).length, 5, `每类 5 个：${t}`);
    } finally { pkg.cleanup(); }
});

test('entry：h1 里有条目被改坏时退出 1 并指出是哪一条；缺 h1 目录也退出 1', () => {
    const pkg = makePackage();
    try {
        const ok = pkg.run('verify-hashed-parity.mjs', { SAMPLE_SIZE: '8' });
        const victim = sampled(ok.stdout)[0].split(/\s+/).pop();
        const h1Entry = join(pkg.root, 'data-h1', 'entry');
        const file = readdirSync(h1Entry).find((f) => f.startsWith(`${victim}.`));
        writeFileSync(join(h1Entry, file), '{"tampered":true}');
        const bad = pkg.run('verify-hashed-parity.mjs', { SAMPLE_SIZE: '8' });
        assert.equal(bad.status, 1);
        assert.match(bad.stderr, new RegExp(`${victim}.*字节不一致`));
        rmSync(join(pkg.root, 'data-h1'), { recursive: true, force: true });
        const none = pkg.run('verify-hashed-parity.mjs');
        assert.equal(none.status, 1);
        assert.match(none.stderr, /不存在/);
    } finally { pkg.cleanup(); }
});

test('text：h1 文本与 items/ 一致时通过；SAMPLE_SEED 改变等距抽样的起点；被改坏的能抓到', () => {
    const pkg = makePackage();
    try {
        const a = pkg.run('verify-hashed-text-parity.mjs', { SAMPLE_SIZE: '8' });
        assert.equal(a.status, 0, a.stderr);
        assert.match(a.stdout, /逐字一致 8\/8/);
        const b = pkg.run('verify-hashed-text-parity.mjs', { SAMPLE_SIZE: '8' });
        assert.deepEqual(sampled(a.stdout), sampled(b.stdout), '不设种子时每次一样（原行为）');
        const s = pkg.run('verify-hashed-text-parity.mjs', { SAMPLE_SIZE: '8', SAMPLE_SEED: '3' });
        assert.equal(s.status, 0, s.stderr);
        assert.notDeepEqual(sampled(s.stdout), sampled(a.stdout), '种子改变抽样起点');
        for (const seed of ['0', '-7', '-1000003']) {
            const r = pkg.run('verify-hashed-text-parity.mjs', { SAMPLE_SIZE: '8', SAMPLE_SEED: seed });
            assert.equal(r.status, 0, `seed ${seed}: ${r.stderr}`);
            assert.match(r.stdout, /逐字一致 8\/8/);
        }
        // 改坏一份：从抽样里取一份 txt，改它的 h1 副本
        const victim = sampled(s.stdout).map((l) => l.split(/\s+/).pop()).find((p) => p.endsWith('.txt'));
        assert.ok(victim, '样本里应有 txt');
        const [owner, ...rest] = victim.split('/');
        const dir = join(pkg.root, 'data-h1-text', 'text', owner, ...rest.slice(0, -1));
        const stem = rest[rest.length - 1].replace(/\.txt$/, '');
        const f = readdirSync(dir).find((n) => n.startsWith(`${stem}.`) && n.endsWith('.txt'));
        writeFileSync(join(dir, f), '被改坏了');
        const bad = pkg.run('verify-hashed-text-parity.mjs', { SAMPLE_SIZE: '8', SAMPLE_SEED: '3' });
        assert.equal(bad.status, 1);
        assert.match(bad.stderr, /字节不一致/);
    } finally { pkg.cleanup(); }
});

test('deploy.yml 接线：比对步骤只报告（continue-on-error、恒 exit 0）、用 run id 当种子、在 COS 同步之后', () => {
    const yml = readFileSync(join(HERE, '..', '..', '.github', 'workflows', 'deploy.yml'), 'utf-8');
    const i = yml.indexOf('- name: h1 vs current parity sampling (report-only');
    assert.ok(i > 0, 'deploy.yml 没有 h1 比对这一步');
    const step = yml.slice(i, yml.indexOf('\n      - name:', i + 10));
    assert.match(step, /continue-on-error: true/);
    assert.match(step, /if: \$\{\{ steps\.cos_sync\.outcome == 'success' \}\}/);
    assert.match(step, /SAMPLE_SEED: \$\{\{ github\.run_id \}\}/);
    assert.match(step, /verify-hashed-parity\.mjs/);
    assert.match(step, /verify-hashed-text-parity\.mjs/);
    assert.match(step, /\n {10}exit 0\n/, '步骤必须恒退出 0（只报告）');
    assert.ok(!/\n {10}exit 1/.test(step), '只报告：步骤里不能有 exit 1');
    assert.ok(i > yml.indexOf('- name: Sync data to Tencent COS'));
    assert.ok(i < yml.indexOf('- name: Item sitemaps (W2-3)'));
});
