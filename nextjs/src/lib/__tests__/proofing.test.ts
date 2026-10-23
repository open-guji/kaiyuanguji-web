/**
 * @jest-environment node
 */
import {
    parsePending, parseCord, resolveCrop, cropRect, versionKeys, pickProofingChapter, loadProofing, submitReview,
    parseExtras, whyLabel, whyLabels, boxInCrop, shownCandidates, preselect, spriteUrl, ctxWorthShowing, proofInvite,
    readingOrder, contextAround, positionIndex, pageColOf, classLabel, refOpLabel,
    parseProofIndex, proofState, loadProofIndex, resetProofIndexCache, loadCosPending, pickChapterByStem, ALT_MAX,
} from '../proofing';

const pending = {
    schema: 'guji-pending/0.1', book: 'b1', vol: 'vol01', rev: 'r1',
    cells: [
        { a: '3:1:2', review: 'pending', c: '天', cand: { lib: '夭', ocr: '天' } },
        { a: '3:1:3', review: 'pending', c: '地', box: [10, 20, 30, 40] },
        { a: '3:1:4', review: 'human', c: '人' },
    ],
};
const cord = { pages: [{ page: 3, canvas: { seq: '0003', width: 1000, height: 1500 }, cells: [{ a: '3:1:2', box: [100, 200, 50, 60] }] }] };

describe('parsePending', () => {
    it('取待审格与 rev，跳过已校', () => {
        const r = parsePending(pending);
        expect(r.rev).toBe('r1');
        expect(r.cells.map(c => c.a)).toEqual(['3:1:2', '3:1:3']);
        expect(r.cells[1].box).toEqual([10, 20, 30, 40]);
        expect(r.cells[0].cand?.length).toBeGreaterThan(0);
    });
    it('坏数据不抛', () => {
        for (const bad of [null, undefined, 1, 'x', [], {}, { cells: 5 }, { rev: '../x', cells: [null, { a: 3 }, { a: '1:1:1', box: [1, 2, 'x', 4] }] }]) {
            expect(() => parsePending(bad)).not.toThrow();
        }
        expect(parsePending({ rev: '../x' }).rev).toBeNull();
        expect(parsePending({ rev: 'r', cells: [{ a: '1:1:1', review: 'pending', box: [1, 2, 0, 4] }] }).cells[0]?.box).toBeUndefined();
    });
});

describe('规范形（book-text#148）：cells 键为 cell、无 c／cand／box', () => {
    it('cell 与 a 都收，rev 原样', () => {
        const r = parsePending({ schema: 'guji-pending/0.1', rev: '001-r1', cv_version: null, cv_commit: 'abc', cells: [{ cell: '3:1:2', review: 'pending' }, { a: '3:1:3', review: 'pending' }] });
        expect(r.rev).toBe('001-r1');
        expect(r.cells.map(c => c.a)).toEqual(['3:1:2', '3:1:3']);
    });
    it('机器读字从 char_file 补', async () => {
        const char = { version: '1.0.0', book_id: 'b', volume: 1, pages: [{ page: 3, columns: [{ col: 1, cells: [{ a: '3:1:1', c: '欽' }, { a: '3:1:2', c: '定' }] }] }] };
        const idx = { chapters: [{ vol: '001', proofing: true, pending_file: '001.pending.json', char_file: '001.char.json', cord_file: '001.cord.json' }] };
        const r = await loadProofing({
            getManifest: async () => ({ versions: [{ key: 'original' }] }),
            getIndex: async () => idx,
            getFile: async (_i, _k, f) => (f.includes('pending') ? { rev: '001-r1', cells: [{ cell: '3:1:2', review: 'pending' }] } : f.includes('char') ? char : { pages: [{ page: 3, canvas: { seq: '0003', width: 100 }, cells: [] }] }),
        }, 'b', '001');
        expect(r.status).toBe('ok');
        if (r.status === 'ok') expect(r.pending.cells[0].c).toBe('定');
    });
});

