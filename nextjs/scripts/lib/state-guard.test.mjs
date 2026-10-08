/**
 * state-guard.test.mjs — 同步 state 缓存的可信度保护（写前标记 + 远端指针核对）。
 * 用法：node --test scripts/lib/state-guard.test.mjs
 *
 * 核心用例是 overview#469 / #275 里的事故：run A 成功，run B（schema-v2）改了桶、在翻指针之前被取消，
 * run C 取回 run A 存的旧 state——此时 latest.json 仍是 A 的值，只比指针发现不了，写前标记才发现得了。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
    guardKey, pointerOf, parseGuardDoc, serializeGuardDoc, judgeState, checkState,
    markDirty, markClean, createStateGuard,
} from './state-guard.mjs';
import { loadStateMeta, saveStateFile, loadStateFile, createCosOps, isTransientCosError } from './h1-sync-core.mjs';

/** 假桶：只实现 guard 用到的 getObjectText／putObjectText。 */
function fakeBucket(initial = {}) {
    const objects = new Map(Object.entries(initial));
    return {
        objects,
        ops: {
            getObjectText: async (k) => (objects.has(k) ? objects.get(k) : null),
            putObjectText: async (k, body) => { objects.set(k, body); },
        },
    };
}

const POINTER = 'h1/manifest-root.json';
const mk = (b, pathPrefix = 'staging', name = 'h1-entry') => createStateGuard({ ops: b.ops, pathPrefix, name, pointerKey: POINTER });
const pointerDoc = (root) => JSON.stringify({ root });

/** 模拟一次成功的同步：返回缓存里会存下的 state 版本记录。 */
async function successfulRun(b, guard, root) {
    const generation = await guard.begin();
    b.objects.set(POINTER, pointerDoc(root));        // 指针最后翻转
    const meta = { generation, pointer: pointerOf(pointerDoc(root)) };
    await guard.finish(generation, meta.pointer);
    return meta;
}

test('guardKey：带前缀放 _deploy/ 下，无前缀不带斜杠', () => {
    assert.equal(guardKey('staging', 'h1-entry'), 'staging/_deploy/state-guard-h1-entry.json');
    assert.equal(guardKey('', 'current'), '_deploy/state-guard-current.json');
    assert.equal(guardKey('/staging/', 'h1-text'), 'staging/_deploy/state-guard-h1-text.json');
});

test('pointerOf：h1 指针取 root，latest.json 取 cacheKey，非 JSON 退回原文，空为 null', () => {
    assert.equal(pointerOf('{"root":"ab.json","generatedAt":1}'), 'ab.json');
    assert.equal(pointerOf('{"commitId":"x","cacheKey":"k1"}'), 'k1');
    assert.equal(pointerOf('  plain-text \n'), 'plain-text');
    assert.equal(pointerOf(null), null);
    assert.equal(pointerOf('   '), null);
});

test('parseGuardDoc：不合法的一律读不出（当没有标记）', () => {
    assert.equal(parseGuardDoc('not json'), null);
    assert.equal(parseGuardDoc('{}'), null);
    assert.equal(parseGuardDoc(JSON.stringify({ version: 1, generation: 'g', status: 'weird' })), null);
    assert.equal(parseGuardDoc(JSON.stringify({ version: 2, generation: 'g', status: 'clean' })), null);
    const ok = parseGuardDoc(serializeGuardDoc({ generation: 'g1', status: 'clean', pointer: 'p' }));
    assert.deepEqual(ok, { generation: 'g1', status: 'clean', pointer: 'p' });
});

test('judgeState：逐条判据', () => {
    const clean = { generation: 'g1', status: 'clean', pointer: 'p1' };
    assert.equal(judgeState({ meta: { generation: 'g1', pointer: 'p1' }, remoteDoc: clean, remotePointer: 'p1' }).trusted, true);
    // state 没有版本记录（旧格式／首次）
    assert.equal(judgeState({ meta: null, remoteDoc: clean, remotePointer: 'p1' }).trusted, false);
    assert.equal(judgeState({ meta: { generation: null, pointer: null }, remoteDoc: clean, remotePointer: 'p1' }).trusted, false);
    // COS 上没有标记
    assert.equal(judgeState({ meta: { generation: 'g1', pointer: 'p1' }, remoteDoc: null, remotePointer: 'p1' }).trusted, false);
    // 标记是 dirty
    assert.equal(judgeState({ meta: { generation: 'g1', pointer: 'p1' }, remoteDoc: { ...clean, status: 'dirty' }, remotePointer: 'p1' }).trusted, false);
    // 版本不一致
    assert.equal(judgeState({ meta: { generation: 'g0', pointer: 'p1' }, remoteDoc: clean, remotePointer: 'p1' }).trusted, false);
    // 指针对不上／指针不存在
    assert.equal(judgeState({ meta: { generation: 'g1', pointer: 'p1' }, remoteDoc: clean, remotePointer: 'p2' }).trusted, false);
    assert.equal(judgeState({ meta: { generation: 'g1', pointer: 'p1' }, remoteDoc: clean, remotePointer: null }).trusted, false);
    // state 没记指针：不查指针
    assert.equal(judgeState({ meta: { generation: 'g1', pointer: null }, remoteDoc: clean, remotePointer: 'whatever' }).trusted, true);
});

