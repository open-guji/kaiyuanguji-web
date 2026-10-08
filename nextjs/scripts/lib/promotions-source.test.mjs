/**
 * promotions-source.test.mjs — 升格对照表源档两种形状（整档／promotions/ 分片，bim#139）都认（overview#458）。
 *
 *   node --test scripts/lib/promotions-source.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
    buildPromotionsFileText, hasPromotionsSource, promotionSourceFiles, readPromotionsSource, serializePromotions,
} from './promotions-source.mjs';
import { buildPromotionShards } from './h1-promotions.mjs';

const REC = (to, type = 'book') => ({ production_id: to, type, promoted_at: '2026-10-08T00:00:00Z' });
const TABLE = {
    '11sjkim94800m': REC('98xh6qrdvl'),
    '11sjkima9435v': REC('98xglqqm87'),
    '1evr5e3mct1mt': REC('d59df01avcw0', 'work'),
    '2aaaaaaaaaa0m': REC('98xhaaaaaa'),
};
const file = (promotions) => JSON.stringify({ version: 1, promotions }, null, 2) + '\n';

function withTmp(fn) {
    const base = mkdtempSync(join(tmpdir(), 'promo-src-'));
    try { return fn(base); } finally { rmSync(base, { recursive: true, force: true }); }
}
const writeWhole = (dir, promotions) => writeFileSync(join(dir, 'promotions.json'), file(promotions));
function writeShards(dir, promotions) {
    mkdirSync(join(dir, 'promotions'), { recursive: true });
    const by = {};
    for (const [k, v] of Object.entries(promotions)) (by[k.slice(-2)] ??= {})[k] = v;
    for (const [key, recs] of Object.entries(by)) writeFileSync(join(dir, 'promotions', `${key}.json`), file(recs));
}

test('同一份对照表：整档形与分片形打出的文本逐字节相同，且就是 bim 写盘格式', () => {
    withTmp((a) => withTmp((b) => {
        writeWhole(a, TABLE);
        writeShards(b, TABLE);
        const fromWhole = buildPromotionsFileText(a);
        const fromShards = buildPromotionsFileText(b);
        assert.equal(fromShards, fromWhole);
        assert.equal(fromWhole, file(TABLE));
    }));
});

test('同一份对照表：整档形与分片形打出的 h1 PH 分片内容相同', () => {
    withTmp((a) => withTmp((b) => {
        writeWhole(a, TABLE);
        writeShards(b, TABLE);
        const ph = (dir) => buildPromotionShards(JSON.parse(buildPromotionsFileText(dir)), 2);
        assert.deepEqual(ph(b), ph(a));
        assert.equal(ph(a).count, 4);
    }));
});

test('过渡期整档、分片同时在：取并集，同键分片优先（与 bim load_all_raw 一致）', () => {
    withTmp((dir) => {
        writeWhole(dir, { '11sjkim94800m': REC('old1'), '1evr5e3mct1mt': REC('keep') });
        writeShards(dir, { '11sjkim94800m': REC('new1'), '2aaaaaaaaaa0m': REC('extra') });
        const t = readPromotionsSource(dir).promotions;
        assert.equal(t['11sjkim94800m'].production_id, 'new1');
        assert.equal(t['1evr5e3mct1mt'].production_id, 'keep');
        assert.equal(t['2aaaaaaaaaa0m'].production_id, 'extra');
        assert.deepEqual(Object.keys(t), [...Object.keys(t)].sort());
    });
});

test('分片目录在但还没有分片：空表（bim 以目录存在为分片形）；整档里 {}、缺 promotions 键也当空表', () => {
    withTmp((dir) => {
        mkdirSync(join(dir, 'promotions'));
        assert.equal(hasPromotionsSource(dir), true);
        assert.deepEqual(readPromotionsSource(dir), { version: 1, promotions: {} });
        assert.equal(serializePromotions(readPromotionsSource(dir)), '{\n  "version": 1,\n  "promotions": {}\n}\n');
    });
    withTmp((dir) => {
        writeFileSync(join(dir, 'promotions.json'), '{}');
        assert.deepEqual(readPromotionsSource(dir).promotions, {});
    });
});

test('整档、分片都没有：hasPromotionsSource 为 false，读取抛错', () => {
    withTmp((dir) => {
        assert.equal(hasPromotionsSource(dir), false);
        assert.deepEqual(promotionSourceFiles(dir), []);
        assert.throws(() => readPromotionsSource(dir), /没有升格对照表/);
    });
});

test('源档不是合法 JSON：抛错并带上文件名，不静默丢一批跳转', () => {
    withTmp((dir) => {
        writeShards(dir, TABLE);
        writeFileSync(join(dir, 'promotions', 'zz.json'), '{ not json');
        assert.throws(() => readPromotionsSource(dir), (e) => /promotions\/zz\.json|promotions[\\/]zz\.json/.test(e.message));
    });
});

test('分片目录里的非 .json 文件（.tmp 等）不读', () => {
    withTmp((dir) => {
        writeShards(dir, TABLE);
        writeFileSync(join(dir, 'promotions', '0m.json.tmp'), '{ not json');
        assert.equal(Object.keys(readPromotionsSource(dir).promotions).length, 4);
    });
});

test('源档（整档或分片）带记录却不是 version 1：抛错，不悄悄标成 1 放行；没有记录的不看版本', () => {
    withTmp((dir) => {
        mkdirSync(join(dir, 'promotions'));
        writeFileSync(join(dir, 'promotions', '0m.json'), JSON.stringify({ version: 2, promotions: { '11sjkim94800m': REC('x') } }));
        assert.throws(() => readPromotionsSource(dir), (e) => /版本不是 1/.test(e.message) && /0m\.json/.test(e.message));
    });
    withTmp((dir) => {
        writeFileSync(join(dir, 'promotions.json'), JSON.stringify({ promotions: { '11sjkim94800m': REC('x') } })); // 缺 version
        assert.throws(() => readPromotionsSource(dir), /版本不是 1/);
    });
    withTmp((dir) => {
        writeFileSync(join(dir, 'promotions.json'), JSON.stringify({ version: 2, promotions: {} }));
        assert.deepEqual(readPromotionsSource(dir).promotions, {});
    });
});