describe('cord / 裁剪', () => {
    it('按 a 查框与页序；pending 的 box 优先', () => {
        const c = parseCord(cord);
        const [x, y] = parsePending(pending).cells;
        expect(resolveCrop(x, c)).toEqual({ box: [100, 200, 50, 60], seq: '0003', canvasWidth: 1000, canvasHeight: 1500 });
        expect(resolveCrop(y, c)?.box).toEqual([10, 20, 30, 40]);
        expect(resolveCrop(x, null)).toBeNull();
        expect(resolveCrop({ a: '9:1:1' }, c)).toBeNull();
    });
    it('cord 坏数据不抛', () => {
        expect(() => parseCord({ pages: [null, { page: 'x' }, { page: 1, cells: 3 }] })).not.toThrow();
        expect(() => parseCord(null)).not.toThrow();
    });
    it('boxInCrop 给出这一格在带四周的裁图里的位置', () => {
        const c = { box: [100, 200, 50, 60] as [number, number, number, number], seq: '1', canvasWidth: 1000 };
        expect(boxInCrop(c, 1000, 1500)).toEqual([17.5, 21, 50, 60]);
        expect(boxInCrop(c, 2000, 3000, 0)).toEqual([0, 0, 100, 120]);
        // 贴边时裁图被夹住，框跟着挪
        expect(boxInCrop({ ...c, box: [0, 0, 50, 60] }, 1000, 1500)).toEqual([0, 0, 50, 60]);
    });

    it('cropRect 按实际图宽换算并夹在图内', () => {
        const [x, y, w, h] = cropRect({ box: [100, 200, 50, 60], seq: '1', canvasWidth: 1000 }, 2000, 3000, 0);
        expect([x, y, w, h]).toEqual([200, 400, 100, 120]);
        const r = cropRect({ box: [0, 0, 50, 60], seq: '1', canvasWidth: 1000 }, 1000, 1500);
        expect(r[0]).toBe(0);
        expect(r[1]).toBe(0);
    });
});

describe('loadProofing', () => {
    const manifest = { versions: [{ key: 'default' }, { key: 'original' }] };
    const index = { chapters: [{ file: 'vol01.json', vol: 'vol01', proofing: true, pending_file: 'vol01.pending.json', cord_file: 'vol01.cord.json' }] };
    const deps = (over: Record<string, unknown> = {}) => ({
        getManifest: async () => manifest,
        getIndex: async () => index,
        getFile: async (_i: string, _k: string, f: string) => (f.includes('pending') ? pending : cord),
        ...over,
    });
    it('版本与章的挑选', () => {
        expect(versionKeys(manifest)).toEqual(['original', 'default']);
        expect(versionKeys(null)).toEqual([]);
        expect(pickProofingChapter(index, 'vol01')).not.toBeNull();
        expect(pickProofingChapter({ chapters: [{ proofing: true, pending_file: 'a.json', vol: 'x' }, { proofing: true, pending_file: 'b.json', vol: 'y' }] }, 'z')).toBeNull();
        // 没有 proofing: true 就不算
        expect(pickProofingChapter({ chapters: [{ pending_file: 'a.json', vol: 'vol01' }] }, 'vol01')).toBeNull();
    });
    it('正常取到', async () => {
        const r = await loadProofing(deps(), 'b1', 'vol01');
        expect(r.status).toBe('ok');
    });
    it('没声明、取不到、抛错都不抛', async () => {
        expect((await loadProofing(deps({ getManifest: async () => null }), 'b1', 'vol01')).status).toBe('none');
        expect((await loadProofing(deps({ getFile: async () => null }), 'b1', 'vol01')).status).toBe('error');
        expect((await loadProofing(deps({ getIndex: async () => { throw new Error('x'); } }), 'b1', 'vol01')).status).toBe('none');
        // 第一个版本目录抛错，第二个版本照样能取到
        let n = 0;
        expect((await loadProofing(deps({ getIndex: async () => { if (n++ === 0) throw new Error('x'); return index; } }), 'b1', 'vol01')).status).toBe('ok');
    });
    it('文件名带路径不请求', async () => {
        const bad = { chapters: [{ vol: 'vol01', proofing: true, pending_file: '../x.json' }] };
        expect((await loadProofing(deps({ getIndex: async () => bad }), 'b1', 'vol01')).status).toBe('none');
    });
});

