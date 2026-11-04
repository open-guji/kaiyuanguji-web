import { clusterKey, clusterChar, parseClusterKey, parseSummary, totals, loadClusterCells, submitBatch, type BookSummary } from '../proofing-cluster';

const summaryRaw = {
    v: 1, book: 'bk01',
    chaps: { '020': { rev: 'r20', n: 2, reasons: { lib_missing: 2 }, voted: 1 }, '021': { rev: 'r21', n: 3, reasons: { lib_missing: 2, hard_pair: 1, 乱写: 1 } } },
    clusters: [
        { k: 'lib_missing~兀', r: 'lib_missing', c: '兀', n: 3, chaps: { '020': 1, '021': 2 } },
        { k: 'bad-key', n: 1, chaps: {} },
    ],
};

describe('聚类键', () => {
    it('原因＋整理本字，缺省退机器字；认不出的原因归 unknown', () => {
        expect(clusterKey({ pendingReason: 'lib_missing', ref: { c: '兀' }, c: '亣' })).toBe('lib_missing~兀');
        expect(clusterKey({ pendingReason: 'hard_pair', c: '日' })).toBe('hard_pair~日');
        expect(clusterKey({})).toBe('unknown~');
        expect(clusterKey({ pendingReason: 'nonsense' })).toBe('unknown~');
        expect(clusterChar({ ref: { c: '兀兀' }, c: '亣' })).toBe('亣');
    });
    it('parseClusterKey：原因要在码表里，字至多一个', () => {
        expect(parseClusterKey('lib_missing~兀')).toEqual({ reason: 'lib_missing', char: '兀' });
        expect(parseClusterKey('unknown~')).toEqual({ reason: 'unknown', char: '' });
        expect(parseClusterKey('nope~兀')).toBeNull();
        expect(parseClusterKey('lib_missing~兀兀')).toBeNull();
        expect(parseClusterKey('lib_missing')).toBeNull();
    });
});

describe('summary', () => {
    it('parseSummary：丢掉坏聚类，认不出的原因并入 unknown；坏数据返回 null', () => {
        const s = parseSummary(summaryRaw, 'bk01')!;
        expect(s.clusters).toHaveLength(1);
        expect(s.chaps['021'].reasons).toEqual({ lib_missing: 2, hard_pair: 1, unknown: 1 });
        expect(parseSummary('x', 'bk01')).toBeNull();
        expect(parseSummary({ chaps: [] }, 'bk01')).toBeNull();
    });
    it('totals：合计待审数、已投数；有章没写 voted 就标未知', () => {
        const s = parseSummary(summaryRaw, 'bk01') as BookSummary;
        expect(totals(s)).toMatchObject({ n: 5, voted: 1, votedKnown: false, byReason: { lib_missing: 4, hard_pair: 1, unknown: 1 } });
    });
});

const pendingJson = (rev: string, cells: unknown[]) => ({ rev, cells });
const fetchOf = (files: Record<string, unknown>) => (async (url: string) => (url in files ? { ok: true, json: async () => files[url] } : { ok: false })) as unknown as typeof fetch;

describe('loadClusterCells', () => {
    it('逐章取待审单，只留这个聚类的格，按章、格位排序；取不到的章记 failed', async () => {
        const s = parseSummary({ ...summaryRaw, clusters: [{ k: 'lib_missing~兀', n: 4, chaps: { '020': 1, '021': 2, '022': 1 } }] }, 'bk01')!;
        const f = fetchOf({
            'https://p/bk01/020.pending.json': pendingJson('r20', [{ cell: '5:1:2', pending_reason: 'lib_missing', ref: { c: '兀' } }, { cell: '5:1:3', pending_reason: 'hard_pair', c: '日' }]),
            'https://p/bk01/021.pending.json': pendingJson('r21', [{ cell: '9:2:1', pending_reason: 'lib_missing', ref: { c: '兀' } }, { cell: '3:1:1', pending_reason: 'lib_missing', ref: { c: '兀' } }]),
        });
        const r = await loadClusterCells('bk01', 'lib_missing~兀', s, f, 'https://p');
        expect(r.cells.map((c) => `${c.chap}/${c.cell.a}/${c.rev}`)).toEqual(['020/5:1:2/r20', '021/3:1:1/r21', '021/9:2:1/r21']);
        expect(r.failed).toEqual(['022']);
    });
});

describe('submitBatch', () => {
    const items = [{ book: 'bk01', vol: '020', a: '1:1:1', rev: 'r20', choice: 'char' as const, char: '兀', pick_src: 'cluster' as const }];
    it('成功返回逐项结果', async () => {
        const f = (async () => ({ ok: true, status: 200, json: async () => ({ results: [{ a: '1:1:1', ok: true }] }) })) as unknown as typeof fetch;
        expect(await submitBatch(items, f, 0)).toEqual([{ a: '1:1:1', ok: true }]);
    });
    it('5xx 重试两次后整体失败；429 不重试；超 50 项直接拒', async () => {
        let n = 0;
        const f5 = (async () => { n++; return { ok: false, status: 500, json: async () => ({}) }; }) as unknown as typeof fetch;
        const r = await submitBatch(items, f5, 0);
        expect(n).toBe(3);
        expect(r[0].ok).toBe(false);
        let m = 0;
        const f429 = (async () => { m++; return { ok: false, status: 429, json: async () => ({}) }; }) as unknown as typeof fetch;
        expect((await submitBatch(items, f429, 0))[0].error).toMatch(/太频繁/);
        expect(m).toBe(1);
        expect((await submitBatch(Array(51).fill(items[0]), f5, 0))[0].error).toMatch(/50/);
    });
});
