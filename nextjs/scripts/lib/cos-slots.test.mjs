/**
 * cos-slots.test.mjs — 三路 COS 同步的动态并发分配（lib/cos-slots.mjs）与 runQueue 的动态模式。
 * 用法：node --test scripts/lib/cos-slots.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { allocateSlots, createSlotAllocator, slotAllocatorFromEnv } from './cos-slots.mjs';
import { runQueue, setSlotAllocator, cosSlots, cosSdkParallelLimit, COS_CONCURRENCY } from './h1-sync-core.mjs';

const sum = (o) => Object.values(o).reduce((s, v) => s + v, 0);

// ─── allocateSlots（纯函数） ───

test('只有一路有活：独占全部预算（封顶于它的剩余数）', () => {
    assert.deepEqual(allocateSlots({ a: 100000 }), { a: 80 });
    assert.deepEqual(allocateSlots({ a: 30 }), { a: 30 });
});

test('没活的路（0、负数、非数）不占名额', () => {
    assert.deepEqual(allocateSlots({ a: 5000, b: 0, c: -3, d: NaN }), { a: 80 });
    assert.deepEqual(allocateSlots({}), {});
});

test('两路同样重：对半分', () => {
    assert.deepEqual(allocateSlots({ 'h1-entry': 147007, current: 147007 }), { 'h1-entry': 40, current: 40 });
});

test('schema-v2 全量：current/ 与 h1 条目都重、h1 文本没变——文本那路 0 个名额，另两路分满 80', () => {
    const r = allocateSlots({ current: 152000, 'h1-entry': 148305, 'h1-text': 0 });
    assert.equal(r['h1-text'], undefined);
    assert.equal(sum(r), 80);
    assert.ok(r.current >= 39 && r.current <= 41, JSON.stringify(r));
    assert.ok(r['h1-entry'] >= 39 && r['h1-entry'] <= 41, JSON.stringify(r));
});

test('一路很重、一路很轻：轻的拿保底，重的拿其余', () => {
    const r = allocateSlots({ heavy: 100000, light: 60 });
    assert.equal(r.light, 4);
    assert.equal(r.heavy, 76);
    assert.equal(sum(r), 80);
});

test('保底不超过自己的剩余数；封顶后的名额让给别的路', () => {
    assert.deepEqual(allocateSlots({ a: 3, b: 2 }), { a: 3, b: 2 });
    const r = allocateSlots({ tiny: 2, big: 100000 });
    assert.equal(r.tiny, 2);
    assert.equal(r.big, 78);
});

test('三路都重：按剩余数比例，每路至少保底', () => {
    const r = allocateSlots({ a: 100000, b: 50000, c: 50000 });
    assert.equal(sum(r), 80);
    // 先给每路保底 4，其余 68 按（剩余数−保底）比例分：约 38／21／21，大致是 2:1:1
    assert.ok(r.a >= 37 && r.a <= 39, JSON.stringify(r));
    assert.ok(r.b >= 20 && r.b <= 22 && r.c >= 20 && r.c <= 22, JSON.stringify(r));
    assert.ok(r.a > r.b && r.b === r.c, JSON.stringify(r));
});

test('预算比保底总和还小：每路均分、至少 1；路数不少于预算时每路最多 1', () => {
    const r = allocateSlots({ a: 100, b: 100, c: 100 }, 8, 4);
    assert.ok(sum(r) <= 8 && Object.values(r).every((v) => v >= 2), JSON.stringify(r));
    const many = allocateSlots({ a: 9, b: 8, c: 7 }, 2, 4);
    assert.ok(sum(many) <= 2, JSON.stringify(many));
});

test('性质：随机输入下份额不超剩余数、总和不超预算、预算够时尽量用满', () => {
    let seed = 12345;
    const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    for (let i = 0; i < 3000; i++) {
        const k = 1 + Math.floor(rnd() * 4);
        const pendings = {};
        for (let j = 0; j < k; j++) pendings[`p${j}`] = rnd() < 0.2 ? 0 : Math.floor(rnd() ** 3 * 200000);
        const total = [8, 20, 80, 120][Math.floor(rnd() * 4)];
        const min = [1, 4, 10][Math.floor(rnd() * 3)];
        const r = allocateSlots(pendings, total, min);
        const active = Object.entries(pendings).filter(([, p]) => p > 0);
        assert.ok(sum(r) <= total, `超预算 ${JSON.stringify({ pendings, total, min, r })}`);
        for (const [n, p] of active) {
            assert.ok(r[n] <= p, `超剩余数 ${n} ${JSON.stringify({ pendings, r })}`);
            if (total >= active.length) assert.ok(r[n] >= 1, `没名额 ${n} ${JSON.stringify({ pendings, total, min, r })}`);
        }
        if (active.length > 0 && total >= active.length) {
            assert.equal(sum(r), Math.min(total, active.reduce((s, [, p]) => s + p, 0)), `没用满 ${JSON.stringify({ pendings, total, min, r })}`);
        }
    }
});

// ─── 分配器（共享目录登记） ───

function withDir(fn) {
    const dir = mkdtempSync(join(tmpdir(), 'cos-slots-'));
    return Promise.resolve(fn(dir)).finally(() => rmSync(dir, { recursive: true, force: true }));
}

test('分配器：独占 → 对方登记后让出 → 对方结束后收回', () => withDir((dir) => {
    let t = 1_000_000;
    const now = () => t;
    const a = createSlotAllocator({ name: 'a', dir, now });
    const b = createSlotAllocator({ name: 'b', dir, now });
    a.publish(100000);
    assert.equal(a.limit(), 80, '对方没登记：独占');
    b.publish(100000);
    t += 1500; // 过读缓存
    assert.equal(a.limit(), 40);
    assert.equal(b.limit(), 40);
    b.publish(0);
    t += 1500;
    assert.equal(a.limit(), 80, '对方没活了：收回');
}));

test('分配器：别路在途数占满预算时，新登记的一路先只拿保底，等对方让出再涨（总在途数不超预算）', () => withDir((dir) => {
    let t = 1_000_000;
    const now = () => t;
    const a = createSlotAllocator({ name: 'a', dir, now });
    const b = createSlotAllocator({ name: 'b', dir, now });
    a.publish(100000, 80);          // a 先开始，80 个在途
    b.publish(100000, 0);           // b 刚登记，还没开始传
    t += 300;
    assert.equal(b.limit(), 4, 'a 还占着 80 个在途：b 只拿保底');
    assert.equal(a.limit(), 40, 'a 的份额降到 40');
    a.publish(99000, 40);           // a 让出了一半（在途降到 40）
    t += 300;
    assert.equal(b.limit(), 40, 'a 在途降下来，b 涨到份额');
}));

test('分配器：先开始的一路在途数还没刷新（仍是 0）时，它声明的份额也算占用——后登记的一路不会趁空档满额起跑', () => withDir((dir) => {
    let t = 1_000_000;
    const now = () => t;
    const a = createSlotAllocator({ name: 'a', dir, now });
    const b = createSlotAllocator({ name: 'b', dir, now });
    a.publish(100000, 0);
    assert.equal(a.limit(), 80, 'a 独占，份额 80（并立即写进登记）');
    b.publish(100000, 0);           // b 刚登记；a 的在途数登记还是 0（要等下一个 250 毫秒刷新）
    assert.equal(b.limit(), 4, '按 a 声明的份额，没有空档：b 只拿保底');
    t += 300;
    assert.equal(a.limit(), 40, 'a 看到 b 登记，份额降到 40，并立即写进登记');
    assert.equal(b.limit(), 40, 'a 声明的份额降了，b 涨到 40');
}));

test('分配器：死掉的一路的在途数超时后不再占名额', () => withDir((dir) => {
    let t = 1_000_000;
    const now = () => t;
    const a = createSlotAllocator({ name: 'a', dir, now });
    const dead = createSlotAllocator({ name: 'dead', dir, now });
    dead.publish(100000, 80);
    a.publish(100000, 0);
    t += 300;
    assert.equal(a.limit(), 4);
    t += 11_000;                    // 超过默认 10 秒 TTL
    a.publish(100000, 0);
    assert.equal(a.limit(), 80);
}));

test('分配器：登记超时的路当没活（进程死了不占名额）', () => withDir((dir) => {
    let t = 1_000_000;
    const now = () => t;
    const a = createSlotAllocator({ name: 'a', dir, now, ttlMs: 60_000 });
    const dead = createSlotAllocator({ name: 'dead', dir, now, ttlMs: 60_000 });
    dead.publish(100000);
    a.publish(100000);
    assert.equal(a.limit(), 40);
    t += 61_000;
    a.publish(100000); // a 自己照常更新
    assert.equal(a.limit(), 80, 'dead 的登记已过期');
}));

test('分配器：损坏或半截的登记文件被忽略；release 撤掉登记', () => withDir((dir) => {
    let t = 1_000_000;
    const now = () => t;
    const a = createSlotAllocator({ name: 'a', dir, now });
    writeFileSync(join(dir, 'broken.json'), '{"name":"broken","pend');
    writeFileSync(join(dir, 'weird.json'), JSON.stringify({ name: 'weird', pending: 'x', at: t }));
    a.publish(5000);
    assert.equal(a.limit(), 80);
    a.release();
    assert.equal(existsSync(join(dir, 'a.json')), false);
    assert.ok(readdirSync(dir).includes('broken.json'));
}));

test('分配器：自己的剩余数很小时仍至少 1 个名额；预算可配', () => withDir((dir) => {
    const a = createSlotAllocator({ name: 'a', dir, total: 10, min: 2 });
    a.publish(0);
    assert.ok(a.limit() >= 1);
    a.publish(1000);
    assert.equal(a.limit(), 10);
}));

test('slotAllocatorFromEnv：没设 COS_PLAN_DIR 返回 null；设了按环境变量取预算与保底', () => withDir((dir) => {
    assert.equal(slotAllocatorFromEnv('x', {}), null);
    const a = slotAllocatorFromEnv('x', { COS_PLAN_DIR: dir, COS_TOTAL_BUDGET: '40', COS_MIN_SLOTS: '6' });
    assert.equal(a.total, 40);
    a.publish(1000);
    assert.equal(a.limit(), 40);
    const dflt = slotAllocatorFromEnv('y', { COS_PLAN_DIR: dir, COS_TOTAL_BUDGET: 'abc' });
    assert.equal(dflt.total, 80);
}));

// ─── runQueue 动态模式 ───

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('runQueue 静态并发：行为与原来一致（最多 N 个同时，全部处理）', async () => {
    setSlotAllocator(null);
    let inflight = 0, maxIn = 0;
    const items = Array.from({ length: 40 }, (_, i) => `i${i}`);
    const r = await runQueue(items, 5, async () => { inflight++; maxIn = Math.max(maxIn, inflight); await sleep(5); inflight--; }, 'static');
    assert.equal(r.done, 40);
    assert.equal(r.failures.length, 0);
    assert.equal(maxIn, 5);
    assert.equal(cosSlots(), COS_CONCURRENCY);
    assert.equal(cosSdkParallelLimit(), COS_CONCURRENCY);
});

test('runQueue 动态模式：份额中途下调后，新开的任务不再超过新份额；全部处理；登记剩余数并在结束时置 0', async () => {
    const published = [];
    let limit = 12;
    const fake = { total: 20, limit: () => limit, publish: (n) => published.push(n), release() {} };
    setSlotAllocator(fake);
    try {
        let inflight = 0;
        const startedOver = [];
        const items = Array.from({ length: 120 }, (_, i) => `i${i}`);
        let started = 0;
        const r = await runQueue(items, cosSlots(), async () => {
            started++;
            if (started === 30) limit = 3; // 中途让出名额
            inflight++;
            // 份额下调后新开的任务：此刻在途数不应超过新份额（已在途的允许跑完，所以给一点过渡）
            if (started > 60 && inflight > limit) startedOver.push(inflight);
            await sleep(8);
            inflight--;
        }, 'dyn');
        assert.equal(r.done, 120);
        assert.equal(r.failures.length, 0);
        assert.deepEqual(startedOver, [], `份额下调后仍超：${startedOver.join(',')}`);
        assert.equal(published[0], 120, '开始时登记总数');
        assert.equal(published[published.length - 1], 0, '结束时登记 0');
        assert.equal(cosSdkParallelLimit(), 20, '动态模式下 SDK 并发取总预算');
    } finally {
        setSlotAllocator(null);
    }
});

test('runQueue 动态模式：份额上调后真的用上了更多并发', async () => {
    let limit = 2;
    setSlotAllocator({ total: 30, limit: () => limit, publish() {}, release() {} });
    try {
        let inflight = 0, maxIn = 0, n = 0;
        const items = Array.from({ length: 100 }, (_, i) => `i${i}`);
        await runQueue(items, cosSlots(), async () => {
            if (++n === 20) limit = 25;
            inflight++; maxIn = Math.max(maxIn, inflight);
            await sleep(15);
            inflight--;
        }, 'up');
        assert.ok(maxIn >= 15, `份额上调后最大在途只有 ${maxIn}`);
        assert.ok(maxIn <= 25, `超过新份额：${maxIn}`);
    } finally {
        setSlotAllocator(null);
    }
});

test('runQueue 动态模式：单个任务失败记入 failures，不影响其余；空队列直接返回', async () => {
    setSlotAllocator({ total: 10, limit: () => 4, publish() {}, release() {} });
    try {
        const items = ['a', 'b', 'bad', 'c'];
        const r = await runQueue(items, cosSlots(), async (x) => { if (x === 'bad') throw new Error('boom'); }, 'f');
        assert.equal(r.done, 3);
        assert.equal(r.failures.length, 1);
        const e = await runQueue([], cosSlots(), async () => {}, 'empty');
        assert.equal(e.done, 0);
    } finally {
        setSlotAllocator(null);
    }
});

// ─── 接线：deploy.yml 的同步步骤要把分配器打开 ───

test('deploy.yml 的 COS 同步步骤设了 COS_PLAN_DIR 与 COS_TOTAL_BUDGET，三路脚本都接了分配器', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const here = fileURLToPath(new URL('.', import.meta.url));
    const yml = readFileSync(join(here, '..', '..', '..', '.github', 'workflows', 'deploy.yml'), 'utf-8');
    const i = yml.indexOf('name: Sync data to Tencent COS');
    assert.ok(i > 0);
    const step = yml.slice(i, yml.indexOf('\n      - name:', i + 10));
    assert.match(step, /COS_PLAN_DIR: \$\{\{ runner\.temp \}\}\/cos-plan/);
    assert.match(step, /COS_TOTAL_BUDGET: '80'/);
    for (const [file, name] of [['sync-to-cos.mjs', 'current'], ['sync-h1-to-cos.mjs', 'h1-entry'], ['sync-h1-text-to-cos.mjs', 'h1-text']]) {
        const src = readFileSync(join(here, '..', file), 'utf-8');
        assert.ok(src.includes(`slotAllocatorFromEnv('${name}')`), `${file} 没接分配器（路名 ${name}）`);
        assert.ok(src.includes('cosSlots()'), `${file} 的 runQueue 没用 cosSlots()`);
        assert.ok(!/FileParallelLimit: (COS_)?CONCURRENCY/.test(src), `${file} 的 SDK 并发仍是静态值`);
    }
});