describe('submitReview', () => {
    const draft = { book: 'b1', vol: 'vol01', a: '3:1:2', rev: 'r1', choice: 'char' as const, char: '天' };
    it('成功返回 null，带 aid', async () => {
        const f = jest.fn(async () => new Response(JSON.stringify({ success: true }), { status: 200 }));
        expect(await submitReview(draft, 'aid1', f as unknown as typeof fetch)).toBeNull();
        expect(JSON.parse((f.mock.calls[0] as unknown as [string, RequestInit])[1].body as string).aid).toBe('aid1');
    });
    it('429／错误体／网络错给文案，不抛', async () => {
        expect(await submitReview(draft, 'a', (async () => new Response('{}', { status: 429 })) as unknown as typeof fetch)).toMatch(/频繁/);
        expect(await submitReview(draft, 'a', (async () => new Response('{"error":"bad"}', { status: 400 })) as unknown as typeof fetch)).toBe('bad');
        expect(await submitReview(draft, 'a', (async () => { throw new Error('x'); }) as unknown as typeof fetch, 0)).toMatch(/网络/);
    });
    it('500 或断网自动重试一次：第二次成功就算成功；400／429 不重试', async () => {
        const f500 = jest.fn()
            .mockResolvedValueOnce(new Response('{"success":false,"error":"服务器错误"}', { status: 500 }))
            .mockResolvedValueOnce(new Response('{"success":true}', { status: 200 }));
        expect(await submitReview(draft, 'a', f500 as unknown as typeof fetch, 0)).toBeNull();
        expect(f500).toHaveBeenCalledTimes(2);
        const fNet = jest.fn().mockRejectedValueOnce(new Error('reset')).mockResolvedValueOnce(new Response('{"success":true}', { status: 200 }));
        expect(await submitReview(draft, 'a', fNet as unknown as typeof fetch, 0)).toBeNull();
        const fBad = jest.fn(async () => new Response('{"error":"bad"}', { status: 400 }));
        expect(await submitReview(draft, 'a', fBad as unknown as typeof fetch, 0)).toBe('bad');
        expect(fBad).toHaveBeenCalledTimes(1);
        const f429 = jest.fn(async () => new Response('{}', { status: 429 }));
        await submitReview(draft, 'a', f429 as unknown as typeof fetch, 0);
        expect(f429).toHaveBeenCalledTimes(1);
        const f500x2 = jest.fn(async () => new Response('{"error":"服务器错误"}', { status: 500 }));
        expect(await submitReview(draft, 'a', f500x2 as unknown as typeof fetch, 0)).toBe('服务器错误');
        expect(f500x2).toHaveBeenCalledTimes(2);
    });
});

describe('真实 guji-cord 形状（96mid1ogzk vol02 第 3 页节选）', () => {
    const real = {
        $schema: 'https://open-guji.org/schema/cord/v0.1.json', book_id: '96mid1ogzk', volume: 2,
        pages: [
            { page: 1, image: { width: 957, height: 1359 }, canvas: { id: 'https://data.kaiyuanguji.com/iiif/96mid1ogzk/canvas/02/0001', seq: '0001', width: 957, height: 1359 }, cells: [] },
            { page: 3, image: { width: 2345, height: 3122 }, canvas: { id: 'https://data.kaiyuanguji.com/iiif/96mid1ogzk/canvas/02/0003', seq: '0003', width: 2345, height: 3122 },
              cells: [{ a: '3:1:1', box: [1862, 332, 163, 128], id: 'gdgzygfc5gy' }, { a: '3:1:2', box: [1858, 451, 163, 131], id: 'gmzn45qh7xw' }],
              marks: [{ kind: 'blank', slot: 3, col: 1, box: [1, 2, 3, 4] }] },
        ],
    };
    it('取到 xywh 框、四位 seq 字符串与 canvas 宽', () => {
        const c = parseCord(real);
        expect(c.boxes.get('3:1:2')).toEqual([1858, 451, 163, 131]);
        expect(c.pages.get(3)).toEqual({ seq: '0003', width: 2345, height: 3122 });
        expect(resolveCrop({ a: '3:1:1' }, c)).toEqual({ box: [1862, 332, 163, 128], seq: '0003', canvasWidth: 2345, canvasHeight: 3122 });
    });
    it('marks 里的非字格不当作字格', () => {
        expect(parseCord(real).boxes.size).toBe(2);
    });

    it('parseCord 从 canvas id 取 IIIF 册目录（01，不是 URL 的 vol01）', () => {
        const c = parseCord({ pages: [{ page: 1, canvas: { id: 'https://data.kaiyuanguji.com/iiif/96mid1ogzk/canvas/01/0001', seq: '0001', width: 957 }, cells: [] }] });
        expect(c.iiifVol).toBe('01');
        expect(parseCord({ pages: [] }).iiifVol).toBeNull();
    });
});

