/**
 * @jest-environment node
 *
 * 条目页头部与结构化数据（W2-2，31 卡 §A.5 字段表）单测。
 */
import { describe, it, expect } from '@jest/globals';
import { buildItemSeo, clip, jsonLdScript, mergedTarget, seoDescription } from '../item-seo';
import { parseItemId } from '../../item-id';

const SITE = 'https://staging.kaiyuanguji.com';

const WORK = {
    id: 'd59f20aowb9c', type: 'work', title: '史記',
    additional_titles: ['太史公書', { book_title: '太史公記' }],
    authors: [{ name: '司馬遷', role: '撰', dynasty: '西漢', entity_id: 'hixhd2h9bhma' }, { name: '無名' }],
    measure_info: '一百三十篇',
    description: { text: '今存。' },
    ai_note: '內部備註，不得外露',
    books: ['988g3f0wsu', 'bad..id'],
};

describe('parseItemId', () => {
    it.each([
        ['d59f20aowb9c', 'official', 'work'],
        ['1evgpgqsis9hc', 'draft', 'work'],
        ['988g3gl3if', 'official', 'book'],
        ['hixhd2f8wamg', 'official', 'entity'],
        ['8rlcsybg2hhi', 'official', 'collection'],
    ])('%s → %s %s', (id, status, type) => {
        expect(parseItemId(id)).toEqual({ status, type });
    });
    it.each(['', 'bad..id', 'ABC', 'zzzzzzzzzzzzzz'])('非法或越界：%s → null', (id) => {
        expect(parseItemId(id)).toBeNull();
    });
});

describe('seoDescription', () => {
    it('作品：（朝代）作者角色 · 卷册 · 简介；不取 ai_note', () => {
        const d = seoDescription(WORK, WORK.id);
        expect(d).toBe('（西漢）司馬遷撰、無名 · 一百三十篇 · 今存。');
        expect(d).not.toContain('內部備註');
    });
    it('M1 描述 confidence 为 high／medium 才用，low 不用', () => {
        expect(seoDescription({ ...WORK, seo: { description: 'M1 寫的', confidence: 'high' } }, WORK.id)).toBe('M1 寫的');
        expect(seoDescription({ ...WORK, seo: { description: 'M1 寫的', confidence: 'low' } }, WORK.id)).not.toBe('M1 寫的');
    });
    it('截 120 字（按码点，不切坏扩展区汉字）', () => {
        const long = '𠀀'.repeat(200);
        const d = seoDescription({ ...WORK, authors: [], measure_info: '', description: long }, WORK.id);
        expect(Array.from(d)).toHaveLength(120);
        expect(d.endsWith('…')).toBe(true);
        expect(clip('短')).toBe('短');
    });
    it('人物：（朝代）籍贯人。简介；无简介补著录作品数；什么都没有也不为空', () => {
        expect(seoDescription({ type: 'entity', primary_name: '黃謨', dynasty: '清', native_place: '海鹽', works: [{}, {}] }, 'x'))
            .toBe('（清）海鹽人。著录作品 2 部。');
        expect(seoDescription({ type: 'entity', primary_name: '某' }, 'x')).toBe('某，开源古籍索引条目。');
    });
});

describe('buildItemSeo', () => {
    it('作品 → Book，作者带人物页 @id，版本只以 URL 引用，非法 id 丢弃', () => {
        const s = buildItemSeo(WORK, WORK.id, `${SITE}/`);
        expect(s.title).toBe('史記');
        expect(s.canonicalPath).toBe('/item/d59f20aowb9c');
        expect(s.ogType).toBe('book');
        expect(s.jsonLd).toEqual({
            '@context': 'https://schema.org',
            '@type': 'Book',
            name: '史記',
            url: `${SITE}/item/d59f20aowb9c`,
            description: s.description,
            alternateName: ['太史公書', '太史公記'],
            author: [
                { '@type': 'Person', name: '司馬遷', '@id': `${SITE}/item/hixhd2h9bhma` },
                { '@type': 'Person', name: '無名' },
            ],
            inLanguage: 'lzh',
            workExample: [{ '@type': 'Book', '@id': `${SITE}/item/988g3f0wsu` }],
        });
    });

    it('版本 → Book：title 带版本名，exampleOfWork／isPartOf 指页面', () => {
        const s = buildItemSeo({
            id: '988g3gl3if', type: 'book', title: '九經字樣', edition: '薈要本',
            work_id: 'd59f28kmwt1i', contained_in: [{ id: '8rlcsybg2hhl' }],
        }, '988g3gl3if', SITE);
        expect(s.title).toBe('九經字樣（薈要本）');
        expect(s.jsonLd).toMatchObject({
            '@type': 'Book', bookEdition: '薈要本',
            exampleOfWork: { '@id': `${SITE}/item/d59f28kmwt1i` },
            isPartOf: [{ '@type': 'Collection', '@id': `${SITE}/item/8rlcsybg2hhl` }],
        });
    });

    it('丛编 → Collection：hasPart 最多 100 个；没有成员就不出 hasPart', () => {
        const many = Array.from({ length: 150 }, (_, i) => ({ id: `d59f2${String(i).padStart(7, '0')}` }));
        const s = buildItemSeo({ type: 'collection', title: '叢', contained_works: many }, '8rlcsybg2hhi', SITE);
        expect(s.ogType).toBe('website');
        expect((s.jsonLd.hasPart as unknown[]).length).toBe(100);
        expect(buildItemSeo({ type: 'collection', title: '叢' }, '8rlcsybg2hhi', SITE).jsonLd).not.toHaveProperty('hasPart');
    });

    it('人物 → Person：生卒年有才出，公元前年份写成 ISO 扩展年', () => {
        const s = buildItemSeo({
            type: 'entity', primary_name: '司馬遷', dynasty: '西漢',
            alt_names: [{ name: '子長', type: '字' }], birth_year: -145,
        }, 'hixhd2h9bhma', SITE);
        expect(s.title).toBe('司馬遷（西漢）');
        expect(s.ogType).toBe('profile');
        expect(s.jsonLd).toMatchObject({ '@type': 'Person', alternateName: ['子長'], birthDate: '-0145' });
        expect(s.jsonLd).not.toHaveProperty('deathDate');
    });
});

describe('mergedTarget／jsonLdScript', () => {
    it('merged_into 为合法且不等于自己的 id 才跳', () => {
        expect(mergedTarget({ merged_into: 'd59f2abcdefg' }, 'd59f20aowb9c')).toBe('d59f2abcdefg');
        expect(mergedTarget({ merged_into: { id: 'd59f2abcdefg' } }, 'x')).toBe('d59f2abcdefg');
        expect(mergedTarget({ merged_into: 'd59f20aowb9c' }, 'd59f20aowb9c')).toBeNull();
        expect(mergedTarget({ merged_into: '../x' }, 'y')).toBeNull();
        expect(mergedTarget({}, 'y')).toBeNull();
    });
    it('数据里的 </script> 不会截断脚本', () => {
        const out = jsonLdScript({ name: '</script><script>alert(1)</script>' });
        expect(out).not.toContain('</script>');
        expect(JSON.parse(out).name).toBe('</script><script>alert(1)</script>');
    });
});
