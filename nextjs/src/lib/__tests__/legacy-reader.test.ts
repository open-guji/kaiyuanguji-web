/**
 * @jest-environment node
 *
 * overview#307 E 块：旧阅读地址 → 新路径式地址。
 * 章号与版本都按规则换算（不把文本总管那张约 11 万行的对照表塞进中间件）；下面的用例里的地址取自对照表的真实行。
 */
import { describe, it, expect } from '@jest/globals';
import { legacyChapter, legacyReaderTarget, legacyVersionKey, parseLegacyReaderParams, parseLegacyTab, type LegacyReaderRef, type ManifestLike } from '../legacy-reader';

const WORK = 'd59f2htm01du';
const BOOK = '988fbiuha8';
const ENTITY = 'hixhd2h9bk4b';
const qs = (s: string) => new URLSearchParams(s);

const v = (key: string, kind: string, source: string) => ({ key, kind, source });
const COLLATED_DEFAULT: ManifestLike = { versions: [v('default', 'collated', 'collated'), v('wikisource', 'transcription', 'wikisource'), v('kanripo', 'transcription', 'kanripo')] };
const WIKI_DEFAULT: ManifestLike = { versions: [v('default', 'transcription', 'wikisource'), v('kanripo', 'transcription', 'kanripo')] };
const KANRIPO_ONLY: ManifestLike = { versions: [v('default', 'transcription', 'kanripo')] };
const TWO_WIKI: ManifestLike = { versions: [v('default', 'transcription', 'wikisource'), v('wikisource-2', 'transcription', 'wikisource')] };

describe('legacyChapter：旧卷／章号 → 三位章号（对照表 109,510 行全部一致）', () => {
    it.each([
        ['011', '011'], ['1', '001'], ['juan/011.json', '011'], ['001.md', '001'], ['第001', '001'], ['卷01', '001'], ['12', '012'], ['juan/100.json', '100'],
    ])('%s → %s', (input, expected) => expect(legacyChapter(input)).toBe(expected));
    it('没有数字或没带 → undefined（该版本的第一章）', () => {
        expect(legacyChapter('序')).toBeUndefined();
        expect(legacyChapter('')).toBeUndefined();
        expect(legacyChapter(undefined)).toBeUndefined();
    });
});

describe('parseLegacyReaderParams：旧查询串里的 kind／key／juan', () => {
    it('没有旧参数 → null（不是旧地址）；其他参数（utm 等）不算', () => {
        expect(parseLegacyReaderParams(WORK, qs(''))).toBeNull();
        expect(parseLegacyReaderParams(WORK, qs('utm_source=x'))).toBeNull();
    });
    it('kind／key／juan 原样带出；kind 缺省按类型（Work 整理本、Book 全文）；不合法的 kind 当没写', () => {
        expect(parseLegacyReaderParams(WORK, qs('kind=fulltext&key=wikisource-01&juan=2'))).toEqual({ id: WORK, kind: 'fulltext', key: 'wikisource-01', juan: '2' });
        expect(parseLegacyReaderParams(WORK, qs('juan=011'))).toEqual({ id: WORK, kind: 'collated', key: undefined, juan: '011' });
        expect(parseLegacyReaderParams(BOOK, qs('juan=001'))).toEqual({ id: BOOK, kind: 'fulltext', key: undefined, juan: '001' });
        expect(parseLegacyReaderParams(WORK, qs('kind=bogus&juan=1'))?.kind).toBe('collated');
    });
    it('条目类型没有阅读页 → null', () => {
        expect(parseLegacyReaderParams(ENTITY, qs('kind=fulltext'))).toBeNull();
    });
});

describe('parseLegacyTab：条目页页签形式', () => {
    it('/book-index?id=…&tab= 与 /item/<id>?tab=', () => {
        expect(parseLegacyTab('/book-index', qs(`id=${WORK}&tab=collated&juan=juan/011.json`))).toEqual({ id: WORK, kind: 'collated', juan: 'juan/011.json' });
        expect(parseLegacyTab(`/item/${BOOK}`, qs('tab=fulltext&juan=003'))).toEqual({ id: BOOK, kind: 'fulltext', juan: '003' });
    });
    it('别的 tab、升格横幅往返、条目类型没有阅读页、id 不对 → null', () => {
        expect(parseLegacyTab(`/item/${WORK}`, qs('tab=lineage'))).toBeNull();
        expect(parseLegacyTab(`/item/${WORK}`, qs('tab=fulltext&redirected_from=x'))).toBeNull();
        expect(parseLegacyTab(`/item/${WORK}`, qs('tab=fulltext&no_redirect=1'))).toBeNull();
        expect(parseLegacyTab(`/item/${ENTITY}`, qs('tab=fulltext'))).toBeNull();
        expect(parseLegacyTab('/book-index', qs('tab=fulltext'))).toBeNull();
        expect(parseLegacyTab(`/item/${WORK}/read`, qs('tab=fulltext'))).toBeNull();
    });
});

const ref = (over: Partial<LegacyReaderRef>): LegacyReaderRef => ({ id: WORK, kind: 'fulltext', ...over });