describe('guji-proof/0.2 新字段（GUJI-557）', () => {
    it('0.1 数据一个新字段都没有，照旧可用', () => {
        const r = parsePending(pending);
        expect(r.cells[0]).toEqual({ a: '3:1:2', c: '天', cand: [{ c: '夭', src: ['lib'] }, { c: '天', src: ['ocr'] }] });
        expect(r.cells[0].img).toBeUndefined();
        expect(preselect(r.cells[0])).toBeNull();
    });

    it('全字段解析；类型不对的键各自丢弃，不连累其他键', () => {
        const e = parseExtras({
            why: ['a_code', 3, ''], cls: 'replace_align', lib_top: [{ c: '己', s: 0.91 }, { c: 5, s: 1 }, { c: '已' }],
            lib: { verdict: 'ok', cov: 0.9, wmax: 'x' }, ctx: { c: '巳', margin: 0.2, src: 'm' }, ref: { c: '己', op: 'coord' },
            ocr: [{ c: '己', src: 'a' }, { src: 'b' }], stale: { c: '已', state: 'stale' }, occ: { c: '印', ref_blank: true },
            img: { s: 'p0009.webp', x: 0, y: 96, w: 96, h: 96 }, ex: { 己: [{ s: 'ex-1.webp', x: 0, y: 0, w: 96, h: 96 }, { bad: 1 }], 已: [] },
        });
        expect(e.why).toEqual(['a_code']);
        expect(e.libTop).toEqual([{ c: '己', s: 0.91 }]);
        expect(e.lib).toEqual({ verdict: 'ok', cov: 0.9 });
        expect(e.ocr).toEqual([{ c: '己', src: 'a' }]);
        expect(e.occ).toEqual({ c: '印', refBlank: true });
        expect(e.img).toEqual({ s: 'p0009.webp', x: 0, y: 96, w: 96, h: 96 });
        expect(Object.keys(e.ex ?? {})).toEqual(['己']);
    });

    it('alt（相似字）：逐项容错、去重、最多 30 个；g 非法就只留字', () => {
        const items = [
            { c: '𡚁', s: 0.91, p: '弊', src: 'v,zi', g: { s: 'alt-001.webp', x: 0, y: 0, w: 96, h: 96 } },
            { c: '弊', s: 0.88, p: '弊', src: 'piv', g: { s: '../x.webp', x: 0, y: 0, w: 96, h: 96 } },
            { c: '𡚁', s: 0.5 }, { c: '两字' }, { s: 1 }, 'x',
            ...Array.from({ length: 40 }, (_, i) => ({ c: String.fromCodePoint(0x4e00 + i) })),
        ];
        const alt = parseExtras({ alt: items }).alt ?? [];
        expect(alt[0]).toEqual({ c: '𡚁', s: 0.91, p: '弊', src: 'v,zi', g: { s: 'alt-001.webp', x: 0, y: 0, w: 96, h: 96 } });
        expect(alt[1]).toEqual({ c: '弊', s: 0.88, p: '弊', src: 'piv' });
        expect(alt.filter(a => a.c === '𡚁')).toHaveLength(1);
        expect(alt).toHaveLength(ALT_MAX);
        expect(parseExtras({ alt: 'x' }).alt).toBeUndefined();
        expect(parseExtras({ alt: [] }).alt).toBeUndefined();
    });

    it('img 非法（越界负数、文件名带路径）当没有，由页面回退原叶裁图', () => {
        expect(parseExtras({ img: { s: '../x.webp', x: 0, y: 0, w: 96, h: 96 } }).img).toBeUndefined();
        expect(parseExtras({ img: { s: 'p1.webp', x: -1, y: 0, w: 96, h: 96 } }).img).toBeUndefined();
        expect(parseExtras({ img: { s: 'p1.webp', x: 0, y: 0, w: 0, h: 96 } }).img).toBeUndefined();
        expect(parseExtras('x')).toEqual({});
    });

    it('parsePending 带出 0.2 字段（规范键 cell）', () => {
        const r = parsePending({ rev: 'r2', cells: [{ cell: '9:7:17', review: 'pending', img: { s: 'p0009.webp', x: 0, y: 0, w: 96, h: 96 }, why: ['none'] }] });
        expect(r.cells[0].img?.s).toBe('p0009.webp');
        expect(r.cells[0].why).toEqual(['none']);
    });

    it('why：已知码映射中文短语，未知码显示「其他疑点」不露原码', () => {
        expect(whyLabel('none')).not.toBe('none');
        for (const code of ['near_form', 'ctx_garble_shape', 'replace_align', 'context_vs_ref', 'iron_ex_missing', 'context_blank_cell']) expect(whyLabel(code)).not.toBe(code);
        expect(whyLabel('some_future_code')).toBe('其他疑点');
        expect(whyLabel('vision_flag')).not.toMatch(/[A-Za-z]/);
        expect(whyLabels(['none', 'ctx_garble_shape', 'vision_flag'])).toEqual(['和本书别处字形都不像', '看图复核认为字可能错了']);
        expect(whyLabels(['none'])).toEqual(['机器没把握']);
        expect(whyLabels(['context_narrow_col', 'context_narrow_slice'])).toHaveLength(1);
    });

    it('候选取 cand 与 lib_top 前 3 的并集、最多显示 3 个并带库分数，多的进「更多」', () => {
        const { top, more } = shownCandidates({
            a: '1:1:1', cand: [{ c: '己' }, { c: '已' }],
            libTop: [{ c: '已', s: 0.9 }, { c: '巳', s: 0.8 }, { c: '以', s: 0.7 }, { c: '目', s: 0.6 }],
        });
        expect(top.map(x => x.c)).toEqual(['己', '已', '巳']);
        expect(top[1].score).toBe(0.9);
        expect(more.map(x => x.c)).toEqual(['以']);
    });

    it('整理本字排第一、带来源，同字合并（GUJI-683）', () => {
        const { top } = shownCandidates({
            a: '1:1:1', ref: { c: '臼' }, cand: [{ c: '曰', src: ['lib'] }, { c: '臼', src: ['ocr'] }],
            libTop: [{ c: '曰', s: 0.9 }, { c: '日', s: 0.8 }],
        });
        expect(top.map(x => x.c)).toEqual(['臼', '曰', '日']);
        expect(top[0].src).toEqual(['ref', 'ocr']);
        expect(top[1].score).toBe(0.9);
        // ref 不是单个字（脏数据）就不当候选
        expect(shownCandidates({ a: 'x', ref: { c: '臼曰' }, libTop: [{ c: '曰', s: 0.9 }] }).top.map(x => x.c)).toEqual(['曰']);
    });

    it('「看前后文」只是字形库首选的回声、或原因说上下文不可信时不显示；「看不出」照显示', () => {
        const libTop = [{ c: '曰', s: 0.9 }];
        expect(ctxWorthShowing({ a: 'x', ctx: { c: '曰' }, libTop })).toBe(false);
        expect(ctxWorthShowing({ a: 'x', ctx: { c: '臼' }, libTop })).toBe(true);
        expect(ctxWorthShowing({ a: 'x', ctx: { c: '臼' }, libTop, why: ['ctx_garble_shape'] })).toBe(false);
        expect(ctxWorthShowing({ a: 'x', ctx: { c: '' }, libTop })).toBe(true);
        expect(ctxWorthShowing({ a: 'x', libTop })).toBe(false);
    });

    it('阅读页横幅：总表列了按 n；取到总表却没列就不请；取不到总表才看 book-text 的待审单（GUJI-683）', () => {
        const idx = { b1: { '001': { rev: 'r', n: 3 }, '002': { rev: 'r', n: 0 } } };
        const ch = { file: '004.char.json', proofing: true };
        expect(proofInvite(idx, 'b1', '001', ch)).toBe('yes');
        expect(proofInvite(idx, 'b1', '002', ch)).toBe('no');
        expect(proofInvite(idx, 'b1', '004', ch)).toBe('no');
        expect(proofInvite(null, 'b1', '004', ch)).toBe('no');
        expect(proofInvite(null, 'b1', '004', { ...ch, pending_file: '004.pending.json' })).toEqual({ pendingFile: '004.pending.json' });
        expect(proofInvite(null, 'b1', '004', { file: '004.char.json', pending_file: '004.pending.json' })).toBe('no');
    });

    it('预勾：只有 stale 预选其字；occ 不预选', () => {
        expect(preselect({ a: 'x', stale: { c: '已' } })).toEqual({ choice: 'char', char: '已' });
        expect(preselect({ a: 'x', occ: { refBlank: true } })).toBeNull();
        expect(preselect({ a: 'x', stale: { c: '已' }, occ: {} })).toEqual({ choice: 'char', char: '已' });
        expect(preselect({ a: 'x' })).toBeNull();
    });

    it('雪碧图地址＝前缀/书/pending 同目录/文件名；不合规返回 null', () => {
        expect(spriteUrl('b1', '001.pending.json', 'p0009.webp', 'https://h/proof')).toBe('https://h/proof/b1/001/p0009.webp');
        expect(spriteUrl('b1', null, 'p1.webp', 'https://h/proof')).toBeNull();
        expect(spriteUrl('b1', '001.pending.json', '../p1.webp', 'https://h/proof')).toBeNull();
    });
});

