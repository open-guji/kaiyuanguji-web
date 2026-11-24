/**
 * 字格永久编号 u（guji-char v0.6）：char.json 读 u、深链 ?u= 与 ?cell=、各处提交带 u、公开意见清单带 u。
 */
import { collectU, parseCellLink, resolveCellLink, cellHref, uField, uPairFields, isU, U_MAX } from '../cell-u';
import { collectEntities, submitCharFix, submitEntityFix, submitSpanFix, type CharFixCtx } from '../charfix';
import { buildFeedbackBody } from '../feedback';
import { itemFields, parseExtras } from '../proofing';
import { groupFixes, parsePublicFixes } from '../fixes';

jest.mock('book-index-ui', () => ({ adaptCharCord: jest.fn() }));

const charV06 = {
    $schema: 'https://open-guji.org/schema/char/v0.6.json',
    version: '0.5.4',
    book_id: '995ejelvk0',
    volume: 7,
    u_max: 6,
    u_retired: [{ u: 5, gone: true }],
    pages: [
        { page: 77, columns: [{ col: 9, cells: [{ a: '77:9:14', u: 1, c: '欽' }, { a: '77:9:15', u: 2, c: '定' }, { a: '77:9:16a', u: 6, c: '四' }] }] },
        { page: 78, columns: [{ col: 1, cells: [{ a: '78:1:1', u: 3, c: '庫' }] }] },
    ],
};
const charV05 = { ...charV06, $schema: 'https://open-guji.org/schema/char/v0.5.json', u_max: undefined, u_retired: undefined,
    pages: charV06.pages.map((p) => ({ ...p, columns: p.columns.map((c) => ({ ...c, cells: c.cells.map(({ a, c: ch }) => ({ a, c: ch })) })) })) };

describe('collectU：char.json → 格位与 u', () => {
    it('v0.6 每格有 u：两个方向都对得上', () => {
        const idx = collectU(charV06);
        expect([...idx.byA]).toEqual([['77:9:14', 1], ['77:9:15', 2], ['77:9:16a', 6], ['78:1:1', 3]]);
        expect(idx.byU.get(6)).toBe('77:9:16a');
    });
    it('v0.5 及以前没有 u：两个表都空，不报错', () => {
        const idx = collectU(charV05);
        expect(idx.byA.size).toBe(0);
        expect(idx.byU.size).toBe(0);
        expect(collectU(null).byA.size).toBe(0);
        expect(collectU({ pages: 'x' }).byA.size).toBe(0);
    });
    it('u 不合法的格跳过；同一个 u 出现两次（数据坏了）两格都不认', () => {
        const bad = { pages: [{ page: 1, columns: [{ col: 1, cells: [
            { a: '1:1:1', u: 0 }, { a: '1:1:2', u: 1.5 }, { a: '1:1:3', u: '4' }, { a: 'x', u: 9 },
            { a: '1:1:4', u: 7 }, { a: '1:1:5', u: 7 }, { a: '1:1:6', u: 8 },
        ] }] }] };
        const idx = collectU(bad);
        expect([...idx.byA]).toEqual([['1:1:6', 8]]);
        expect([...idx.byU]).toEqual([[8, '1:1:6']]);
    });
});