test('正常往返：成功同步后，用它存下的 state 可信', async () => {
    const b = fakeBucket();
    const guard = mk(b);
    const meta = await successfulRun(b, guard, 'r1.json');
    const g = await guard.check(meta);
    assert.equal(g.trusted, true, g.reason);
});

test('连续成功：用上一次的 state 可信，用上上次的 state 不可信（版本对不上）', async () => {
    const b = fakeBucket();
    const guard = mk(b);
    const m1 = await successfulRun(b, guard, 'r1.json');
    const m2 = await successfulRun(b, guard, 'r2.json');
    assert.equal((await guard.check(m2)).trusted, true);
    const stale = await guard.check(m1);
    assert.equal(stale.trusted, false);
    assert.match(stale.reason, /不一致/);
});

test('事故复现：B 改了桶、翻指针之前被取消，C 取回 A 的旧 state——指针没变也必须判不可信', async () => {
    const b = fakeBucket();
    const guard = mk(b);
    const metaA = await successfulRun(b, guard, 'main.json');   // run A 成功，缓存存下 metaA
    // run B：state 可信 → 写 dirty 标记 → 开始改桶 → 在翻指针之前被取消（没有 finish、没有存缓存）
    assert.equal((await guard.check(metaA)).trusted, true);
    await guard.begin();
    // 此刻远端指针仍是 A 的值——只比指针的话会误判可信
    assert.equal(pointerOf(b.objects.get(POINTER)), metaA.pointer);
    assert.equal(judgeState({ meta: metaA, remoteDoc: { generation: metaA.generation, status: 'clean' }, remotePointer: metaA.pointer }).trusted, true,
        '（对照：若只比指针，会判可信）');
    // run C：取回 A 的旧 state
    const g = await guard.check(metaA);
    assert.equal(g.trusted, false);
    assert.match(g.reason, /dirty|没走完/);
});

test('在 begin 之前被取消：桶没动过，旧 state 仍可信', async () => {
    const b = fakeBucket();
    const guard = mk(b);
    const metaA = await successfulRun(b, guard, 'main.json');
    // run B 在算计划时被取消，什么都没写
    assert.equal((await guard.check(metaA)).trusted, true);
});

test('本地 state 已存、COS 标记没改成 clean：下一次重建', async () => {
    const b = fakeBucket();
    const generation = await markDirty({ putText: b.ops.putObjectText, key: guardKey('staging', 'x') });
    const g = createStateGuard({ ops: b.ops, pathPrefix: 'staging', name: 'x', pointerKey: POINTER });
    b.objects.set(POINTER, pointerDoc('r.json'));
    // finish 没执行；缓存里却已经有 {generation, pointer}
    assert.equal((await g.check({ generation, pointer: 'r.json' })).trusted, false);
});

test('别的写入者改了指针：不可信', async () => {
    const b = fakeBucket();
    const guard = mk(b);
    const meta = await successfulRun(b, guard, 'r1.json');
    b.objects.set(POINTER, pointerDoc('someone-else.json'));
    const g = await guard.check(meta);
    assert.equal(g.trusted, false);
    assert.match(g.reason, /指针/);
});

test('读 COS 出错：当不可信，不抛', async () => {
    const meta = { generation: 'g1', pointer: 'p1' };
    const g = await checkState({ getText: async () => { throw new Error('boom'); }, key: 'k', meta, pointerKey: 'p' });
    assert.equal(g.trusted, false);
    assert.match(g.reason, /boom/);
});

test('首次（没有任何标记）与旧格式 state：不可信', async () => {
    const b = fakeBucket();
    const guard = mk(b);
    assert.equal((await guard.check(null)).trusted, false);
    assert.equal((await guard.check({ generation: null, pointer: null })).trusted, false);
    assert.equal((await guard.check({ generation: 'g', pointer: null })).trusted, false); // COS 上没有标记
});

