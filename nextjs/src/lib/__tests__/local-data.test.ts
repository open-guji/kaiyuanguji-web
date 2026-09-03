/**
 * local-data.ts 单测：服务端本地数据访问（dev 模式 API routes 用）
 *
 * 之前 663 行 0% coverage —— Next.js dev server / local 模式的所有数据
 * 访问代码完全没保护网，跑错只会在 dev server 上看到 500。
 *
 * 测试用 tmp dir 起 mini fake workspace（含 book-index-draft + 几个
 * shard / metadata），通过 BOOK_INDEX_WORKSPACE_ROOT env var 让 lib
 * 读到。每个测试独立 tmp 防止串扰。
 */
import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// IMPORTANT: setEnv 必须在 import lib 之前生效；用 beforeEach 在 fixture 阶段设
let workspace: string;
let originalEnv: string | undefined;

// ─── helpers ───
function writeJson(p: string, data: unknown) {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(data, null, 2), 'utf-8');
}

function makeWorkspace(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kyg-test-'));
    fs.mkdirSync(path.join(dir, 'book-index-draft'), { recursive: true });
    return dir;
}

beforeEach(() => {
    workspace = makeWorkspace();
    originalEnv = process.env.BOOK_INDEX_WORKSPACE_ROOT;
    process.env.BOOK_INDEX_WORKSPACE_ROOT = workspace;
    // local-data.ts 用 module-scope 缓存（t2sConverter）→ 用 jest.resetModules 拿新实例
    jest.resetModules();
});

afterEach(() => {
    if (originalEnv === undefined) delete process.env.BOOK_INDEX_WORKSPACE_ROOT;
    else process.env.BOOK_INDEX_WORKSPACE_ROOT = originalEnv;
    try { fs.rmSync(workspace, { recursive: true, force: true }); } catch { /* ignore */ }
});

function loadModule() {
    return require('../local-data') as typeof import('../local-data');
}

// ─── shard fixture helpers ───
function setupWorks(entries: Record<string, any>) {
    // 全推到 0.json shard，简化（脚本会读所有 16 个 shard 合并）
    writeJson(path.join(workspace, 'book-index-draft', 'index', 'works', '0.json'), entries);
}
function setupBooks(entries: Record<string, any>) {
    writeJson(path.join(workspace, 'book-index-draft', 'index', 'books', '0.json'), entries);
}
function setupCollections(entries: Record<string, any>) {
    writeJson(path.join(workspace, 'book-index-draft', 'index', 'collections.json'), entries);
}
function setupEntities(entries: Record<string, any>) {
    writeJson(path.join(workspace, 'book-index-draft', 'index', 'entities', '0.json'), entries);
}

// ─── tests ───

describe('local-data getAllEntries', () => {
    it('空 workspace 返回 []', () => {
        expect(loadModule().getAllEntries('work')).toEqual([]);
    });

    it('未知 type 返回 []', () => {
        expect(loadModule().getAllEntries('bogus')).toEqual([]);
    });

    it('从 work shard 读取 + 标记 isDraft', () => {
        setupWorks({
            'w1': { id: 'w1', title: '史記', type: 'Work', path: 'Work/1/e/u/w1-史記.json', author: '司馬遷', year: '', holder: '' },
        });
        const entries = loadModule().getAllEntries('work');
        expect(entries).toHaveLength(1);
        expect(entries[0]).toMatchObject({ id: 'w1', title: '史記', type: 'work', isDraft: true });
    });

    it('Entity 缺 title 时用 primary_name 兜底', () => {
        setupEntities({
            'e1': { id: 'e1', primary_name: '司馬遷', type: 'Entity', path: 'Entity/x/y/z/e1.json', author: '', year: '', holder: '' },
        });
        const entries = loadModule().getAllEntries('entity');
        expect(entries[0].title).toBe('司馬遷');
    });

    it('合并 collections.json（不分 shard）', () => {
        setupCollections({
            'c1': { id: 'c1', title: '四庫全書', type: 'Collection', path: 'Collection/.../c1.json', author: '', year: '', holder: '' },
        });
        const entries = loadModule().getAllEntries('collection');
        expect(entries).toHaveLength(1);
    });
});