describe('上下文（char_file 阅读顺序）', () => {
    // 文件里页、列故意乱序：阅读顺序按页升序、列升序（右→左），列内照文件顺序
    const charRaw = { pages: [
        { page: 10, columns: [{ col: 1, cells: [{ a: '10:1:1', c: '丙' }] }] },
        { page: 9, columns: [
            { col: 2, cells: [{ a: '9:2:1', c: '乙' }, { a: '9:2:2a', c: '小' }, { a: '9:2:2b', c: '注' }] },
            { col: 1, cells: [{ a: '9:1:1', c: '甲' }, { a: 'bad', c: '×' }, { a: '9:1:2' }] },
        ] },
        null,
    ] };
    const order = readingOrder(charRaw);
    it('跨列跨页排好，坏格号跳过，缺字记空串', () => {
        expect(order.map(s => s.a)).toEqual(['9:1:1', '9:1:2', '9:2:1', '9:2:2a', '9:2:2b', '10:1:1']);
        expect(order[1].c).toBe('');
    });
    it('前后各取 n 个，跨列、跨页补；不在顺序里返回 null', () => {
        const pos = positionIndex(order);
        const ctx = contextAround(order, pos, '9:2:1', 2)!;
        expect(ctx.before.map(s => s.c)).toEqual(['甲', '']);
        expect(ctx.after.map(s => s.c)).toEqual(['小', '注']);
        expect(contextAround(order, pos, '10:1:1', 3)!.after).toEqual([]);
        expect(contextAround(order, pos, '1:1:1')).toBeNull();
    });
    it('坏数据不抛', () => {
        expect(readingOrder(null)).toEqual([]);
        expect(readingOrder({ pages: 'x' })).toEqual([]);
    });
    it('pageColOf 认夹注半格', () => {
        expect(pageColOf('90:1:3a')).toEqual([90, 1]);
        expect(pageColOf('x')).toBeNull();
    });
});

