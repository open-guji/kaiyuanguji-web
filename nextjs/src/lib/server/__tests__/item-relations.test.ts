/**
 * @jest-environment node
 *
 * 关系访问器（schema-v2 双兼容，overview#458）：新字段优先、缺则回退旧字段。
 * 新格式用例取 book-index 契约样例（fixtures/contract-sample）。
 */
import { describe, it, expect } from '@jest/globals';
import { readFileSync } from 'fs';
import { join } from 'path';
import type { ItemEntry } from '../item-data';
import { booksOf, classificationOf, collectionsOf, membersOf, worksOf } from '../item-relations';
import { buildItemSeo } from '../item-seo';

const SITE = 'https://staging.kaiyuanguji.com';
const sample = (id: string) =>
    JSON.parse(readFileSync(join(__dirname, 'fixtures', 'contract-sample', `${id}.json`), 'utf-8')) as ItemEntry;

describe('item-relations：契约样例（新格式）', () => {
    it('Work：_books、_collections、_classifications', () => {
        const kaozheng = sample('d59dgrvmvrwg');
        expect(booksOf(kaozheng).length).toBeGreaterThan(0);
        expect(collectionsOf(kaozheng).length).toBeGreaterThan(0);
        const zuo = sample('d59ezak6jq4g');
        expect(classificationOf(zuo)).toMatchObject({ l1: '經部', l2: '春秋類', scheme: 'zongmu' });
    });
    it('Collection：_members', () => {
        const col = sample('8rlcsybg2hhf');
        expect(membersOf(col)).toHaveLength(((col as Record<string, unknown>)._members as unknown[]).length);
    });
    it('Entity：_works', () => {
        expect(worksOf(sample('hixhcvhrh4ow'))).toEqual(expect.arrayContaining([expect.objectContaining({ work_id: 'd59f2ndvczcw', role: '撰' })]));
    });
    it('Book：_collections', () => {
        expect(collectionsOf(sample('988fxodt6s')).length).toBeGreaterThan(0);
    });
    it('新格式条目能出 SEO（不抛、标题在）', () => {
        for (const id of ['d59dgrvmvrwg', 'd59ezak6jq4g', '8rlcsybg2hhf', 'hixhcvhrh4ow', '988fxodt6s']) {
            const seo = buildItemSeo(sample(id), id, SITE);
            expect(seo.description.length).toBeGreaterThan(0);
        }
    });
});

describe('item-relations：旧格式回退', () => {
    const old = {
        books: ['988g3f0wsu'], contained_works: [{ id: 'd59f20aowb9c' }], contained_in: [{ id: '8rlcsy6ubh1c' }],
        works: [{ work_id: 'd59f20aowb9c' }], classification: { l1: '史部', l2: '正史類' },
    } as unknown as ItemEntry;
    it('没有 _ 字段时读旧字段', () => {
        expect(booksOf(old)).toEqual(['988g3f0wsu']);
        expect(membersOf(old)).toEqual([{ id: 'd59f20aowb9c' }, '988g3f0wsu']);
        expect(collectionsOf(old)).toEqual([{ id: '8rlcsy6ubh1c' }]);
        expect(worksOf(old)).toHaveLength(1);
        expect(classificationOf(old)).toMatchObject({ l1: '史部' });
    });
    it('新旧并存时新字段优先；新字段为空数组时回退', () => {
        const both = { ...old, _books: [{ id: 'x' }], _classifications: [{ scheme: 'zongmu', l1: '經部' }] } as unknown as ItemEntry;
        expect(booksOf(both)).toEqual([{ id: 'x' }]);
        expect(classificationOf(both).l1).toBe('經部');
        expect(booksOf({ ...old, _books: [] } as unknown as ItemEntry)).toEqual(['988g3f0wsu']);
    });
    it('什么都没有时给空', () => {
        const none = {} as ItemEntry;
        expect(booksOf(none)).toEqual([]);
        expect(classificationOf(none)).toEqual({});
    });
});