describe('local-data getEntry', () => {
    it('查到的条目带 type / isDraft 标记', () => {
        setupWorks({
            'w1': { id: 'w1', title: '史記', type: 'Work', path: 'p', author: '', year: '', holder: '' },
        });
        const entry = loadModule().getEntry('w1');
        expect(entry?.type).toBe('work');
        expect(entry?.isDraft).toBe(true);
    });

    it('找不到返回 null', () => {
        expect(loadModule().getEntry('nonexistent')).toBeNull();
    });
});

describe('local-data findItemFile', () => {
    it('按 ID 后 3 字符落桶 + 找 {id}-*.json', () => {
        const id = 'abcd1234';
        const filePath = path.join(workspace, 'book-index-draft', 'Work', '2', '3', '4', `${id}-标题.json`);
        writeJson(filePath, { id, title: '标题', type: 'Work' });

        const found = loadModule().findItemFile(id);
        expect(found).toBe(filePath);
    });

    // 分桶必须用 ID 的**后**三位——这是两个数据仓的既有事实（抽样 200 条
    // Work，200/200 匹配后三位、0/200 匹配前三位）。此前实现与这批测试都
    // 误用了前三位，导致本地开发模式下 findItemFile 永远返回 null；因为
    // 测试自己也按错误规则造 fixture，红不出来，错误就一直固化着。
    // 这条用例显式钉住规则：放对桶能找到、放错桶找不到。
    it('用前 3 字符落桶则找不到（防止规则被改回去）', () => {
        const id = 'xyz98765';
        const wrongBucket = path.join(
            workspace, 'book-index-draft', 'Work',
            id[0], id[1], id[2], `${id}-x.json`,
        );
        writeJson(wrongBucket, { id, type: 'Work' });
        expect(loadModule().findItemFile(id)).toBeNull();

        const rightBucket = path.join(
            workspace, 'book-index-draft', 'Work',
            id.slice(-3)[0], id.slice(-3)[1], id.slice(-3)[2], `${id}-x.json`,
        );
        writeJson(rightBucket, { id, type: 'Work' });
        expect(loadModule().findItemFile(id)).toBe(rightBucket);
    });

    it('找不到返回 null', () => {
        expect(loadModule().findItemFile('zz')).toBeNull();
    });

    it('扫 official 和 draft 两个仓库', () => {
        const id = 'aaa12345';
        const officialFile = path.join(workspace, 'book-index', 'Book', '3', '4', '5', `${id}-x.json`);
        writeJson(officialFile, { id, title: 'x', type: 'Book' });
        expect(loadModule().findItemFile(id)).toBe(officialFile);
    });
});

describe('local-data getItem', () => {
    it('读取并 parse JSON', () => {
        const id = 'item1234';
        const filePath = path.join(workspace, 'book-index-draft', 'Work', '2', '3', '4', `${id}-x.json`);
        writeJson(filePath, { id, title: '红楼梦', type: 'Work' });
        const data = loadModule().getItem(id);
        expect(data?.title).toBe('红楼梦');
    });

    it('Work 含 collated_edition 目录 → has_collated=true', () => {
        const id = 'work1234';
        const dir = path.join(workspace, 'book-index-draft', 'Work', '2', '3', '4');
        writeJson(path.join(dir, `${id}-t.json`), { id, title: 't', type: 'Work' });
        fs.mkdirSync(path.join(dir, id, 'collated_edition'), { recursive: true });
        const data = loadModule().getItem(id);
        expect(data?.has_collated).toBe(true);
    });

    it('Entity title 缺失时用 primary_name', () => {
        const id = 'ent12345';
        const filePath = path.join(workspace, 'book-index-draft', 'Entity', '3', '4', '5', `${id}-x.json`);
        writeJson(filePath, { id, type: 'Entity', primary_name: '司馬遷' });
        expect(loadModule().getItem(id)?.title).toBe('司馬遷');
    });

    it('找不到文件返回 null', () => {
        expect(loadModule().getItem('nonexistent')).toBeNull();
    });

    it('损坏的 JSON 返回 null（不抛）', () => {
        const id = 'bad12345';
        const filePath = path.join(workspace, 'book-index-draft', 'Work', '3', '4', '5', `${id}-x.json`);
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, '{invalid json', 'utf-8');
        expect(loadModule().getItem(id)).toBeNull();
    });
});