describe('机器判读标签', () => {
    it('类别用大白话，未知类别原样', () => {
        expect(classLabel('replace_align').name).toBe('整理本改过字');
        expect(classLabel('lib_miss').hint).toContain('生僻字');
        expect(classLabel('future')).toEqual({ name: 'future' });
        expect(classLabel('seg_defect').name).toBe('切坏格');
        expect(whyLabel('seg_defect')).toContain('书影');
        expect(whyLabel('symbol')).toBe('可能是符号');
    });
    it('原因码全是中文，不含英文和术语', () => {
        for (const code of ['none', 'near_form', 'ctx_garble_shape', 'replace_align', 'iron_ex_missing', 'context_vs_ref', 'vision_flag', 'nonchar', 'unknown_x']) {
            expect(whyLabel(code)).not.toMatch(/[A-Za-z]/);
            expect(whyLabel(code)).not.toMatch(/铁证|载体|墨形|cov/);
        }
    });
    it('整理本对位方式：未知的不显示原码', () => {
        expect(refOpLabel('replace')).toContain('改过字');
        expect(refOpLabel('coord')).toBe('');
    });
    it('cls_sub 读进 clsSub', () => {
        expect(parseExtras({ cls: 'replace_align', cls_sub: 'manual' }).clsSub).toBe('manual');
    });
});

