/**
 * @jest-environment node
 *
 * GUJI-355：旧→新 ID 全表读表接口（3 条假数据；真表格式由 Eric 定）。
 */
import { describe, it, expect, jest } from '@jest/globals';
import { parseRedirectTable, EMPTY_REDIRECT_TABLE } from '../redirect-table';
import { lookupItemRedirectTraced, type ItemRedirectDeps } from '../item-redirect';

const A = 'd59f2q8ge0ap';
const B = 'd59f2evs8ni8';
const C = 'd59f284a78jn';
const D = 'd59f2pv8d3ia';
const E = 'd59f2pzbp3wh';

const raw = { version: 1, redirects: { [A]: B, [B]: C, [D]: { to: C } } };

describe('parseRedirectTable', () => {
    it('命中：字符串与 {to} 两种写法；终点自己还在表里（多跳）→ 不信', () => {
        const t = parseRedirectTable(raw);
        expect(t.size).toBe(3);
        expect(t.lookup(D)).toBe(C);
        expect(t.lookup(A)).toBeNull(); // A→B，B 又在表里：表未折叠，交回实时逻辑
        expect(t.lookup(E)).toBeNull();
    });
    it('折叠后的表：A→C 一跳命中', () => {
        expect(parseRedirectTable({ version: 1, redirects: { [A]: C } }).lookup(A)).toBe(C);
    });
    it('自指、环、非法 id 一律丢弃', () => {
        const t = parseRedirectTable({ version: 1, redirects: { [A]: A, [B]: C, [C]: B, '../x': A, [D]: '../y' } });
        expect(t.lookup(A)).toBeNull();
        expect(t.lookup(B)).toBeNull(); // 环
        expect(t.lookup(C)).toBeNull();
        expect(t.lookup(D)).toBeNull();
    });
    it('表缺失／版本不对／结构坏 → 空表（降级）', () => {
        for (const bad of [null, undefined, 'x', {}, { version: 2, redirects: {} }, { version: 1 }]) {
            expect(parseRedirectTable(bad)).toBe(EMPTY_REDIRECT_TABLE);
        }
    });
});

describe('lookupItemRedirectTraced + 全表', () => {
    const deps = (table?: ItemRedirectDeps['table']) => ({
        getItem: jest.fn(async () => null),
        resolvePromotion: jest.fn(async () => ({ status: 'absent' as const })),
        table,
    });
    it('表命中：308 到终点，不发任何取数', async () => {
        const d = deps(parseRedirectTable({ version: 1, redirects: { [A]: C } }));
        const r = await lookupItemRedirectTraced(A, d, 50);
        expect(r).toEqual({ redirect: { to: `/item/${C}`, permanent: true }, reason: 'redirect:table' });
        expect(d.getItem).not.toHaveBeenCalled();
        expect(d.resolvePromotion).not.toHaveBeenCalled();
    });
    it('表未命中／无表：走原有实时逻辑', async () => {
        const d1 = deps(parseRedirectTable({ version: 1, redirects: { [A]: C } }));
        expect((await lookupItemRedirectTraced(E, d1, 50)).reason).toBe('pass:not-found');
        expect(d1.getItem).toHaveBeenCalled();
        expect((await lookupItemRedirectTraced(E, deps(), 50)).reason).toBe('pass:not-found');
    });
});