describe('local-data searchAll / searchEntries', () => {
    beforeEach(() => {
        setupWorks({
            'w1': { id: 'w1', title: '史記', type: 'Work', path: 'p', author: '司馬遷', year: '', holder: '' },
            'w2': { id: 'w2', title: '漢書', type: 'Work', path: 'p', author: '班固', year: '', holder: '' },
            'w3': { id: 'w3', title: '紅樓夢', type: 'Work', path: 'p', author: '曹霑', year: '', holder: '' },
        });
    });

    it('searchAll 按 title 命中 + 限制 limit', async () => {
        const r = await loadModule().searchAll('史', 5);
        const works = (r.works as any[]);
        expect(works.length).toBeGreaterThan(0);
        expect(works[0].title).toBe('史記');
    });

    it('searchAll 空 query 返回所有（按 limit 切）', async () => {
        const r = await loadModule().searchAll('', 5);
        expect((r.works as any[]).length).toBe(3);
        expect(r.totalWorks).toBe(3);
    });

    it('searchAll 按 author 命中', async () => {
        const r = await loadModule().searchAll('司馬遷', 5);
        const works = (r.works as any[]);
        expect(works.some(w => w.id === 'w1')).toBe(true);
    });

    it('searchEntries 按 type 过滤 + 分页', async () => {
        const r = await loadModule().searchEntries('', 'work', 1, 2);
        expect(r.entries.length).toBe(2);
        expect(r.total).toBe(3);
        expect(r.page).toBe(1);
    });

    it('searchEntries page=2 拿剩下的', async () => {
        const r = await loadModule().searchEntries('', 'work', 2, 2);
        expect(r.entries.length).toBe(1);
        expect(r.total).toBe(3);
    });
});

describe('local-data collated edition', () => {
    it('getCollatedEditionIndex 优先读 collated_edition_index.json', () => {
        const id = 'wcoll123';
        const dir = path.join(workspace, 'book-index-draft', 'Work', '1', '2', '3');
        writeJson(path.join(dir, `${id}-x.json`), { id, type: 'Work' });
        const idxData = { work_id: id, juans: [{ name: 'juan1' }] };
        writeJson(path.join(dir, id, 'collated_edition', 'collated_edition_index.json'), idxData);

        expect(loadModule().getCollatedEditionIndex(id)).toEqual(idxData);
    });

    it('getCollatedEditionIndex 无索引文件时按 juan*.json 排序生成', () => {
        const id = 'wcoll456';
        const dir = path.join(workspace, 'book-index-draft', 'Work', '4', '5', '6');
        writeJson(path.join(dir, `${id}-x.json`), { id, type: 'Work' });
        const collDir = path.join(dir, id, 'collated_edition');
        // 几个 juan 文件
        writeJson(path.join(collDir, 'juan2.json'), { name: '卷二' });
        writeJson(path.join(collDir, 'juan1.json'), { name: '卷一' });
        writeJson(path.join(collDir, 'juanshou.json'), { name: '卷首' });

        const idx = loadModule().getCollatedEditionIndex(id);
        expect(idx).toBeTruthy();
        // juanshou 应排第一
        expect((idx as any).work_id).toBe(id);
    });

    it('找不到 work 时 getCollatedEditionIndex 返回 null', () => {
        expect(loadModule().getCollatedEditionIndex('nonexistent')).toBeNull();
    });

    it('getCollatedJuanText 读取 markdown 文件', () => {
        const id = 'wjuan123';
        const dir = path.join(workspace, 'book-index-draft', 'Work', '1', '2', '3');
        writeJson(path.join(dir, `${id}-x.json`), { id, type: 'Work' });
        const collTextDir = path.join(dir, id, 'collated_edition', 'text');
        fs.mkdirSync(collTextDir, { recursive: true });
        fs.writeFileSync(path.join(collTextDir, 'juan1.md'), '# 卷一\n内容', 'utf-8');

        // API 接受 .json 形式，内部转 .md
        const text = loadModule().getCollatedJuanText(id, 'juan1.json');
        expect(text).toContain('卷一');
    });

    it('getCollatedJuanText 找不到返回 null', () => {
        expect(loadModule().getCollatedJuanText('nonexistent', 'foo.json')).toBeNull();
    });

    it('getCollatedJuanText 拒绝 path traversal（含 ..）', () => {
        expect(loadModule().getCollatedJuanText('any', '../../etc/passwd')).toBeNull();
    });

    it('getCollatedJuanText 拒绝非 .json 后缀', () => {
        expect(loadModule().getCollatedJuanText('any', 'juan1.exe')).toBeNull();
    });
});

