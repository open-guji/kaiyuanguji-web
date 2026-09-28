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

const L = (t: string) => Array.from(t).length;

describe('seoDescription：作品', () => {
    it('书名、别名、（朝代）作者角色、卷数、存佚、部类、简介；不取 ai_note', () => {
        const d = seoDescription(WORK, WORK.id);
        expect(d).toBe('《史記》，又名《太史公書》《太史公記》，（西漢）司馬遷撰、無名。一百三十篇。今存。本站收錄其版本 1 種。開源古籍索引作品條目。');
        expect(d).not.toContain('內部備註');
    });
    it('简介里重复作者、卷数的开头句不再出；套话排到最后', () => {
        const d = seoDescription({
            type: 'work', title: '敘州府志', authors: [{ name: '周洪謨', role: '撰', dynasty: '明' }], measure_info: '十二卷',
            description: { text: '周洪謨（明）撰。十二卷。本書惟《明史藝文志》一志著錄，別無他證。見著錄於《明史藝文志》。' },
        }, 'x');
        expect(d.startsWith('《敘州府志》，（明）周洪謨撰。十二卷。見著錄於《明史藝文志》。本書惟')).toBe(true);
        // 简介开头的「今存」与存佚字段重复，不出两次
        const x = seoDescription({ type: 'work', title: '史記', loss_status: 'extant', description: '今存。或稱《太史公書》。' }, 'x');
        expect(x.startsWith('《史記》。今存。或稱《太史公書》。')).toBe(true);
    });
    it('没有简介：引第一条书目著录原文并标出处；列著录书目、版本数、相關資源', () => {
        const d = seoDescription({
            type: 'work', title: '洞序', authors: [{ name: '應奉', role: '撰', dynasty: '東漢' }], loss_status: 'lost',
            classification: { l1: '子部', l2: '雜家類' },
            indexed_by: [{ source: '後漢藝文志', summary: '應奉洞序九卷。隋書經籍志：梁有洞序九卷。' }, { source: '補後漢書藝文志' }],
            books: ['988g3f0wsu'], resources: [{ name: '維基文庫' }],
        }, 'x');
        expect(d).toBe('《洞序》，（東漢）應奉撰。已佚。屬子部雜家類。《後漢藝文志》著錄：應奉洞序九卷。隋書經籍志：梁有洞序九卷。又見著錄於《補後漢書藝文志》。本站收錄其版本 1 種。相關資源：維基文庫。');
    });
    it('缺作者有朝代 → 书名后标朝代；存佚值不认识就不出；著录原形不当别名', () => {
        const d = seoDescription({
            type: 'work', title: '守法守令', dynasty: '漢', loss_status: 'unknown',
            additional_titles: ['守法守令孫臏撰', '謹按見《世說》注'], authors: [{ name: '孫臏' }],
        }, 'x');
        expect(d).toBe('《守法守令》，孫臏。開源古籍索引作品條目。'); // 有作者时不另标朝代；两个假别名都不出
        const bare = seoDescription({ type: 'work', title: '尚書舊事', dynasty: '漢', loss_status: 'unknown', additional_titles: ['謹按見《世說》注'] }, 'x');
        expect(bare).toBe('《尚書舊事》（漢）。開源古籍索引作品條目。');
    });
    it('引文以「。」」收尾时不再补句号', () => {
        expect(seoDescription({ type: 'work', title: '伊川易解', description: '陳振孫曰：「止解六十四卦。」' }, 'x'))
            .toBe('《伊川易解》。陳振孫曰：「止解六十四卦。」開源古籍索引作品條目。');
    });
    it('长简介：总长不过 160，整句放不下时截断收尾', () => {
        const long = `${'甲'.repeat(300)}。`;
        const d = seoDescription({ type: 'work', title: '某書', description: long }, 'x');
        expect(L(d)).toBe(160);
        expect(d.endsWith('…')).toBe(true);
    });
    it('截断按码点，不切坏扩展区汉字', () => {
        const d = seoDescription({ type: 'work', title: '某', description: '𠀀'.repeat(200) }, 'x');
        expect(L(d)).toBeLessThanOrEqual(160);
        expect(d).not.toMatch(/[\uD800-\uDBFF]$/);
        expect(clip('短')).toBe('短');
    });
    it('M1 描述 confidence 为 high／medium 才用，low 不用', () => {
        expect(seoDescription({ ...WORK, seo: { description: 'M1 寫的', confidence: 'high' } }, WORK.id)).toBe('M1 寫的');
        expect(seoDescription({ ...WORK, seo: { description: 'M1 寫的', confidence: 'low' } }, WORK.id)).not.toBe('M1 寫的');
    });
    it('数据全空也不出空 description', () => {
        expect(seoDescription({ type: 'work' }, 'd59f2abcdefg')).toBe('《d59f2abcdefg》。開源古籍索引作品條目。');
    });
});

