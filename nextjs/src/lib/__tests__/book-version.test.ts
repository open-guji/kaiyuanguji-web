/**
 * 数据地址按书版本化：前端口径（src/lib/book-version.ts）与脚本侧（scripts/lib/book-versions.mjs）必须一致；
 * 回退规则：清单取不到／书不在清单里 ⇒ 用全局键。
 */
import {
    bookIdOfItemsPath, bookVersionShardKey, bookVersionShardUrl, parseBookVersionShard, versionForPath,
} from '../book-version';
import {
    bookIdOfPath, bookVersionShardKey as scriptShardKey, buildBookVersionShards, BOOK_VERSION_SHARD_KEY_LENGTH,
} from '../../../scripts/lib/book-versions.mjs';

describe('前端与脚本口径一致', () => {
    const ids = ['abc123xy', 'a', 'ab', 'x/y', 'ab-cd_ef'];
    it.each(ids)('分片键 %s', (id) => {
        expect(bookVersionShardKey(id)).toBe(scriptShardKey(id));
    });
    it.each(['items/abc/default/001.txt', 'items/abc/manifest.json', 'entry/abc.json', 'promotions.json'])('书内路径 %s', (p) => {
        expect(bookIdOfItemsPath(p)).toBe(bookIdOfPath(p));
    });
    it('脚本产出的分片能被前端解析，并按分片键找到书', () => {
        const shards = buildBookVersionShards(new Map([['book0011', '0123456789abcdef'], ['book0012', 'fedcba9876543210']]));
        expect(BOOK_VERSION_SHARD_KEY_LENGTH).toBe(2);
        const parsed = parseBookVersionShard(JSON.parse(shards.get(bookVersionShardKey('book0011')!)!));
        expect(parsed).toEqual({ book0011: '0123456789abcdef' });
    });
});

describe('parseBookVersionShard', () => {
    it('格式不对一律 null；摘要不合格的书被丢掉', () => {
        expect(parseBookVersionShard(null)).toBeNull();
        expect(parseBookVersionShard({ version: 2, books: {} })).toBeNull();
        expect(parseBookVersionShard({ version: 1, books: [] })).toBeNull();
        expect(parseBookVersionShard({ version: 1, books: { a: { v: 'zz' }, b: { v: '0123456789abcdef' } } })).toEqual({ b: '0123456789abcdef' });
    });
});

describe('versionForPath', () => {
    const lookup = async (id: string) => (id === 'bk' ? 'bookver0123456789'.slice(0, 16) : null);
    it('非书内文件用全局键，不查清单', async () => {
        const fn = jest.fn(lookup);
        expect(await versionForPath('entry/bk.json', 'G', fn)).toBe('G');
        expect(fn).not.toHaveBeenCalled();
    });
    it('书内文件用书版本；书不在清单里／查清单出错回退全局键', async () => {
        expect(await versionForPath('items/bk/manifest.json', 'G', lookup)).toBe('bookver012345678');
        expect(await versionForPath('items/other/manifest.json', 'G', lookup)).toBe('G');
        expect(await versionForPath('items/bk/manifest.json', 'G', async () => { throw new Error('x'); })).toBe('G');
    });
});

describe('bookVersionShardUrl', () => {
    it('带全局键；没有全局键就不带', () => {
        expect(bookVersionShardUrl('https://c/current', 'xy', 'G')).toBe('https://c/current/vers/xy.json?v=G');
        expect(bookVersionShardUrl('https://c/current', 'xy', undefined)).toBe('https://c/current/vers/xy.json');
    });
});
