/**
 * lib/read-seed.mjs 单测（GUJI-230 第 2 项：生成器正式版＋四种故障＋逐字节比对）。
 * 跑法：cd nextjs && node --test scripts/lib/read-seed.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildReadSeed, SEED_MAX_BYTES } from './read-seed.mjs';

function makeItem(files) {
    const dir = mkdtempSync(join(tmpdir(), 'kyg-seed-'));
    for (const [rel, body] of Object.entries(files)) {
        const full = join(dir, rel);
        mkdirSync(join(full, '..'), { recursive: true });
        writeFileSync(full, typeof body === 'string' ? body : JSON.stringify(body));
    }
    return dir;
}

const MANIFEST = {
    id: 'w1',
    versions: [
        { key: 'default', kind: 'transcription', label: '全文', source: 'wikisource', license: 'CC BY-SA 4.0' },
        { key: 'wikisource', kind: 'collated', label: '整理', source: 'wikisource', license: 'CC BY-SA 4.0' },
    ],
};
const INDEX = { chapters: [{ n: 1, file: '001', title: '卷一' }, { n: 2, file: '002', title: '卷二' }] };

test('正常条目：生成 seed，主版本取 default，manifest／index 与源文件语义一致（逐字节比对规范 JSON）', () => {
    const d = makeItem({ 'manifest.json': MANIFEST, 'default/index.json': INDEX, 'wikisource/index.json': INDEX });
    try {
        const r = buildReadSeed(d);
        assert.equal(r.status, 'ok');
        assert.equal(r.key, 'default');
        const seed = JSON.parse(r.text);
        assert.equal(seed.v, 1);
        // 逐字节：seed 里 index 的规范序列化，与源文件解析后的规范序列化逐字节相同
        const srcIndex = JSON.parse(readFileSync(join(d, 'default/index.json'), 'utf-8'));
        assert.equal(JSON.stringify(seed.primary.index), JSON.stringify(srcIndex));
        assert.ok(r.text.includes(JSON.stringify(srcIndex)), 'seed 文本里原样含有 index 的字节');
        assert.equal(JSON.stringify(seed.manifest), JSON.stringify(MANIFEST));
        // 确定性：同一输入两次生成，文本逐字节相同
        assert.equal(buildReadSeed(d).text, r.text);
    } finally { rmSync(d, { recursive: true }); }
});

test('整理本与全文版并存：整理本不作主版本（与阅读器 readerManifest 一致）', () => {
    const noDefault = { id: 'w2', versions: [
        { key: 'wikisource', kind: 'collated', label: '整理', source: 'wikisource', license: 'CC BY-SA 4.0' },
        { key: 'kanripo', kind: 'transcription', label: '全文', source: 'kanripo', license: 'CC BY-SA 4.0' },
    ] };
    const d = makeItem({ 'manifest.json': noDefault, 'wikisource/index.json': INDEX, 'kanripo/index.json': INDEX });
    try {
        const r = buildReadSeed(d);
        assert.equal(r.status, 'ok');
        assert.equal(r.key, 'kanripo');
    } finally { rmSync(d, { recursive: true }); }
});

test('故障 1：主版本 index.json 缺失 → skip，不生成也不抛错', () => {
    const d = makeItem({ 'manifest.json': MANIFEST, 'wikisource/index.json': INDEX });
    try {
        assert.deepEqual(buildReadSeed(d), { status: 'skip', reason: 'no-index' });
    } finally { rmSync(d, { recursive: true }); }
});

test('故障 2：index 超过 64KB → skip（Ella 答复：走老四请求读法）', () => {
    const big = { chapters: Array.from({ length: 3000 }, (_, i) => ({ n: i + 1, file: String(i + 1).padStart(3, '0'), title: '章'.repeat(20) })) };
    const d = makeItem({ 'manifest.json': MANIFEST, 'default/index.json': big });
    try {
        assert.ok(readFileSync(join(d, 'default/index.json')).length > SEED_MAX_BYTES, '夹具确实超限');
        assert.deepEqual(buildReadSeed(d), { status: 'skip', reason: 'index-too-large' });
    } finally { rmSync(d, { recursive: true }); }
});

test('故障 3：index 章目录为空，或有章没有字符串 file → skip（bad-index）', () => {
    for (const bad of [{ chapters: [] }, { chapters: [{ n: 1, title: '缺 file' }] }, { chapters: [null] }]) {
        const d = makeItem({ 'manifest.json': MANIFEST, 'default/index.json': bad });
        try {
            assert.deepEqual(buildReadSeed(d), { status: 'skip', reason: 'bad-index' }, JSON.stringify(bad));
        } finally { rmSync(d, { recursive: true }); }
    }
});

test('故障 4：manifest.json 不是合法 JSON → 抛错（fail closed，不当没有文本悄悄放过）', () => {
    const d = makeItem({ 'manifest.json': '{oops', 'default/index.json': INDEX });
    try {
        assert.throws(() => buildReadSeed(d), /manifest/);
    } finally { rmSync(d, { recursive: true }); }
});

test('没有 manifest.json、或全部版本都内部：skip，不生成', () => {
    const none = makeItem({ 'default/index.json': INDEX });
    const allInternal = makeItem({ 'manifest.json': { id: 'w3', visibility: 'internal', versions: [MANIFEST.versions[0]] }, 'default/index.json': INDEX });
    try {
        assert.deepEqual(buildReadSeed(none), { status: 'skip', reason: 'no-manifest' });
        assert.deepEqual(buildReadSeed(allInternal), { status: 'skip', reason: 'not-public' });
    } finally { rmSync(none, { recursive: true }); rmSync(allInternal, { recursive: true }); }
});