describe('seoDescription：版本', () => {
    it('书名＋版本名、部类、藏地索书号、简介', () => {
        const d = seoDescription({
            type: 'book', title: '吳邑志', edition: '明嘉靖刻本', section: '史部',
            provenance: [{ institution: '國立故宮博物院', call_number: '故志005041' }],
            description: '十六卷，圖說一卷。', resources: [{ name: '國立故宮博物院善本古籍', short_name: '故宮善本' }],
        }, 'x');
        expect(d).toBe('《吳邑志》明嘉靖刻本。屬史部。國立故宮博物院藏，索書號故志005041。十六卷，圖說一卷。相關資源：故宮善本。開源古籍索引版本條目。');
    });
    it('只有书名和版本名：不编造，补站名句', () => {
        expect(seoDescription({ type: 'book', title: '詩傳遺說', edition: '薈要本' }, 'x')).toBe('《詩傳遺說》薈要本。開源古籍索引版本條目。');
    });
});

describe('seoDescription：丛编', () => {
    it('编者（英文角色占位不出）、出版、收书种数与册数', () => {
        const d = seoDescription({
            type: 'collection', title: '四庫全書珍本初集',
            authors: [{ name: '商務印書館', role: '編' }, { name: '紀昀', role: 'author' }],
            publication_info: { publisher: '商務印書館', year: '1933-1935' },
            count: { zhong: 231, ce: 1960, juan: null },
        }, 'x');
        expect(d).toBe('《四庫全書珍本初集》，商務印書館編、紀昀。商務印書館 1933-1935 年出版。收書 231 種，1960 冊。開源古籍索引叢編條目。');
    });
    it('没有 count 时用成员数；出版年是「推算」或只有朝代名的不出', () => {
        const d = seoDescription({
            type: 'collection', title: '叢', publication_info: { year: '清初（推算）' },
            contained_works: [{ id: 'd59f2abcdefg' }], books: ['988g3f0wsu'],
        }, 'x');
        expect(d).toBe('《叢》。本站收錄其子目 2 種。開源古籍索引叢編條目。');
        expect(seoDescription({ type: 'collection', title: '正始石經', publication_info: { year: '曹魏正始年間' } }, 'x'))
            .toBe('《正始石經》。曹魏正始年間。開源古籍索引叢編條目。');
    });
});

