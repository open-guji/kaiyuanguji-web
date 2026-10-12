/**
 * @jest-environment node
 */
import { describe, it, expect, jest } from '@jest/globals';
import { isReadSeedEnabled, parseReadSeed, loadReadSeed, withReadSeed, type ReadSeed } from '../read-seed';

const ID = 'd59f2abc';
const MANIFEST = { id: ID, versions: [{ key: 'default', kind: 'transcription' }, { key: 'wikisource', kind: 'transcription' }] };
const INDEX = { chapters: [{ n: 1, file: '001', title: '序' }], type: 'catalog' };
const seed = (over: Record<string, unknown> = {}) => ({ v: 1, manifest: MANIFEST, primary: { key: 'default', index: INDEX }, ...over });

describe('read-seed（overview#345 方案 B）', () => {
    it('isReadSeedEnabled：只认数字 1', () => {
        expect(isReadSeedEnabled({ readSeed: 1 })).toBe(true);
        for (const v of [undefined, null, 0, 2, '1', true, {}]) expect(isReadSeedEnabled({ readSeed: v })).toBe(false);
        expect(isReadSeedEnabled(null)).toBe(false);
        expect(isReadSeedEnabled('x')).toBe(false);
    });

    it('parseReadSeed：合格的原样取出（不拷贝改写）', () => {
        const r = parseReadSeed(seed(), ID)!;
        expect(r.manifest).toBe(MANIFEST);
        expect(r.primary.index).toBe(INDEX);
    });

    it.each([
        ['不是对象', 'x'], ['v 不认识', seed({ v: 2 })], ['没有 manifest', seed({ manifest: undefined })],
        ['manifest 没有版本', seed({ manifest: { versions: [] } })], ['版本缺 key', seed({ manifest: { versions: [{ kind: 'x' }] } })],
        ['manifest.id 对不上', seed({ manifest: { ...MANIFEST, id: 'zzz' } })],
        ['主版本不在 manifest 里', seed({ primary: { key: 'nonesuch', index: INDEX } })],
        ['主版本 index 没有 chapters', seed({ primary: { key: 'default', index: {} } })],
        ['主版本 index 章为空', seed({ primary: { key: 'default', index: { chapters: [] } } })],
        ['章里有 null', seed({ primary: { key: 'default', index: { chapters: [{ file: '001' }, null] } } })],
        ['章缺 file', seed({ primary: { key: 'default', index: { chapters: [{ n: 1, title: '序' }] } } })],
        ['章的 file 不是字符串', seed({ primary: { key: 'default', index: { chapters: [{ file: 1 }] } } })],
    ])('parseReadSeed：%s → null', (_n, raw) => {
        expect(parseReadSeed(raw, ID)).toBeNull();
    });

    it('loadReadSeed：取数抛错、404 都返回 null，不抛', async () => {
        expect(await loadReadSeed(ID, async () => { throw new Error('boom'); })).toBeNull();
        expect(await loadReadSeed(ID, async () => null)).toBeNull();
        expect(await loadReadSeed(ID, (async () => seed()) as never)).not.toBeNull();
    });

    it('withReadSeed：manifest 与主版本 index 用 seed，其余地址原样转给底层', async () => {
        const base = jest.fn(async (rel: string) => ({ from: 'base', rel }));
        const s = parseReadSeed(seed(), ID) as ReadSeed;
        const get = withReadSeed(ID, base as never, Promise.resolve(s));
        await expect(get(`items/${ID}/manifest.json`)).resolves.toBe(MANIFEST);
        await expect(get(`items/${ID}/default/index.json`)).resolves.toBe(INDEX);
        await expect(get(`items/${ID}/wikisource/index.json`)).resolves.toEqual({ from: 'base', rel: `items/${ID}/wikisource/index.json` });
        await expect(get(`items/${ID}/default/001.json`)).resolves.toEqual({ from: 'base', rel: `items/${ID}/default/001.json` });
        await expect(get(`items/other/manifest.json`)).resolves.toEqual({ from: 'base', rel: 'items/other/manifest.json' });
        expect(base).toHaveBeenCalledTimes(3);
    });

    it('withReadSeed：seed 为 null 时全部转给底层', async () => {
        const base = jest.fn(async (rel: string) => rel);
        const get = withReadSeed(ID, base as never, Promise.resolve(null));
        await get(`items/${ID}/manifest.json`);
        await get(`items/${ID}/default/index.json`);
        expect(base).toHaveBeenCalledTimes(2);
    });
});