describe('深链：?u= 优先，兼容 ?cell=', () => {
    const idx = collectU(charV06);
    it('parseCellLink', () => {
        expect(parseCellLink('?u=2')).toEqual({ u: 2 });
        expect(parseCellLink('?u=1~3')).toEqual({ u: 1, uEnd: 3 });
        expect(parseCellLink('?u=2~2')).toEqual({ u: 2 });
        expect(parseCellLink('?cell=77:9:15')).toEqual({ cell: '77:9:15' });
        expect(parseCellLink('?cell=77:9:15~78:1:1')).toEqual({ cell: '77:9:15~78:1:1' });
        expect(parseCellLink('?u=2&cell=1:1:1')).toEqual({ u: 2 });
        // u 不合法时退到 cell
        expect(parseCellLink('?u=abc&cell=1:1:1')).toEqual({ cell: '1:1:1' });
        for (const bad of ['', '?u=0', '?u=-1', '?u=1.5', '?u=123456789', '?cell=a:b', '?cell=1:1', '?proof=1']) expect(parseCellLink(bad)).toBeNull();
    });
    it('resolveCellLink：u → 本章格位；范围；查不到为 null（交给 #格位 兜底）', () => {
        expect(resolveCellLink({ u: 2 }, idx)).toBe('77:9:15');
        expect(resolveCellLink({ u: 1, uEnd: 3 }, idx)).toBe('77:9:14~78:1:1');
        expect(resolveCellLink({ u: 1, uEnd: 99 }, idx)).toBe('77:9:14');
        expect(resolveCellLink({ u: 99 }, idx)).toBeNull();
        expect(resolveCellLink({ u: 2 }, collectU(charV05))).toBeNull();
        expect(resolveCellLink({ cell: '9:9:9' }, idx)).toBe('9:9:9');
        expect(resolveCellLink(null, idx)).toBeNull();
    });
    it('cellHref：有 u 写 ?u=，格位照写进 #', () => {
        expect(cellHref('96mid1ogzk', '031', { a: '3:4:6a', u: 1234 })).toBe('/read/96mid1ogzk/031?u=1234#3:4:6a');
        expect(cellHref('96mid1ogzk', '031', { a: '3:4:6a', u: 12, end: '3:4:8', uEnd: 14 })).toBe('/read/96mid1ogzk/031?u=12~14#3:4:6a~3:4:8');
        expect(cellHref('96mid1ogzk', '031', { a: '3:4:6a' })).toBe('/read/96mid1ogzk/031#3:4:6a');
        expect(cellHref('96mid1ogzk', '031', { u: 5 })).toBe('/read/96mid1ogzk/031?u=5');
        expect(cellHref('96mid1ogzk', '031', { a: 'bad', u: 0 })).toBe('/read/96mid1ogzk/031');
    });
    it('提交字段：u 合法才带，起止要成对', () => {
        expect(isU(U_MAX)).toBe(true);
        expect(isU(U_MAX + 1)).toBe(false);
        expect(uField(3)).toEqual({ u: 3 });
        expect(uField(undefined)).toEqual({});
        expect(uPairFields(3, 4)).toEqual({ u_start: 3, u_end: 4 });
        expect(uPairFields(3, undefined)).toEqual({});
    });
});