describe('local-data resource progress / counts / recommended', () => {
    it('getResourceProgress：从 resource.json 读', () => {
        const data = { resources: [{ id: 'wikisource', name: '维基文库' }] };
        writeJson(path.join(workspace, 'book-index-draft', 'resource.json'), data);
        expect(loadModule().getResourceProgress()).toEqual(data);
    });

    it('getResourceProgress：文件不存在返回 null', () => {
        expect(loadModule().getResourceProgress()).toBeNull();
    });

    it('getSiteProgress：从 resource-site.json 读', () => {
        const data = { sites: [{ name: 'wikisource' }] };
        writeJson(path.join(workspace, 'book-index-draft', 'resource-site.json'), data);
        expect(loadModule().getSiteProgress()).toEqual(data);
    });

    it('getRecommended：从 recommended.json 读', () => {
        const data = [{ id: 'w1' }];
        writeJson(path.join(workspace, 'book-index-draft', 'recommended.json'), data);
        expect(loadModule().getRecommended()).toEqual(data);
    });

    it('getResourceCounts：扫 work 索引计 has_text / has_image', () => {
        setupWorks({
            'w1': { id: 'w1', title: 'a', type: 'Work', path: 'p', author: '', year: '', holder: '', has_text: true },
            'w2': { id: 'w2', title: 'b', type: 'Work', path: 'p', author: '', year: '', holder: '', has_image: true },
            'w3': { id: 'w3', title: 'c', type: 'Work', path: 'p', author: '', year: '', holder: '', has_text: true, has_image: true },
        });
        const counts = loadModule().getResourceCounts();
        expect(counts.hasText).toBe(2);
        expect(counts.hasImage).toBe(2);
    });
});

describe('local-data 损坏文件容错', () => {
    it('shard JSON 损坏不阻塞其他 shard', () => {
        const baseDir = path.join(workspace, 'book-index-draft', 'index', 'works');
        fs.mkdirSync(baseDir, { recursive: true });
        fs.writeFileSync(path.join(baseDir, '0.json'), '{invalid', 'utf-8');
        // 1.json 是合法的
        writeJson(path.join(baseDir, '1.json'), {
            'w1': { id: 'w1', title: '正常', type: 'Work', path: 'p', author: '', year: '', holder: '' },
        });
        // getAllEntries 不抛，能拿到 w1
        const entries = loadModule().getAllEntries('work');
        expect(entries.find(e => e.id === 'w1')).toBeTruthy();
    });

    it('resource.json 损坏返回 null', () => {
        const filePath = path.join(workspace, 'book-index-draft', 'resource.json');
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, '{bad', 'utf-8');
        expect(loadModule().getResourceProgress()).toBeNull();
    });
});