describe('seoDescription：人物', () => {
    it('名、字號（字在前）、（朝代）籍贯人、生卒、作品数（多角色分列）', () => {
        const d = seoDescription({
            type: 'entity', primary_name: '何秋濤', dynasty: '清', native_place: '光澤',
            alt_names: [{ name: '一燈精舍', type: '號' }, { name: '巨源', type: '字' }, { name: '海槎', type: '別名' }, { name: '何秋濤', type: '著錄形' }],
            dates: { birth: 1824, death: 1862 },
            works: [{ role: '撰' }, { role: '撰' }, { role: '注' }],
        }, 'x');
        expect(d).toBe('何秋濤，字巨源，號一燈精舍，又名海槎，（清）光澤人，1824—1862。本站著錄其作品 3 部（撰 2、注 1）。開源古籍索引人物條目。');
    });
    it('缺籍贯、缺卒年、有简介', () => {
        expect(seoDescription({ type: 'entity', primary_name: '趙學敏', dynasty: '清', birth_year: 1719, description: { text: '清醫家' } }, 'x'))
            .toBe('趙學敏，清人，生於1719年。清醫家。開源古籍索引人物條目。');
        expect(seoDescription({ type: 'entity', primary_name: '司馬遷', death_year: -86 }, 'x')).toBe('司馬遷，卒於前86年。開源古籍索引人物條目。');
    });
    it('只有名字：不编造', () => {
        expect(seoDescription({ type: 'entity', primary_name: '某' }, 'x')).toBe('某。開源古籍索引人物條目。');
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
            '@id': `${SITE}/item/d59f20aowb9c`,
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

    it('作品：单篇 → CreativeWork；部类进 genre；收入丛编进 isPartOf', () => {
        const s = buildItemSeo({
            type: 'work', subtype: 'poem', title: '冉冉孤生竹',
            classification: { l1: '集部', l2: '別集類' }, contained_in: [{ id: '8rlcsybg2hin' }],
        }, 'd59f2abcdefg', SITE);
        expect(s.jsonLd).toMatchObject({
            '@type': 'CreativeWork', genre: '集部·別集類',
            isPartOf: [{ '@type': 'Collection', '@id': `${SITE}/item/8rlcsybg2hin` }],
        });
        expect(s.jsonLd).not.toHaveProperty('author');
    });

    it('版本 → Book：title 带版本名，exampleOfWork／isPartOf 指页面，成书年只收确定的单一年份', () => {
        const s = buildItemSeo({
            id: '988g3gl3if', type: 'book', title: '九經字樣', edition: '薈要本', section: '經部',
            work_id: 'd59f28kmwt1i', contained_in: [{ id: '8rlcsybg2hhl' }],
            dating: { era: '清', year: 1740, certainty: 'inferred' },
        }, '988g3gl3if', SITE);
        expect(s.title).toBe('九經字樣（薈要本）');
        expect(s.jsonLd).toMatchObject({
            '@type': 'Book', bookEdition: '薈要本', inLanguage: 'lzh', genre: '經部', dateCreated: '1740',
            exampleOfWork: { '@id': `${SITE}/item/d59f28kmwt1i` },
            isPartOf: [{ '@type': 'Collection', '@id': `${SITE}/item/8rlcsybg2hhl` }],
        });
        const loose = buildItemSeo({ type: 'book', title: '某', dating: { year: 1740, certainty: 'uncertain' } }, '988g3gl3if', SITE);
        expect(loose.jsonLd).not.toHaveProperty('dateCreated');
        expect(loose.jsonLd).not.toHaveProperty('exampleOfWork');
    });

    it('版本：满文本不标 inLanguage=lzh；机构作者出 Organization', () => {
        const s = buildItemSeo({
            type: 'book', title: '三國演義', edition: '清故宮藏滿文譯本', authors: [{ name: '上海博物館', role: '整理' }],
        }, '988g3gl3if', SITE);
        expect(s.jsonLd).not.toHaveProperty('inLanguage');
        expect(s.jsonLd.author).toEqual([{ '@type': 'Organization', name: '上海博物館' }]);
    });

    it('丛编 → Collection：hasPart 最多 100 个；collectionSize 取 count.zhong，否则成员数；出版社与出版年', () => {
        const many = Array.from({ length: 150 }, (_, i) => ({ id: `d59f2${String(i).padStart(7, '0')}` }));
        const s = buildItemSeo({
            type: 'collection', title: '叢', contained_works: many,
            publication_info: { publisher: '中華書局', year: '2014' },
        }, '8rlcsybg2hhi', SITE);
        expect(s.ogType).toBe('website');
        expect((s.jsonLd.hasPart as unknown[]).length).toBe(100);
        expect(s.jsonLd).toMatchObject({
            '@type': 'Collection', collectionSize: 150,
            publisher: { '@type': 'Organization', name: '中華書局' }, datePublished: '2014',
        });
        const bare = buildItemSeo({ type: 'collection', title: '叢', count: { zhong: 231 }, publication_info: { year: '1995-2002' } }, '8rlcsybg2hhi', SITE);
        expect(bare.jsonLd).not.toHaveProperty('hasPart');
        expect(bare.jsonLd).not.toHaveProperty('datePublished');
        expect(bare.jsonLd.collectionSize).toBe(231);
        expect(buildItemSeo({ type: 'collection', title: '叢' }, '8rlcsybg2hhi', SITE).jsonLd).not.toHaveProperty('collectionSize');
    });

    it('人物 → Person：生卒年有才出（dates 兜底），公元前年份写成 ISO 扩展年', () => {
        const s = buildItemSeo({
            type: 'entity', primary_name: '司馬遷', dynasty: '西漢',
            alt_names: [{ name: '子長', type: '字' }], birth_year: -145,
        }, 'hixhd2h9bhma', SITE);
        expect(s.title).toBe('司馬遷（西漢）');
        expect(s.ogType).toBe('profile');
        expect(s.jsonLd).toMatchObject({ '@type': 'Person', alternateName: ['子長'], birthDate: '-0145' });
        expect(s.jsonLd).not.toHaveProperty('deathDate');
        const d = buildItemSeo({ type: 'entity', primary_name: '某', dates: { birth: null, death: 706 } }, 'hixhd2h9bhma', SITE);
        expect(d.jsonLd).toMatchObject({ deathDate: '0706' });
        expect(d.jsonLd).not.toHaveProperty('birthDate');
    });

    it('人物：subtype=collective → Organization，不出生卒', () => {
        const s = buildItemSeo({ type: 'entity', subtype: 'collective', primary_name: '某整理小組', birth_year: 1970 }, 'hixhd2h9bhma', SITE);
        expect(s.jsonLd['@type']).toBe('Organization');
        expect(s.jsonLd).not.toHaveProperty('birthDate');
    });

    it('JSON-LD 的 description 与 meta description 同源', () => {
        for (const e of [WORK, { type: 'book', title: '某' }, { type: 'collection', title: '叢' }, { type: 'entity', primary_name: '某' }]) {
            const s = buildItemSeo(e, 'hixhd2h9bhma', SITE);
            expect(s.jsonLd.description).toBe(s.description);
            expect(s.jsonLd.name).toBeTruthy();
            expect(s.jsonLd.url).toBe(`${SITE}/item/hixhd2h9bhma`);
        }
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