describe('COS 上的待审单（中心库发布）', () => {
    const res = (status: number, body?: unknown) => ({ ok: status >= 200 && status < 300, status, json: async () => body }) as unknown as Response;
    beforeEach(() => resetProofIndexCache());

    it('总表解析与各章状态', () => {
        const idx = parseProofIndex({ books: { b1: { '001': { rev: '001-r3', n: 4 }, '002': { rev: '002-r1', n: 0 }, bad: { n: 'x' } } } });
        expect(idx).toEqual({ b1: { '001': { rev: '001-r3', n: 4 }, '002': { rev: '002-r1', n: 0 } } });
        expect(proofState(idx, 'b1', '001')).toBe('open');
        expect(proofState(idx, 'b1', '002')).toBe('done');
        expect(proofState(idx, 'b1', '003')).toBe('unknown');
        expect(proofState(null, 'b1', '001')).toBe('unknown');
        expect(parseProofIndex({})).toBeNull();
    });
    it('总表只取一次；取不到给 null', async () => {
        const f = jest.fn(async () => res(200, { books: { b1: { '001': { rev: 'r', n: 1 } } } }));
        await loadProofIndex(f as unknown as typeof fetch, 'https://x/proof');
        await loadProofIndex(f as unknown as typeof fetch, 'https://x/proof');
        expect(f).toHaveBeenCalledTimes(1);
        expect(f).toHaveBeenCalledWith('https://x/proof/index.json');
        resetProofIndexCache();
        expect(await loadProofIndex((async () => res(404)) as unknown as typeof fetch)).toBeNull();
        resetProofIndexCache();
        expect(await loadProofIndex((async () => { throw new Error('net'); }) as unknown as typeof fetch)).toBeNull();
    });
    it('取一章待审单：地址按书与章拼；坏参数不发请求', async () => {
        const f = jest.fn(async () => res(200, { rev: 'r', cells: [] }));
        expect(await loadCosPending('b1', '001', f as unknown as typeof fetch, 'https://x/proof')).toEqual({ rev: 'r', cells: [] });
        expect(f).toHaveBeenCalledWith('https://x/proof/b1/001.pending.json');
        expect(await loadCosPending('b/1', '001', f as unknown as typeof fetch)).toBeNull();
        expect(f).toHaveBeenCalledTimes(1);
        expect(await loadCosPending('b1', '001', (async () => res(404)) as unknown as typeof fetch)).toBeNull();
    });
    it('loadProofing：COS 有待审单就用它，章按文件名找（不看 proofing 标记）', async () => {
        const index = { chapters: [{ file: '001', title: '卷首', cord_file: '001.cord.json' }] };
        const getFile = jest.fn(async () => cord);
        const r = await loadProofing({
            getManifest: async () => ({ versions: [{ key: 'default' }] }), getIndex: async () => index, getFile,
            getCosPending: async () => pending,
        }, 'b1', '001');
        expect(r.status).toBe('ok');
        if (r.status !== 'ok') return;
        expect(r.pendingFile).toBe('001.pending.json');
        expect(r.chapterTitle).toBe('卷首');
        expect(r.pending.rev).toBe('r1');
        expect(getFile.mock.calls.map(c => (c as unknown[])[2])).toEqual(['001.cord.json']);
        expect(pickChapterByStem(index, '002')).toBeNull();
    });
    it('loadProofing：COS 没有就退回 book-text；COS 有而目录里没这章也给待审单', async () => {
        const index = { chapters: [{ file: 'vol01.json', vol: 'vol01', proofing: true, pending_file: 'vol01.pending.json' }] };
        const base = { getManifest: async () => ({ versions: [{ key: 'default' }] }), getIndex: async () => index, getFile: async () => pending };
        const r1 = await loadProofing({ ...base, getCosPending: async () => null }, 'b1', 'vol01');
        expect(r1.status === 'ok' && r1.pendingFile).toBe('vol01.pending.json');
        const r2 = await loadProofing({ ...base, getManifest: async () => { throw new Error('x'); }, getCosPending: async () => pending }, 'b1', '009');
        expect(r2.status === 'ok' && r2.cord).toBeNull();
    });
});