describe('阅读页提交带 u', () => {
    const ctx = (u?: Map<string, number>): CharFixCtx => ({
        book: 'd59f2870u874', volume: '002', chapter: '002', textVersion: '1.0.0',
        chars: new Map([['4:3:8', '紀'], ['4:3:9', '昀']]), ...(u ? { u } : {}),
        entities: [{ id: 'e01384', start: '4:3:8', end: '4:3:9', text: '紀昀' }], entityVersion: '1.8.12',
    });
    const sent = () => {
        const bodies: Record<string, unknown>[] = [];
        const f = jest.fn(async (_u: unknown, init?: RequestInit) => { bodies.push(JSON.parse(String(init?.body))); return { ok: true, status: 200, json: async () => ({ success: true }) }; });
        return { f: f as unknown as typeof fetch, bodies };
    };
    const umap = new Map([['4:3:8', 41], ['4:3:9', 42]]);

    it('改字：有 u 带 u，没有不带', async () => {
        const a = sent();
        expect(await submitCharFix(ctx(umap), { cell: '4:3:8', newChar: '记', basis: '' }, a.f)).toBeNull();
        expect(a.bodies[0]).toMatchObject({ cell_id: '4:3:8', u: 41 });
        const b = sent();
        await submitCharFix(ctx(), { cell: '4:3:8', newChar: '记', basis: '' }, b.f);
        expect(b.bodies[0]).not.toHaveProperty('u');
    });
    it('一段：首末格 u 成对带', async () => {
        const a = sent();
        await submitSpanFix(ctx(umap), { span: { start: '4:3:8', end: '4:3:9', text: '紀昀', count: 2 }, sub: 'wrong', newText: '纪昀', note: '' }, a.f);
        expect(a.bodies[0]).toMatchObject({ start: '4:3:8', end: '4:3:9', u_start: 41, u_end: 42 });
        const b = sent();
        await submitSpanFix(ctx(new Map([['4:3:8', 41]])), { span: { start: '4:3:8', end: '4:3:9', text: '紀昀', count: 2 }, sub: 'wrong', newText: '纪昀', note: '' }, b.f);
        expect(b.bodies[0]).not.toHaveProperty('u_start');
    });
    it('专名：专名层自带的 u_start／u_end 优先，没有就按 char 现查', async () => {
        const ents = collectEntities({ entities: [{ id: 'e01384', anchor: { start: '4:3:8', end: '4:3:9' }, text: '紀昀', u_start: 7, u_end: 8 }] });
        expect(ents[0]).toMatchObject({ uStart: 7, uEnd: 8 });
        const a = sent();
        await submitEntityFix(ctx(umap), { entity: ents[0], note: '應作紀曉嵐' }, a.f);
        expect(a.bodies[0]).toMatchObject({ u_start: 7, u_end: 8 });
        const b = sent();
        await submitEntityFix(ctx(umap), { entity: ctx().entities[0], note: '應作紀曉嵐' }, b.f);
        expect(b.bodies[0]).toMatchObject({ u_start: 41, u_end: 42 });
    });
    it('选字报错走通用反馈：带首格格位与 u', () => {
        const body = buildFeedbackBody({ type: 'bug', text: '這段錯了', pageUrl: 'https://x/read/a/002', context: { quote: '紀昀', cell: '4:3:8', u: 41 } });
        expect(body).toMatchObject({ cell: '4:3:8', u: 41 });
        const none = buildFeedbackBody({ type: 'bug', text: '這段錯了', pageUrl: 'https://x/read/a/002', context: { cell: 'bad', u: 0 } });
        expect(none).not.toHaveProperty('cell');
        expect(none).not.toHaveProperty('u');
    });
});

describe('校对页：待审单条目带 u 就随票提交', () => {
    it('parseExtras 读 u；itemFields 带上', () => {
        const ex = parseExtras({ id: 'pi_0123456789ab', ver: 2, u: 1234 });
        expect(ex).toMatchObject({ item: 'pi_0123456789ab', itemVer: 2, u: 1234 });
        expect(itemFields(ex)).toEqual({ item: 'pi_0123456789ab', ver: 2, u: 1234 });
        expect(itemFields(parseExtras({ u: 'x' }))).toEqual({});
        expect(itemFields({ u: 5 })).toEqual({ u: 5 });
    });
});

describe('公开意见清单：u 用来做链接', () => {
    it('parsePublicFixes 读 u／ue，groupFixes 取最近一条带 u 的', () => {
        const raw = { volumes: { '002': [
            { kind: 'char', at: '4:3:8', who: 'aaaaaa', ts: 1 },
            { kind: 'char', at: '4:3:8', who: 'bbbbbb', ts: 2, u: 41 },
            { kind: 'span', at: '4:3:8', end: '4:3:9', sub: 'wrong', who: 'cccccc', ts: 3, u: 41, ue: 42 },
            { kind: 'char', at: '4:3:9', who: 'dddddd', u: 0, ue: 5 },
        ] } };
        const fixes = parsePublicFixes(raw, '002');
        expect(fixes[1].u).toBe(41);
        expect(fixes[2]).toMatchObject({ u: 41, ue: 42 });
        expect(fixes[3]).not.toHaveProperty('u');
        expect(fixes[3]).not.toHaveProperty('ue');
        const groups = groupFixes(fixes);
        const ch = groups.find((x) => x.kind === 'char' && x.at === '4:3:8')!;
        expect(ch.u).toBe(41);
        const sp = groups.find((x) => x.kind === 'span')!;
        expect(sp).toMatchObject({ u: 41, ue: 42 });
    });
});
