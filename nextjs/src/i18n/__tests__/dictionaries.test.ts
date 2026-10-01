/**
 * 网站字典自检（overview#337）：繁简两栏同形、占位符一致，简体栏不含常见繁体字；t() 回落与插值。
 */
import { NAMESPACES } from '../messages';
import { getSiteT } from '../translate';
import { findTraditionalChars } from '../traditional-check';

type Tree = { [k: string]: string | Tree };

function leaves(t: Tree, p = ''): Array<[string, string]> {
    return Object.entries(t).flatMap(([k, v]) => (typeof v === 'string' ? [[p + k, v] as [string, string]] : leaves(v, `${p}${k}.`)));
}
const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');

describe.each(Object.entries(NAMESPACES))('字典 %s', (_name, set) => {
    const H = new Map(leaves(set['zh-Hant'] as Tree));
    const S = new Map(leaves(set['zh-Hans'] as Tree));

    it('繁简两栏键一一对应', () => {
        expect([...S.keys()].sort()).toEqual([...H.keys()].sort());
    });

    it('占位符一致', () => {
        expect([...H].filter(([k, v]) => placeholders(v) !== placeholders(S.get(k) ?? '')).map(([k]) => k)).toEqual([]);
    });

    it('简体栏没有常见繁体字', () => {
        expect([...S].filter(([, v]) => findTraditionalChars(v).length).map(([k, v]) => `${k}: ${v}`)).toEqual([]);
    });
});

describe('getSiteT', () => {
    it('缺键原样返回键名', () => {
        expect(getSiteT('zh-Hans')('no.such' as never)).toBe('no.such');
    });
});