test('begin 写不进去会抛错（调用方必须中止，不许动桶）；finish 写失败只警告返回 false', async () => {
    const failing = { putObjectText: async () => { throw new Error('cos down'); }, getObjectText: async () => null };
    const g = createStateGuard({ ops: failing, pathPrefix: '', name: 'x', pointerKey: POINTER });
    await assert.rejects(() => g.begin(), /cos down/);
    const warns = [];
    const ok = await markClean({ putText: failing.putObjectText, key: 'k', generation: 'g', pointer: 'p', warn: (m) => warns.push(m) });
    assert.equal(ok, false);
    assert.equal(warns.length, 1);
});

test('三路各用各的标记，互不影响', async () => {
    const b = fakeBucket();
    const cur = createStateGuard({ ops: b.ops, pathPrefix: 'staging', name: 'current', pointerKey: 'staging/latest.json' });
    const ent = mk(b, 'staging', 'h1-entry');
    b.objects.set('staging/latest.json', JSON.stringify({ cacheKey: 'k1' }));
    const g1 = await cur.begin(); await cur.finish(g1, 'k1');
    const metaEnt = await successfulRun(b, ent, 'r1.json');
    await ent.begin();                                                  // h1 条目这一路中途挂了
    assert.equal((await cur.check({ generation: g1, pointer: 'k1' })).trusted, true);
    assert.equal((await ent.check(metaEnt)).trusted, false);
});

test('state 文件：版本记录往返；没有记录的旧文件读出 generation=null；旧读法仍能读出 Map', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sg-'));
    try {
        const f = join(dir, 's.json');
        saveStateFile(f, new Map([['a', '1'], ['b', '2']]), { generation: 'g9', pointer: 'root.json' });
        assert.deepEqual(loadStateMeta(f), { generation: 'g9', pointer: 'root.json' });
        assert.equal(loadStateFile(f).size, 2);
        saveStateFile(f, new Map([['a', '1']]));                       // 不带版本记录（dry-run、旧调用）
        assert.deepEqual(loadStateMeta(f), { generation: null, pointer: null });
        assert.equal(loadStateMeta(join(dir, 'missing.json')), null);
        writeFileSync(f, '{bad');
        assert.equal(loadStateMeta(f), null);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('isTransientCosError：签名类与网络类可重试，其余不重试', () => {
    assert.equal(isTransientCosError(new Error('The Signature you specified is invalid.')), true);
    assert.equal(isTransientCosError({ code: 'ECONNRESET' }), true);
    assert.equal(isTransientCosError({ code: 'EPIPE' }), true);
    assert.equal(isTransientCosError(new Error('AccessDenied')), false);
});

test('putObjectText：签名错误重试后成功；小文本走 putObject，大于 1MB 走分块 uploadFile', async () => {
    const calls = [];
    let failOnce = true;
    const cos = {
        putObject: (p, cb) => {
            calls.push(['putObject', p.Key]);
            if (failOnce) { failOnce = false; return cb(new Error('The Signature you specified is invalid.')); }
            cb(null);
        },
        uploadFile: (p, cb) => { calls.push(['uploadFile', p.Key, p.SliceSize, typeof p.FilePath]); cb(null); },
    };
    const ops = createCosOps({ cos, bucket: 'b', region: 'r', retryBaseMs: 1 });
    const opts = { contentType: 'application/json', cacheControl: 'no-store' };
    await ops.putObjectText('small.json', '{"a":1}', opts);
    assert.deepEqual(calls.map((c) => c[0]), ['putObject', 'putObject'], '第一次签名错误，第二次成功');
    calls.length = 0;
    await ops.putObjectText('big.json', 'x'.repeat(2 * 1024 * 1024), opts);
    assert.deepEqual(calls, [['uploadFile', 'big.json', 1024 * 1024, 'string']]);
});

test('putObjectText：不可重试的错误直接抛，且重试有上限', async () => {
    let n = 0;
    const denied = { putObject: (p, cb) => { n++; cb(new Error('AccessDenied')); } };
    await assert.rejects(() => createCosOps({ cos: denied, bucket: 'b', region: 'r', retryBaseMs: 1 }).putObjectText('k', 'v', {}), /AccessDenied/);
    assert.equal(n, 1);
    n = 0;
    const sig = { putObject: (p, cb) => { n++; cb(new Error('Signature invalid')); } };
    await assert.rejects(() => createCosOps({ cos: sig, bucket: 'b', region: 'r', retryBaseMs: 1 }).putObjectText('k', 'v', {}), /Signature/);
    assert.equal(n, 4);
});