describe('legacyVersionKey：旧引用对应 manifest 的哪份', () => {
    it('整理本 → kind=collated 那份（default 或 collated）；没有整理本回落第一份', () => {
        expect(legacyVersionKey(COLLATED_DEFAULT, ref({ kind: 'collated' }))).toBe('default');
        expect(legacyVersionKey({ versions: [v('default', 'transcription', 'wikisource'), v('collated', 'collated', 'collated')] }, ref({ kind: 'collated' }))).toBe('collated');
        expect(legacyVersionKey(WIKI_DEFAULT, ref({ kind: 'collated' }))).toBe('default');
    });
    it('全文带 key：先按新 key 精确匹配，再按来源与序号', () => {
        expect(legacyVersionKey(COLLATED_DEFAULT, ref({ key: 'wikisource-01' }))).toBe('wikisource');
        expect(legacyVersionKey(COLLATED_DEFAULT, ref({ key: 'kanripo-01' }))).toBe('kanripo');
        expect(legacyVersionKey(WIKI_DEFAULT, ref({ key: 'kanripo-01' }))).toBe('kanripo');
        expect(legacyVersionKey(TWO_WIKI, ref({ key: 'wikisource-02' }))).toBe('wikisource-2');
        expect(legacyVersionKey(TWO_WIKI, ref({ key: 'wikisource-01' }))).toBe('default');
    });
    it('旧的 wikisource-02 迁移后是唯一一份（成了 default）：同来源只有一份就是它', () => {
        expect(legacyVersionKey({ versions: [v('default', 'transcription', 'wikisource')] }, ref({ key: 'wikisource-02' }))).toBe('default');
        expect(legacyVersionKey(KANRIPO_ONLY, ref({ key: 'kanripo-01' }))).toBe('default');
    });
    it('全文不带 key（Book，或 Work 由阅读器取首选）→ 第一份 transcription', () => {
        expect(legacyVersionKey(COLLATED_DEFAULT, ref({}))).toBe('wikisource');
        expect(legacyVersionKey({ versions: [v('default', 'transcription', 'wikisource')] }, ref({ id: BOOK }))).toBe('default');
    });
    it('旧 key 在 manifest 里找不到对应来源：回落第一份 transcription', () => {
        expect(legacyVersionKey(WIKI_DEFAULT, ref({ key: 'shidian-01' }))).toBe('default');
    });
    it('manifest 没有版本 → null', () => {
        expect(legacyVersionKey({ versions: [] }, ref({}))).toBeNull();
        expect(legacyVersionKey(null, ref({}))).toBeNull();
    });
});

describe('legacyReaderTarget：对照表里的真实行', () => {
    // item/d59f207tw000/read?kind=fulltext&key=wikisource-01&juan=1 → /read/d59f207tw000/001（default）
    it('维基是 default：不写 key，章号补成三位', () => {
        expect(legacyReaderTarget(ref({ id: WORK, key: 'wikisource-01', juan: '1' }), WIKI_DEFAULT)).toBe(`/read/${WORK}/001`);
    });
    // item/d59f2mox0000/read?kind=fulltext&key=wikisource-01&juan=1 → /read/d59f2mox0000/wikisource/001（整理本是 default）
    it('整理本是 default、维基是另一份：写 key', () => {
        expect(legacyReaderTarget(ref({ key: 'wikisource-01', juan: '1' }), COLLATED_DEFAULT)).toBe(`/read/${WORK}/wikisource/001`);
    });
    // item/d59f2njr0002/read?kind=fulltext&key=kanripo-01&juan=1 → /read/d59f2njr0002/kanripo/001
    it('Kanripo 非 default', () => {
        expect(legacyReaderTarget(ref({ key: 'kanripo-01', juan: '1' }), WIKI_DEFAULT)).toBe(`/read/${WORK}/kanripo/001`);
    });
    it('整理本：旧卷号 juan/011.json、011 都换成章号；整理本是 default 不写 key', () => {
        expect(legacyReaderTarget(ref({ kind: 'collated', juan: 'juan/011.json' }), COLLATED_DEFAULT)).toBe(`/read/${WORK}/011`);
        expect(legacyReaderTarget(ref({ kind: 'collated', juan: '011' }), COLLATED_DEFAULT)).toBe(`/read/${WORK}/011`);
    });
    it('Book 全文：kind=fulltext（没 key）→ /read/<id>[/章]', () => {
        const m: ManifestLike = { versions: [v('default', 'transcription', 'wikisource')] };
        expect(legacyReaderTarget({ id: BOOK, kind: 'fulltext', juan: '第003' }, m)).toBe(`/read/${BOOK}/003`);
        expect(legacyReaderTarget({ id: BOOK, kind: 'fulltext' }, m)).toBe(`/read/${BOOK}`);
    });
    it('没有 juan：版本的短地址（第一章）', () => {
        expect(legacyReaderTarget(ref({ key: 'wikisource-01' }), COLLATED_DEFAULT)).toBe(`/read/${WORK}/wikisource`);
    });
    it('条目没有文本（manifest 为 null 或无版本）→ null，调用方跳条目页', () => {
        expect(legacyReaderTarget(ref({}), null)).toBeNull();
        expect(legacyReaderTarget(ref({}), { versions: [] })).toBeNull();
    });
});
